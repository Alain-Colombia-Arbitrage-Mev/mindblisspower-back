import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { readAdministrativeWallet } from '../identity/administrative-wallet';
import type { IdentityDatabase } from '../identity/model';
import { createAdministrativePreflightGate } from './wallet-funding';

type CheckoutDatabase = Pick<IdentityDatabase, 'execute'>;
type CheckoutEnvironment = Record<string, string | undefined>;
const reference = z.string().uuid();
const subjectInput = z.string().min(1).max(255);
const identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).refine(value => value !== '.' && value !== '..');
export const meldCheckoutInput = z.object({ requestId: reference.transform(value => value.toLowerCase()), country: z.enum(['US', 'MX', 'CO']),
  sourceCurrencyCode: z.enum(['USD', 'MXN']), amount: z.number().finite().min(1).max(10_000_000)
    .refine(amount => Math.abs(amount * 100 - Math.round(amount * 100)) < 0.000001),
}).strict().superRefine((input, ctx) => {
  if (input.sourceCurrencyCode === 'MXN' && input.country !== 'MX') ctx.addIssue({ code: 'custom', path: ['sourceCurrencyCode'], message: 'Unsupported source' });
  if (input.sourceCurrencyCode === 'USD' && (input.amount < 50 || input.amount > 25_000)) ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Unsupported amount' });
});

function configuration(environment: CheckoutEnvironment) {
  const secret = environment.MELD_API_SANDBOX, publicKey = environment.MELD_WIDGET_PUBLIC_KEY, accountId = environment.MELD_ACCOUNT_ID;
  const validKey = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048 && /^[\x21-\x7e]+$/.test(value);
  if (environment.MELD_CHECKOUT_ENABLED !== 'true' || environment.MELD_ADMIN_SANDBOX_ENABLED !== 'true'
    || !validKey(secret) || !validKey(publicKey) || secret === publicKey || !identifier.safeParse(accountId).success) {
    throw new Error('wallet_funding_unconfigured');
  }
  return { secret, publicKey, accountId: accountId! };
}

/** Configuration metadata only: no database, keys, upstream calls or minted links. */
export function meldCheckoutCapabilities(environment: CheckoutEnvironment = process.env) {
  let configured = false;
  try { configuration(environment); configured = true; } catch { /* Feature remains unavailable. */ }
  return { flow: 'meld_checkout' as const, configured, environment: 'sandbox' as const, asset: 'USDT' as const,
    network: 'polygon' as const, chainId: 137 as const };
}
export function requireMeldCheckoutConfiguration(environment: CheckoutEnvironment = process.env) { configuration(environment); }
export function meldSandboxCheckoutReturnUrl(checkoutReference: string) {
  return `https://wallet.mindblisspower.com/dashboard/wallet-administrative?meldCheckoutReference=${reference.parse(checkoutReference).toLowerCase()}`;
}

/** The returned sandbox link is a bearer secret. Never rebuild its token or log it. */
export function meldSandboxCheckoutUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 8192 || /[\\%#\u0000-\u0020\u007f]/.test(value)
    || !/^https:\/\/sb\.meldcrypto\.com\/?\?/.test(value)) throw new Error('wallet_funding_provider_unavailable');
  const url = new URL(value), token = url.searchParams.get('wt');
  if (url.origin !== 'https://sb.meldcrypto.com' || url.pathname !== '/' || url.username || url.password || url.hash
    || !token || token.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(token)
    || url.search !== `?wt=${token}`) throw new Error('wallet_funding_provider_unavailable');
  return url.href;
}

const gates = new WeakMap<CheckoutDatabase, ReturnType<typeof createAdministrativePreflightGate>>();
function gate(database: CheckoutDatabase) {
  let value = gates.get(database); if (!value) { value = createAdministrativePreflightGate(); gates.set(database, value); }
  return value;
}
function scope(parent: AbortSignal | undefined) {
  const controller = new AbortController(), abort = () => controller.abort();
  if (parent?.aborted) abort(); else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 15_000);
  return { signal: controller.signal, close() { clearTimeout(timer); parent?.removeEventListener('abort', abort); } };
}
function cancel(body: ReadableStream<Uint8Array> | null) { try { void body?.cancel().catch(() => {}); } catch { /* Already locked. */ } }
function boundedOperation<T>(operation: () => Promise<T>, signal: AbortSignal, late?: (result: T) => void) {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = () => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); reject(new Error('wallet_funding_provider_unavailable')); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { if (signal.aborted) throw new Error('wallet_funding_provider_unavailable'); return operation(); }).then(result => {
      if (settled) { late?.(result); return; } settled = true; signal.removeEventListener('abort', abort); resolve(result);
    }, error => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); reject(error); });
  });
}
async function json(response: Response, signal: AbortSignal) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 32_768)) { cancel(response.body); throw new Error('wallet_funding_provider_unavailable'); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('wallet_funding_provider_unavailable');
  const abort = () => { try { void reader.cancel().catch(() => {}); } catch { /* Already cancelled. */ } };
  signal.addEventListener('abort', abort, { once: true });
  const pieces: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const result = await boundedOperation(() => reader.read(), signal);
      if (result.done) break; bytes += result.value.byteLength;
      if (bytes > 32_768) throw new Error('wallet_funding_provider_unavailable'); pieces.push(result.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(pieces))) as unknown;
  } catch { throw new Error('wallet_funding_provider_unavailable'); }
  finally { signal.removeEventListener('abort', abort); abort(); reader.releaseLock(); }
}

