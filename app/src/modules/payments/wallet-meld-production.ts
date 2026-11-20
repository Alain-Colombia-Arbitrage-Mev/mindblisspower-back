import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SandboxWalletDatabase, SandboxWalletEnvironment, SandboxWalletPrincipal } from '../identity/sandbox-wallet';
import { createAdministrativePreflightGate } from './wallet-funding';
import { productionMeldJson, productionOperation, productionScope } from './wallet-meld-production-http';
import { recordWalletWidgetDiagnostic, type WalletWidgetStage } from './wallet-production-diagnostic';
import coverageSnapshot from './wallet-production-coverage-data.json';
import { resolveProductionCoverage, coverageCountries, coverageCurrencies, coverageMinorUnits, coverageMethodsByProvider,
  intersectProductionCoverage, assertProductionCoverageSelection, coverageAsset, productionAsset, productionAssetAllowed,
  isUsBankFunding, isUsRampNowFunding, rampNowAsset, rampNowAssets, rampNowPaymentMode, productionAssetDetails, productionCheckoutProviders,
  type ProductionAsset, type ProductionRoute } from './wallet-production-coverage';
import { verifyRampNowDelivery, transactionHash } from './wallet-rampnow-delivery';

const uuid = z.string().uuid().transform(value => value.toLowerCase()), country = z.string().regex(/^[A-Z]{2}$/), currency = z.string().regex(/^[A-Z]{3}$/);
const identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).refine(value => value !== '.' && value !== '..');
const token = z.string().regex(/^[A-Z0-9_]{2,64}$/), address = z.string().regex(/^0x[0-9a-f]{40}$/).refine(value => value !== `0x${'0'.repeat(40)}`);
const preciseAmount = z.number().finite().min(0.01).max(1_000_000_000)
  .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001);
// Existing attempts retain their original provider when reading history or evidence.
const recordedProviders = new Set([...productionCheckoutProviders, 'BLOCKCHAINDOTCOM', 'BTCDIRECT', 'GUARDARIAN',
  'KOYWE', 'KRYPTONIM', 'ROBINHOOD', 'STRIPE', 'TOPPER', 'TRANSAK', 'UNLIMIT']);
const provider = token.refine(value => recordedProviders.has(value));
export const productionWalletOptionsInput = z.object({ country, sourceCurrencyCode: currency }).strict();
const recordedFundingInput = z.object({ requestId: uuid, country, sourceCurrencyCode: currency, amount: preciseAmount,
  paymentMethodType: token, serviceProvider: provider }).strict()
  .refine(value => value.sourceCurrencyCode !== 'USD' || (value.amount >= 50 && value.amount <= 25000));
const quoteFields = { country, sourceCurrencyCode: currency, amount: preciseAmount, paymentMethodType: token, destinationCurrencyCode: rampNowAsset.optional() };
const quoteSchema = z.object(quoteFields).strict();
type FundingSelection = z.infer<typeof quoteSchema>;
const allowsSelection = (value: FundingSelection) =>
  (value.sourceCurrencyCode !== 'USD' || (value.amount >= 50 && value.amount <= 25000))
  && (value.destinationCurrencyCode === undefined || isUsRampNowFunding(value.country, value.sourceCurrencyCode, value.paymentMethodType));
export const productionWalletQuoteInput = quoteSchema.refine(allowsSelection);
export const productionWalletFundingInput = z.object({ ...quoteFields, requestId: uuid, serviceProvider: provider }).strict()
  .refine(value => allowsSelection(value) && productionCheckoutProviders.has(value.serviceProvider)
    && (value.serviceProvider === 'RAMPNOW' ? value.destinationCurrencyCode !== undefined
      : value.destinationCurrencyCode === undefined
        || (value.serviceProvider === 'ONRAMPMONEY' && value.destinationCurrencyCode === 'USDC_POLYGON'
          && isUsBankFunding(value.country, value.sourceCurrencyCode, value.paymentMethodType))));
