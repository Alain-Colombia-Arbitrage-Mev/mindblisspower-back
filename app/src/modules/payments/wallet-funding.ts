import { sql } from 'drizzle-orm';
import { isIP } from 'node:net';
import { z } from 'zod';
import { readAdministrativeWallet } from '../identity/administrative-wallet';
import type { IdentityDatabase } from '../identity/model';
import { readReownProductionOptions } from './reown-funding-options';

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
  paymentMethodType: z.string().regex(/^[A-Z0-9_]{2,40}$/),
}).strict();
export const administrativeFundingInput = personalFundingInput.extend({
  serviceProvider: z.enum(['TRANSAK', 'BANXA']),
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
export async function createPersonalFundingIntent(database: FundingDatabase, rawInput: unknown, subject: string, {
  fetchImpl = fetch, signal,
}: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}) {
  const owner = subjectInput.parse(subject);
  const input = personalFundingInput.parse(rawInput);
  const options = await readReownProductionOptions(input.country, { fetchImpl, signal });
  const matching = options.routes.filter(route => route.paymentMethods.some(method => method.method === input.paymentMethodType));
  if (!matching.length) throw new Error('wallet_funding_method_unavailable');
  const allowedProviders = matching.filter(route => route.paymentMethods.some(method => method.method === input.paymentMethodType
    && input.amount >= method.minimumUsd && input.amount <= method.maximumUsd)).map(route => route.serviceProvider);
  if (!allowedProviders.length) throw new Error('wallet_funding_amount_unavailable');
  const rows = await database.execute(sql`SELECT * FROM payments.create_reown_funding_intent(
    ${owner},${input.walletAddress.toLowerCase()},${input.country},${input.amount},${input.requestId}::uuid,${input.paymentMethodType})`);
  const row = oneRow(rows, intentRow);
  if (row.id !== input.requestId) throw new Error('wallet_funding_unavailable');
  return { checkoutReference: row.id, walletKind: 'personal' as const, environment: 'production' as const,
    provider: 'reown' as const, status: 'initiated' as const, requestedAmount: input.amount, paymentMethodType: input.paymentMethodType, allowedProviders,
    createdAt: row.created_at.toISOString() };
}

type FundingDiagnostic = { event: 'wallet_funding_provider_failure'; environment: 'sandbox';
  phase: 'options' | 'session'; status: number | null; requestId?: string;
  code: 'UPSTREAM_REJECTED' | 'INVALID_RESPONSE' | 'TRANSPORT_FAILURE' | 'METHOD_UNAVAILABLE' | 'AMOUNT_OUTSIDE_ROUTE_LIMITS';
  providerCode?: string; providerRequestId?: string };
type Diagnostic = (event: FundingDiagnostic) => void;
const defaultDiagnostic: Diagnostic = event => console.warn(JSON.stringify(event));
function diagnose(diagnostic: Diagnostic, event: Omit<FundingDiagnostic, 'event' | 'environment'>) {
  // Never log upstream messages, customer data, addresses, headers or checkout URLs.
  try { diagnostic({ event: 'wallet_funding_provider_failure', environment: 'sandbox', ...event }); } catch { /* diagnostics cannot change an outcome */ }
}

// Only top-level, documented Meld codes are useful support metadata. Never
// inspect serviceProviderDetails, message, errors, headers or arbitrary fields.
const meldCodes = new Set(['ACCOUNT_OFFRAMP_NOT_ENABLED', 'ACCOUNT_ONRAMP_NOT_ENABLED', 'BAD_REQUEST',
  'CUSTOMER_KYC_NOT_APPROVED', 'CUSTOMER_NOT_FOUND', 'DUPLICATE_EXTERNAL_SESSION_ID', 'INCOMPATIBLE_REQUEST',
  'INVALID_AMOUNT', 'INVALID_AMOUNT_OR_CURRENCY', 'INVALID_AMOUNT_TOO_HIGH', 'INVALID_AMOUNT_TOO_LOW',
  'INVALID_CRYPTO_CURRENCY', 'INVALID_FIAT_CURRENCY', 'INVALID_QUERY_PARAMETER', 'NOT_SUPPORTED',
  'PASSTHROUGH_CREDENTIALS_INVALID', 'TRANSACTION_INVALID_PARAMETER', 'TRANSACTION_INVALID_PROVIDER',
  'TRANSACTION_PROPERTY_COMBINATION_NOT_SUPPORTED_BY_SERVICE_PROVIDER', 'SERVICE_PROVIDER_AUTHENTICATION_EXCEPTION',
  'VERIFICATION_REQUIRED', 'SERVICE_PROVIDER_ERROR', 'TRANSACTION_EXCEPTION', 'UNAUTHORIZED', 'FORBIDDEN',
  'CONFLICT', 'NOT_FOUND', 'UNEXPECTED_ERROR', 'JSON_PROCESSING_ERROR', 'METHOD_NOT_ALLOWED',
  'UNSUPPORTED_MEDIA_TYPE', 'NOT_ACCEPTABLE', 'ENCRYPTION_ERROR']);
function providerMetadata(value: unknown): Pick<FundingDiagnostic, 'providerCode' | 'providerRequestId'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const { code, requestId } = value as Record<string, unknown>;
  return { ...(typeof code === 'string' && meldCodes.has(code) ? { providerCode: code } : {}),
    ...(typeof requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)
      ? { providerRequestId: requestId } : {}) };
}

