import { sql } from 'drizzle-orm';
import { isIP } from 'node:net';
import { z } from 'zod';
import { readAdministrativeWallet } from '../identity/administrative-wallet';
import type { IdentityDatabase } from '../identity/model';

type FundingDatabase = Pick<IdentityDatabase, 'execute'>;
type FundingEnvironment = Record<string, string | undefined>;
const subjectInput = z.string().min(1).max(255);
const addressInput = z.string().regex(/^0x[0-9a-f]{40}$/i);
const amountInput = z.number().finite().min(50).max(25_000)
  .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001);
export const fundingKindInput = z.enum(['personal', 'administrative']);
export const personalFundingInput = z.object({
  requestId: z.string().uuid(), walletAddress: addressInput,
  country: z.string().regex(/^[A-Z]{2}$/), amount: amountInput,
}).strict();
export const administrativeFundingInput = personalFundingInput.extend({
  serviceProvider: z.enum(['TRANSAK', 'BANXA']),
  paymentMethodType: z.string().regex(/^[A-Z0-9_]{2,40}$/).optional(),
}).strict();
export const administrativeOptionsInput = z.object({
  country: z.string().regex(/^[A-Z]{2}$/), serviceProvider: z.enum(['TRANSAK', 'BANXA']),
}).strict();

const intentRow = z.object({ id: z.string().uuid(), created_at: z.coerce.date() });
const sandboxRow = intentRow.extend({ created: z.boolean(), status: z.string() });

function oneRow<T>(rows: unknown[], schema: z.ZodType<T>): T {
  if (rows.length !== 1) throw new Error('wallet_funding_unavailable');
  return schema.parse(rows[0]);
}

/** Records a request only. Reown owns the real quote and payment flow. */
export async function createPersonalFundingIntent(database: FundingDatabase, rawInput: unknown, subject: string) {
  const owner = subjectInput.parse(subject);
  const input = personalFundingInput.parse(rawInput);
  const rows = await database.execute(sql`SELECT * FROM payments.create_reown_funding_intent(
    ${owner},${input.walletAddress.toLowerCase()},${input.country},${input.amount},${input.requestId}::uuid)`);
  const row = oneRow(rows, intentRow);
  if (row.id !== input.requestId) throw new Error('wallet_funding_unavailable');
  return { checkoutReference: row.id, walletKind: 'personal' as const, environment: 'production' as const,
    provider: 'reown' as const, status: 'initiated' as const, requestedAmount: input.amount,
    createdAt: row.created_at.toISOString() };
}

function sandboxCredential(environment: FundingEnvironment) {
  const key = environment.MELD_API_SANDBOX;
  if (environment.MELD_ADMIN_SANDBOX_ENABLED !== 'true' || !key || key.length > 2048 || /\s/.test(key)) {
    throw new Error('wallet_funding_unconfigured');
  }
  return key;
}

const sessionInput = z.object({
  id: z.string().min(1).max(128), widgetUrl: z.string().min(1).max(8192),
  externalSessionId: z.string().optional(), externalCustomerId: z.string().optional(),
});

export function sandboxWidgetUrl(value: string) {
  const url = new URL(value);
  if (url.origin !== 'https://sb.meldcrypto.com' || url.username || url.password || url.hash
    || !url.search || !['/', '/widget'].includes(url.pathname)) throw new Error('wallet_funding_invalid_provider');
  return url.href;
}

async function boundedProviderJson(response: Response) {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 65_536)) throw new Error('wallet_funding_unavailable');
  if (!response.body) throw new Error('wallet_funding_unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 65_536) { void reader.cancel().catch(() => {}); throw new Error('wallet_funding_unavailable'); }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { reader.releaseLock(); }
}

function canonicalPaymentMethod(value: string) {
  return ['CARD', 'VISA', 'MASTERCARD'].includes(value) ? 'CREDIT_DEBIT_CARD' : value;
}

