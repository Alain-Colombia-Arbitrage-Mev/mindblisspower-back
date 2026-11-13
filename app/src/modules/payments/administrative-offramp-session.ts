import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { getAddress, parseUnits } from 'ethers';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { IdentityDatabase } from '../identity/model';
import { readAdministrativeOfframpOptions } from './administrative-offramp-discovery';
import { sandboxMeldJson, sandboxOperation, sandboxOperationScope } from './meld-sandbox-http';

export type OfframpDatabase = Pick<IdentityDatabase, 'execute'>;
export type OfframpEnvironment = Record<string, string | undefined>;
const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).refine(value => value !== '.' && value !== '..');
const code = z.string().regex(/^[A-Z0-9_]{2,64}$/);
const uuid = z.string().uuid();
const quantity = z.string().regex(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/)
  .refine(value => { try { const atomic = parseUnits(value, 6); return atomic > 0n && atomic <= 1_000_000_000_000_000n; }
    catch { return false; } });
export const administrativeOfframpInput = z.object({ requestId: uuid.transform(value => value.toLowerCase()),
  country: z.enum(['US', 'MX', 'CO']), destinationCurrencyCode: z.enum(['USD', 'MXN', 'COP']),
  amount: quantity, serviceProvider: code, paymentMethodType: code }).strict()
  .refine(value => value.destinationCurrencyCode === 'USD' || (value.country === 'MX' && value.destinationCurrencyCode === 'MXN')
    || (value.country === 'CO' && value.destinationCurrencyCode === 'COP'));
const rowInput = z.object({ id: uuid, wallet_address: z.string().regex(/^0x[0-9a-f]{40}$/), customer_reference: uuid,
  status: z.enum(['initiated', 'session_created', 'unavailable']), created: z.boolean(), created_at: z.coerce.date() });

export function administrativeOfframpConfiguration(environment: OfframpEnvironment) {
  const key = environment.MELD_API_SANDBOX;
  if (environment.ADMINISTRATIVE_MELD_OFFRAMP_ENABLED !== 'true' || environment.ADMINISTRATIVE_WALLET_SIGNING_ENABLED !== 'true'
    || environment.MELD_ADMIN_SANDBOX_ENABLED !== 'true' || !key || key.length > 2048 || /\s/.test(key)
    || !id.safeParse(environment.MELD_ACCOUNT_ID).success) throw Error('administrative_offramp_unconfigured');
  return { key, account: environment.MELD_ACCOUNT_ID! };
}

/** Provider-specific SELL sessions use an opaque sandbox MELD fallback, not a public Checkout key. */
export function administrativeOfframpWidgetUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 8192 || /[\\%#\u0000-\u0020\u007f]/.test(value)
    || !/^https:\/\/sb\.meldcrypto\.com\/?\?/.test(value)) throw Error('administrative_offramp_unavailable');
  const url = new URL(value), token = url.searchParams.get('token');
  if (url.origin !== 'https://sb.meldcrypto.com' || url.pathname !== '/' || url.username || url.password || url.hash || !token
    || token.length > 7000 || !/^[A-Za-z0-9_.~-]+$/.test(token) || url.search !== `?token=${token}`) throw Error('administrative_offramp_unavailable');
  return url.href;
}

/** A quote does not establish final fiat payout, nor authorize sending real crypto to sandbox. */
export function administrativeOfframpQuote(value: unknown, expected: z.infer<typeof administrativeOfframpInput>) {
  const result = z.object({ quotes: z.array(z.object({ serviceProvider: code, sourceCurrencyCode: z.literal('USDT_POLYGON'),
    countryCode: z.string().optional(),
    destinationCurrencyCode: z.string(), sourceAmount: z.number().finite().positive(), destinationAmount: z.number().finite().positive().max(1_000_000_000),
    paymentMethodType: code })).max(20) }).safeParse(value);
  if (!result.success) throw Error('administrative_offramp_unavailable');
  const matching = result.data.quotes.filter(quote => quote.serviceProvider === expected.serviceProvider
    && (quote.countryCode === undefined || quote.countryCode === expected.country)
    && quote.destinationCurrencyCode === expected.destinationCurrencyCode && quote.paymentMethodType === expected.paymentMethodType
    && Number(quote.sourceAmount.toFixed(6)) === quote.sourceAmount && parseUnits(quote.sourceAmount.toFixed(6), 6) === parseUnits(expected.amount, 6));
  if (matching.length !== 1) throw Error('administrative_offramp_unavailable');
  return matching[0]!;
}

