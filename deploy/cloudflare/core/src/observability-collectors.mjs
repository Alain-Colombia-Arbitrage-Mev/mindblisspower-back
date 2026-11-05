// Read-only provider snapshots. No send key, SQL, container wake-up, retries or
// caller-selected URL enters this module. The caller persists/deduplicates alerts.
// Contracts: resend.com/docs/api-reference/usage/retrieve-usage,
// developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/,
// github.com/planetscale/cli/internal/planetscale/metrics.go and report_catalog.go.
const DEADLINE_MS = 4000;
const MAX_BYTES = 192 * 1024;
const FIVE_MINUTES = 5 * 60 * 1000;
const WORKERS = Object.freeze([
  ['core', 'mindbliss-core-production', 50],
  ['portal', 'mindbliss-portal-production', 30000],
  // No explicit cpu_ms in the admin deployment: do not assume a plan default.
  ['admin', 'mindbliss-admin-production', null],
].map(Object.freeze));
const SERIES = Object.freeze([
  ['planetscale_pods_cpu_util_percentages', 'cpu_percent', 'percent', 80, 95],
  ['planetscale_pods_mem_util_percentages', 'memory_percent', 'percent', 85, 95],
  ['planetscale_replica_lag_seconds', 'replica_lag_seconds', 'seconds', 30, 60],
]);
const INSTANT = Object.freeze([
  ['planetscale_volume_usage_percentage', 'storage_percent', 'percent', 80, 90],
  ['planetscale_pgbouncer_current_client_connections', 'client_connections', 'connections', null, null],
  ['planetscale_pgbouncer_settings_max_client_conn', 'max_client_connections', 'connections', null, null],
]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const count = value => number(value) && Number.isSafeInteger(value);
const secret = value => typeof value === 'string' && value.length >= 8 && value.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(value);
const segment = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const stamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const metric = (name, unit, value, threshold = null) => ({ name, unit, value, threshold, source: value === null ? 'unavailable' : 'provider' });
const severity = (value, warning, critical) => value === null ? 'unknown'
  : critical !== null && value >= critical ? 'critical' : warning !== null && value >= warning ? 'warn' : 'ok';
function worst(statuses) {
  return ['critical', 'warn', 'unknown', 'ok'].find(status => statuses.includes(status)) ?? 'unknown';
}

async function providerJson(fetchImpl, url, options) {
  const controller = new AbortController();
  let timer, reader;
  const work = async () => {
    const response = await fetchImpl(url, { ...options, redirect: 'manual', cache: 'no-store', signal: controller.signal });
    if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new Error('provider_timeout'); }
    if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      void response.body?.cancel().catch(() => {});
      throw new Error('provider_unavailable');
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) {
      void response.body?.cancel().catch(() => {}); throw new Error('provider_body_limit');
    }
    reader = response.body?.getReader();
    if (!reader) throw new Error('provider_invalid');
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('provider_body_limit');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  };
  try {
    return await Promise.race([work(), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('provider_timeout')); }, DEADLINE_MS);
    })]);
  } finally {
    clearTimeout(timer);
    // Cancellation must not extend the deadline, including adversarial streams.
    if (reader) { void reader.cancel().catch(() => {}); }
  }
}