/** Minting is a technical request, never a purchase, settlement, credit or commission. */
export async function createMeldSandboxCheckout(database: CheckoutDatabase, raw: unknown, {
  subject, clientIp, environment = process.env, fetchImpl = fetch, signal,
}: { subject: string; clientIp: string; environment?: CheckoutEnvironment; fetchImpl?: typeof fetch; signal?: AbortSignal }) {
  const config = configuration(environment); // Fail before DB/network when feature or public profile is absent.
  const input = meldCheckoutInput.parse(raw), owner = subjectInput.parse(subject);
  if (!isIP(clientIp)) throw new Error('wallet_funding_unconfigured');
  const deadline = scope(signal); let release = () => {};
  try {
    release = gate(database)(owner, input.requestId);
    const wallet = await boundedOperation(() => readAdministrativeWallet(database, { userId: owner }), deadline.signal);
    if (wallet.status !== 'assigned' || !wallet.address || !reference.safeParse(wallet.checkoutReference).success) {
      throw new Error('wallet_funding_wallet_not_assigned');
    }
    const address = wallet.address.toLowerCase(), customer = wallet.checkoutReference!;
    const rows = await boundedOperation(() => database.execute(sql`SELECT * FROM payments.create_meld_sandbox_checkout_intent(
      ${owner},${address},${input.country},${input.amount},${input.requestId}::uuid,${input.sourceCurrencyCode},${config.accountId})`), deadline.signal);
    const parsed = z.object({ id: reference, created_at: z.coerce.date(), created: z.boolean(), status: z.enum(['initiated', 'minted', 'unavailable']), customer_reference: reference }).safeParse(rows[0]);
    if (rows.length !== 1 || !parsed.success || parsed.data.id !== input.requestId || parsed.data.customer_reference !== customer) throw new Error('wallet_funding_unavailable');
    const row = parsed.data;
    if (!row.created) throw new Error('wallet_funding_request_already_used');
    if (row.status !== 'initiated') throw new Error('wallet_funding_unavailable');
    const finish = async (status: 'minted' | 'unavailable', hash: string | null) => {
      const saved = await boundedOperation(() => database.execute(sql`SELECT payments.finish_meld_sandbox_checkout_mint(
        ${owner},${row.id}::uuid,${status},${hash}) AS finished`), deadline.signal);
      if (saved.length !== 1 || (saved[0] as { finished?: unknown }).finished !== true) throw new Error('wallet_funding_unavailable');
    };
    let outcomeStarted = false;
    try {
      const response = await boundedOperation(() => fetchImpl('https://api-sb.meld.io/crypto/session/widget/url', { method: 'POST', redirect: 'error', signal: deadline.signal,
        headers: { Authorization: `BASIC ${config.secret}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Meld-Version': '2026-02-03' },
        body: JSON.stringify({ publicKey: config.publicKey, sessionType: 'BUY',
          prefill: { countryCode: input.country, sourceCurrencyCode: input.sourceCurrencyCode, sourceAmount: input.amount,
            destinationCurrencyCode: 'USDT_POLYGON', walletAddress: address },
          locked: ['countryCode', 'sourceCurrencyCode', 'sourceAmount', 'destinationCurrencyCode', 'walletAddress'],
          redirectUrl: meldSandboxCheckoutReturnUrl(row.id), externalCustomerId: customer, externalSessionId: row.id }),
      }), deadline.signal, result => cancel(result.body));
      if (!response.ok) { cancel(response.body); throw new Error('wallet_funding_provider_unavailable'); }
      const body = await json(response, deadline.signal);
      const parsedUrl = z.object({ widgetUrl: z.string().max(8192) }).safeParse(body);
      if (!parsedUrl.success) throw new Error('wallet_funding_provider_unavailable');
      const checkoutUrl = meldSandboxCheckoutUrl(parsedUrl.data.widgetUrl);
      outcomeStarted = true;
      await finish('minted', createHash('sha256').update(checkoutUrl).digest('hex'));
      return { flow: 'meld_checkout' as const, status: 'checkout_minted' as const, checkoutReference: row.id, country: input.country,
        requestedAmount: input.amount, sourceCurrencyCode: input.sourceCurrencyCode,
        destination: { address, asset: 'USDT' as const, network: 'polygon' as const, chainId: 137 as const }, checkoutUrl, createdAt: row.created_at.toISOString() };
    } catch (error) {
      if (!outcomeStarted && !deadline.signal.aborted) await finish('unavailable', null);
      throw error;
    }
  } finally { release(); deadline.close(); }
}
