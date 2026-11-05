import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const HOST = 'observability.core.internal';
const PREFIX = 'ops:v1:';
const STALE_MS = 15 * 60_000;
const INTERVAL_MS = 5 * 60_000;
const providers = ['resend', 'cloudflare'];
const states = new Set(['ok', 'warn', 'critical', 'unknown', 'stale']);
const iso = now => new Date(now).toISOString();
const validDate = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
const emptyCounts = () => ({ attempted: 0, accepted: 0, rejected: 0, unknown: 0, configuration: 0, throttled: 0 });
const response = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });

export const operationalMonitoringEnabled = env => ['production', 'staging'].includes(env.CORE_ENV)
  && env.CORE_OBSERVABILITY_ENABLED === 'true';
export const observationRequest = request => {
  try { return new URL(request.url).hostname === HOST; } catch { return false; }
};

function signature(secret, method, path, timestamp, body) {
  return createHmac('sha256', secret).update([method, path, timestamp,
    createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex');
}

export function signedObservationRequest(env, path, body, now = Date.now()) {
  const method = body === undefined ? 'GET' : 'POST';
  const timestamp = String(Math.floor(now / 1000));
  const raw = body === undefined ? '' : JSON.stringify(body);
  return new Request(`https://${HOST}${path}`, { method, redirect: 'manual',
    headers: { 'content-type': 'application/json', 'x-vp-observation-timestamp': timestamp,
      'x-vp-observation-signature': signature(env.API_BFF_SHARED_SECRET, method, path, timestamp, raw) },
    ...(body === undefined ? {} : { body: raw }), signal: AbortSignal.timeout(3000) });
}

export async function readOperationalText(request, max, signal) {
  if (!request.body) return '';
  const reader = request.body.getReader(); let size = 0;
  const chunks = [];
  try {
    while (true) {
      let abort;
      const interrupted = new Promise((_, reject) => { abort = () => reject(new Error('body_timeout')); signal.addEventListener('abort', abort, { once: true }); });
      let part;
      try { if (signal.aborted) throw new Error('body_timeout'); part = await Promise.race([reader.read(), interrupted]); }
      finally { signal.removeEventListener('abort', abort); }
      const { done, value } = part; if (done) break;
      size += value.byteLength; if (size > max) throw new Error('body_limit'); chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function validEvent(value, now) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => ['version', 'id', 'occurred_at', 'provider', 'outcome', 'http_status', 'provider_code'].includes(key))
    && value.version === 1 && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.id || '')
    && validDate(value.occurred_at) && Math.abs(now - Date.parse(value.occurred_at)) <= 10 * 60_000
    && providers.includes(value.provider) && ['accepted', 'rejected', 'unknown', 'configuration'].includes(value.outcome)
    && (value.http_status === undefined || (Number.isInteger(value.http_status) && value.http_status >= 100 && value.http_status <= 599))
    && (value.provider_code === undefined || (Number.isInteger(value.provider_code) && value.provider_code >= 10000 && value.provider_code <= 10999));
}

async function recordEmail(storage, value, now) {
  const day = iso(Date.parse(value.occurred_at)).slice(0, 10);
  const recent = Math.floor(Date.parse(value.occurred_at) / INTERVAL_MS);
  // The observation ID is random and contains no recipient/provider identifier.
  // Fixed event time makes replay keys stable across midnight and restarts.
  const seen = `${PREFIX}seen:${value.id}`;
  await storage.transaction(async tx => {
    if (await tx.get(seen)) return;
    const started = await tx.get(`${PREFIX}tracking-start`);
    if (!started) await tx.put(`${PREFIX}tracking-start`, iso(now));
    for (const period of [`day:${day}`, `month:${day.slice(0, 7)}`, `recent:${recent}`]) {
      const key = `${PREFIX}count:${period}:${value.provider}`;
      const count = await tx.get(key) || emptyCounts();
      count.attempted++; count[value.outcome]++;
      if (value.http_status === 429) count.throttled++;
      count.last_http_status = value.http_status ?? null;
      await tx.put(key, count);
    }
    await tx.put(seen, true);
    await tx.put(`${PREFIX}seen-date:${day}:${value.id}`, seen);
  });
}

function quotaStatus(row) {
  if (!Number.isFinite(row.used) || !(row.limit > 0)) return row.status;
  return row.used / row.limit >= .95 ? 'critical' : row.used / row.limit >= .8 ? 'warn' : row.status;
}

function overallStatus(values) {
  if (values.includes('critical')) return 'critical';
  if (values.includes('warn')) return 'warn';
  if (values.includes('stale')) return 'stale';
  if (!values.length || values.includes('unknown')) return 'unknown';
  return 'ok';
}

export function unknownOperationalSnapshot(enabled = false, now = Date.now()) {
  return { version: 1, generated_at: iso(now), observed_at: null, next_refresh_at: null, overall: 'unknown',
    email: [], infrastructure: [], alerts: [], monitor: { enabled, last_run_at: null, next_run_at: null } };
}

async function buildSnapshot(storage, env, now) {
  const saved = await storage.get(`${PREFIX}sources`);
  const started = await storage.get(`${PREFIX}tracking-start`);
  const stale = !saved || now - Date.parse(saved.observed_at) > STALE_MS || Date.parse(saved.observed_at) > now + 60_000;
  const email = [];
  for (const provider of providers) {
    const period = provider === 'cloudflare' ? 'day' : 'calendar_month';
    const rows = saved?.email?.filter(row => row.provider === provider) || [];
    const fallback = { provider, period, window_start: null, window_end: null,
      limit: provider === 'resend' ? 50_000 : 200, used: null, coverage: 'local_since',
      status: 'unknown', detail: 'Límite declarado; consumo total del proveedor no confirmado.' };
    for (const row of rows.length ? rows : [fallback]) {
      const localPeriod = row.period === 'day' ? 'day' : period;
      const suffix = localPeriod === 'day' ? `day:${iso(now).slice(0, 10)}` : `month:${iso(now).slice(0, 7)}`;
      const count = await storage.get(`${PREFIX}count:${suffix}:${provider}`);
      // Local counts describe this app's observation window, NOT account-wide
      // usage or confirmed inbox delivery. A missing observation is never zero.
      email.push({ ...row, accepted: count?.accepted ?? (started ? 0 : null), rejected: count?.rejected ?? (started ? 0 : null),
        limit: row.limit ?? (row.coverage === 'provider' ? null : fallback.limit),
        limit_source: row.coverage === 'provider' ? 'provider' : 'administrator',
        attempted: count?.attempted ?? (started ? 0 : null), unknown: count?.unknown ?? (started ? 0 : null),
        delivered: null, bounced: null, tracking_started_at: started || null,
        local_period: localPeriod, local_window: suffix.split(':')[1],
        status: stale && row.status === 'ok' ? 'stale' : quotaStatus(row) });
    }
  }
  const infrastructure = (saved?.infrastructure || ['workers', 'planetscale'].map(service => ({
    service, status: 'unknown', observed_at: null, metrics: [], detail: 'Fuente de métricas no disponible.' })))
    .map(row => ({ ...row, status: stale && row.status === 'ok' ? 'stale' : row.status }));
  const alerts = [];
  for (const provider of providers) {
    const rows = email.filter(row => row.provider === provider);
    const status = overallStatus(rows.map(row => row.status));
    if (['warn', 'critical'].includes(status)) alerts.push({ key: `${provider}:quota`, severity: status, resource: provider });
    // Local Cloudflare volume is advisory, not billed quota: verified
    // destinations can be exempt and other senders are outside our coverage.
    // Still warn before our declared 200/day operational budget is approached.
    else if (provider === 'cloudflare' && rows[0]?.accepted >= 160) alerts.push({ key: 'cloudflare:quota',
      severity: rows[0].accepted >= 190 ? 'critical' : 'warn', resource: provider, basis: 'local_volume', window: iso(now).slice(0, 10) });
  }
  for (const row of infrastructure) {
    if (['warn', 'critical'].includes(row.status)) alerts.push({ key: `${row.service}:capacity`, severity: row.status, resource: row.service });
  }
  if (stale) alerts.push({ key: 'monitor:stale', severity: 'warn', resource: 'monitor' });
  if (email.some(row => row.status === 'unknown') || infrastructure.some(row => row.status === 'unknown')) {
    alerts.push({ key: 'monitor:source_unavailable', severity: 'warn', resource: 'monitor' });
  }
  const bucket = Math.floor(now / INTERVAL_MS);
  let rejected = 0, unknown = 0, attempted = 0, throttled = false;
  for (const provider of providers) for (let offset = 0; offset < 3; offset++) {
    const row = await storage.get(`${PREFIX}count:recent:${bucket - offset}:${provider}`);
    rejected += row?.rejected || 0; unknown += row?.unknown || 0; attempted += row?.attempted || 0;
    throttled ||= row?.throttled > 0;
  }
  if (throttled || rejected + unknown >= 3) alerts.push({ key: 'email:delivery_failure',
    severity: throttled || (attempted >= 10 && (rejected + unknown) / attempted >= .2) ? 'critical' : 'warn', resource: 'email' });
  const nowIso = iso(now);
  const history = await storage.get(`${PREFIX}alerts`) || {};
  const active = new Set(alerts.map(alert => alert.key));
  for (const [key, prior] of Object.entries(history)) if (!active.has(key) && !prior.resolved_at) {
    // Losing telemetry is NOT proof that an incident recovered. Preserve the
    // last incident and its original last-seen time until fresh data proves it.
    const recovered = prior.basis === 'local_volume' ? prior.window !== iso(now).slice(0, 10)
      : key === 'monitor:stale' ? !stale
      : key === 'monitor:source_unavailable' ? !stale && ![...email, ...infrastructure].some(row => ['unknown', 'stale'].includes(row.status))
      : key === 'email:delivery_failure' ? attempted > 0 && rejected + unknown === 0 && !throttled
      : providers.includes(prior.resource) ? !stale && email.filter(row => row.provider === prior.resource).every(row => row.status === 'ok' && row.coverage === 'provider')
      : !stale && infrastructure.some(row => row.service === prior.resource && row.status === 'ok');
    if (recovered) history[key] = { ...prior, resolved_at: nowIso };
    else alerts.push({ ...prior, data_status: 'unknown' });
  }
  for (const alert of alerts) {
    const prior = history[alert.key];
    Object.assign(alert, { first_seen_at: prior && !prior.resolved_at ? prior.first_seen_at : nowIso,
      last_seen_at: alert.data_status === 'unknown' ? alert.last_seen_at : nowIso, notification_status: 'in_app' });
    history[alert.key] = { ...alert, resolved_at: null };
  }
  return { snapshot: { version: 1, generated_at: nowIso, observed_at: saved?.observed_at || null,
    next_refresh_at: saved ? iso(Date.parse(saved.observed_at) + INTERVAL_MS) : null,
    overall: overallStatus([...email, ...infrastructure].map(row => row.status).concat(alerts.map(row => row.severity))),
    email, infrastructure, alerts, monitor: { enabled: operationalMonitoringEnabled(env),
      last_run_at: saved?.observed_at || null, next_run_at: saved ? iso(Date.parse(saved.observed_at) + INTERVAL_MS) : null } }, history };
}

async function prune(storage, now) {
  // Bounded housekeeping; no per-email records/PII are retained in PlanetScale.
  const seenCutoff = iso(now - 7 * 86400_000).slice(0, 10);
  const dayCutoff = iso(now - 45 * 86400_000).slice(0, 10);
  const monthCutoff = iso(now - 400 * 86400_000).slice(0, 7);
  const recentCutoff = String(Math.floor((now - 86400_000) / INTERVAL_MS));
  const seen = await storage.list({ prefix: `${PREFIX}seen-date:`, end: `${PREFIX}seen-date:${seenCutoff}`, limit: 256 });
  if (seen.size) await storage.delete([...seen.keys(), ...seen.values()]);
  for (const [prefix, cutoff] of [[`${PREFIX}count:day:`, dayCutoff],
    [`${PREFIX}count:month:`, monthCutoff], [`${PREFIX}count:recent:`, recentCutoff]]) {
    const rows = await storage.list({ prefix, end: `${prefix}${cutoff}`, limit: 256 });
    if (rows.size) await storage.delete([...rows.keys()]);
  }
}

const workerNames = ['mindbliss-core-production', 'mindbliss-portal-production', 'mindbliss-admin-production'];
const metricNames = new Set(workerNames.flatMap(name => ['requests', 'errors', 'error_rate_percent', 'exceeded_resources', 'cpu_p99_ms'].map(metric => `${name}.${metric}`))
  .concat(['cpu_percent', 'memory_percent', 'replica_lag_seconds', 'storage_percent', 'client_connections', 'max_client_connections', 'client_connection_utilization_percent']));
const finite = value => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER);
const countValue = value => value === null || (finite(value) && Number.isSafeInteger(value));
function projectSources(value, now) {
  if (!validDate(value?.observed_at) || Math.abs(now - Date.parse(value.observed_at)) > 10 * 60_000
    || !Array.isArray(value.email) || value.email.length > 4 || !Array.isArray(value.infrastructure) || value.infrastructure.length !== 2) throw new Error('invalid_snapshot');
  const unique = new Set();
  const email = value.email.map(row => {
    if (!providers.includes(row?.provider) || !states.has(row.status) || !['provider_month', 'calendar_month', 'day', null].includes(row.period)
      || !['provider', 'unknown', 'local_since'].includes(row.coverage) || !countValue(row.limit) || !countValue(row.used)
      || (row.window_start !== null && !validDate(row.window_start)) || (row.window_end !== null && !validDate(row.window_end))) throw new Error('invalid_snapshot');
    const key = `${row.provider}:${row.period}`; if (unique.has(key)) throw new Error('invalid_snapshot'); unique.add(key);
    return { provider: row.provider, period: row.period, limit: row.limit, used: row.used, coverage: row.coverage, status: row.status,
      window_start: row.window_start === null ? null : iso(Date.parse(row.window_start)), window_end: row.window_end === null ? null : iso(Date.parse(row.window_end)),
      detail: 'Consumo y límite del proveedor; los acumulados locales se muestran por separado.' };
  });
  unique.clear();
  const infrastructure = value.infrastructure.map(row => {
    if (!['workers', 'planetscale'].includes(row?.service) || unique.has(row.service) || !states.has(row.status)
      || !validDate(row.observed_at) || Math.abs(now - Date.parse(row.observed_at)) > 10 * 60_000
      || !Array.isArray(row.metrics) || row.metrics.length > 24) throw new Error('invalid_snapshot');
    unique.add(row.service); const names = new Set();
    const metrics = row.metrics.map(item => {
      if (!metricNames.has(item?.name) || names.has(item.name) || !['requests', 'percent', 'milliseconds', 'seconds', 'connections'].includes(item.unit)
        || !finite(item.value) || !finite(item.threshold) || !['provider', 'unavailable'].includes(item.source)
        || (item.source === 'unavailable' && item.value !== null)
        || (row.service === 'workers') !== item.name.startsWith('mindbliss-')) throw new Error('invalid_snapshot');
      names.add(item.name); return { name: item.name, unit: item.unit, value: item.value, threshold: item.threshold, source: item.source };
    });
    return { service: row.service, status: row.status === 'ok' && !metrics.some(item => item.source === 'provider' && item.value !== null) ? 'unknown' : row.status,
      observed_at: iso(Date.parse(row.observed_at)), metrics,
      detail: 'Capacidad observada por el proveedor; no certifica disponibilidad funcional ni entrega de OTP.' };
  });
  return { observed_at: iso(Date.parse(value.observed_at)), email, infrastructure };
}

/** Only the existing API Durable Object invokes this handler; never public. */
export async function handleOperationalStorage(request, storage, env, now = Date.now()) {
  if (!operationalMonitoringEnabled(env)) return response({ error: 'observability_disabled' }, 503);
  const url = new URL(request.url);
  const read = request.method === 'GET' && url.pathname === '/v1/snapshot';
  if (url.protocol !== 'https:' || url.hostname !== HOST || url.port || url.username || url.password || url.search || url.hash
    || request.headers.has('upgrade') || request.headers.has('cookie') || request.headers.has('content-encoding')
    || (!read && !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || ''))
    || (!read && !(request.method === 'POST' && ['/v1/email', '/v1/refresh'].includes(url.pathname)))) return response({ error: 'not_found' }, 404);
  const secret = env.API_BFF_SHARED_SECRET;
  const timestamp = request.headers.get('x-vp-observation-timestamp') || '';
  const proof = request.headers.get('x-vp-observation-signature') || '';
  if (typeof secret !== 'string' || secret.length < 32 || !/^\d{10}$/.test(timestamp)
    || Math.abs(now / 1000 - Number(timestamp)) > 60 || !/^[a-f0-9]{64}$/.test(proof)) return response({ error: 'unauthorized' }, 401);
  let raw, timer;
  try {
    const controller = new AbortController(); timer = setTimeout(() => controller.abort(), 1000);
    raw = await readOperationalText(request, url.pathname === '/v1/refresh' ? 32 * 1024 : 1024, controller.signal);
  } catch { return response({ error: 'invalid_request' }, 400); }
  finally { clearTimeout(timer); }
  if (!timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(signature(secret, request.method, url.pathname, timestamp, raw), 'hex'))) return response({ error: 'unauthorized' }, 401);
  try {
    if (url.pathname === '/v1/email') {
      const event = JSON.parse(raw); if (!validEvent(event, now)) return response({ error: 'invalid_observation' }, 400);
      await recordEmail(storage, event, now); return response({ recorded: true });
    }
    if (url.pathname === '/v1/refresh') {
      let value;
      try { value = projectSources(JSON.parse(raw), now); } catch { return response({ error: 'invalid_snapshot' }, 400); }
      await storage.put(`${PREFIX}sources`, value);
      if (!await storage.get(`${PREFIX}tracking-start`)) await storage.put(`${PREFIX}tracking-start`, iso(now));
      const { history } = await buildSnapshot(storage, env, now);
      await storage.put(`${PREFIX}alerts`, history); await prune(storage, now);
      return response({ recorded: true });
    }
    const { snapshot } = await buildSnapshot(storage, env, now);
    return response(snapshot);
  } catch { return response({ error: 'observability_unavailable' }, 503); }
}