function emailUnknown() {
  return { provider: 'resend', period: 'provider_month', window_start: null, window_end: null,
    limit: null, used: null, accepted: null, delivered: null, bounced: null, rejected: null,
    coverage: 'unknown', tracking_started_at: null, status: 'unknown',
    detail: 'Cuota Resend no disponible; requiere una clave de monitoreo separada con acceso a Usage.' };
}
function emailPeriod(value, period, now) {
  const end = stamp(value?.resets_at);
  if (!object(value) || !count(value.used) || !(value.limit === null || count(value.limit)) || !end || Date.parse(end) <= now) return null;
  const ratio = value.limit === null ? null : value.limit === 0 ? Infinity : value.used / value.limit;
  return { provider: 'resend', period, window_start: null, window_end: end, limit: value.limit, used: value.used,
    // Usage combines sent + received, not delivery or failed-send accounting.
    accepted: null, delivered: null, bounced: null, rejected: null, coverage: 'provider', tracking_started_at: null,
    status: ratio === null ? 'ok' : ratio >= 0.95 ? 'critical' : ratio >= 0.8 ? 'warn' : 'ok',
    detail: 'Consumo total de la cuenta según Resend (envíos y recepción); reinicio informado por el proveedor. No confirma entrega.' };
}
async function collectEmail(env, fetchImpl, now) {
  if (!secret(env.RESEND_MONITOR_API_KEY)) return [emailUnknown()];
  try {
    const value = await providerJson(fetchImpl, 'https://api.resend.com/usage', {
      method: 'GET', headers: { authorization: `Bearer ${env.RESEND_MONITOR_API_KEY}`, accept: 'application/json' },
    });
    if (value?.object !== 'usage') return [emailUnknown()];
    const monthly = emailPeriod(value.emails?.monthly, 'provider_month', now);
    const daily = emailPeriod(value.emails?.daily, 'day', now);
    return [monthly ?? emailUnknown(), ...(daily ? [daily] : [])];
  } catch { return [emailUnknown()]; }
}

function unknownWorkers(observedAt) {
  return { service: 'workers', status: 'unknown', observed_at: observedAt,
    metrics: WORKERS.flatMap(([, name, limit]) => [metric(`${name}.requests`, 'requests', null),
      metric(`${name}.errors`, 'requests', null), metric(`${name}.error_rate_percent`, 'percent', null, 1),
      metric(`${name}.exceeded_resources`, 'requests', null, 1), metric(`${name}.cpu_p99_ms`, 'milliseconds', null, limit === null ? null : limit * 0.8)]),
    detail: 'Métricas de Workers no disponibles. No se confirma capacidad ni ausencia de errores.' };
}
function workerQuery() {
  const fields = WORKERS.map(([alias, name]) => `
    ${alias}: workersInvocationsAdaptive(limit: 1, filter: {scriptName: "${name}", datetime_geq: $start, datetime_leq: $end}) {
      sum { requests errors } quantiles { cpuTimeP99 }
    }
    ${alias}Outcomes: workersInvocationsAdaptive(limit: 10, filter: {scriptName: "${name}", datetime_geq: $start, datetime_leq: $end}) {
      sum { requests } dimensions { status }
    }`).join('\n');
  return `query OperationalWorkers($accountTag: string!, $start: Time!, $end: Time!) {
    viewer { accounts(filter: {accountTag: $accountTag}) { ${fields} } }
  }`;
}
async function collectWorkers(env, fetchImpl, now, observedAt) {
  if (!secret(env.CLOUDFLARE_MONITOR_API_TOKEN) || !/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID ?? '')) return unknownWorkers(observedAt);
  try {
    const value = await providerJson(fetchImpl, 'https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST', headers: { authorization: `Bearer ${env.CLOUDFLARE_MONITOR_API_TOKEN}`, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ query: workerQuery(), variables: { accountTag: env.CLOUDFLARE_ACCOUNT_ID,
        start: new Date(now - FIVE_MINUTES).toISOString(), end: observedAt } }),
    });
    const accounts = value?.data?.viewer?.accounts;
    if ((value.errors != null && (!Array.isArray(value.errors) || value.errors.length)) || !Array.isArray(accounts) || accounts.length !== 1) return unknownWorkers(observedAt);
    const metrics = [], statuses = [];
    for (const [alias, name, limit] of WORKERS) {
      const rows = accounts[0]?.[alias], outcomes = accounts[0]?.[`${alias}Outcomes`];
      const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
      const requests = number(row?.sum?.requests) ? row.sum.requests : null;
      const errors = number(row?.sum?.errors) && requests !== null && row.sum.errors <= requests ? row.sum.errors : null;
      // Cloudflare's Workers GraphQL cpuTime quantiles are microseconds, not wall latency.
      const cpu = requests > 0 && number(row?.quantiles?.cpuTimeP99) ? row.quantiles.cpuTimeP99 / 1000 : null;
      const validOutcomes = Array.isArray(outcomes) && outcomes.length <= 5 && outcomes.length > 0
        && outcomes.every(outcome => number(outcome?.sum?.requests)
          && ['success', 'clientDisconnected', 'scriptThrewException', 'exceededResources', 'internalError'].includes(outcome?.dimensions?.status));
      const exceeded = validOutcomes ? outcomes.filter(outcome => outcome.dimensions.status === 'exceededResources').reduce((sum, outcome) => sum + outcome.sum.requests, 0) : null;
      const rate = requests > 0 && errors !== null ? errors / requests * 100 : null;
      metrics.push(metric(`${name}.requests`, 'requests', requests), metric(`${name}.errors`, 'requests', errors),
        metric(`${name}.error_rate_percent`, 'percent', rate, 1), metric(`${name}.exceeded_resources`, 'requests', exceeded, 1),
        metric(`${name}.cpu_p99_ms`, 'milliseconds', cpu, limit === null ? null : limit * 0.8));
      statuses.push(requests === null || requests === 0 || errors === null || exceeded === null || cpu === null ? 'unknown' : 'ok',
        severity(exceeded, 1, 1), severity(rate, 1, 5), limit === null ? 'ok' : severity(cpu, limit * 0.8, limit));
    }
    return { service: 'workers', status: worst(statuses), observed_at: observedAt, metrics,
      detail: 'Ventana de 5 minutos, métricas muestreadas de Cloudflare; datos recientes pueden demorar. CPU no es latencia. Límite del administrador no configurado; sin inferirlo.' };
  } catch { return unknownWorkers(observedAt); }
}

