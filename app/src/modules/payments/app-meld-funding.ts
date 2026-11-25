import { isIP } from 'node:net';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { IdentityDatabase } from '../identity/model';
import { createAdministrativePreflightGate, personalFundingInput } from './wallet-funding';
import { additionalAppMeldOnrampParameters } from './app-meld-additional-markets';
import { productionMeldJson, productionOperation, productionScope } from './meld-production-http';
import { appMeldAmountFitsPrecision, appMeldAsset, appMeldDestination, appMeldMarket, appMeldNetwork, appMeldProvider, appMeldRouteBounds,
  type AppMeldAsset, type AppMeldProvider } from './app-meld-funding-policy';

export const APP_MELD_ORIGIN = 'https://app.mindblisspower.com';
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const unavailable = () => new Error('wallet_funding_provider_unavailable');
type Database = Pick<IdentityDatabase, 'execute'>;
type Dependencies = { environment?: Record<string, string | undefined>; fetchImpl?: typeof fetch; signal?: AbortSignal };
const appMeldInput = personalFundingInput.extend({ amount: z.number().finite().min(0.01).max(1_000_000_000),
  serviceProvider: appMeldProvider.optional(), destinationCurrencyCode: appMeldAsset.optional() });
type PaymentMethod = { method: string; currencyCode: string; minimumAmount: number; maximumAmount: number; minimumUsd?: number; maximumUsd?: number };
type FundingRoute = { serviceProvider: AppMeldProvider; destinationCurrencyCode: AppMeldAsset; paymentMethods: PaymentMethod[] }
  & ReturnType<typeof appMeldNetwork>;

function configuration(environment: Record<string, string | undefined>) {
  const key = environment.MELD_PRODUCTION_API_KEYS;
  const account = identifier.safeParse(environment.MELD_PRODUCTION_ACCOUNT_ID);
  if (!key || !/^[\x21-\x7e]{1,2048}$/.test(key) || !account.success) throw Error('wallet_funding_unconfigured');
  return { key, account: account.data };
}
const routeSchema = z.object({ partner: z.string(), source: z.string(), destination: z.string(),
  checkoutSupported: z.boolean().optional(), paymentMethods: z.array(z.object({ name: z.string(), checkoutSupported: z.boolean().optional(),
    limits: z.object({ currencyCode: z.string(), min: z.number().finite().nonnegative(), max: z.number().finite().positive() }).nullish() })).max(128) });