type Dependencies = { environment?: SandboxWalletEnvironment; fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number; catalogue?: unknown };
export function productionWalletConfiguration(environment: SandboxWalletEnvironment) {
  const key = environment.MELD_PRODUCTION_API_KEYS, account = environment.MELD_PRODUCTION_ACCOUNT_ID;
  if (environment.WALLET_MELD_PRODUCTION_ENABLED !== 'true' || !key || !/^[\x21-\x7e]{1,2048}$/.test(key)
    || !account || !/^[A-Za-z0-9_-]{1,128}$/.test(account)) throw Error('wallet_production_unconfigured');
  return { key, account };
}
export function productionWalletCapabilities(environment: SandboxWalletEnvironment = process.env) {
  let configured = false; try { productionWalletConfiguration(environment); configured = true; } catch { /* No configuration metadata. */ }
  return { flow: 'wallet_funding' as const, configured, environment: 'production' as const, asset: 'USDT' as const,
    network: 'polygon' as const, chainId: 137 as const, canBroadcast: false as const };
}
const one = (rows: unknown[]) => { if (rows.length !== 1) throw Error('wallet_production_unavailable'); return rows[0]; };
const destination = (value: string, asset: ProductionAsset) => ({ address: value, ...productionAssetDetails[asset] });
type Route = ProductionRoute;
export function normalizeProductionWalletRoutes(raw: unknown, sourceCurrencyCode: string, countryCode?: string,
  asset: ProductionAsset = 'USDT_POLYGON', methodsByProvider?: ReadonlyMap<string, ReadonlySet<string>>): Route[] {
  if (!Array.isArray(raw) || raw.length > 256) throw Error('wallet_production_provider_unavailable');
  const routes = new Map<string, Route>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw Error('wallet_production_provider_unavailable');
    const value = item as Record<string, unknown>;
    if (typeof value.partner !== 'string' || !productionCheckoutProviders.has(value.partner) || value.checkoutSupported === false) continue;
    const allowedMethods = methodsByProvider?.get(value.partner);
    if (methodsByProvider && !allowedMethods) continue;
    if (value.source !== sourceCurrencyCode || value.destination !== asset || !Array.isArray(value.paymentMethods)
      || value.paymentMethods.length > 128) throw Error('wallet_production_provider_unavailable');
    let result = routes.get(value.partner); if (!result) { result = { serviceProvider: value.partner, paymentMethods: [] }; routes.set(value.partner, result); }
    for (const rawMethod of value.paymentMethods) {
      if (allowedMethods && !allowedMethods.has(rawMethod?.name)) continue;
      if (typeof rawMethod?.category === 'string' && rawMethod.category !== 'CRYPTO_ONRAMP') continue;
      const parsed = z.object({ name: token, checkoutSupported: z.boolean().optional(), limits: z.object({ currencyCode: currency,
        min: z.number().finite().nonnegative(), max: z.number().finite().positive().max(1_000_000_000) }).nullish() }).safeParse(rawMethod);
      if (!parsed.success) throw Error('wallet_production_provider_unavailable'); const method = parsed.data;
      // New preparations only: the live Banxa MX/MXN/SPEI checkout displayed
      // USD for an MXN request. Historical destinations and proofs stay valid.
      if (countryCode === 'MX' && sourceCurrencyCode === 'MXN' && value.partner === 'BANXA' && method.name === 'SPEI') continue;
      if (method.checkoutSupported === false || !method.limits) continue;
      const limit = method.limits; if (limit.currencyCode !== sourceCurrencyCode || limit.max < limit.min) throw Error('wallet_production_provider_unavailable');
      const minimumAmount = Math.max(limit.min, sourceCurrencyCode === 'USD' ? 50 : 0.01);
      const maximumAmount = Math.min(limit.max, sourceCurrencyCode === 'USD' ? 25000 : 1_000_000_000);
      const prior = result.paymentMethods.find(entry => entry.method === method.name);
      if (prior) {
        prior.minimumAmount = Math.max(prior.minimumAmount, minimumAmount);
        prior.maximumAmount = Math.min(prior.maximumAmount, maximumAmount);
      } else result.paymentMethods.push({ method: method.name, currencyCode: sourceCurrencyCode, minimumAmount, maximumAmount });
    }
  }
  return [...routes.values()].map(route => ({ ...route,
    paymentMethods: route.paymentMethods.filter(method => method.minimumAmount <= method.maximumAmount),
  })).filter(route => route.paymentMethods.length);
}
export async function readProductionWalletOptions(raw: unknown, { environment = process.env, fetchImpl = fetch, signal, timeoutMs, catalogue = coverageSnapshot }: Dependencies = {},
  selectedAsset?: ProductionAsset) {
  const config = productionWalletConfiguration(environment), input = productionWalletOptionsInput.parse(raw);
  const coverage = resolveProductionCoverage(environment, catalogue), scope = productionScope(signal, timeoutMs);
  const destinationCurrencyCode = selectedAsset ?? coverageAsset(coverage, input.country, input.sourceCurrencyCode);
  const load = async (asset: ProductionAsset) => {
    const methodsByProvider = coverageMethodsByProvider(coverage, input.country, input.sourceCurrencyCode, asset);
    if (!methodsByProvider.size) return [];
    const query = new URLSearchParams({ partners: [...methodsByProvider.keys()].join(','), checkout: 'true' });
    const result = await productionMeldJson(`/network-partner/supported/routes/CRYPTO_ONRAMP/${input.country}/${input.sourceCurrencyCode}/${asset}?${query}`,
      { ...config, fetchImpl, signal: scope.signal });
    if (!result.ok && ![400, 404].includes(result.status)) throw Error('wallet_production_provider_unavailable');
    return result.ok ? intersectProductionCoverage(normalizeProductionWalletRoutes(result.data, input.sourceCurrencyCode, input.country, asset, methodsByProvider),
      coverage, input.country, input.sourceCurrencyCode, asset) : [];
  };
  try {
    const discoverNetworks = !selectedAsset && input.country === 'US' && input.sourceCurrencyCode === 'USD' && destinationCurrencyCode === 'USDC_POLYGON';
    const alternatives = discoverNetworks ? rampNowAssets.filter(asset => asset !== destinationCurrencyCode) : [];
    const [routes, ...networkRoutes] = await Promise.all([load(destinationCurrencyCode), ...alternatives.map(asset => load(asset).catch(() => []))]);
    if (scope.signal.aborted) throw Error('wallet_production_unavailable');
    if (discoverNetworks) {
      const primary = routes.find(route => route.serviceProvider === 'RAMPNOW');
      const rails = primary?.paymentMethods ?? [];
      for (const rail of rails) rail.destinationCurrencyCodes = [destinationCurrencyCode];
      for (const [index, asset] of alternatives.entries()) {
        const candidates = networkRoutes[index]?.find(route => route.serviceProvider === 'RAMPNOW')?.paymentMethods ?? [];
        for (const other of candidates) {
          const rail = rails.find(item => item.method === other.method);
          if (!rail) {
            rails.push({ ...other, destinationCurrencyCodes: [asset] });
            continue;
          }
          const minimum = Math.max(rail.minimumAmount, other.minimumAmount), maximum = Math.min(rail.maximumAmount, other.maximumAmount);
          if (minimum <= maximum) {
            rail.minimumAmount = minimum;
            rail.maximumAmount = maximum;
            rail.destinationCurrencyCodes!.push(asset);
          }
        }
      }
      if (!primary && rails.length) routes.push({ serviceProvider: 'RAMPNOW', paymentMethods: rails });
    }
    return { environment: 'production' as const, country: input.country, sourceCurrencyCode: input.sourceCurrencyCode, destinationCurrencyCode,
      paymentMethods: [...new Set(routes.flatMap(route => route.paymentMethods.map(method => method.method)))], routes };
  } finally { scope.close(); }
}
export async function readProductionWalletDiscovery(rawCountry: string | undefined, { environment = process.env, fetchImpl = fetch, signal, timeoutMs, catalogue = coverageSnapshot }: Dependencies = {}) {
  const config = productionWalletConfiguration(environment), coverage = resolveProductionCoverage(environment, catalogue), scope = productionScope(signal, timeoutMs);
  try {
    if (rawCountry === undefined) {
      const query = new URLSearchParams({ category: 'CRYPTO_ONRAMP', partners: [...productionCheckoutProviders].join(',') });
      const result = await productionMeldJson(`/network-partner/supported/countries?${query}`, { ...config, fetchImpl, signal: scope.signal });
      const parsed = z.object({ countries: z.array(z.object({ countryCode: country, name: z.string().min(1).max(120) })).max(300) }).safeParse(result.data);
      if (!result.ok || !parsed.success || new Set(parsed.data.countries.map(item => item.countryCode)).size !== parsed.data.countries.length) throw Error('wallet_production_provider_unavailable');
      const eligibleCountries = coverageCountries(coverage);
      return { countries: parsed.data.countries.filter(item => eligibleCountries.has(item.countryCode)).map(item => ({ code: item.countryCode, name: item.name })) };
    }
    const selected = country.parse(rawCountry), eligibleCurrencies = coverageCurrencies(coverage, selected);
    if (!eligibleCurrencies.size) return { country: selected, currencies: [], defaultCurrencyCode: null };
    const query = new URLSearchParams({ category: 'CRYPTO_ONRAMP', country: selected, type: 'FIAT' });
    const result = await productionMeldJson(`/network-partner/supported/currencies?${query}`, { ...config, fetchImpl, signal: scope.signal });
    const parsed = z.object({ currencies: z.array(z.object({ currencyCode: currency, name: z.string().min(1).max(120),
      decimalPlaces: z.number().int().min(0).max(18), type: z.literal('FIAT') })).max(200) }).safeParse(result.data);
    if (!result.ok || !parsed.success || new Set(parsed.data.currencies.map(item => item.currencyCode)).size !== parsed.data.currencies.length) throw Error('wallet_production_provider_unavailable');
    // Defaults are suggestions, never an implicit country or an invented rate.
    const defaults = await productionMeldJson(`/network-partner/defaults/${selected}/CRYPTO_ONRAMP`, { ...config, fetchImpl, signal: scope.signal });
    const list = parsed.data.currencies.filter(item => eligibleCurrencies.has(item.currencyCode)
      && item.decimalPlaces === coverageMinorUnits(coverage, selected, item.currencyCode))
      .map(item => ({ code: item.currencyCode, name: item.name, decimalPlaces: item.decimalPlaces }));
    const defaultValue = defaults.ok && defaults.data && typeof defaults.data === 'object' ? (defaults.data as Record<string, unknown>).currencyCode : undefined;
    return { country: selected, currencies: list, defaultCurrencyCode: typeof defaultValue === 'string' && list.some(item => item.code === defaultValue)
      ? defaultValue : list.length === 1 ? list[0]!.code : null };
  } finally { scope.close(); }
}
export function productionWalletReturnUrl(reference: string) {
  return `https://wallet.mindblisspower.com/dashboard/wallet-administrative?walletCheckoutReference=${uuid.parse(reference)}`;
}
export function productionWalletCheckoutUrl(value: unknown, serviceProvider: string) {
  if (!productionCheckoutProviders.has(serviceProvider) || typeof value !== 'string' || value.length > 8192 || /[\\\u0000-\u0020\u007f]/.test(value) || value.includes('#')) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.port || url.hash || url.protocol !== 'https:') return null;
    if (url.origin === 'https://meldcrypto.com' && url.pathname === '/' && url.searchParams.size === 1 && url.searchParams.getAll('token').length === 1
      && /^https:\/\/meldcrypto\.com\/?\?token=[A-Za-z0-9_.~-]{1,7000}$/.test(value)) return url.href;
    if (serviceProvider === 'BANXA' && url.origin === 'https://meldshared.banxa.com' && url.pathname === '/papi/transit/'
      && value.startsWith('https://meldshared.banxa.com/papi/transit/?initId=') && url.searchParams.size === 1
      && url.searchParams.getAll('initId').length === 1 && /^[A-Za-z0-9._~+/-]{1,4096}={0,2}$/.test(url.searchParams.get('initId') || '')) return value;
  } catch { /* Never open an unknown provider or a sandbox host. */ }
  return null;
}