function fundingDeadline(parent: AbortSignal | undefined, milliseconds: number) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent?.aborted) abort(); else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, milliseconds);
  return { signal: controller.signal, dispose() { clearTimeout(timer); parent?.removeEventListener('abort', abort); } };
}
function cancelBody(value: { cancel: () => unknown } | null | undefined) {
  try { void Promise.resolve(value?.cancel()).catch(() => {}); } catch { /* best effort */ }
}
function withFundingSignal<T>(operation: () => Promise<T>, signal: AbortSignal, lateValue?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { if (settled) return; settled = true; cleanup(); reject(new Error('wallet_funding_provider_unavailable')); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { if (signal.aborted) throw new Error('wallet_funding_provider_unavailable'); return operation(); })
      .then(value => { if (settled) { lateValue?.(value); return; } settled = true; cleanup(); resolve(value); },
        error => { if (settled) return; settled = true; cleanup(); reject(error); });
  });
}

type AdministrativeRoute = { serviceProvider: 'TRANSAK' | 'BANXA';
  paymentMethods: { method: string; minimumUsd: number; maximumUsd: number }[] };
export function normalizeAdministrativeSandboxRoutes(data: unknown, serviceProvider: 'TRANSAK' | 'BANXA'): AdministrativeRoute[] {
  if (!Array.isArray(data) || data.length > 100) throw new Error('wallet_funding_provider_unavailable');
  const methods = new Map<string, { method: string; minimumUsd: number; maximumUsd: number }>();
  for (const value of data) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('wallet_funding_provider_unavailable');
    const route = value as Record<string, unknown>;
    if (route.partner !== serviceProvider) continue;
    if (route.source !== 'USD' || route.destination !== 'USDT_POLYGON' || !Array.isArray(route.paymentMethods)
      || route.paymentMethods.length > 64) throw new Error('wallet_funding_provider_unavailable');
    for (const value of route.paymentMethods) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('wallet_funding_provider_unavailable');
      const entry = value as Record<string, unknown>;
      if (typeof entry.name !== 'string' || !/^[A-Z0-9_]{2,40}$/.test(entry.name)) throw new Error('wallet_funding_provider_unavailable');
      if (entry.limits === null || entry.limits === undefined) continue;
      if (!entry.limits || typeof entry.limits !== 'object' || Array.isArray(entry.limits)) throw new Error('wallet_funding_provider_unavailable');
      const { currencyCode, min, max } = entry.limits as Record<string, unknown>;
      if (currencyCode !== 'USD' || typeof min !== 'number' || typeof max !== 'number'
        || !Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min || max > 1_000_000_000) throw new Error('wallet_funding_provider_unavailable');
      const prior = methods.get(entry.name);
      if (prior && (prior.minimumUsd !== min || prior.maximumUsd !== max)) throw new Error('wallet_funding_provider_unavailable');
      methods.set(entry.name, { method: entry.name, minimumUsd: min, maximumUsd: max });
    }
  }
  return methods.size ? [{ serviceProvider, paymentMethods: [...methods.values()] }] : [];
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

async function boundedProviderJson(response: Response, signal: AbortSignal) {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 65_536)) throw new Error('wallet_funding_unavailable');
  if (!response.body) throw new Error('wallet_funding_unavailable');
  const reader = response.body.getReader();
  const cancel = () => cancelBody(reader);
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await withFundingSignal(() => reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 65_536) { void reader.cancel().catch(() => {}); throw new Error('wallet_funding_unavailable'); }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { signal.removeEventListener('abort', cancel); try { reader.releaseLock(); } catch { /* pending cancelled read */ } }
}