export async function readAppMeldOptions(country: string, sourceCurrencyCode: string, {
  environment = process.env, fetchImpl = fetch, signal,
}: Dependencies = {}, selectedAsset?: AppMeldAsset) {
  const market = appMeldMarket(country, sourceCurrencyCode);
  const asset = selectedAsset ?? market?.asset ?? 'USDT_POLYGON';
  const result = { walletKind: 'personal' as const, environment: 'production' as const, provider: 'meld' as const,
    country, sourceCurrencyCode, destinationCurrencyCode: asset, ...appMeldNetwork(asset),
    minorUnits: market?.minorUnits ?? 2 };
  if (!market) return { ...result, paymentMethods: [], routes: [] as FundingRoute[] };
  const config = configuration(environment), scope = productionScope(signal, 8_000);
  async function discover(destinationCurrencyCode: AppMeldAsset): Promise<FundingRoute[]> {
    const approved = market!.rows.filter(row => row.destinationCurrencyCode === destinationCurrencyCode);
    const partners = [...new Set(approved.map(row => row.serviceProvider))];
    if (!partners.length) return [];
    const query = new URLSearchParams({ partners: partners.join(','), checkout: 'true' });
    const response = await productionMeldJson('/network-partner/supported/routes/CRYPTO_ONRAMP/' + country + '/'
      + sourceCurrencyCode + '/' + destinationCurrencyCode + '?' + query, { ...config, fetchImpl, signal: scope.signal });
    if (!response.ok && [400, 404].includes(response.status)) return [];
    const parsed = z.array(routeSchema).max(256).safeParse(response.data);
    if (!response.ok || !parsed.success) throw unavailable();
    const options = new Map<string, PaymentMethod>();
    for (const route of parsed.data) {
      if (route.source !== sourceCurrencyCode || route.destination !== destinationCurrencyCode || route.checkoutSupported === false) continue;
      for (const rail of route.paymentMethods) {
        const approvedRow = approved.find(row => row.serviceProvider === route.partner && row.paymentMethodType === rail.name);
        if (!approvedRow || rail.checkoutSupported === false || rail.limits?.currencyCode !== sourceCurrencyCode) continue;
        const key = approvedRow.serviceProvider + ':' + rail.name, prior = options.get(key);
        const { minimumAmount, maximumAmount } = appMeldRouteBounds(approvedRow,
          Math.max(rail.limits.min, prior?.minimumAmount ?? 0), Math.min(rail.limits.max, prior?.maximumAmount ?? Infinity));
        options.set(key, { method: rail.name, currencyCode: sourceCurrencyCode, minimumAmount, maximumAmount,
          ...(sourceCurrencyCode === 'USD' ? { minimumUsd: minimumAmount, maximumUsd: maximumAmount } : {}) });
      }
    }
    return partners.flatMap(serviceProvider => {
      const paymentMethods = approved.filter(row => row.serviceProvider === serviceProvider).flatMap(row => {
        const rail = options.get(row.serviceProvider + ':' + row.paymentMethodType);
        return rail && rail.minimumAmount <= rail.maximumAmount ? [rail] : [];
      });
      return paymentMethods.length ? [{ serviceProvider, destinationCurrencyCode, ...appMeldNetwork(destinationCurrencyCode), paymentMethods }] : [];
    });
  }
  try {
    const alternatives = selectedAsset ? [] : [...new Set(market.rows.map(row => row.destinationCurrencyCode))].filter(other => other !== asset);
    const loaded = await Promise.all([discover(asset), ...alternatives.map(other => discover(other).catch(() => []))]);
    if (scope.signal.aborted) throw unavailable();
    const routes = loaded.flat();
    return { ...result, paymentMethods: [...new Set(routes.flatMap(route => route.paymentMethods.map(rail => rail.method)))], routes };
  } finally { scope.close(); }
}

const quoteSchema = z.object({ quotes: z.array(z.object({ serviceProvider: appMeldProvider, countryCode: z.string().optional(),
  sourceCurrencyCode: z.string(), sourceAmount: z.number(), paymentMethodType: z.string(), destinationCurrencyCode: appMeldAsset,
  destinationAmount: z.number().finite().positive(), totalFee: z.number().finite().nonnegative(), transactionType: z.literal('CRYPTO_PURCHASE'),
  walletAddress: z.string().optional(), accountId: identifier.optional() })).length(1) });
const widget = z.object({ id: identifier, customerId: identifier, externalSessionId: z.string().uuid(), externalCustomerId: z.string().uuid(),
  serviceProvider: appMeldProvider.optional(), widgetUrl: z.string().max(8192).nullish(), serviceProviderWidgetUrl: z.string().max(8192).nullish() });
const reserved = z.object({ id: z.string().uuid(), wallet_address: address, customer_reference: z.string().uuid(), created: z.boolean(),
  status: z.literal('initiated'), created_at: z.coerce.date() });
const mercuryoWidgetMethods = new Map([['CREDIT_DEBIT_CARD', 'card'], ['APPLE_PAY', 'apple'], ['GOOGLE_PAY', 'google']]);