function onrampUsdcPrefill(value: string | null | undefined, input: z.infer<typeof productionWalletFundingInput>, walletAddress: string, redirectUrl: string) {
  if (!value) return false;
  try {
    const url = new URL(value), params = url.searchParams;
    const fiatTypes: Record<string, string> = { MXN: '4', COP: '9', USD: '21' };
    const fiatType = fiatTypes[input.sourceCurrencyCode];
    if (!fiatType) return false;
    const expected = {
      coinCode: 'usdc', network: 'matic20', walletAddress,
      fiatAmount: input.amount.toFixed(2), fiatType,
      paymentMethod: input.paymentMethodType === 'LOCAL_BANK_TRANSFER' ? '1' : '2', redirectUrl,
    };
    return url.origin === 'https://onramp.money' && !url.username && !url.password && !url.hash && url.pathname === '/main/buy/'
      && Object.entries(expected).every(([key, value]) => params.getAll(key).length === 1 && params.get(key) === value);
  } catch { return false; }
}

function alchemyPayArbitrumPrefill(value: string | null | undefined, input: z.infer<typeof productionWalletFundingInput>, walletAddress: string, redirectUrl: string) {
  if (!value || !productionAssetAllowed('USDC_ARBITRUM', input.country, input.sourceCurrencyCode, input.serviceProvider, input.paymentMethodType)) return false;
  try {
    const url = new URL(value), params = url.searchParams;
    const expected = { address: walletAddress, country: 'MX', fiat: 'EUR', fiatAmount: input.amount.toFixed(2),
      crypto: 'USDC', network: 'ARBITRUM', showTable: 'buy', redirectUrl };
    const callback = new URL(params.get('callbackUrl') || '');
    return url.origin === 'https://ramp.alchemypay.org' && url.pathname === '/' && !url.username && !url.password && !url.hash
      && [...params.keys()].every(key => params.getAll(key).length === 1)
      && Object.entries(expected).every(([key, value]) => params.get(key) === value)
      && callback.origin === 'https://api.meld.io' && /^\/webhooks\/alchemypay\/[A-Za-z0-9_-]{1,128}$/.test(callback.pathname)
      && !callback.username && !callback.password && !callback.search && !callback.hash
      && /^[A-Za-z0-9_-]{1,128}$/.test(params.get('appId') || '')
      && /^[A-Za-z0-9_-]{1,128}$/.test(params.get('merchantOrderNo') || '')
      && /^\d{13}$/.test(params.get('timestamp') || '')
      && /^[A-Za-z0-9+/]{43}=$/.test(params.get('sign') || '')
      // The hosted Alchemy screen can offer a different method even when MELD quoted card.
      && params.get('payWayCode') === '10001';
  } catch { return false; }
}