/** Methods belong to this sandbox credential and selected provider only. */
export async function readAdministrativeSandboxOptions(rawInput: unknown, {
  environment = process.env, fetchImpl = fetch, diagnostic = defaultDiagnostic, requestId, signal,
}: { environment?: FundingEnvironment; fetchImpl?: typeof fetch; diagnostic?: Diagnostic; requestId?: string; signal?: AbortSignal } = {}) {
  const input = administrativeOptionsInput.parse(rawInput);
  const key = sandboxCredential(environment);
  const deadline = fundingDeadline(signal, 8_000);
  try {
  let response: Response;
  try { response = await withFundingSignal(() => fetchImpl(`https://api-sb.meld.io/network-partner/supported/routes/CRYPTO_ONRAMP/${input.country}/USD/USDT_POLYGON`, {
    method: 'GET', redirect: 'error', signal: deadline.signal,
    headers: { Authorization: `BASIC ${key}`, Accept: 'application/json', 'Meld-Version': '2026-02-03' },
  }), deadline.signal, value => cancelBody(value.body)); } catch {
    diagnose(diagnostic, { phase: 'options', status: null, requestId, code: 'TRANSPORT_FAILURE' });
    throw new Error('wallet_funding_provider_unavailable');
  }
  if ([400, 404].includes(response.status)) {
    void response.body?.cancel().catch(() => {});
    return { walletKind: 'administrative' as const, environment: 'sandbox' as const, provider: 'meld' as const,
      country: input.country, serviceProvider: input.serviceProvider, paymentMethods: [] as string[], routes: [] as AdministrativeRoute[] };
  }
  if (!response.ok) {
    let metadata = {};
    try { metadata = providerMetadata(await boundedProviderJson(response, deadline.signal)); } catch { cancelBody(response.body); }
    diagnose(diagnostic, { phase: 'options', status: response.status, requestId, code: 'UPSTREAM_REJECTED', ...metadata });
    throw new Error('wallet_funding_provider_unavailable');
  }
  let routes: AdministrativeRoute[];
  try { routes = normalizeAdministrativeSandboxRoutes(await boundedProviderJson(response, deadline.signal), input.serviceProvider); }
  catch {
    diagnose(diagnostic, { phase: 'options', status: response.status, requestId, code: 'INVALID_RESPONSE' });
    throw new Error('wallet_funding_provider_unavailable');
  }
  const paymentMethods = [...new Set(routes.flatMap(route => route.paymentMethods.map(method => method.method)))];
  return { walletKind: 'administrative' as const, environment: 'sandbox' as const, provider: 'meld' as const,
    country: input.country, serviceProvider: input.serviceProvider, paymentMethods, routes };
  } finally { deadline.dispose(); }
}

async function finishSandbox(database: FundingDatabase, subject: string, id: string,
  status: 'session_created' | 'unavailable' | 'failed', providerSessionId: string | null) {
  const rows = await database.execute(sql`SELECT payments.finish_meld_sandbox_funding_attempt(
    ${subject},${id}::uuid,${status},${providerSessionId}) AS finished`);
  if (rows.length !== 1 || (rows[0] as { finished?: unknown }).finished !== true) throw new Error('wallet_funding_unavailable');
}

