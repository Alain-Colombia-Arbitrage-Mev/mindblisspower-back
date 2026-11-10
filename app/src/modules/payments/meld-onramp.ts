import { z } from 'zod';

export const MELD_ONRAMP_ASSET = 'USDT' as const;
export const MELD_ONRAMP_CRYPTO = 'USDT_POLYGON' as const;
export const MELD_ONRAMP_NETWORK = 'POLYGON' as const;
export const MELD_ONRAMP_MINIMUM_USD = 50;

const ALLOWED_PROVIDERS = new Set(['TOPPER', 'SWAPPED']);
const countryInput = z.string().regex(/^[A-Z]{2}$/);
const paymentMethodInput = z.string().regex(/^[A-Z0-9_]{2,40}$/);
const providerInput = z.string().regex(/^[A-Z0-9_]{2,40}$/);
const addressInput = z.string().regex(/^0x[0-9a-f]{40}$/i);

export const availabilityInput = z.object({
  country: countryInput,
  fiat: z.literal('USD'),
  crypto: z.literal(MELD_ONRAMP_CRYPTO),
}).strict();

export const quoteInput = availabilityInput.extend({
  amount: z.number().finite().min(MELD_ONRAMP_MINIMUM_USD).max(25_000),
  paymentMethodType: paymentMethodInput.optional(),
  walletAddress: addressInput.optional(),
}).strict();

type MeldEnvironment = Record<string, string | undefined>;
type AvailabilityInput = z.infer<typeof availabilityInput>;
type QuoteInput = z.infer<typeof quoteInput>;
type RouteMethod = { code: string; type: string; minimum: number | null; maximum: number | null };
type SafeQuote = {
  serviceProvider: string;
  paymentMethodType: string;
  sourceAmount: number;
  destinationAmount: number;
  totalFee: number;
  transactionFee: number;
  networkFee: number;
  partnerFee: number;
  rampScore: number;
};
type QuoteResult =
  | { available: false; reason: 'no_valid_quotes' }
  | { available: true; quote: SafeQuote; quotes: SafeQuote[] };
type Discovery = {
  available: boolean;
  country: string;
  fiat: 'USD';
  crypto: typeof MELD_ONRAMP_CRYPTO;
  asset: typeof MELD_ONRAMP_ASSET;
  network: typeof MELD_ONRAMP_NETWORK;
  paymentMethods: RouteMethod[];
  providers: string[];
};

function meldConfiguration(environment: MeldEnvironment = process.env) {
  const productionKey = environment.MELD_API_KEY?.trim();
  const sandboxKey = environment.MELD_API_SANDBOX?.trim();
  const key = productionKey || sandboxKey;
  if (!key || key.length > 2048 || /[\r\n]/.test(key)) throw new Error('meld_onramp_unconfigured');
  return { key, baseUrl: productionKey ? 'https://api.meld.io' : 'https://api-sb.meld.io' };
}

function headers(key: string) {
  return {
    Accept: 'application/json',
    Authorization: `BASIC ${key}`,
    'Content-Type': 'application/json',
    'Meld-Version': '2026-02-03',
  };
}

async function responseJson(response: Response) {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > 512_000) throw new Error('meld_onramp_unavailable');
  return response.json().catch(() => ({}));
}

function canonicalPaymentMethod(value: string) {
  if (['CARD', 'VISA', 'MASTERCARD'].includes(value)) return 'CREDIT_DEBIT_CARD';
  return value;
}