function unknownPlanetScale(observedAt) {
  return { service: 'planetscale', status: 'unknown', observed_at: observedAt,
    metrics: [...SERIES, ...INSTANT].map(([, name, unit, warning]) => metric(name, unit, null, warning))
      .concat(metric('client_connection_utilization_percent', 'percent', null, 80)),
    detail: 'Métricas de PlanetScale no disponibles; requiere token read_branch separado y organización, base y rama explícitas.' };
}
function seriesValue(value, name, now) {
  if (!Array.isArray(value?.series) || value.series.length > 100) return null;
  const found = [];
  for (const series of value.series.filter(series => series?.metric === name)) {
    if (!Array.isArray(series.points) || series.points.length > 100) return null;
    let latest = null;
    for (const point of series.points) {
      if (!Array.isArray(point) || point.length !== 2 || !number(point[0]) || !number(point[1])) continue;
      const time = point[0] * 1000;
      if (time > now || time < now - 10 * 60 * 1000) continue;
      if (!latest || time > latest.time) latest = { time, value: point[1] };
    }
    if (latest) found.push(latest.value);
  }
  return found.length ? Math.max(...found) : null;
}
function instantValue(value, name) {
  if (!Array.isArray(value?.metrics) || value.metrics.length > 100) return null;
  const rows = value.metrics.filter(row => row?.metric === name);
  if (!rows.length || rows.some(row => !Array.isArray(row.values) || !row.values.length || row.values.length > 100 || row.values.some(item => !number(item?.value)))) return null;
  // Maximum observed series, not a sum over unrelated pools/nodes. We do not
  // fabricate connection utilization by dividing maxima from different nodes.
  return Math.max(...rows.flatMap(row => row.values.map(item => item.value)));
}
function connectionUtilization(value) {
  if (!Array.isArray(value?.metrics) || value.metrics.length > 100) return null;
  const dimensionKey = row => {
    if (!object(row) || Object.keys(row).length > 20 || !count(row.value)) return null;
    const dimensions = Object.entries(row).filter(([key]) => key !== 'value').sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    if (dimensions.some(([key, item]) => key.length > 100 || !['string', 'number', 'boolean'].includes(typeof item)
      || typeof item === 'string' && item.length > 200 || typeof item === 'number' && !Number.isFinite(item))) return null;
    return JSON.stringify(dimensions);
  };
  const dimensionsFor = name => {
    const rows = value.metrics.filter(row => row?.metric === name);
    if (!rows.length || rows.some(row => !Array.isArray(row.values) || !row.values.length || row.values.length > 100)) return null;
    const values = new Map();
    for (const item of rows.flatMap(row => row.values)) {
      const key = dimensionKey(item);
      if (key === null || values.has(key)) return null;
      values.set(key, item.value);
    }
    return values;
  };
  const current = dimensionsFor('planetscale_pgbouncer_current_client_connections');
  const capacity = dimensionsFor('planetscale_pgbouncer_settings_max_client_conn');
  if (!current || !capacity || current.size !== capacity.size || [...current.keys()].some(key => !capacity.has(key))) return null;
  const percentages = [];
  for (const [key, used] of current) {
    if (capacity.get(key) <= 0) return null;
    percentages.push(used / capacity.get(key) * 100);
  }
  return percentages.length ? Math.max(...percentages) : null;
}
async function collectPlanetScale(env, fetchImpl, now, observedAt) {
  if (!secret(env.PLANETSCALE_MONITOR_SERVICE_TOKEN_ID) || !secret(env.PLANETSCALE_MONITOR_SERVICE_TOKEN)
    || ![env.PLANETSCALE_MONITOR_ORGANIZATION, env.PLANETSCALE_MONITOR_DATABASE, env.PLANETSCALE_MONITOR_BRANCH].every(segment)) return unknownPlanetScale(observedAt);
  const base = `https://api.planetscale.com/v1/organizations/${env.PLANETSCALE_MONITOR_ORGANIZATION}/databases/${env.PLANETSCALE_MONITOR_DATABASE}/branches/${env.PLANETSCALE_MONITOR_BRANCH}/metrics`;
  const headers = { authorization: `${env.PLANETSCALE_MONITOR_SERVICE_TOKEN_ID}:${env.PLANETSCALE_MONITOR_SERVICE_TOKEN}`, accept: 'application/json' };
  const query = new URLSearchParams({ from: new Date(now - FIVE_MINUTES).toISOString(), to: observedAt, steps: '5' });
  for (const [name] of SERIES) query.append('metrics[]', name);
  const instantQuery = new URLSearchParams();
  for (const [name] of INSTANT) instantQuery.append('metrics[]', name);
  // Failure in one provider subresource must not discard the other real sample.
  const [series, instant] = await Promise.all([
    providerJson(fetchImpl, `${base}?${query}`, { method: 'GET', headers }).catch(() => null),
    providerJson(fetchImpl, `${base}/instant?${instantQuery}`, { method: 'GET', headers }).catch(() => null),
  ]);
  const metrics = [], statuses = [];
  for (const [definition, sample] of [[SERIES, series], [INSTANT, instant]]) {
    for (const [providerName, name, unit, warning, critical] of definition) {
      let value = definition === SERIES ? seriesValue(sample, providerName, now) : instantValue(sample, providerName);
      if (unit === 'percent' && value !== null && value > 100) value = null;
      metrics.push(metric(name, unit, value, warning));
      statuses.push(severity(value, warning, critical));
    }
  }
  const utilization = connectionUtilization(instant);
  metrics.push(metric('client_connection_utilization_percent', 'percent', utilization, 80));
  statuses.push(severity(utilization, 80, 95));
  return { service: 'planetscale', status: worst(statuses), observed_at: observedAt, metrics,
    detail: 'Métricas oficiales de la rama; máximo de cada serie reciente. Memoria puede incluir caché. El porcentaje de conexiones sólo se calcula entre series con todas las dimensiones del nodo idénticas.' };
}

export async function collectOperationalProviders(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000) throw new Error('Invalid observation time');
  const observedAt = new Date(now).toISOString();
  const [email, workers, planetscale] = await Promise.all([
    collectEmail(env, fetchImpl, now), collectWorkers(env, fetchImpl, now, observedAt), collectPlanetScale(env, fetchImpl, now, observedAt),
  ]);
  return { observed_at: observedAt, email, infrastructure: [workers, planetscale] };
}