function checkoutUrl(value: string | null | undefined) {
  return value && /^https:\/\/meldcrypto\.com\/?\?token=[A-Za-z0-9_.~-]{1,7000}$/.test(value) ? new URL(value).href : null;
}
function banxaCheckoutUrl(value: string | null | undefined) {
  if (!value || !value.startsWith('https://meldshared.banxa.com/papi/transit/?initId=') || /[\\\u0000-\u0020\u007f#]/.test(value)) return null;
  try {
    const url = new URL(value), query = url.searchParams;
    return url.origin === 'https://meldshared.banxa.com' && url.pathname === '/papi/transit/' && !url.username && !url.password
      && query.size === 1 && query.getAll('initId').length === 1 && /^[A-Za-z0-9._~+/-]{1,4096}={0,2}$/.test(query.get('initId') ?? '') ? value : null;
  } catch { return null; }
}
function matchesWidget(link: string | null | undefined, provider: AppMeldProvider, id: string, wallet: string, asset: AppMeldAsset,
  { sourceCurrencyCode: fiat, country, amount, paymentMethodType }: z.infer<typeof appMeldInput>, amountText: string, redirectUrl: string) {
  if (provider === 'BANXA' || provider === 'ONMETA') {
    // These routes authenticate an opaque MELD or Banxa checkout. The exact
    // quote, the linked recipient and the locked session parameters bind it.
    return asset === 'USDT_POLYGON' || (provider === 'BANXA' && country === 'MX' && fiat === 'MXN'
      && paymentMethodType === 'SPEI' && asset === 'USDC_POLYGON' && Boolean(banxaCheckoutUrl(link)));
  }
  if (provider === 'ONRAMPMONEY' && asset === 'USDT_POLYGON' && !link) return true;
  if (!link) return false;
  if (/[\\\u0000-\u0020\u007f]/.test(link)) return false;
  try {
    const url = new URL(link), query = url.searchParams;
    if (url.username || url.password || url.hash || ![...query.keys()].every(key => query.getAll(key).length === 1)) return false;
    const matches = (expected: Record<string, string>) => Object.entries(expected).every(([key, value]) => query.get(key) === value);
    const destination = appMeldDestination(asset, wallet);
    const token = destination.asset, network = destination.network.toUpperCase();
    if (provider === 'MERCURYO') {
      const method = mercuryoWidgetMethods.get(paymentMethodType);
      if (!method || (method !== 'card' && (country !== 'US' || fiat !== 'USD'))) return false;
      return url.origin === 'https://exchange.mercuryo.io' && url.pathname === '/'
        && !query.has('address_map') && (method !== 'apple' || query.get('fix_payment_method') === 'true')
        && matches({ type: 'buy', currency: token, network, fix_currency: 'true', country_code: country,
          fiat_currency: fiat, fiat_amount: amount.toFixed(2), fix_fiat_currency: 'true', fix_fiat_amount: 'true',
          payment_method: method, address: wallet, redirect_url: redirectUrl, merchant_transaction_id: id })
        && z.string().uuid().safeParse(query.get('widget_id')).success && /^v2:[a-f0-9]{128}$/i.test(query.get('signature') || '');
    }
    if (provider === 'ALCHEMYPAY') {
      const callback = new URL(query.get('callbackUrl') || '');
      // The approved rail is bound in the MELD session. Alchemy's signed
      // handoff contains the country, fiat, amount, asset and recipient.
      return asset === 'USDC_ARBITRUM'
        && url.origin === 'https://ramp.alchemypay.org' && url.pathname === '/' && !query.has('payWayCode')
        && matches({ address: wallet, country, fiat, fiatAmount: amountText, crypto: token, network,
          redirectUrl, showTable: 'buy', merchantOrderNo: id })
        && callback.origin === 'https://api.meld.io' && /^\/webhooks\/alchemypay\/[A-Za-z0-9_-]{1,128}$/.test(callback.pathname)
        && !callback.username && !callback.password && !callback.search && !callback.hash
        && identifier.safeParse(query.get('appId')).success
        && /^\d{13}$/.test(query.get('timestamp') || '') && /^[A-Za-z0-9+/]{43}=$/.test(query.get('sign') || '');
    }
    if (provider === 'RAMPNOW') {
      return country === 'DE' && fiat === 'EUR' && paymentMethodType === 'SEPA' && asset === 'USDC_POLYGON'
        && url.origin === 'https://app.rampnow.io' && url.pathname === '/order/quote'
        && matches({ orderType: 'buy', srcCurrency: fiat, srcChain: 'fiat', dstCurrency: token, dstChain: destination.network,
          srcAmount: amountText, walletAddress: wallet, lockFields: 'walletAddress', paymentMode: 'sepa', prefill: 'true',
          externalOrderId: id, returnUrl: redirectUrl });
    }
    if (provider === 'ONRAMPMONEY') {
      const verified = additionalAppMeldOnrampParameters(country, fiat, paymentMethodType);
      const fiatType = verified?.fiatType ?? ({ MXN: '4', COP: '9', USD: '21' } as Record<string, string>)[fiat];
      const paymentMethod = verified?.paymentMethod ?? (fiatType ? (paymentMethodType === 'LOCAL_BANK_TRANSFER' ? '1' : '2') : undefined);
      if (checkoutUrl(link) && asset === 'USDT_POLYGON' && fiatType === undefined) return true;
      return url.origin === 'https://onramp.money' && url.pathname === '/main/buy/'
        && matches({ coinCode: token.toLowerCase(), network: 'matic20', walletAddress: wallet, fiatAmount: amount.toFixed(2), redirectUrl })
        && (fiatType === undefined ? /^\d{1,3}$/.test(query.get('fiatType') ?? '') : query.get('fiatType') === fiatType)
        && (paymentMethod === undefined ? /^\d{1,3}$/.test(query.get('paymentMethod') ?? '') : query.get('paymentMethod') === paymentMethod);
    }
    return false;
  } catch { return false; }
}
const limits = new WeakMap<Database, ReturnType<typeof createAdministrativePreflightGate>>();

export async function createAppMeldFunding(database: Database, raw: unknown, {
  subject, nativeSessionId, clientIp, environment = process.env, fetchImpl = fetch, signal,
}: Dependencies & { subject: string; nativeSessionId: string; clientIp: string }) {
  const input = appMeldInput.parse(raw);
  const market = appMeldMarket(input.country, input.sourceCurrencyCode);
  const asset = input.destinationCurrencyCode ?? market?.asset;
  const approved = market?.rows.filter(row => row.destinationCurrencyCode === asset
    && row.paymentMethodType === input.paymentMethodType && (!input.serviceProvider || row.serviceProvider === input.serviceProvider));
  if (!market || !asset || !approved?.length) throw Error('wallet_funding_method_unavailable');
  if (!appMeldAmountFitsPrecision(input.amount, market.minorUnits) || !approved.some(row => {
    const { minimumAmount, maximumAmount } = appMeldRouteBounds(row);
    return input.amount >= minimumAmount && input.amount <= maximumAmount;
  })) throw Error('wallet_funding_amount_unavailable');
  const config = configuration(environment);
  if (!isIP(clientIp) || !nativeSessionId) throw Error('wallet_funding_unconfigured');
  let limiter = limits.get(database);
  if (!limiter) { limiter = createAdministrativePreflightGate(); limits.set(database, limiter); }
  const release = limiter(subject, input.requestId);
  const scope = productionScope(signal);
  const walletAddress = input.walletAddress.toLowerCase();
  let sessionSaved = false, journalId: string | undefined;
  const finish = async (status: 'session_created' | 'unavailable', id: string | null, customer: string | null) => {
    const rows = await productionOperation(() => database.execute(sql`SELECT payments.finish_app_meld_funding(
      ${subject},${nativeSessionId},${journalId}::uuid,${status},${id},${customer}) AS finished`), scope.signal);
    if (rows.length !== 1 || (rows[0] as { finished?: unknown }).finished !== true) throw unavailable();
  };
  try {
    const options = await readAppMeldOptions(input.country, input.sourceCurrencyCode, { environment, fetchImpl, signal: scope.signal }, asset);
    const candidates = options.routes.filter(item => (!input.serviceProvider || item.serviceProvider === input.serviceProvider)
      && item.paymentMethods.some(rail => rail.method === input.paymentMethodType));
    if (!candidates.length) throw Error('wallet_funding_method_unavailable');
    const route = candidates.find(item => item.paymentMethods.some(rail => rail.method === input.paymentMethodType
      && input.amount >= rail.minimumAmount && input.amount <= rail.maximumAmount));
    if (!route) throw Error('wallet_funding_amount_unavailable');
    const serviceProvider = route.serviceProvider;
    const rows = await productionOperation(() => database.execute(sql`SELECT * FROM payments.reserve_app_meld_funding_v3(
      ${subject},${nativeSessionId},${input.requestId}::uuid,${walletAddress},${input.country},${input.sourceCurrencyCode},
      ${input.amount},${input.paymentMethodType},${serviceProvider},${config.account},${asset})`), scope.signal);
    const row = reserved.safeParse(rows.length === 1 ? rows[0] : null);
    if (!row.success || row.data.id !== input.requestId || row.data.wallet_address !== walletAddress || !row.data.created)
      throw Error('wallet_funding_request_already_used');
    journalId = row.data.id;
    const { country, sourceCurrencyCode, paymentMethodType, amount } = input;
    const quote = await productionMeldJson('/payments/crypto/quote?includeSwap=false', { ...config, fetchImpl, signal: scope.signal,
      body: { countryCode: country, sourceCurrencyCode, sourceAmount: amount, destinationCurrencyCode: asset,
        paymentMethodType, serviceProviders: [serviceProvider], walletAddress, clientIpAddress: clientIp } });
    const estimations = quoteSchema.safeParse(quote.data), estimate = estimations.success && estimations.data.quotes[0];
    if (!quote.ok || !estimate || estimate.serviceProvider !== serviceProvider || estimate.sourceCurrencyCode !== sourceCurrencyCode || estimate.destinationCurrencyCode !== asset
      || estimate.sourceAmount !== amount || estimate.paymentMethodType !== paymentMethodType || (estimate.countryCode && estimate.countryCode !== country)
      || (estimate.walletAddress && estimate.walletAddress.toLowerCase() !== walletAddress) || (estimate.accountId && estimate.accountId !== config.account)) throw unavailable();

    const redirectUrl = `${APP_MELD_ORIGIN}/dashboard/wallet-personal?walletCheckoutReference=${journalId}`;
    const amountText = amount.toFixed(market.minorUnits);
    const session = await productionMeldJson('/crypto/session/widget', { ...config, fetchImpl, signal: scope.signal,
      body: { sessionType: 'BUY', externalSessionId: journalId, externalCustomerId: row.data.customer_reference,
        sessionData: { serviceProvider, walletAddress, countryCode: country, sourceCurrencyCode, sourceAmount: amountText,
          destinationCurrencyCode: asset, paymentMethodType, clientIpAddress: clientIp, redirectUrl,
          lockFields: ['walletAddress', 'destinationCurrencyCode', 'sourceCurrencyCode', 'sourceAmount', 'paymentMethodType'] } } });
    const parsed = widget.safeParse(session.data);
    if (!session.ok || !parsed.success || parsed.data.externalSessionId !== journalId
      || parsed.data.externalCustomerId !== row.data.customer_reference || (parsed.data.serviceProvider && parsed.data.serviceProvider !== serviceProvider)
      || !matchesWidget(parsed.data.serviceProviderWidgetUrl, serviceProvider, parsed.data.id, walletAddress, asset, input, amountText, redirectUrl)) throw unavailable();
    const url = (serviceProvider === 'BANXA' ? banxaCheckoutUrl(parsed.data.serviceProviderWidgetUrl) : null)
      ?? checkoutUrl(parsed.data.widgetUrl);
    if (!url) throw unavailable();
    sessionSaved = true;
    await finish('session_created', parsed.data.id, parsed.data.customerId);
    return { checkoutReference: journalId, walletKind: 'personal' as const, environment: 'production' as const, provider: 'meld' as const,
      serviceProvider, status: 'session_created' as const, checkoutUrl: url, country, sourceCurrencyCode, requestedAmount: amount,
      paymentMethodType, destinationCurrencyCode: asset, destination: appMeldDestination(asset, walletAddress), createdAt: row.data.created_at.toISOString() };
  } catch (error) {
    if (journalId && !sessionSaved && !scope.signal.aborted) {
      try { await finish('unavailable', null, null); } catch { /* Keep the original failure and do not retry the vendor request. */ }
    }
    throw error;
  } finally { scope.close(); release(); }
}