export function rampNowPrefill(value: string | null | undefined, asset: ProductionAsset, amount: number, method: string, walletAddress: string, redirectUrl: string, sessionId: string) {
  const paymentMode = rampNowPaymentMode(method);
  if (!value || !paymentMode || !rampNowAsset.safeParse(asset).success) return false;
  try {
    const url = new URL(value), params = url.searchParams;
    const expected = { orderType: 'buy', srcCurrency: 'USD', srcChain: 'fiat', srcAmount: amount.toFixed(2),
      dstCurrency: 'USDC', dstChain: asset === 'USDC_ARBITRUM' ? 'arbitrum-one' : productionAssetDetails[asset].network,
      walletAddress, prefill: 'true', paymentMode, returnUrl: redirectUrl, externalOrderId: sessionId };
    return url.origin === 'https://app.rampnow.io' && url.pathname === '/order/quote' && !url.username && !url.password && !url.hash
      && [...params.keys()].every(key => params.getAll(key).length === 1)
      && Object.entries(expected).every(([key, expectedValue]) => params.get(key) === expectedValue)
      && params.get('lockFields')?.split(',').includes('walletAddress') === true;
  } catch { return false; }
}

const createRow = z.object({ id: uuid, address, customer_reference: uuid, created: z.boolean(),
  status: z.enum(['initiated', 'session_created', 'unavailable']), created_at: z.coerce.date() });
const gates = new WeakMap<SandboxWalletDatabase, ReturnType<typeof createAdministrativePreflightGate>>();
function acquire(database: SandboxWalletDatabase, subject: string, id: string) {
  let gate = gates.get(database); if (!gate) { gate = createAdministrativePreflightGate(); gates.set(database, gate); } return gate(subject, id);
}
function assertQuote(raw: unknown, input: z.infer<typeof productionWalletFundingInput>, walletAddress: string, account: string, asset: ProductionAsset) {
  const parsed = z.object({ quotes: z.array(z.object({ serviceProvider: token, sourceCurrencyCode: currency, sourceAmount: preciseAmount,
    destinationCurrencyCode: z.literal(asset), destinationAmount: z.number().finite().positive(), paymentMethodType: token,
    totalFee: z.number().finite().nonnegative(), networkFee: z.number().finite().nonnegative(),
    rampIntelligence: z.object({ rampScore: z.number().finite().nullish() }).nullish(),
    transactionType: z.literal('CRYPTO_PURCHASE'), countryCode: country.optional(), accountId: identifier.optional(), walletAddress: z.string().optional() })).length(1) }).safeParse(raw);
  const item = parsed.success ? parsed.data.quotes[0] : null;
  if (!item || item.serviceProvider !== input.serviceProvider || item.sourceCurrencyCode !== input.sourceCurrencyCode || item.sourceAmount !== input.amount
    || item.paymentMethodType !== input.paymentMethodType || (item.countryCode !== undefined && item.countryCode !== input.country)
    || (item.accountId !== undefined && item.accountId !== account) || (item.walletAddress !== undefined && item.walletAddress.toLowerCase() !== walletAddress)) throw Error('wallet_production_provider_unavailable');
  return { serviceProvider: item.serviceProvider, sourceAmount: item.sourceAmount, destinationAmount: item.destinationAmount,
    totalFee: item.totalFee, networkFee: item.networkFee, sourceCurrencyCode: item.sourceCurrencyCode, destinationCurrencyCode: item.destinationCurrencyCode,
    ...(typeof item.rampIntelligence?.rampScore === 'number' ? { rampScore: item.rampIntelligence.rampScore } : {}) };
}
async function readDepositBinding(database: SandboxWalletDatabase, principal: SandboxWalletPrincipal, signal: AbortSignal) {
  const parsed = z.object({ address, binding_reference: uuid }).safeParse(one(await productionOperation(() => database.execute(sql`SELECT * FROM identity.read_wallet_meld_production_binding(
    ${principal.subject},${principal.nativeSessionId})`), signal)));
  if (!parsed.success) throw Error('wallet_production_verification_required'); return parsed.data;
}
const quoteGates = new WeakMap<SandboxWalletDatabase, ReturnType<typeof createAdministrativePreflightGate>>();
/** Manual quote discovery. Each candidate is requested at most once and failed
 * candidates are removed; an available route is never presented as a quote. */