/** Methods belong to this sandbox credential and selected provider only. */
export async function readAdministrativeSandboxOptions(rawInput: unknown, {
  environment = process.env, fetchImpl = fetch,
}: { environment?: FundingEnvironment; fetchImpl?: typeof fetch } = {}) {
  const input = administrativeOptionsInput.parse(rawInput);
  const key = sandboxCredential(environment);
  const response = await fetchImpl(`https://api-sb.meld.io/network-partner/supported/routes/CRYPTO_ONRAMP/${input.country}/USD/USDT_POLYGON`, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8_000),
    headers: { Authorization: `BASIC ${key}`, Accept: 'application/json', 'Meld-Version': '2026-02-03' },
  });
  if ([400, 404].includes(response.status)) {
    void response.body?.cancel().catch(() => {});
    return { walletKind: 'administrative' as const, environment: 'sandbox' as const, provider: 'meld' as const,
      country: input.country, serviceProvider: input.serviceProvider, paymentMethods: [] as string[] };
  }
  if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error('wallet_funding_provider_unavailable'); }
  const data = await boundedProviderJson(response);
  const routes = Array.isArray(data) ? data : data && typeof data === 'object' && Array.isArray(data.routes) ? data.routes : [];
  const paymentMethods: string[] = [];
  for (const route of routes.slice(0, 100)) {
    if (!route || typeof route !== 'object' || Array.isArray(route) || route.partner !== input.serviceProvider || !Array.isArray(route.paymentMethods)) continue;
    for (const method of route.paymentMethods) {
      if (!method || typeof method !== 'object' || Array.isArray(method)) continue;
      const raw = method.name || method.paymentMethodSubType || method.subType || method.paymentMethodType || method.paymentType || method.type;
      if (typeof raw !== 'string') continue;
      const code = canonicalPaymentMethod(raw);
      if (/^[A-Z0-9_]{2,40}$/.test(code) && !paymentMethods.includes(code)) paymentMethods.push(code);
    }
  }
  return { walletKind: 'administrative' as const, environment: 'sandbox' as const, provider: 'meld' as const,
    country: input.country, serviceProvider: input.serviceProvider, paymentMethods: paymentMethods.slice(0, 20) };
}

async function finishSandbox(database: FundingDatabase, subject: string, id: string,
  status: 'session_created' | 'unavailable' | 'failed', providerSessionId: string | null) {
  const rows = await database.execute(sql`SELECT payments.finish_meld_sandbox_funding_attempt(
    ${subject},${id}::uuid,${status},${providerSessionId}) AS finished`);
  if (rows.length !== 1 || (rows[0] as { finished?: unknown }).finished !== true) throw new Error('wallet_funding_unavailable');
}