export async function prepareAdministrativeOfframp(database: OfframpDatabase, raw: unknown, {
  subject, nativeSessionId, clientIp, environment = process.env, fetchImpl = fetch, signal,
}: { subject: string; nativeSessionId: string; clientIp: string; environment?: OfframpEnvironment; fetchImpl?: typeof fetch; signal?: AbortSignal }) {
  const config = administrativeOfframpConfiguration(environment), input = administrativeOfframpInput.parse(raw);
  if (!subject || subject.length > 255 || !nativeSessionId || nativeSessionId.length > 255 || !isIP(clientIp)) throw Error('administrative_offramp_unconfigured');
  const scope = sandboxOperationScope(signal);
  try {
    // SQL checks the current native session, exact assignment and its verified
    // external signer BEFORE this code performs any provider requests.
    const rows = await sandboxOperation(() => database.execute(sql`SELECT * FROM payments.create_administrative_offramp_intent(
      ${subject},${nativeSessionId},${input.requestId}::uuid,${input.country},${input.destinationCurrencyCode},${input.amount},
      ${input.serviceProvider},${input.paymentMethodType},${config.account})`), scope.signal);
    const parsed = rowInput.safeParse(rows[0]);
    if (rows.length !== 1 || !parsed.success || parsed.data.id !== input.requestId) throw Error('administrative_offramp_unavailable');
    const row = parsed.data;
    if (!row.created) throw Error('administrative_operation_already_used');
    if (row.status !== 'initiated') throw Error('administrative_offramp_unavailable');
    const finish = async (status: 'session_created' | 'unavailable', session: string | null, estimate: number | null) => {
      const saved = await sandboxOperation(() => database.execute(sql`SELECT payments.finish_administrative_offramp_intent(
        ${subject},${nativeSessionId},${row.id}::uuid,${status},${session},${estimate}) AS finished`), scope.signal);
      if (saved.length !== 1 || (saved[0] as { finished?: unknown }).finished !== true) throw Error('administrative_offramp_unavailable');
    };
    let finishing = false;
    try {
      const options = await readAdministrativeOfframpOptions({ country: input.country, destinationCurrencyCode: input.destinationCurrencyCode },
        { environment, fetchImpl, signal: scope.signal });
      const route = options.routes.find(route => route.serviceProvider === input.serviceProvider);
      const method = route?.paymentMethods.find(method => method.method === input.paymentMethodType);
      if (!method) throw Error('administrative_offramp_method_unavailable');
      if (['USDT', 'USDT_POLYGON'].includes(method.currencyCode)
        && (Number(input.amount) < method.minimumAmount || Number(input.amount) > method.maximumAmount)) throw Error('administrative_offramp_method_unavailable');
      const quoteResponse = await sandboxMeldJson('/payments/crypto/quote?includeSwap=false', { key: config.key, fetchImpl, signal: scope.signal,
        body: { countryCode: input.country, sourceCurrencyCode: 'USDT_POLYGON', destinationCurrencyCode: input.destinationCurrencyCode,
          sourceAmount: Number(input.amount), paymentMethodType: input.paymentMethodType, serviceProviders: [input.serviceProvider] } });
      if (!quoteResponse.ok) throw Error('administrative_offramp_unavailable');
      const quote = administrativeOfframpQuote(quoteResponse.data, input);
      // Fiat-denominated route limits may refer to gross input valuation,
      // rather than net payout after fees. The exact provider quote remains
      // authoritative; never relabel that fiat bound as a source USDT amount.
      const session = await sandboxMeldJson('/crypto/session/widget', { key: config.key, fetchImpl, signal: scope.signal,
        body: { sessionType: 'SELL', externalCustomerId: row.customer_reference, externalSessionId: row.id,
          sessionData: { serviceProvider: input.serviceProvider, countryCode: input.country, clientIpAddress: clientIp,
            sourceCurrencyCode: 'USDT_POLYGON', sourceAmount: input.amount, destinationCurrencyCode: input.destinationCurrencyCode,
            paymentMethodType: input.paymentMethodType, walletAddress: row.wallet_address, redirectFlow: true,
            redirectUrl: `https://wallet.mindblisspower.com/dashboard/wallet-administrative?offrampReference=${row.id}`,
            lockFields: ['sourceCurrencyCode', 'walletAddress', 'destinationCurrencyCode', 'sourceAmount', 'paymentMethodType'] } } });
      if (!session.ok) throw Error('administrative_offramp_unavailable');
      const parsedDetail = z.object({ id, externalSessionId: uuid, externalCustomerId: uuid, widgetUrl: z.string().max(8192) }).safeParse(session.data);
      if (!parsedDetail.success) throw Error('administrative_offramp_unavailable');
      const detail = parsedDetail.data;
      if (detail.externalSessionId !== row.id || detail.externalCustomerId !== row.customer_reference) throw Error('administrative_offramp_unavailable');
      const checkoutUrl = administrativeOfframpWidgetUrl(detail.widgetUrl);
      finishing = true; await finish('session_created', detail.id, quote.destinationAmount);
      return { flow: 'administrative_offramp' as const, walletKind: 'administrative' as const, environment: 'sandbox' as const,
        reference: row.id, status: 'session_created' as const, country: input.country, sourceAmount: input.amount,
        source: { address: getAddress(row.wallet_address), asset: 'USDT' as const, network: 'polygon' as const, chainId: 137 as const },
        destinationCurrencyCode: input.destinationCurrencyCode, quotedDestinationAmount: quote.destinationAmount,
        serviceProvider: input.serviceProvider, paymentMethodType: input.paymentMethodType, checkoutUrl, createdAt: row.created_at.toISOString(),
        execution: { canBroadcast: false as const, canFund: false as const, mode: 'sandbox_no_funds' as const } };
    } catch (error) {
      if (!finishing && !scope.signal.aborted) await finish('unavailable', null, null);
      throw error;
    }
  } finally { scope.close(); }
}

export const administrativeOfframpHash = (value: string) => createHash('sha256').update(value).digest('hex');
