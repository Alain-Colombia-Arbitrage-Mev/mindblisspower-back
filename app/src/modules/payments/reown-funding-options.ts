/** Production discovery for Reown's own Meld account, independent of administrative Meld credentials. */
// Published by @reown/appkit-controllers 1.8.24 (src/utils/ConstantsUtil.js).
// This is the public checkout key shipped by Reown, not a Mindbliss private API key.
const REOWN_MELD_PUBLIC_KEY = 'WXETMuFUQmqqybHuRkSgxv:25B8LJHSfpG6LVjR2ytU5Cwh7Z4Sch2ocoU';
const PROVIDERS = ['SWAPPED', 'MERCURYO'] as const;
export const PERSONAL_FUNDING_COUNTRIES = ['US', 'MX', 'CO'] as const;
export const PERSONAL_FUNDING_MINIMUM_USD = 30;
export const PERSONAL_FUNDING_MAXIMUM_USD = 15_000;
export const PERSONAL_FUNDING_MINIMUM_MXN = 931;
const EXCLUDED_PERSONAL_METHODS = new Set(['NETELLER', 'SKRILL']);
const MAX_BYTES = 65_536;
const TIMEOUT_MS = 8_000;
const unavailable = () => new Error('wallet_funding_provider_unavailable');
type DiscoveryDiagnostic = { event: 'personal_funding_discovery_failure'; phase: 'fetch' | 'response' | 'body' | 'normalization';
  status: number | null; code: 'TRANSPORT_FAILURE' | 'HTTP_REJECTED' | 'INVALID_RESPONSE' | 'TIMEOUT'; country: string; sourceCurrencyCode: string };

export type ReownFundingMethod = { method: string; currencyCode: string; minimumAmount: number; maximumAmount: number;
  minimumUsd?: number; maximumUsd?: number };
export type ReownFundingRoute = {
  serviceProvider: typeof PROVIDERS[number];
  paymentMethods: ReownFundingMethod[];
};
export type ReownProductionOptions = {
  walletKind: 'personal'; environment: 'production'; provider: 'reown'; country: string; sourceCurrencyCode: string;
  paymentMethods: string[]; routes: ReownFundingRoute[];
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Canonical IDs and limits in the requested fiat; labels and guessed rails are never accepted. */
export function normalizeReownProductionRoutes(data: unknown, sourceCurrencyCode = 'USD'): ReownFundingRoute[] {
  if (!/^[A-Z]{3}$/.test(sourceCurrencyCode)) throw unavailable();
  if (!Array.isArray(data) || data.length > 100) throw unavailable();
  const routes = new Map<ReownFundingRoute['serviceProvider'], Map<string, ReownFundingMethod>>();
  for (const route of data) {
    if (!record(route) || typeof route.partner !== 'string') throw unavailable();
    if (!PROVIDERS.some(provider => provider === route.partner)) continue;
    if (route.source !== sourceCurrencyCode || route.destination !== 'USDT'
      || !Array.isArray(route.paymentMethods) || route.paymentMethods.length > 64) throw unavailable();
    const provider = route.partner as ReownFundingRoute['serviceProvider'];
    const methods = routes.get(provider) ?? new Map<string, ReownFundingMethod>();
    for (const method of route.paymentMethods) {
      if (!record(method) || typeof method.name !== 'string' || !/^[A-Z0-9_]{2,40}$/.test(method.name)) {
        throw unavailable();
      }
      if (EXCLUDED_PERSONAL_METHODS.has(method.name)) continue;
      // The approved local-fiat policy is SPEI in Mexico; other local methods
      // cannot silently inherit the USD minimum or currency conversion rules.
      if (sourceCurrencyCode === 'MXN' && method.name !== 'SPEI') continue;
      // Without limits, the server cannot verify the selected amount for this rail.
      if (method.limits === null || method.limits === undefined) continue;
      if (!record(method.limits)) throw unavailable();
      const { currencyCode, min, max } = method.limits;
      if (currencyCode !== sourceCurrencyCode || typeof min !== 'number' || typeof max !== 'number'
        || !Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min || max > 1_000_000_000) {
        throw unavailable();
      }
      const prior = methods.get(method.name);
      if (prior && (prior.minimumAmount !== min || prior.maximumAmount !== max)) throw unavailable();
      methods.set(method.name, { method: method.name, currencyCode: sourceCurrencyCode, minimumAmount: min, maximumAmount: max,
        ...(sourceCurrencyCode === 'USD' ? { minimumUsd: min, maximumUsd: max } : {}) });
    }
    if (methods.size) routes.set(provider, methods);
  }
  return PROVIDERS.flatMap(serviceProvider => {
    const methods = routes.get(serviceProvider);
    return methods ? [{ serviceProvider, paymentMethods: [...methods.values()] }] : [];
  });
}

function disposeBody(body: { cancel: () => unknown } | null | undefined) {
  try { void Promise.resolve(body?.cancel()).catch(() => {}); } catch { /* best effort after cancellation */ }
}

// Keep the deadline effective even when a faulty upstream ignores AbortSignal.
function withSignal<T>(operation: () => Promise<T>, signal: AbortSignal, lateValue?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      if (settled) return;
      settled = true; cleanup(); reject(unavailable());
    };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw unavailable();
      return operation();
    }).then(value => {
      if (settled) { lateValue?.(value); return; }
      settled = true; cleanup(); resolve(value);
    }, error => {
      if (settled) return;
      settled = true; cleanup(); reject(error);
    });
  });
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) { disposeBody(response.body); throw unavailable(); }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) {
    disposeBody(response.body); throw unavailable();
  }
  const reader = response.body?.getReader();
  if (!reader) throw unavailable();
  const cancel = () => disposeBody(reader);
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await withSignal(() => reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BYTES) { cancel(); throw unavailable(); }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    signal.removeEventListener('abort', cancel);
    try { reader.releaseLock(); } catch { /* a cancelled reader cannot extend the deadline */ }
  }
}