/** Sandbox sessions have their own store and never touch the commission ledger. */
export async function createAdministrativeSandboxSession(database: FundingDatabase, rawInput: unknown, {
  subject, clientIp, environment = process.env, fetchImpl = fetch,
}: { subject: string; clientIp: string; environment?: FundingEnvironment; fetchImpl?: typeof fetch }) {
  const owner = subjectInput.parse(subject);
  const input = administrativeFundingInput.parse(rawInput);
  const key = sandboxCredential(environment);
  if (!isIP(clientIp)) throw new Error('wallet_funding_unconfigured');
  const wallet = await readAdministrativeWallet(database, { userId: owner });
  if (wallet.status !== 'assigned' || wallet.address?.toLowerCase() !== input.walletAddress.toLowerCase()) {
    throw new Error('wallet_funding_forbidden');
  }
  const paymentMethod = input.paymentMethodType || 'CREDIT_DEBIT_CARD';
  const rows = await database.execute(sql`SELECT * FROM payments.create_meld_sandbox_funding_attempt(
    ${owner},${input.walletAddress.toLowerCase()},${input.country},${input.amount},${input.requestId}::uuid,
    ${input.serviceProvider},${paymentMethod})`);
  const row = oneRow(rows, sandboxRow);
  if (row.id !== input.requestId) throw new Error('wallet_funding_unavailable');
  if (!row.created) throw new Error('wallet_funding_request_already_used');
  let outcomeWriteStarted = false;
  try {
    const options = await readAdministrativeSandboxOptions({ country: input.country, serviceProvider: input.serviceProvider }, { environment, fetchImpl });
    if (!options.paymentMethods.includes(paymentMethod)) {
      outcomeWriteStarted = true;
      await finishSandbox(database, owner, row.id, 'unavailable', null);
      throw new Error('wallet_funding_method_unavailable');
    }
    const response = await fetchImpl('https://api-sb.meld.io/crypto/session/widget', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12_000),
      headers: { Authorization: `BASIC ${key}`, 'Content-Type': 'application/json', Accept: 'application/json',
        'Meld-Version': '2026-02-03' },
      body: JSON.stringify({ sessionType: 'BUY', externalCustomerId: row.id, externalSessionId: row.id,
        sessionData: { serviceProvider: input.serviceProvider, countryCode: input.country, clientIpAddress: clientIp,
          sourceCurrencyCode: 'USD', sourceAmount: input.amount.toFixed(2), destinationCurrencyCode: 'USDT_POLYGON',
          walletAddress: wallet.address,
          paymentMethodType: paymentMethod,
          lockFields: ['walletAddress', 'destinationCurrencyCode', 'sourceCurrencyCode', 'sourceAmount', 'paymentMethodType'],
        } }),
    });
    const data = await boundedProviderJson(response);
    if (!response.ok) {
      outcomeWriteStarted = true;
      await finishSandbox(database, owner, row.id, 'unavailable', null);
      throw new Error('wallet_funding_provider_unavailable');
    }
    const providerSession = sessionInput.parse(data);
    if ((providerSession.externalSessionId && providerSession.externalSessionId !== row.id)
      || (providerSession.externalCustomerId && providerSession.externalCustomerId !== row.id)) {
      throw new Error('wallet_funding_invalid_provider');
    }
    const checkoutUrl = sandboxWidgetUrl(providerSession.widgetUrl);
    outcomeWriteStarted = true;
    await finishSandbox(database, owner, row.id, 'session_created', providerSession.id);
    return { checkoutReference: row.id, walletKind: 'administrative' as const, environment: 'sandbox' as const,
      provider: 'meld' as const, status: 'session_created' as const, checkoutUrl,
      requestedAmount: input.amount, createdAt: row.created_at.toISOString() };
  } catch (error) {
    if (!outcomeWriteStarted) await finishSandbox(database, owner, row.id, 'failed', null);
    throw error;
  }
}

const historyRow = z.object({
  id: z.string().uuid(), wallet_kind: fundingKindInput, environment: z.enum(['production', 'sandbox']),
  provider: z.enum(['reown', 'meld']), status: z.enum(['initiated', 'session_created', 'unavailable', 'failed']),
  wallet_address: addressInput, country_code: z.string().regex(/^[A-Z]{2}$/),
  requested_amount: z.coerce.number().finite().min(50).max(25_000), created_at: z.coerce.date(),
});

export async function readWalletFundingHistory(database: FundingDatabase, subject: string, rawKind: unknown) {
  const owner = subjectInput.parse(subject);
  const walletKind = fundingKindInput.parse(rawKind);
  const rows = await database.execute(sql`SELECT * FROM payments.read_wallet_funding_history(${owner},${walletKind})`);
  if (rows.length > 20) throw new Error('wallet_funding_unavailable');
  const items = rows.map(value => {
    const row = historyRow.parse(value);
    const personal = walletKind === 'personal';
    if (row.wallet_kind !== walletKind || row.environment !== (personal ? 'production' : 'sandbox')
      || row.provider !== (personal ? 'reown' : 'meld') || (personal && row.status !== 'initiated')) {
      throw new Error('wallet_funding_unavailable');
    }
    return { checkoutReference: row.id, provider: row.provider,
      status: row.status, country: row.country_code,
      requestedAmount: row.requested_amount, createdAt: row.created_at.toISOString() };
  });
  return { walletKind, environment: walletKind === 'personal' ? 'production' as const : 'sandbox' as const,
    records: items, settlement: 'unconfirmed' as const };
}