export async function quoteProductionWalletFunding(database: SandboxWalletDatabase, raw: unknown,
  { subject, nativeSessionId, clientIp, environment = process.env, fetchImpl = fetch, signal, timeoutMs, catalogue = coverageSnapshot }: SandboxWalletPrincipal & Dependencies & { clientIp: string }) {
  const config = productionWalletConfiguration(environment), input = productionWalletQuoteInput.parse(raw);
  if (!isIP(clientIp)) throw Error('wallet_production_unconfigured');
  assertProductionCoverageSelection(resolveProductionCoverage(environment, catalogue), input);
  let gate = quoteGates.get(database); if (!gate) { gate = createAdministrativePreflightGate(); quoteGates.set(database, gate); }
  const release = gate(subject, randomUUID()), scope = productionScope(signal, timeoutMs);
  try {
    const binding = await readDepositBinding(database, { subject, nativeSessionId }, scope.signal);
    const options = await readProductionWalletOptions({ country: input.country, sourceCurrencyCode: input.sourceCurrencyCode },
      { environment, fetchImpl, signal: scope.signal, catalogue }, input.destinationCurrencyCode);
    const asset = options.destinationCurrencyCode;
    const matching = options.routes.filter(route => route.paymentMethods.some(rail => rail.method === input.paymentMethodType));
    if (!matching.length) throw Error('wallet_production_method_unavailable');
    const candidates = matching.filter(route => route.paymentMethods.some(rail => rail.method === input.paymentMethodType
      && input.amount >= rail.minimumAmount && input.amount <= rail.maximumAmount)).slice(0, 4);
    if (!candidates.length) throw Error('wallet_production_amount_unavailable');
    const outcomes = await Promise.all(candidates.map(async route => {
      try {
        const result = await productionMeldJson('/payments/crypto/quote?includeSwap=false', { ...config, fetchImpl, signal: scope.signal,
          body: { countryCode: input.country, sourceCurrencyCode: input.sourceCurrencyCode, sourceAmount: input.amount,
            destinationCurrencyCode: asset, paymentMethodType: input.paymentMethodType, serviceProviders: [route.serviceProvider],
            walletAddress: binding.address, clientIpAddress: clientIp } });
        if (!result.ok) return null;
        return assertQuote(result.data, { ...input, requestId: randomUUID(), serviceProvider: route.serviceProvider }, binding.address, config.account, asset);
      } catch { return null; }
    }));
    if (scope.signal.aborted) throw Error('wallet_production_unavailable');
    const quotes = outcomes.filter(item => item !== null).sort((a, b) => (b.rampScore ?? -Infinity) - (a.rampScore ?? -Infinity));
    if (!quotes.length) throw Error('wallet_production_quote_unavailable');
    return { walletKind: 'personal' as const, environment: 'production' as const, country: input.country, sourceCurrencyCode: input.sourceCurrencyCode,
      requestedAmount: input.amount, paymentMethodType: input.paymentMethodType, destination: destination(binding.address, asset), quotes };
  } finally { scope.close(); release(); }
}
/** Only an explicit user request creates one vendor session; never signs or sends funds. */
export async function createProductionWalletSession(database: SandboxWalletDatabase, raw: unknown,
  { subject, nativeSessionId, clientIp, environment = process.env, fetchImpl = fetch, signal, timeoutMs, catalogue = coverageSnapshot }: SandboxWalletPrincipal & Dependencies & { clientIp: string }) {
  const config = productionWalletConfiguration(environment), input = productionWalletFundingInput.parse(raw);
  if (!isIP(clientIp)) throw Error('wallet_production_unconfigured');
  const coverage = resolveProductionCoverage(environment, catalogue);
  assertProductionCoverageSelection(coverage, input);
  const release = acquire(database, subject, input.requestId), scope = productionScope(signal, timeoutMs);
  try {
    // SQL checks the native session and permanently verified ownership binding;
    // browser-supplied addresses, customer IDs and destinations are not accepted.
    const binding = await readDepositBinding(database, { subject, nativeSessionId }, scope.signal), walletAddress = binding.address;
    const options = await readProductionWalletOptions({ country: input.country, sourceCurrencyCode: input.sourceCurrencyCode },
      { environment, fetchImpl, signal: scope.signal, catalogue }, input.destinationCurrencyCode);
    const asset = options.destinationCurrencyCode;
    const method = options.routes.find(route => route.serviceProvider === input.serviceProvider)?.paymentMethods.find(rail => rail.method === input.paymentMethodType);
    if (!method) throw Error('wallet_production_method_unavailable');
    if (input.amount < method.minimumAmount || input.amount > method.maximumAmount) throw Error('wallet_production_amount_unavailable');
    const quote = await productionMeldJson('/payments/crypto/quote?includeSwap=false', { ...config, fetchImpl, signal: scope.signal,
      body: { countryCode: input.country, sourceCurrencyCode: input.sourceCurrencyCode, sourceAmount: input.amount,
        destinationCurrencyCode: asset, paymentMethodType: input.paymentMethodType, serviceProviders: [input.serviceProvider], walletAddress, clientIpAddress: clientIp } });
    if (!quote.ok) throw Error('wallet_production_provider_unavailable'); assertQuote(quote.data, input, walletAddress, config.account, asset);
    const parsed = createRow.safeParse(one(await productionOperation(() => database.execute(sql`SELECT * FROM payments.create_wallet_meld_production_attempt(
      ${subject},${nativeSessionId},${input.requestId}::uuid,${input.country},${input.amount},${input.sourceCurrencyCode},${input.paymentMethodType},${input.serviceProvider},${config.account},${asset})`), scope.signal)));
    if (!parsed.success) throw Error('wallet_production_unavailable'); const row = parsed.data;
    if (row.id !== input.requestId || row.address !== walletAddress || !row.created || row.status !== 'initiated') throw Error('wallet_production_request_already_used');
    const finish = async (status: 'session_created' | 'unavailable', providerSession: string | null, customer: string | null) => {
      const rows = await productionOperation(() => database.execute(sql`SELECT payments.finish_wallet_meld_production_attempt(
        ${subject},${nativeSessionId},${row.id}::uuid,${status},${providerSession},${customer}) AS finished`), scope.signal);
      if (rows.length !== 1 || (rows[0] as { finished?: unknown }).finished !== true) throw Error('wallet_production_unavailable');
    };
    let finishing = false, stage: WalletWidgetStage = 'widget_transport', upstreamStatus: number | undefined, upstreamBody: unknown;
    try {
      const redirectUrl = productionWalletReturnUrl(row.id);
      const widgetFetch = (async (target: string | Request | URL, init?: RequestInit) => {
        const response = await fetchImpl(target, init); upstreamStatus = response.status; return response;
      }) as unknown as typeof fetch;
      const result = await productionMeldJson('/crypto/session/widget', { ...config, fetchImpl: widgetFetch, signal: scope.signal,
        body: { sessionType: 'BUY', externalSessionId: row.id, externalCustomerId: row.customer_reference,
          sessionData: { serviceProvider: input.serviceProvider, countryCode: input.country, sourceCurrencyCode: input.sourceCurrencyCode,
            sourceAmount: input.amount.toFixed(coverageMinorUnits(coverage, input.country, input.sourceCurrencyCode) ?? 2), destinationCurrencyCode: asset, walletAddress, paymentMethodType: input.paymentMethodType,
            clientIpAddress: clientIp, redirectUrl,
            lockFields: ['walletAddress', 'destinationCurrencyCode', 'sourceCurrencyCode', 'sourceAmount', 'paymentMethodType'] } } });
      stage = 'widget_http'; upstreamBody = result.data;
      if (!result.ok) throw Error('wallet_production_provider_unavailable');
      stage = 'widget_schema';
      const session = z.object({ id: identifier, customerId: identifier, externalSessionId: uuid, externalCustomerId: uuid,
        serviceProvider: token.optional(), serviceProviderWidgetUrl: z.string().max(8192).nullish(), widgetUrl: z.string().max(8192).nullish() }).safeParse(result.data);
      if (!session.success || session.data.externalSessionId !== row.id || session.data.externalCustomerId !== row.customer_reference
        || (session.data.serviceProvider !== undefined && session.data.serviceProvider !== input.serviceProvider)) throw Error('wallet_production_provider_unavailable');
      stage = 'widget_url';
      const hosted = productionWalletCheckoutUrl(session.data.widgetUrl, input.serviceProvider);
      // Only the opaque Meld URL goes to the browser. Verify the provider's
      // prefill separately so a mismapped fiat, network or recipient cannot open.
      const checkoutUrl = input.serviceProvider === 'RAMPNOW'
        ? (rampNowPrefill(session.data.serviceProviderWidgetUrl, asset, input.amount, input.paymentMethodType, walletAddress, redirectUrl, session.data.id) ? hosted : null)
        : asset === 'USDC_POLYGON'
        ? (onrampUsdcPrefill(session.data.serviceProviderWidgetUrl, input, walletAddress, redirectUrl) ? hosted : null)
        : asset === 'USDC_ARBITRUM'
          ? (alchemyPayArbitrumPrefill(session.data.serviceProviderWidgetUrl, input, walletAddress, redirectUrl) ? hosted : null)
          : productionWalletCheckoutUrl(session.data.serviceProviderWidgetUrl, input.serviceProvider) ?? hosted;
      if (!checkoutUrl) throw Error('wallet_production_provider_unavailable');
      finishing = true; stage = 'widget_finish'; await finish('session_created', session.data.id, session.data.customerId);
      return { checkoutReference: row.id, walletKind: 'personal' as const, environment: 'production' as const, provider: 'meld' as const,
        serviceProvider: input.serviceProvider, status: 'session_created' as const, country: input.country, requestedAmount: input.amount, sourceCurrencyCode: input.sourceCurrencyCode,
        destinationCurrencyCode: asset, destination: destination(walletAddress, asset), paymentMethodType: input.paymentMethodType,
        checkoutUrl, createdAt: row.created_at.toISOString() };
    } catch (error) {
      recordWalletWidgetDiagnostic(error, stage, upstreamStatus, upstreamBody);
      if (!finishing && !scope.signal.aborted) { try { await finish('unavailable', null, null); } catch { /* Preserve the original failure and its safe diagnostic. */ } }
      throw error;
    }
  } finally { scope.close(); release(); }
}