/** Exactly one read-only request, scoped with Reown's public merchant key; never reads administrative env. */
export async function readReownProductionOptions(country: string, {
  fetchImpl = fetch, signal, sourceCurrencyCode = 'USD', diagnostic = (event: DiscoveryDiagnostic) => console.warn(JSON.stringify(event)),
}: { fetchImpl?: typeof fetch; signal?: AbortSignal; sourceCurrencyCode?: string;
  diagnostic?: (event: DiscoveryDiagnostic) => void } = {}): Promise<ReownProductionOptions> {
  if (typeof country !== 'string' || !PERSONAL_FUNDING_COUNTRIES.some(allowed => allowed === country)) {
    throw new Error('wallet_funding_invalid_country');
  }
  if (typeof sourceCurrencyCode !== 'string' || !/^[A-Z]{3}$/.test(sourceCurrencyCode)) throw new Error('wallet_funding_invalid_currency');
  if (sourceCurrencyCode !== 'USD' && !(country === 'MX' && sourceCurrencyCode === 'MXN')) {
    throw new Error('wallet_funding_invalid_currency');
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, TIMEOUT_MS);
  let phase: DiscoveryDiagnostic['phase'] = 'fetch';
  let status: number | null = null;
  try {
    const url = `https://api.meld.io/network-partner/supported/routes/CRYPTO_ONRAMP/${country}/${sourceCurrencyCode}/USDT?partners=SWAPPED,MERCURYO`;
    const response = await withSignal(() => fetchImpl(url, {
      method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit', signal: controller.signal,
      headers: { Authorization: `BASIC ${REOWN_MELD_PUBLIC_KEY}`, Accept: 'application/json', 'Meld-Version': '2026-02-03' },
    }), controller.signal, response => disposeBody(response.body));
    phase = 'response'; status = response.status;
    if (!response.ok || response.redirected) { disposeBody(response.body); throw unavailable(); }
    phase = 'body';
    const body = await boundedJson(response, controller.signal);
    phase = 'normalization';
    const normalized = normalizeReownProductionRoutes(body, sourceCurrencyCode);
    // This is a fixed MXN business minimum, not a USD exchange-rate quote.
    // A provider can require more, and a route whose maximum is lower is absent.
    const routes = normalized.map(route => ({ ...route, paymentMethods: route.paymentMethods.flatMap(method => {
      const minimumAmount = Math.max(sourceCurrencyCode === 'USD' ? PERSONAL_FUNDING_MINIMUM_USD : PERSONAL_FUNDING_MINIMUM_MXN, method.minimumAmount);
      const maximumAmount = sourceCurrencyCode === 'USD' ? Math.min(PERSONAL_FUNDING_MAXIMUM_USD, method.maximumAmount) : method.maximumAmount;
      return minimumAmount > maximumAmount ? [] : [{ ...method, minimumAmount, maximumAmount,
        ...(sourceCurrencyCode === 'USD' ? { minimumUsd: minimumAmount, maximumUsd: maximumAmount } : {}) }];
    }) })).filter(route => route.paymentMethods.length > 0);
    const paymentMethods = [...new Set(routes.flatMap(route => route.paymentMethods.map(method => method.method)))];
    if (controller.signal.aborted) throw unavailable();
    return { walletKind: 'personal', environment: 'production', provider: 'reown', country, sourceCurrencyCode, paymentMethods, routes };
  } catch {
    // Caller-driven cancellation is normal when a user changes country. Never
    // record upstream body text, request headers, credentials, URLs or identity.
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try { diagnostic({ event: 'personal_funding_discovery_failure', phase, status, country, sourceCurrencyCode,
      code: controller.signal.aborted ? 'TIMEOUT' : phase === 'fetch' ? 'TRANSPORT_FAILURE'
        : phase === 'response' ? 'HTTP_REJECTED' : 'INVALID_RESPONSE' }); } catch { /* diagnostics cannot change availability */ }
    throw unavailable();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
