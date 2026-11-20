import { isIP } from 'node:net';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { IdentityDatabase } from '../identity/model';
import { createAdministrativePreflightGate, personalFundingInput } from './wallet-funding';
import { productionMeldJson, productionOperation, productionScope } from './meld-production-http';
import { appMeldAsset, appMeldDestination, appMeldMarket, appMeldProvider, rampNowPaymentModes,
  type AppMeldAsset, type AppMeldProvider } from './app-meld-funding-policy';

export const APP_MELD_ORIGIN = 'https://app.mindblisspower.com';
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const unavailable = () => new Error('wallet_funding_provider_unavailable');
type Database = Pick<IdentityDatabase, 'execute'>;
type Dependencies = { environment?: Record<string, string | undefined>; fetchImpl?: typeof fetch; signal?: AbortSignal };
const appMeldInput = personalFundingInput.extend({ serviceProvider: appMeldProvider.optional(), destinationCurrencyCode: appMeldAsset.optional() });
type PaymentMethod = { method: string; currencyCode: string; minimumAmount: number; maximumAmount: number; minimumUsd?: number; maximumUsd?: number };
type FundingRoute = { serviceProvider: AppMeldProvider; paymentMethods: PaymentMethod[] };

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
}: Dependencies = {}) {
  const market = appMeldMarket(country, sourceCurrencyCode), asset = market?.asset ?? 'USDT_POLYGON';
  const result = { walletKind: 'personal' as const, environment: 'production' as const, provider: 'meld' as const,
    country, sourceCurrencyCode, destinationCurrencyCode: asset, network: 'polygon' as const, chainId: 137 as const };
  if (!market) return { ...result, paymentMethods: [], routes: [] };
  const config = configuration(environment), scope = productionScope(signal, 8_000);
  try {
    const query = new URLSearchParams({ partners: market.rails.map(route => route.provider).join(','), checkout: 'true' });
    const response = await productionMeldJson(`/network-partner/supported/routes/CRYPTO_ONRAMP/${country}/${sourceCurrencyCode}/${asset}?${query}`,
      { ...config, fetchImpl, signal: scope.signal });
    const parsed = z.array(routeSchema).max(128).safeParse(response.data);
    if (!response.ok || !parsed.success) throw unavailable();
    const options = new Map<string, PaymentMethod>();
    for (const route of parsed.data) {
      const policy = market.rails.find(rail => rail.provider === route.partner);
      if (!policy || route.source !== sourceCurrencyCode || route.destination !== asset || route.checkoutSupported === false) continue;
      for (const rail of route.paymentMethods) {
        if (!policy.methods.some(method => method === rail.name) || rail.checkoutSupported === false || rail.limits?.currencyCode !== sourceCurrencyCode) continue;
        const key = `${policy.provider}:${rail.name}`, prior = options.get(key);
        const usd = sourceCurrencyCode === 'USD';
        const minimumAmount = Math.max(rail.limits.min, policy.minimum, prior?.minimumAmount ?? 0);
        const maximumAmount = Math.min(rail.limits.max, policy.maximum, prior?.maximumAmount ?? Infinity);
        options.set(key, { method: rail.name, currencyCode: sourceCurrencyCode, minimumAmount, maximumAmount,
          ...(usd ? { minimumUsd: minimumAmount, maximumUsd: maximumAmount } : {}) });
      }
    }
    const routes: FundingRoute[] = market.rails.map(policy => ({ serviceProvider: policy.provider,
      paymentMethods: policy.methods.flatMap(method => {
        const rail = options.get(`${policy.provider}:${method}`);
        return rail && rail.minimumAmount <= rail.maximumAmount ? [rail] : [];
      }),
    })).filter(route => route.paymentMethods.length > 0);
    return { ...result, paymentMethods: [...new Set(routes.flatMap(route => route.paymentMethods.map(rail => rail.method)))], routes };
  } finally { scope.close(); }
}

const quoteSchema = z.object({ quotes: z.array(z.object({ serviceProvider: appMeldProvider, countryCode: z.string().optional(),
  sourceCurrencyCode: z.string(), sourceAmount: z.number(), paymentMethodType: z.string(), destinationCurrencyCode: appMeldAsset,
  destinationAmount: z.number().finite().positive(), totalFee: z.number().finite().nonnegative(), transactionType: z.literal('CRYPTO_PURCHASE'),
  walletAddress: z.string().optional(), accountId: identifier.optional() })).length(1) });
const widget = z.object({ id: identifier, customerId: identifier, externalSessionId: z.string().uuid(), externalCustomerId: z.string().uuid(),
  serviceProvider: appMeldProvider.optional(), widgetUrl: z.string().max(8192), serviceProviderWidgetUrl: z.string().max(8192) });
const reserved = z.object({ id: z.string().uuid(), wallet_address: address, customer_reference: z.string().uuid(), created: z.boolean(),
  status: z.literal('initiated'), created_at: z.coerce.date() });