function finiteLimit(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseRouteMethod(item: unknown): RouteMethod[] {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
  const value = item as Record<string, unknown>;
  const type = typeof value.paymentType === 'string' ? value.paymentType
    : typeof value.paymentMethodType === 'string' ? value.paymentMethodType
      : typeof value.type === 'string' ? value.type : '';
  const name = typeof value.name === 'string' ? value.name
    : typeof value.paymentMethodSubType === 'string' ? value.paymentMethodSubType
      : typeof value.subType === 'string' ? value.subType : '';
  const parsedCode = paymentMethodInput.safeParse(canonicalPaymentMethod(name || type));
  if (!parsedCode.success) return [];
  const limits = value.limits && typeof value.limits === 'object' && !Array.isArray(value.limits)
    ? value.limits as Record<string, unknown> : {};
  const minimum = finiteLimit(value.min) ?? finiteLimit(value.minimum) ?? finiteLimit(limits.min);
  const maximum = finiteLimit(value.max) ?? finiteLimit(value.maximum) ?? finiteLimit(limits.max);
  const parsedType = paymentMethodInput.safeParse(type);
  return [{ code: parsedCode.data, type: parsedType.success ? parsedType.data : parsedCode.data, minimum, maximum }];
}

function mergeRouteMethods(methods: RouteMethod[]) {
  const merged = new Map<string, RouteMethod>();
  for (const method of methods) {
    const current = merged.get(method.code);
    if (!current) {
      merged.set(method.code, method);
      continue;
    }
    merged.set(method.code, {
      code: current.code,
      type: current.type,
      minimum: current.minimum === null ? method.minimum
        : method.minimum === null ? current.minimum : Math.min(current.minimum, method.minimum),
      maximum: current.maximum === null ? method.maximum
        : method.maximum === null ? current.maximum : Math.max(current.maximum, method.maximum),
    });
  }
  return [...merged.values()].slice(0, 20);
}

async function discoverMeldOnramp(
  input: AvailabilityInput,
  { environment = process.env, fetchImpl = fetch }: { environment?: MeldEnvironment; fetchImpl?: typeof fetch } = {},
): Promise<Discovery> {
  const config = meldConfiguration(environment);
  const countryQuery = new URLSearchParams({
    category: 'CRYPTO_ONRAMP', country: input.country, fiatCurrency: input.fiat, cryptoCurrency: input.crypto,
  });
  const routePath = `/network-partner/supported/routes/CRYPTO_ONRAMP/${input.country}/${input.fiat}/${input.crypto}`;
  const [countryResponse, routeResponse] = await Promise.all([
    fetchImpl(`${config.baseUrl}/network-partner/supported/countries?${countryQuery}`, {
      method: 'GET', headers: headers(config.key), redirect: 'error', signal: AbortSignal.timeout(8_000),
    }),
    fetchImpl(`${config.baseUrl}${routePath}`, {
      method: 'GET', headers: headers(config.key), redirect: 'error', signal: AbortSignal.timeout(8_000),
    }),
  ]);
  const [countryData, routeData] = await Promise.all([responseJson(countryResponse), responseJson(routeResponse)]);
  if ([400, 404].includes(countryResponse.status) || [400, 404].includes(routeResponse.status)) {
    return { available: false, country: input.country, fiat: input.fiat, crypto: input.crypto,
      asset: MELD_ONRAMP_ASSET, network: MELD_ONRAMP_NETWORK, paymentMethods: [], providers: [] };
  }
  if (!countryResponse.ok || !routeResponse.ok) throw new Error('meld_onramp_unavailable');
  const countries = countryData && typeof countryData === 'object' && !Array.isArray(countryData)
    && Array.isArray((countryData as { countries?: unknown }).countries)
    ? (countryData as { countries: unknown[] }).countries : [];
  const countrySupported = countries.some(item => item && typeof item === 'object' && !Array.isArray(item)
    && (item as { countryCode?: unknown }).countryCode === input.country);
  if (!countrySupported) {
    return { available: false, country: input.country, fiat: input.fiat, crypto: input.crypto,
      asset: MELD_ONRAMP_ASSET, network: MELD_ONRAMP_NETWORK, paymentMethods: [], providers: [] };
  }
  const routes = Array.isArray(routeData) ? routeData
    : routeData && typeof routeData === 'object' && !Array.isArray(routeData)
      && Array.isArray((routeData as { routes?: unknown }).routes) ? (routeData as { routes: unknown[] }).routes : [];
  const providers: string[] = [];
  const methods: RouteMethod[] = [];
  for (const item of routes.slice(0, 100)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const route = item as Record<string, unknown>;
    const parsedProvider = providerInput.safeParse(route.partner);
    if (!parsedProvider.success || !ALLOWED_PROVIDERS.has(parsedProvider.data)) continue;
    if (!providers.includes(parsedProvider.data)) providers.push(parsedProvider.data);
    if (!Array.isArray(route.paymentMethods)) continue;
    methods.push(...route.paymentMethods.flatMap(parseRouteMethod));
  }
  const paymentMethods = mergeRouteMethods(methods);
  return { available: providers.length > 0 && paymentMethods.length > 0, country: input.country, fiat: input.fiat,
    crypto: input.crypto, asset: MELD_ONRAMP_ASSET, network: MELD_ONRAMP_NETWORK, paymentMethods, providers };
}

export async function readMeldOnrampAvailability(
  rawInput: unknown,
  options: { environment?: MeldEnvironment; fetchImpl?: typeof fetch } = {},
) {
  const input = availabilityInput.parse(rawInput);
  const discovery = await discoverMeldOnramp(input, options);
  const { providers: _providers, ...safe } = discovery;
  return safe;
}

function unavailable() {
  return { available: false, reason: 'no_valid_quotes' as const } satisfies QuoteResult;
}

function safeNumber(value: unknown, fallback: number | null = null) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export async function createMeldOnrampQuote(
  rawInput: unknown,
  options: { environment?: MeldEnvironment; fetchImpl?: typeof fetch } = {},
): Promise<QuoteResult> {
  const input: QuoteInput = quoteInput.parse(rawInput);
  const discovery = await discoverMeldOnramp(input, options);
  if (!discovery.available) return unavailable();
  const selectedMethod = input.paymentMethodType ? canonicalPaymentMethod(input.paymentMethodType) : '';
  const eligibleMethods = discovery.paymentMethods.filter(method => (!selectedMethod || method.code === selectedMethod)
    && (method.minimum === null || input.amount >= Math.max(MELD_ONRAMP_MINIMUM_USD, method.minimum))
    && (method.maximum === null || input.amount <= method.maximum));
  if (!eligibleMethods.length) return unavailable();

  const config = meldConfiguration(options.environment);
  const response = await (options.fetchImpl || fetch)(`${config.baseUrl}/payments/crypto/quote?includeSwap=false`, {
    method: 'POST', headers: headers(config.key), redirect: 'error', signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      countryCode: input.country,
      sourceCurrencyCode: input.fiat,
      destinationCurrencyCode: input.crypto,
      sourceAmount: input.amount,
      serviceProviders: discovery.providers,
      ...(selectedMethod ? { paymentMethodType: selectedMethod } : {}),
      ...(input.walletAddress ? { walletAddress: input.walletAddress } : {}),
    }),
  });
  const data = await responseJson(response);
  if ([400, 408, 409, 422].includes(response.status)) return unavailable();
  if (!response.ok || !data || typeof data !== 'object' || Array.isArray(data)) throw new Error('meld_onramp_unavailable');
  const quotes = Array.isArray((data as { quotes?: unknown }).quotes) ? (data as { quotes: unknown[] }).quotes : [];
  const allowedProviders = new Set(discovery.providers);
  const allowedMethods = new Set(eligibleMethods.map(method => method.code));
  const safeQuotes: SafeQuote[] = quotes.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const quote = item as Record<string, unknown>;
    const provider = providerInput.safeParse(quote.serviceProvider);
    const rawMethod = typeof quote.paymentMethodType === 'string' ? quote.paymentMethodType : '';
    const method = paymentMethodInput.safeParse(canonicalPaymentMethod(rawMethod));
    const sourceAmount = safeNumber(quote.sourceAmount);
    const destinationAmount = safeNumber(quote.destinationAmount);
    if (!provider.success || !allowedProviders.has(provider.data) || !ALLOWED_PROVIDERS.has(provider.data)
      || !method.success || !allowedMethods.has(method.data) || sourceAmount === null || destinationAmount === null
      || destinationAmount <= 0 || (typeof quote.destinationCurrencyCode === 'string' && quote.destinationCurrencyCode !== input.crypto)) return [];
    return [{
      serviceProvider: provider.data,
      paymentMethodType: method.data,
      sourceAmount,
      destinationAmount,
      totalFee: safeNumber(quote.totalFee, 0)!,
      transactionFee: safeNumber(quote.transactionFee, 0)!,
      networkFee: safeNumber(quote.networkFee, 0)!,
      partnerFee: safeNumber(quote.partnerFee, 0)!,
      rampScore: safeNumber((quote.rampIntelligence as { rampScore?: unknown } | undefined)?.rampScore, 0)!,
    }];
  });
  safeQuotes.sort((left, right) => right.rampScore - left.rampScore
    || right.destinationAmount - left.destinationAmount || left.totalFee - right.totalFee);
  const bestByMethod = [...new Map(safeQuotes.map(quote => [quote.paymentMethodType, quote])).values()];
  return bestByMethod[0] ? { available: true as const, quote: bestByMethod[0], quotes: bestByMethod } : unavailable();
}