/** Sandbox sessions have their own store and never touch the commission ledger. */
export async function createAdministrativeSandboxSession(database: FundingDatabase, rawInput: unknown, {
  subject, clientIp, environment = process.env, fetchImpl = fetch, diagnostic = defaultDiagnostic, signal,
}: { subject: string; clientIp: string; environment?: FundingEnvironment; fetchImpl?: typeof fetch; diagnostic?: Diagnostic; signal?: AbortSignal }) {
  // One budget includes assignment lookup, request persistence, route discovery,
  // widget creation and outcome persistence. A late/ambiguous provider result
  // never causes another session request or a false terminal settlement state.
  const deadline = fundingDeadline(signal, 15_000);
  try { return await withFundingSignal(async () => {
  const owner = subjectInput.parse(subject);
  const input = administrativeFundingInput.parse(rawInput);
  const key = sandboxCredential(environment);
  if (!isIP(clientIp)) throw new Error('wallet_funding_unconfigured');
  const wallet = await withFundingSignal(() => readAdministrativeWallet(database, { userId: owner }), deadline.signal);
  if (wallet.status !== 'assigned' || wallet.address?.toLowerCase() !== input.walletAddress.toLowerCase()) {
    throw new Error('wallet_funding_forbidden');
  }
  const paymentMethod = input.paymentMethodType;
  const rows = await withFundingSignal(() => database.execute(sql`SELECT * FROM payments.create_meld_sandbox_funding_attempt(
    ${owner},${input.walletAddress.toLowerCase()},${input.country},${input.amount},${input.requestId}::uuid,
    ${input.serviceProvider},${paymentMethod})`), deadline.signal);
  const row = oneRow(rows, sandboxRow);
  if (row.id !== input.requestId) throw new Error('wallet_funding_unavailable');
  if (!row.created) throw new Error('wallet_funding_request_already_used');
  let outcomeWriteStarted = false;
  try {
    const options = await readAdministrativeSandboxOptions({ country: input.country, serviceProvider: input.serviceProvider }, { environment, fetchImpl, diagnostic, requestId: row.id, signal: deadline.signal });
    if (!options.paymentMethods.includes(paymentMethod)) {
      outcomeWriteStarted = true;
      await withFundingSignal(() => finishSandbox(database, owner, row.id, 'unavailable', null), deadline.signal);
      diagnose(diagnostic, { phase: 'session', status: null, requestId: row.id, code: 'METHOD_UNAVAILABLE' });
      throw new Error('wallet_funding_method_unavailable');
    }
    if (!options.routes.some(route => route.paymentMethods.some(method => method.method === paymentMethod
      && input.amount >= method.minimumUsd && input.amount <= method.maximumUsd))) {
      outcomeWriteStarted = true;
      await withFundingSignal(() => finishSandbox(database, owner, row.id, 'unavailable', null), deadline.signal);
      diagnose(diagnostic, { phase: 'session', status: null, requestId: row.id, code: 'AMOUNT_OUTSIDE_ROUTE_LIMITS' });
      throw new Error('wallet_funding_amount_unavailable');
    }
    const response = await withFundingSignal(() => fetchImpl('https://api-sb.meld.io/crypto/session/widget', {
      method: 'POST', redirect: 'error', signal: deadline.signal,
      headers: { Authorization: `BASIC ${key}`, 'Content-Type': 'application/json', Accept: 'application/json',
        'Meld-Version': '2026-02-03' },
      body: JSON.stringify({ sessionType: 'BUY', externalCustomerId: row.id, externalSessionId: row.id,
        sessionData: { serviceProvider: input.serviceProvider, countryCode: input.country, clientIpAddress: clientIp,
          sourceCurrencyCode: 'USD', sourceAmount: input.amount.toFixed(2), destinationCurrencyCode: 'USDT_POLYGON',
          walletAddress: wallet.address,
          paymentMethodType: paymentMethod,
          lockFields: ['walletAddress', 'destinationCurrencyCode', 'sourceCurrencyCode', 'sourceAmount', 'paymentMethodType'],
        } }),
    }), deadline.signal, value => cancelBody(value.body));
    const data = await boundedProviderJson(response, deadline.signal);
    if (!response.ok) {
      outcomeWriteStarted = true;
      await withFundingSignal(() => finishSandbox(database, owner, row.id, 'unavailable', null), deadline.signal);
      diagnose(diagnostic, { phase: 'session', status: response.status, requestId: row.id, code: 'UPSTREAM_REJECTED', ...providerMetadata(data) });
      throw new Error('wallet_funding_provider_unavailable');
    }
    const providerSession = sessionInput.parse(data);
    if ((providerSession.externalSessionId && providerSession.externalSessionId !== row.id)
      || (providerSession.externalCustomerId && providerSession.externalCustomerId !== row.id)) {
      throw new Error('wallet_funding_invalid_provider');
    }
    const checkoutUrl = sandboxWidgetUrl(providerSession.widgetUrl);
    outcomeWriteStarted = true;
    await withFundingSignal(() => finishSandbox(database, owner, row.id, 'session_created', providerSession.id), deadline.signal);
    return { checkoutReference: row.id, walletKind: 'administrative' as const, environment: 'sandbox' as const,
      provider: 'meld' as const, status: 'session_created' as const, checkoutUrl,
      requestedAmount: input.amount, createdAt: row.created_at.toISOString() };
  } catch (error) {
    if (!outcomeWriteStarted && !deadline.signal.aborted) {
      await withFundingSignal(() => finishSandbox(database, owner, row.id, 'failed', null), deadline.signal);
      diagnose(diagnostic, { phase: 'session', status: null, requestId: row.id, code: 'INVALID_RESPONSE' });
    }
    throw error;
  }
  }, deadline.signal); } finally { deadline.dispose(); }
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