function checkoutUrl(value: string) {
  return /^https:\/\/meldcrypto\.com\/?\?token=[A-Za-z0-9_.~-]{1,7000}$/.test(value) ? new URL(value).href : null;
}
function matchesWidget(link: string, provider: AppMeldProvider, id: string, wallet: string, asset: AppMeldAsset,
  { sourceCurrencyCode: fiat, country, amount, paymentMethodType }: z.infer<typeof appMeldInput>, redirectUrl: string) {
  if (/[\\\u0000-\u0020\u007f]/.test(link)) return false;
  try {
    const url = new URL(link), query = url.searchParams;
    if (url.username || url.password || url.hash || ![...query.keys()].every(key => query.getAll(key).length === 1)) return false;
    const matches = (expected: Record<string, string>) => Object.entries(expected).every(([key, value]) => query.get(key) === value);
    const token = appMeldDestination(asset, wallet).asset;
    if (provider === 'MERCURYO') {
      return url.origin === 'https://exchange.mercuryo.io' && url.pathname === '/'
        && matches({ type: 'buy', currency: token, network: 'POLYGON', fix_currency: 'true', country_code: country,
          fiat_currency: fiat, fiat_amount: amount.toFixed(2), fix_fiat_currency: 'true', fix_fiat_amount: 'true',
          payment_method: 'card', address: wallet, redirect_url: redirectUrl, merchant_transaction_id: id })
        && z.string().uuid().safeParse(query.get('widget_id')).success && /^v2:[a-f0-9]{128}$/i.test(query.get('signature') || '');
    }
    if (provider === 'ONRAMPMONEY') {
      const fiatType = ({ MXN: '4', COP: '9', USD: '21' } as Record<string, string>)[fiat];
      return Boolean(fiatType) && url.origin === 'https://onramp.money' && url.pathname === '/main/buy/'
        && matches({ coinCode: token.toLowerCase(), network: 'matic20', walletAddress: wallet, fiatAmount: amount.toFixed(2),
          fiatType: fiatType!, paymentMethod: paymentMethodType === 'LOCAL_BANK_TRANSFER' ? '1' : '2', redirectUrl });
    }
    const paymentMode = (rampNowPaymentModes as Record<string, string>)[paymentMethodType];
    return Boolean(paymentMode) && url.origin === 'https://app.rampnow.io' && url.pathname === '/order/quote'
      && matches({ orderType: 'buy', srcCurrency: fiat, srcChain: 'fiat', srcAmount: amount.toFixed(2),
        dstCurrency: token, dstChain: 'polygon', walletAddress: wallet, prefill: 'true', paymentMode: paymentMode!,
        returnUrl: redirectUrl, externalOrderId: id })
      && query.get('lockFields')?.split(',').includes('walletAddress') === true;
  } catch { return false; }
}
const limits = new WeakMap<Database, ReturnType<typeof createAdministrativePreflightGate>>();

export async function createAppMeldFunding(database: Database, raw: unknown, {
  subject, nativeSessionId, clientIp, environment = process.env, fetchImpl = fetch, signal,
}: Dependencies & { subject: string; nativeSessionId: string; clientIp: string }) {
  const input = appMeldInput.parse(raw);
  const market = appMeldMarket(input.country, input.sourceCurrencyCode);
  if (!market || (input.destinationCurrencyCode && input.destinationCurrencyCode !== market.asset)) throw Error('wallet_funding_method_unavailable');
  const asset = market.asset;
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
    const options = await readAppMeldOptions(input.country, input.sourceCurrencyCode, { environment, fetchImpl, signal: scope.signal });
    const candidates = options.routes.filter(item => (!input.serviceProvider || item.serviceProvider === input.serviceProvider)
      && item.paymentMethods.some(rail => rail.method === input.paymentMethodType));
    if (!candidates.length) throw Error('wallet_funding_method_unavailable');
    const route = candidates.find(item => item.paymentMethods.some(rail => rail.method === input.paymentMethodType
      && input.amount >= rail.minimumAmount && input.amount <= rail.maximumAmount));
    if (!route) throw Error('wallet_funding_amount_unavailable');
    const serviceProvider = route.serviceProvider;
    const rows = await productionOperation(() => database.execute(sql`SELECT * FROM payments.reserve_app_meld_funding(
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
    const session = await productionMeldJson('/crypto/session/widget', { ...config, fetchImpl, signal: scope.signal,
      body: { sessionType: 'BUY', externalSessionId: journalId, externalCustomerId: row.data.customer_reference,
        sessionData: { serviceProvider, walletAddress, countryCode: country, sourceCurrencyCode, sourceAmount: amount.toFixed(2),
          destinationCurrencyCode: asset, paymentMethodType, clientIpAddress: clientIp, redirectUrl,
          lockFields: ['walletAddress', 'destinationCurrencyCode', 'sourceCurrencyCode', 'sourceAmount', 'paymentMethodType'] } } });
    const parsed = widget.safeParse(session.data);
    if (!session.ok || !parsed.success || parsed.data.externalSessionId !== journalId
      || parsed.data.externalCustomerId !== row.data.customer_reference || (parsed.data.serviceProvider && parsed.data.serviceProvider !== serviceProvider)
      || !matchesWidget(parsed.data.serviceProviderWidgetUrl, serviceProvider, parsed.data.id, walletAddress, asset, input, redirectUrl)) throw unavailable();
    const url = checkoutUrl(parsed.data.widgetUrl);
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