const statuses = z.enum(['PENDING_CREATED', 'PENDING', 'PROCESSING', 'AUTHORIZED', 'ACCEPTED', 'PARTIALLY_SETTLED',
  'SETTLING', 'TWO_FA_REQUIRED', 'TWO_FA_PROVIDED', 'ERROR', 'SETTLED', 'FAILED', 'DECLINED', 'CANCELLED', 'REFUNDED', 'VOIDED', 'AUTHORIZATION_EXPIRED']);
const instant = z.string().datetime({ offset: true });
const proofChainId = z.enum(['137', '42161', '1']);
const proofInput = z.object({ transactionId: identifier, accountId: identifier, sessionId: identifier, externalSessionId: uuid,
  externalCustomerId: uuid, serviceProvider: provider, countryCode: country, sourceCurrencyCode: currency, paymentMethodType: token,
  sourceAmount: z.string().regex(/^\d{1,10}\.\d{2}$/), destinationCurrencyCode: productionAsset, walletAddress: address,
  chainId: proofChainId, providerStatus: statuses, providerUpdatedAt: instant,
  receivedAmount: z.string().regex(/^\d{1,12}(?:\.\d{1,6})?$/),
}).strict().refine(value => value.providerStatus !== 'SETTLED' || Number(value.receivedAmount) > 0);
type Confirmation = { state: 'unconfirmed' | 'pending' | 'confirmed' | 'failed'; source: 'none' | 'meld_production_api'; testMode: false;
  receivedAmount?: string; confirmedAt?: string; transactionId?: string; providerStatus?: string };
