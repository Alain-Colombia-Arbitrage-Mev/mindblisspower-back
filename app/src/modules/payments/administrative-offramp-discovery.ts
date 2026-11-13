import { z } from 'zod';

const inputSchema = z.object({
  country: z.enum(['US', 'MX', 'CO']),
  destinationCurrencyCode: z.enum(['USD', 'MXN', 'COP']),
}).strict().refine(value => value.destinationCurrencyCode === 'USD'
  || (value.country === 'MX' && value.destinationCurrencyCode === 'MXN')
  || (value.country === 'CO' && value.destinationCurrencyCode === 'COP'));
const identifier = z.string().regex(/^[A-Z0-9_]{2,64}$/);
const currency = z.string().regex(/^[A-Z0-9_]{2,40}$/);
const bounds = z.object({ currencyCode: currency, min: z.number().finite().min(0).max(1_000_000_000),
  max: z.number().finite().min(0).max(1_000_000_000) }).refine(value => value.max >= value.min);
const methodSchema = z.object({ name: identifier, checkoutSupported: z.boolean().optional(), limits: bounds.nullish() });
const routeSchema = z.object({ partner: identifier, source: currency, destination: currency,
  checkoutSupported: z.boolean().optional(), paymentMethods: z.array(methodSchema).max(64) });
type Environment = Record<string, string | undefined>;
type Route = { serviceProvider: string; paymentMethods: { method: string; currencyCode: string; minimumAmount: number; maximumAmount: number }[] };

/** Preserve the provider's limits currency. A fiat minimum is never relabelled as USDT. */
export function administrativeOfframpRoutes(value: unknown, payoutCurrency: string): Route[] {
  const parsed = z.array(routeSchema).max(100).parse(value);
  const providers = new Map<string, Map<string, Route['paymentMethods'][number]>>();
  for (const route of parsed) {
    if (route.checkoutSupported === false) continue;
    if (route.source !== 'USDT_POLYGON' || route.destination !== payoutCurrency) throw Error('offramp_provider_unavailable');
    let methods = providers.get(route.partner);
    if (!methods) { methods = new Map(); providers.set(route.partner, methods); }
    for (const item of route.paymentMethods) {
      if (item.checkoutSupported === false || !item.limits) continue;
      if (!['USDT_POLYGON', 'USDT', payoutCurrency].includes(item.limits.currencyCode)) throw Error('offramp_provider_unavailable');
      const next = { method: item.name, currencyCode: item.limits.currencyCode,
        minimumAmount: item.limits.min, maximumAmount: item.limits.max };
      const prior = methods.get(item.name);
      if (prior && JSON.stringify(prior) !== JSON.stringify(next)) throw Error('offramp_provider_unavailable');
      methods.set(item.name, next);
    }
  }
  return [...providers.entries()].filter(([, methods]) => methods.size)
    .map(([serviceProvider, methods]) => ({ serviceProvider, paymentMethods: [...methods.values()] }));
}

function withSignal<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const aborted = () => { if (!settled) { settled = true; signal.removeEventListener('abort', aborted); reject(Error('offramp_provider_unavailable')); } };
    if (signal.aborted) return aborted();
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(() => { if (signal.aborted) throw Error('offramp_provider_unavailable'); return operation(); })
      .then(value => { if (!settled) { settled = true; signal.removeEventListener('abort', aborted); resolve(value); }
        else if (value instanceof Response) void value.body?.cancel().catch(() => {}); },
      () => { if (!settled) { settled = true; signal.removeEventListener('abort', aborted); reject(Error('offramp_provider_unavailable')); } });
  });
}

async function responseJson(response: Response, signal: AbortSignal) {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '') || !response.body) throw Error('offramp_provider_unavailable');
  const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const chunk = await withSignal(() => reader.read(), signal); if (chunk.done) break;
      size += chunk.value.length; if (size > 131_072) throw Error('offramp_provider_unavailable'); parts.push(chunk.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))) as unknown;
  } finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
}

/** Discovery only. This module cannot create a sell session, sign, or broadcast a transfer. */
export async function readAdministrativeOfframpOptions(rawInput: unknown, {
  environment = process.env, fetchImpl = fetch, signal,
}: { environment?: Environment; fetchImpl?: typeof fetch; signal?: AbortSignal } = {}) {
  const input = inputSchema.parse(rawInput), key = environment.MELD_API_SANDBOX;
  if (environment.MELD_ADMIN_SANDBOX_ENABLED !== 'true' || !key || key.length > 2048 || /\s/.test(key)) throw Error('offramp_unconfigured');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
  const deadline = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  try {
    const response = await withSignal(() => fetchImpl(
      `https://api-sb.meld.io/network-partner/supported/routes/CRYPTO_OFFRAMP/${input.country}/USDT_POLYGON/${input.destinationCurrencyCode}`,
      { method: 'GET', redirect: 'error', signal: deadline,
        headers: { Authorization: `BASIC ${key}`, Accept: 'application/json', 'Meld-Version': '2026-02-03' } }), deadline);
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw Error('offramp_provider_unavailable'); }
    let routes: Route[];
    try { routes = administrativeOfframpRoutes(await responseJson(response, deadline), input.destinationCurrencyCode); }
    catch { throw Error('offramp_provider_unavailable'); }
    return { flow: 'offramp' as const, walletKind: 'administrative' as const, environment: 'sandbox' as const,
      asset: 'USDT' as const, network: 'polygon' as const, chainId: 137 as const,
      country: input.country, destinationCurrencyCode: input.destinationCurrencyCode, routes,
      execution: { canCreateSession: false as const, canTransfer: false as const, reason: 'discovery_only' as const } };
  } finally { clearTimeout(timer); }
}