const unconfirmed = (): Confirmation => ({ state: 'unconfirmed', source: 'none', testMode: false });
const attemptInput = z.object({ id: uuid, subject: z.string().min(1).max(255), address, country_code: country,
  destination_currency: productionAsset,
  source_currency: currency, requested_amount: z.coerce.number().finite().positive().max(1_000_000_000),
  service_provider: provider, payment_method: token, status: z.enum(['initiated', 'session_created', 'unavailable']), created_at: z.coerce.date(),
  customer_reference: uuid, account_id: identifier, provider_session_id: identifier.nullable(), provider_customer_id: identifier.nullable(),
  proof: z.unknown().nullable(), checked_at: z.coerce.date().nullable() });
type Attempt = z.infer<typeof attemptInput>;
function readAttempt(raw: unknown, subject: string) {
  const parsed = attemptInput.safeParse(raw);
  if (!parsed.success || parsed.data.subject !== subject
    || !productionAssetAllowed(parsed.data.destination_currency, parsed.data.country_code, parsed.data.source_currency, parsed.data.service_provider, parsed.data.payment_method)
    || !recordedFundingInput.safeParse({ requestId: parsed.data.id,
    country: parsed.data.country_code, amount: parsed.data.requested_amount, sourceCurrencyCode: parsed.data.source_currency,
    paymentMethodType: parsed.data.payment_method, serviceProvider: parsed.data.service_provider }).success) throw Error('wallet_production_unavailable');
  return parsed.data;
}
function matchesProof(proof: z.infer<typeof proofInput>, row: Attempt) {
  const compatibleAsset = row.service_provider === 'RAMPNOW'
    ? productionAssetAllowed(proof.destinationCurrencyCode, row.country_code, row.source_currency, row.service_provider, row.payment_method)
    : proof.destinationCurrencyCode === row.destination_currency;
  return proof.externalSessionId === row.id && proof.accountId === row.account_id && proof.sessionId === row.provider_session_id
    && proof.externalCustomerId === row.customer_reference && proof.serviceProvider === row.service_provider && proof.countryCode === row.country_code
    && proof.sourceCurrencyCode === row.source_currency && proof.sourceAmount === row.requested_amount.toFixed(2)
    && proof.paymentMethodType === row.payment_method && proof.walletAddress === row.address && compatibleAsset
    && proof.chainId === String(productionAssetDetails[proof.destinationCurrencyCode].chainId);
}
function cachedProof(row: Attempt) {
  if (row.proof === null) return null; const parsed = proofInput.safeParse(row.proof);
  if (!parsed.success || !matchesProof(parsed.data, row)) throw Error('wallet_production_unavailable');
  return parsed.data;
}
function confirmation(proof: z.infer<typeof proofInput> | null): Confirmation {
  if (!proof) return unconfirmed();
  const state = proof.providerStatus === 'SETTLED' ? 'confirmed' :
    ['FAILED', 'DECLINED', 'CANCELLED', 'REFUNDED', 'VOIDED', 'AUTHORIZATION_EXPIRED'].includes(proof.providerStatus) ? 'failed' : 'pending';
  return { state, source: 'meld_production_api', testMode: false, transactionId: proof.transactionId, providerStatus: proof.providerStatus,
    ...(state === 'confirmed' ? { receivedAmount: proof.receivedAmount, confirmedAt: proof.providerUpdatedAt } : {}) };
}
function transactionOutcome(row: Attempt, proof: z.infer<typeof proofInput> | null) {
  const state = confirmation(proof);
  return { confirmation: state, ...(row.service_provider === 'RAMPNOW' && proof && state.state === 'confirmed'
    ? { confirmedDestination: destination(row.address, proof.destinationCurrencyCode) } : {}) };
}
const rampNowTransferHash = z.object({ transaction: z.object({ cryptoDetails: z.object({ blockchainTransactionId: transactionHash }) }) });
/** The provider GET, not a redirect, is the authority for a payment result. */
export function validateProductionWalletTransaction(raw: unknown, row: Attempt, transactionId: string) {
  const parsed = z.object({ transaction: z.object({ id: identifier, accountId: identifier, sessionId: identifier,
    customerId: identifier, externalSessionId: uuid, externalCustomerId: uuid, serviceProvider: provider,
    transactionType: z.literal('CRYPTO_PURCHASE'), countryCode: country, sourceCurrencyCode: currency, sourceAmount: preciseAmount,
    destinationCurrencyCode: productionAsset, destinationAmount: z.number().finite().nonnegative().max(1_000_000_000),
    paymentMethodType: token, status: z.string(), updatedAt: instant,
    cryptoDetails: z.object({ destinationWalletAddress: z.string().regex(/^0x[0-9a-f]{40}$/i), chainId: z.union([proofChainId, z.literal(137), z.literal(42161), z.literal(1)]) }) }) }).safeParse(raw);
  if (!parsed.success) throw Error('wallet_production_provider_unavailable'); const item = parsed.data.transaction;
  if (item.id !== transactionId || item.customerId !== row.provider_customer_id
    || Math.abs(item.destinationAmount * 1e6 - Math.round(item.destinationAmount * 1e6)) > 0.00001) throw Error('wallet_production_provider_unavailable');
  const proof = proofInput.safeParse({ transactionId: item.id, accountId: item.accountId, sessionId: item.sessionId,
    externalSessionId: item.externalSessionId, externalCustomerId: item.externalCustomerId, serviceProvider: item.serviceProvider,
    countryCode: item.countryCode, sourceCurrencyCode: item.sourceCurrencyCode, sourceAmount: item.sourceAmount.toFixed(2),
    paymentMethodType: item.paymentMethodType, destinationCurrencyCode: item.destinationCurrencyCode,
    walletAddress: item.cryptoDetails.destinationWalletAddress.toLowerCase(), chainId: String(item.cryptoDetails.chainId),
    providerStatus: item.status === 'PENDING CREATED' ? 'PENDING_CREATED' : item.status, providerUpdatedAt: item.updatedAt,
    receivedAmount: item.destinationAmount.toFixed(6).replace(/\.?0+$/, '') || '0' });
  if (!proof.success || !matchesProof(proof.data, row)) throw Error('wallet_production_provider_unavailable');
  return proof.data;
}
const reconcileGates = new WeakMap<SandboxWalletDatabase, ReturnType<typeof createAdministrativePreflightGate>>();
async function reconcile(database: SandboxWalletDatabase, row: Attempt, dependencies: Dependencies, signal: AbortSignal) {
  const config = productionWalletConfiguration(dependencies.environment || process.env), previous = cachedProof(row), fetchImpl = dependencies.fetchImpl || fetch;
  if (row.account_id !== config.account) throw Error('wallet_production_provider_unavailable');
  if (!row.provider_session_id || !row.provider_customer_id) return transactionOutcome(row, previous);
  let gate = reconcileGates.get(database); if (!gate) { gate = createAdministrativePreflightGate(); reconcileGates.set(database, gate); }
  const release = gate(row.subject, randomUUID());
  try {
    let id = previous?.transactionId;
    if (!id) {
      const query = new URLSearchParams({ externalSessionIds: row.id, sessionIds: row.provider_session_id, externalCustomerIds: row.customer_reference,
        serviceProviders: row.service_provider, types: 'CRYPTO_PURCHASE', limit: '2' });
      const result = await productionMeldJson(`/payments/transactions?${query}`, { ...config, fetchImpl, signal });
      const search = z.object({ transactions: z.array(z.object({ id: identifier })).max(1) }).safeParse(result.data);
      if (!result.ok || !search.success) throw Error('wallet_production_provider_unavailable');
      if (!search.data.transactions.length) return transactionOutcome(row, previous);
      id = search.data.transactions[0]!.id;
    }
    const result = await productionMeldJson(`/payments/transactions/${encodeURIComponent(id)}`, { ...config, fetchImpl, signal });
    if (!result.ok) throw Error('wallet_production_provider_unavailable'); const proof = validateProductionWalletTransaction(result.data, row, id);
    if (row.service_provider === 'RAMPNOW') {
      if (proof.providerStatus === 'SETTLED') {
        const hash = rampNowTransferHash.safeParse(result.data);
        const delivered = hash.success && await verifyRampNowDelivery({ asset: proof.destinationCurrencyCode,
          address: row.address, amount: proof.receivedAmount, hash: hash.data.transaction.cryptoDetails.blockchainTransactionId }, fetchImpl, signal);
        if (!delivered) return transactionOutcome(row, previous?.providerStatus === 'SETTLED'
          ? previous : { ...proof, providerStatus: 'SETTLING' });
      } else if (proof.destinationCurrencyCode !== row.destination_currency && proof.destinationCurrencyCode !== previous?.destinationCurrencyCode) {
        return transactionOutcome(row, previous?.providerStatus === 'SETTLED' ? previous : proof);
      }
    }
    const serialized = JSON.stringify(proof), digest = createHash('sha256').update(serialized).digest('hex');
    const rows = await productionOperation(() => database.execute(sql`SELECT payments.record_wallet_meld_production_proof(
      ${row.subject},${row.id}::uuid,${serialized}::jsonb,${digest}) AS proof`), signal);
    const saved = cachedProof({ ...row, proof: z.object({ proof: z.unknown() }).parse(one(rows)).proof });
    if (!saved || saved.transactionId !== id) throw Error('wallet_production_unavailable');
    return transactionOutcome(row, saved);
  } finally { release(); }
}
export async function readProductionWalletStatus(database: SandboxWalletDatabase, input: SandboxWalletPrincipal & { checkoutReference: string },
  { environment = process.env, fetchImpl = fetch, signal, timeoutMs }: Dependencies = {}) {
  productionWalletConfiguration(environment); const reference = uuid.parse(input.checkoutReference), scope = productionScope(signal, timeoutMs);
  try {
    const rows = await productionOperation(() => database.execute(sql`SELECT * FROM payments.read_wallet_meld_production_attempt_with_asset(
      ${input.subject},${input.nativeSessionId},${reference}::uuid)`), scope.signal);
    if (!rows.length) throw Error('wallet_production_not_found'); const row = readAttempt(one(rows), input.subject);
    if (row.id !== reference) throw Error('wallet_production_unavailable');
    return { checkoutReference: row.id, walletKind: 'personal' as const, environment: 'production' as const, provider: 'meld' as const,
      serviceProvider: row.service_provider, requestedAmount: row.requested_amount, sourceCurrencyCode: row.source_currency,
      paymentMethodType: row.payment_method, country: row.country_code, requestStatus: row.status, destination: destination(row.address, row.destination_currency),
      ...await reconcile(database, row, { environment, fetchImpl }, scope.signal) };
  } finally { scope.close(); }
}
export async function readProductionWalletHistory(database: SandboxWalletDatabase, input: SandboxWalletPrincipal,
  { environment = process.env, signal, timeoutMs }: Dependencies = {}) {
  const config = productionWalletConfiguration(environment), scope = productionScope(signal, timeoutMs);
  try {
    const rows = await productionOperation(() => database.execute(sql`SELECT * FROM payments.read_wallet_meld_production_history_with_asset(
      ${input.subject},${input.nativeSessionId})`), scope.signal);
    if (rows.length > 50) throw Error('wallet_production_unavailable');
    const records = rows.map(value => { const row = readAttempt(value, input.subject);
      if (row.account_id !== config.account) throw Error('wallet_production_unavailable');
      return { checkoutReference: row.id, provider: 'meld' as const, serviceProvider: row.service_provider, status: row.status,
        country: row.country_code, requestedAmount: row.requested_amount, sourceCurrencyCode: row.source_currency, destination: destination(row.address, row.destination_currency),
        paymentMethodType: row.payment_method, createdAt: row.created_at.toISOString(), ...(row.proof !== null ? transactionOutcome(row, cachedProof(row)) : {}) }; });
    if (new Set(records.map(row => row.checkoutReference)).size !== records.length) throw Error('wallet_production_unavailable');
    return { walletKind: 'personal' as const, environment: 'production' as const, settlement: 'unconfirmed' as const, records };
  } finally { scope.close(); }
}
