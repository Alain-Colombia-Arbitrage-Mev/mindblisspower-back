import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { TypedDataEncoder } from 'ethers';
import { z } from 'zod';
import type { IdentityDatabase } from '../identity/model';
import { readWalletBinding } from '../identity/wallet-link';
import { companyPaymentAtomic, COMPANY_PAYMENT_RECIPIENT, LEGACY_POLYGON_TOKEN, POLYGON_USDC_TOKEN } from './personal-company-rpc';
import { POLYGON_RELAY_ENTRY_POINT, POLYGON_RELAY_IMPLEMENTATION, polygonRelayCapabilities, polygonRelayTypedData,
  polygonRelayPolicy, readPolygonRelayAuthorization, verifyPolygonRelayAuthorization } from './polygon-relay-policy';
import { encryptPolygonRelayJson, decryptPolygonRelayJson } from './polygon-relay-crypto';
import { createPolygonAaRelayer, prepareSignedPolygonRelayOperation, sendPersistedPolygonRelayOperation } from './polygon-relay-aa';
import { readCanonicalPolygonNativeNonce, readPolygonRelayProof, validateSavedPolygonRelayOperation, type PolygonRelayProofContext } from './polygon-relay-proof';
import { POLYGON_USDC_DOMAIN, POLYGON_USDC_IMPLEMENTATION, polygonUsdcTypedData, readPolygonUsdcAuthorization, verifyPolygonUsdcAuthorization } from './polygon-usdc-authorization';

type Database = Pick<IdentityDatabase, 'execute'>;
type Options = { environment?: Record<string, string | undefined>; fetchImpl?: typeof fetch; signal?: AbortSignal; allowUsdc?: boolean;
  /** Server dependency injection for deterministic offline integration tests. */
  createRelayer?: typeof createPolygonAaRelayer };
const uuid = z.string().uuid(), ownerSchema = z.string().min(1).max(255), address = z.string().regex(/^0x[0-9a-f]{40}$/);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/), uint = z.string().regex(/^(?:0|[1-9][0-9]{0,77})$/).refine(value => BigInt(value) < 1n << 256n);
const amount = z.string().refine(companyPaymentAtomic), keyId = z.string().regex(/^[a-z0-9_-]{1,16}$/);
export const preparePolygonRelayInput = z.object({ requestId: uuid, amountAtomic: amount, asset: z.enum(['USDT', 'USDC']).optional() }).strict();
export const authorizePolygonRelayInput = z.object({ paymentId: uuid, signature: z.string().regex(/^0x[0-9a-f]{130}$/i) }).strict();
export const polygonRelayPaymentInput = z.object({ paymentId: uuid }).strict();
const rowSchema = z.object({ id: uuid, subject: ownerSchema, wallet_address: address, amount_atomic: amount,
  execution_mode: z.literal('polygon_native_meta_aa'), chain_id: z.literal(137), token_address: z.enum([LEGACY_POLYGON_TOKEN, POLYGON_USDC_TOKEN]),
  token_decimals: z.literal(6), recipient_address: z.literal(COMPANY_PAYMENT_RECIPIENT), authorization_nonce: uint,
  authorization_digest: hash, domain_separator: hash, implementation_address: z.enum([POLYGON_RELAY_IMPLEMENTATION, POLYGON_USDC_IMPLEMENTATION]),
  relayer_address: address, entry_point: z.literal(POLYGON_RELAY_ENTRY_POINT), max_fee_wei: amount, owner_daily_cap_wei: amount, global_daily_cap_wei: amount,
  created_at: z.coerce.date(), expires_at: z.coerce.date(), authorized_at: z.coerce.date().nullable(),
  authorization_ciphertext: z.string().max(16384).nullable(), authorization_key_id: keyId.nullable(),
  status: z.enum(['prepared', 'authorized', 'broadcasting', 'ambiguous', 'submitted', 'confirmed', 'failed', 'expired', 'reconciliation_required']),
  attempt_id: uuid.nullable(), user_operation_hash: hash.nullable(), transaction_hash: hash.nullable(),
  block_number: uint.nullable(), block_hash: hash.nullable(), confirmations: z.number().int().min(0).max(1_000_000_000),
  confirmed_at: z.coerce.date().nullable(), failure_reason: z.enum(['transaction_reverted', 'user_operation_reverted', 'authorization_nonce_changed',
    'sponsorship_rejected', 'operation_expired', 'transaction_mismatch', 'preparation_expired', 'preparation_abandoned']).nullable(),
  entry_point_nonce: uint.nullable(), lease_token: uuid.nullable(), lease_expires_at: z.coerce.date().nullable(),
  operation_ciphertext: z.string().max(45000).nullable(), operation_key_id: keyId.nullable(), quoted_max_fee_wei: uint.nullable(),
  operation_valid_after: z.coerce.number().int().min(0).nullable(), operation_valid_until: z.coerce.number().int().positive().nullable(),
  should_prepare: z.boolean().optional(), should_send: z.boolean().optional() });
type Row = z.infer<typeof rowSchema>;
function one(rows: unknown[], owner: string, id?: string): Row {
  if (!rows.length) throw new Error('polygon_relay_not_found');
  const parsed = rows.length === 1 ? rowSchema.safeParse(rows[0]) : null;
  if (!parsed?.success) throw new Error('polygon_relay_unavailable');
  const row = parsed.data;
  if (row.subject !== owner || (id && row.id !== id) || row.expires_at <= row.created_at || row.expires_at.getTime() - row.created_at.getTime() > 300_000
    || (row.token_address === POLYGON_USDC_TOKEN ? row.implementation_address !== POLYGON_USDC_IMPLEMENTATION || row.expires_at.getTime() % 1000 !== 0
      || row.domain_separator !== TypedDataEncoder.hashDomain(POLYGON_USDC_DOMAIN)
      || BigInt(row.authorization_nonce) === 0n || BigInt(row.authorization_nonce) >= 1n << 128n : row.implementation_address !== POLYGON_RELAY_IMPLEMENTATION)
    || row.max_fee_wei !== BigInt(row.max_fee_wei).toString() || BigInt(row.max_fee_wei) > 10n ** 18n
    || BigInt(row.owner_daily_cap_wei) > 2n * 10n ** 18n || BigInt(row.global_daily_cap_wei) > 10n ** 19n
    || (row.status === 'confirmed' && (!row.transaction_hash || !row.user_operation_hash || !row.block_number || !row.block_hash || row.confirmations < 12 || !row.confirmed_at || row.failure_reason))
    || (row.status === 'prepared' && (row.authorized_at || row.authorization_ciphertext || row.attempt_id || row.transaction_hash || row.user_operation_hash))
    || (!['prepared', 'expired'].includes(row.status) && (!row.authorized_at || !row.authorization_ciphertext || !row.authorization_key_id))
    || (row.status === 'authorized' && (row.attempt_id || row.user_operation_hash || row.transaction_hash))) throw new Error('polygon_relay_unavailable');
  if (row.token_address === POLYGON_USDC_TOKEN) {
    const typed = polygonUsdcTypedData(row.wallet_address, row.amount_atomic, row.authorization_nonce, Math.floor(row.expires_at.getTime() / 1000));
    if (TypedDataEncoder.hash(typed.domain, typed.types, typed.message) !== row.authorization_digest) throw new Error('polygon_relay_unavailable');
  }
  return row;
}
const validBefore = (row: Row) => row.token_address === POLYGON_USDC_TOKEN ? Math.floor(row.expires_at.getTime() / 1000) : undefined;
function typedData(row: Row) {
  const before = validBefore(row);
  return before === undefined ? polygonRelayTypedData(row.wallet_address, row.amount_atomic, row.authorization_nonce)
    : polygonUsdcTypedData(row.wallet_address, row.amount_atomic, row.authorization_nonce, before);
}
function verifyAuthorization(row: Row, signature: string) {
  const before = validBefore(row);
  return before === undefined ? verifyPolygonRelayAuthorization(row.wallet_address, row.amount_atomic, row.authorization_nonce, signature)
    : verifyPolygonUsdcAuthorization(row.wallet_address, row.amount_atomic, row.authorization_nonce, before, signature);
}
function readAuthorization(environment: Record<string, string | undefined>, row: Row, fetchImpl: typeof fetch, signal?: AbortSignal) {
  const before = validBefore(row);
  return before === undefined ? readPolygonRelayAuthorization(environment, row.wallet_address, row.amount_atomic, fetchImpl, signal)
    : readPolygonUsdcAuthorization(environment, row.wallet_address, row.amount_atomic, row.authorization_nonce, before, fetchImpl, signal);
}
function view(row: Row, typed = false, confirmations = row.confirmations) {
  const usdc = row.token_address === POLYGON_USDC_TOKEN;
  return { paymentId: row.id, walletKind: 'personal' as const, executionMode: row.execution_mode, chainId: row.chain_id,
    tokenAddress: row.token_address, tokenDecimals: row.token_decimals, walletAddress: row.wallet_address, recipientAddress: row.recipient_address,
    amountAtomic: row.amount_atomic, status: row.status, authorizationNonce: row.authorization_nonce, authorizationDigest: row.authorization_digest,
    authorizationHasOnchainExpiry: usdc, ...(usdc ? { asset: 'USDC' as const } : {}), relayerAddress: row.relayer_address, entryPointAddress: row.entry_point,
    createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(), userOperationHash: row.user_operation_hash,
    transactionHash: row.transaction_hash, blockNumber: row.block_number, blockHash: row.block_hash, confirmations, requiredConfirmations: 12,
    confirmedAt: row.confirmed_at?.toISOString() ?? null, failureReason: row.failure_reason, membershipAssignment: 'pending' as const,
    typedData: typed && row.status === 'prepared' ? typedData(row) : null };
}
async function readRow(database: Database, owner: string, id: string, allowUsdc = false) {
  const row = one(await database.execute(sql`SELECT * FROM payments.read_personal_polygon_relay(${owner},${id}::uuid)`), owner, id);
  if (!allowUsdc && row.token_address === POLYGON_USDC_TOKEN) throw new Error('polygon_relay_not_found');
  return row;
}
function errorCode(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const part = current as { message?: unknown; cause?: unknown };
    if (typeof part.message === 'string' && part.message.startsWith('polygon_relay_')) return part.message;
    current = part.cause;
  }
  return '';
}
function enabled(environment: Record<string, string | undefined>) {
  if (!polygonRelayCapabilities(environment).transferEnabled) throw new Error('polygon_relay_unconfigured');
}
function requireUsdc(environment: Record<string, string | undefined>, allowUsdc?: boolean) {
  if (!allowUsdc || environment.PERSONAL_POLYGON_USDC_ENABLED !== 'true') throw new Error('polygon_relay_unconfigured');
}
function active(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); }
async function ownedAddress(database: Database, owner: string) {
  const binding = await readWalletBinding(database, { userId: owner });
  if (!binding.linked || !binding.address || !address.safeParse(binding.address.toLowerCase()).success) throw new Error('polygon_relay_wallet_not_linked');
  return binding.address.toLowerCase();
}
const authorizationContext = (owner: string, id: string) => `polygon-relay:${owner}:${id}:authorization`;
const operationContext = (owner: string, id: string, attempt: string) => `polygon-relay:${owner}:${id}:operation:${attempt}`;
function authorizationSignature(row: Row, environment: Record<string, string | undefined>) {
  const stored = z.object({ signature: z.string().regex(/^0x[0-9a-f]{130}$/i), authorizationDigest: hash }).strict()
    .parse(decryptPolygonRelayJson(environment, authorizationContext(row.subject, row.id), row.authorization_ciphertext!));
  const verified = verifyAuthorization(row, stored.signature);
  if (stored.authorizationDigest !== row.authorization_digest || verified.authorizationDigest !== row.authorization_digest) throw new Error('polygon_relay_authorization_unavailable');
  return stored.signature;
}
function proofContext(row: Row): PolygonRelayProofContext {
  if (!row.entry_point_nonce || !row.user_operation_hash || row.operation_valid_after === null || row.operation_valid_until === null) throw new Error('polygon_relay_proof_unavailable');
  if (!row.attempt_id) throw new Error('polygon_relay_proof_unavailable');
  return { paymentId: row.id, attemptId: row.attempt_id, walletAddress: row.wallet_address, amountAtomic: row.amount_atomic, authorizationNonce: row.authorization_nonce, relayerAddress: row.relayer_address,
    entryPointNonce: row.entry_point_nonce, userOperationHash: row.user_operation_hash, maxFeeWei: row.max_fee_wei,
    operationValidAfter: row.operation_valid_after, operationValidUntil: row.operation_valid_until, usdcValidBefore: validBefore(row) };
}

export async function preparePersonalPolygonRelay(database: Database, raw: unknown, userId: string,
  { environment = process.env, fetchImpl = fetch, signal, createRelayer = createPolygonAaRelayer, allowUsdc }: Options = {}) {
  const owner = ownerSchema.parse(userId), input = preparePolygonRelayInput.parse(raw); enabled(environment); active(signal);
  const usdc = input.asset === 'USDC';
  if (usdc) requireUsdc(environment, allowUsdc);
  const tokenAddress = usdc ? POLYGON_USDC_TOKEN : LEGACY_POLYGON_TOKEN;
  // Return an immutable exact replay before observing a nonce that may already
  // have changed onchain. A reused UUID can never select a new amount/wallet.
  try {
    const existing = await readRow(database, owner, input.requestId, allowUsdc);
    if (existing.amount_atomic !== input.amountAtomic || existing.token_address !== tokenAddress) throw new Error('polygon_relay_request_already_used');
    return view(existing, true);
  } catch (error) { if (errorCode(error) !== 'polygon_relay_not_found') throw error; }
  const sender = await ownedAddress(database, owner);
  const now = Math.floor(Date.now() / 1000);
  const usdcValidBefore = Math.min(now + 240, (Math.floor(now / 86400) + 1) * 86400);
  const usdcNonce = usdc ? BigInt('0x' + createHash('sha256').update(`mindbliss:polygon-usdc:137:${sender}:${input.requestId}`).digest('hex').slice(0, 32)).toString() : '';
  const [snapshot, relayer] = await Promise.all([
    usdc ? readPolygonUsdcAuthorization(environment, sender, input.amountAtomic, usdcNonce, usdcValidBefore, fetchImpl, signal)
      : readPolygonRelayAuthorization(environment, sender, input.amountAtomic, fetchImpl, signal),
    createRelayer(environment, fetchImpl, signal, now * 1000, usdc ? usdcValidBefore : undefined),
  ]);
  active(signal); const policy = polygonRelayPolicy(environment);
  const prepare = usdc ? sql`SELECT * FROM payments.prepare_personal_polygon_usdc_relay(${owner},${sender},${input.amountAtomic},${input.requestId}::uuid,
    ${snapshot.authorizationNonce},${snapshot.authorizationDigest},${relayer.relayerAddress},${usdcValidBefore}::bigint,
    ${policy.maxFeeWei},${policy.ownerDailyCapWei},${policy.globalDailyCapWei})`
    : sql`SELECT * FROM payments.prepare_personal_polygon_relay(${owner},${sender},${input.amountAtomic},${input.requestId}::uuid,
    ${snapshot.authorizationNonce},${snapshot.authorizationDigest},${relayer.relayerAddress},${POLYGON_RELAY_ENTRY_POINT},${snapshot.domainSeparator},${POLYGON_RELAY_IMPLEMENTATION},
    ${policy.maxFeeWei},${policy.ownerDailyCapWei},${policy.globalDailyCapWei})`;
  // The App origin is already established by the authenticated relay route.
  // The same database statement freezes the accounting lots before a signature
  // can be requested. Older prepared payment IDs only take the replay path.
  const registerAccounting = allowUsdc && environment.ENV === 'production' && environment.APP_PAGAR_ACCOUNTING_ENABLED === 'true';
  const rows = await database.execute(registerAccounting ? sql`
    WITH draft AS MATERIALIZED (${prepare})
    SELECT draft.*,payments.register_app_pagar_intent_v1(draft.subject,draft.id) AS accounting_intent FROM draft
  ` : prepare);
  if (registerAccounting && typeof rows[0]?.accounting_intent !== 'boolean') throw new Error('polygon_relay_unavailable');
  const row = one(rows, owner, input.requestId);
  if (row.token_address !== tokenAddress || row.authorization_nonce !== snapshot.authorizationNonce || row.amount_atomic !== input.amountAtomic
    || row.wallet_address !== sender || row.relayer_address !== relayer.relayerAddress
    || (!usdc && row.authorization_digest !== snapshot.authorizationDigest)
    || (usdc && row.domain_separator !== snapshot.domainSeparator))
    throw new Error('polygon_relay_unavailable');
  return view(row, true);
}
export async function authorizePersonalPolygonRelay(database: Database, raw: unknown, userId: string, { environment = process.env, fetchImpl = fetch, signal, allowUsdc }: Options = {}) {
  const owner = ownerSchema.parse(userId), input = authorizePolygonRelayInput.parse(raw); enabled(environment);
  const row = await readRow(database, owner, input.paymentId, allowUsdc);
  if (row.token_address === POLYGON_USDC_TOKEN) requireUsdc(environment, allowUsdc);
  const verified = verifyAuthorization(row, input.signature);
  if (verified.authorizationDigest !== row.authorization_digest) throw new Error('polygon_relay_signature_invalid');
  if (row.authorized_at) return view(row);
  const snapshot = await readAuthorization(environment, row, fetchImpl, signal);
  if (snapshot.authorizationNonce !== row.authorization_nonce || snapshot.authorizationDigest !== row.authorization_digest || snapshot.domainSeparator !== row.domain_separator) throw new Error('polygon_relay_authorization_nonce_changed');
  const encrypted = encryptPolygonRelayJson(environment, authorizationContext(owner, row.id), { signature: verified.signature, authorizationDigest: verified.authorizationDigest });
  active(signal);
  return view(one(await database.execute(sql`SELECT * FROM payments.authorize_personal_polygon_relay(${owner},${row.id}::uuid,${verified.authorizationDigest},${encrypted.ciphertext},${encrypted.keyId})`), owner, row.id));
}
export async function submitPersonalPolygonRelay(database: Database, raw: unknown, userId: string,
  { environment = process.env, fetchImpl = fetch, signal, createRelayer = createPolygonAaRelayer, allowUsdc }: Options = {}) {
  const owner = ownerSchema.parse(userId), input = polygonRelayPaymentInput.parse(raw); enabled(environment);
  const initial = await readRow(database, owner, input.paymentId, allowUsdc);
  if (initial.token_address === POLYGON_USDC_TOKEN) requireUsdc(environment, allowUsdc);
  if (initial.status !== 'authorized') return view(initial);
  const signature = authorizationSignature(initial, environment);
  const [snapshot, relayer] = await Promise.all([readAuthorization(environment, initial, fetchImpl, signal), createRelayer(environment, fetchImpl, signal, Date.now(), validBefore(initial))]);
  if (snapshot.authorizationNonce !== initial.authorization_nonce || snapshot.authorizationDigest !== initial.authorization_digest) throw new Error('polygon_relay_authorization_nonce_changed');
  if (relayer.relayerAddress !== initial.relayer_address) throw new Error('polygon_relay_authorization_unavailable');
  // One explicitly serialized EntryPoint lane. SDK nonce-key managers must not
  // silently choose another key that the durable queue/expiry proof cannot see.
  const nonce = await relayer.account.getNonce({ key: 0n }); active(signal);
  const attempt = randomUUID();
  const leased = one(await database.execute(sql`SELECT * FROM payments.begin_personal_polygon_relay(${owner},${initial.id}::uuid,${attempt}::uuid,${nonce.toString()})`), owner, initial.id);
  if (!leased.should_prepare) return view(leased);
  if (!leased.attempt_id || !leased.lease_token || leased.entry_point_nonce !== nonce.toString()) throw new Error('polygon_relay_unavailable');
  let persisted = false;
  try {
    const operation = await prepareSignedPolygonRelayOperation(relayer, { paymentId: leased.id, attemptId: leased.attempt_id, walletAddress: leased.wallet_address, amountAtomic: leased.amount_atomic,
      authorizationNonce: leased.authorization_nonce, signature, entryPointNonce: nonce.toString(), maxFeeWei: leased.max_fee_wei,
      usdcValidBefore: validBefore(leased) }, environment);
    const encrypted = encryptPolygonRelayJson(environment, operationContext(owner, leased.id, leased.attempt_id), operation); active(signal);
    const saved = one(await database.execute(sql`SELECT * FROM payments.persist_personal_polygon_relay_operation(${owner},${leased.id}::uuid,${leased.attempt_id}::uuid,${leased.lease_token}::uuid,
      ${operation.userOperationHash},${encrypted.ciphertext},${encrypted.keyId},${operation.operationValidAfter},${operation.operationValidUntil},${operation.maxCostWei})`), owner, leased.id);
    if (!saved.should_send) return view(saved);
    persisted = true;
    if (saved.user_operation_hash !== operation.userOperationHash || saved.attempt_id !== leased.attempt_id || !saved.operation_ciphertext) throw new Error('polygon_relay_unavailable');
    const checked = validateSavedPolygonRelayOperation(decryptPolygonRelayJson(environment, operationContext(owner, saved.id, saved.attempt_id), saved.operation_ciphertext), proofContext(saved), signature);
    // Once signed bytes are durably persisted, ANY timeout retains the lane and
    // budget. Never send again on HTTP replay or generate a replacement nonce.
    active(signal);
    if (validBefore(saved) !== undefined && checked.operationValidUntil <= Math.floor(Date.now() / 1000)) throw new Error('polygon_relay_expired');
    await sendPersistedPolygonRelayOperation(environment, checked, fetchImpl, signal);
    return view(one(await database.execute(sql`SELECT * FROM payments.mark_personal_polygon_relay_submitted(${owner},${saved.id}::uuid,${saved.attempt_id}::uuid,${saved.user_operation_hash},${null})`), owner, saved.id));
  } catch (error) {
    if (persisted) return view(one(await database.execute(sql`SELECT * FROM payments.mark_personal_polygon_relay_ambiguous(${owner},${leased.id}::uuid,${leased.attempt_id}::uuid)`), owner, leased.id));
    await database.execute(sql`SELECT * FROM payments.release_personal_polygon_relay_attempt(${owner},${leased.id}::uuid,${leased.attempt_id}::uuid,${leased.lease_token}::uuid,${'sponsorship_rejected'})`);
    throw error;
  }
}
export async function verifyPersonalPolygonRelay(database: Database, raw: unknown, userId: string, { environment = process.env, fetchImpl = fetch, signal, allowUsdc }: Options = {}) {
  const owner = ownerSchema.parse(userId), input = polygonRelayPaymentInput.parse(raw), row = await readRow(database, owner, input.paymentId, allowUsdc);
  if (row.status === 'prepared' && row.expires_at.getTime() <= Date.now()) return view(one(await database.execute(sql`SELECT * FROM payments.expire_personal_polygon_relay(${owner},${row.id}::uuid)`), owner, row.id));
  if (row.status === 'authorized') {
    const before = validBefore(row);
    const canonical = await readCanonicalPolygonNativeNonce(environment, row.wallet_address, fetchImpl, signal,
      before === undefined ? undefined : row.authorization_nonce); active(signal);
    if (BigInt(canonical.observedNativeNonce) <= BigInt(row.authorization_nonce)) {
      if (before === undefined || canonical.canonicalTimestamp === undefined || BigInt(canonical.canonicalTimestamp) < BigInt(before)) return view(row);
      return view(one(await database.execute(sql`SELECT * FROM payments.expire_personal_polygon_usdc_authorization(${owner},${row.id}::uuid,
        ${canonical.blockNumber},${canonical.blockHash},${canonical.canonicalTimestamp}::bigint,${canonical.confirmations})`), owner, row.id));
    }
    return view(one(await database.execute(sql`SELECT * FROM payments.retire_native_polygon_relay_authorization(${owner},${row.id}::uuid,
      ${canonical.observedNativeNonce},${canonical.blockNumber},${canonical.blockHash},${canonical.confirmations})`), owner, row.id));
  }
  if (!['broadcasting', 'submitted', 'ambiguous'].includes(row.status)) return view(row);
  if (!row.user_operation_hash) {
    if (row.operation_ciphertext || !row.attempt_id || !row.lease_token || !row.lease_expires_at) throw new Error('polygon_relay_unavailable');
    if (row.lease_expires_at.getTime() > Date.now()) return view(row);
    // Fenced unsigned lease recovery cannot sponsor, sign or transmit anything.
    return view(one(await database.execute(sql`SELECT * FROM payments.release_personal_polygon_relay_attempt(${owner},${row.id}::uuid,${row.attempt_id}::uuid,${row.lease_token}::uuid,${'preparation_timeout'})`), owner, row.id));
  }
  if (!row.attempt_id || !row.operation_ciphertext) throw new Error('polygon_relay_unavailable');
  const signature = authorizationSignature(row, environment), context = proofContext(row);
  const saved = validateSavedPolygonRelayOperation(decryptPolygonRelayJson(environment, operationContext(owner, row.id, row.attempt_id), row.operation_ciphertext), context, signature);
  const proof = await readPolygonRelayProof(environment, context, saved, fetchImpl, signal); active(signal);
  if (proof.state === 'pending') return view(row, false, proof.confirmations);
  if (proof.state === 'expired') return view(one(await database.execute(sql`SELECT * FROM payments.expire_personal_polygon_relay_operation(${owner},${row.id}::uuid,${row.attempt_id}::uuid,
    ${row.user_operation_hash},${proof.blockNumber},${proof.blockHash},${proof.canonicalTimestamp},${proof.observedEntryPointNonce},${proof.confirmations},${proof.observedNativeNonce})`), owner, row.id));
  const rows = proof.state === 'confirmed' ? await database.execute(sql`SELECT * FROM payments.confirm_personal_polygon_relay(${owner},${row.id}::uuid,${row.attempt_id}::uuid,
      ${row.user_operation_hash},${proof.transactionHash},${proof.blockNumber},${proof.blockHash},${proof.confirmations},${proof.actualGasCostWei})`)
    : await database.execute(sql`SELECT * FROM payments.reject_personal_polygon_relay(${owner},${row.id}::uuid,${row.attempt_id}::uuid,
      ${row.user_operation_hash},${proof.transactionHash},${proof.blockNumber},${proof.blockHash},${proof.confirmations},${proof.actualGasCostWei},${proof.reason},${proof.observedNativeNonce})`);
  const result = one(rows, owner, row.id);
  if (proof.state === 'confirmed' && (result.status !== 'confirmed' || result.transaction_hash !== proof.transactionHash || result.block_hash !== proof.blockHash)) throw new Error('polygon_relay_unavailable');
  return view(result);
}
export async function readPersonalPolygonRelay(database: Database, userId: string, paymentId: unknown, allowUsdc = false) {
  return view(await readRow(database, ownerSchema.parse(userId), uuid.parse(paymentId), allowUsdc), true);
}
export async function abandonPersonalPolygonRelay(database: Database, raw: unknown, userId: string, { signal, allowUsdc }: Options = {}) {
  const owner = ownerSchema.parse(userId), input = polygonRelayPaymentInput.parse(raw); active(signal);
  if (!allowUsdc) await readRow(database, owner, input.paymentId);
  const row = one(await database.execute(sql`SELECT * FROM payments.abandon_personal_polygon_relay(${owner},${input.paymentId}::uuid)`), owner, input.paymentId);
  if (row.status !== 'expired' || row.failure_reason !== 'preparation_abandoned' || row.authorized_at || row.authorization_ciphertext || row.attempt_id) throw new Error('polygon_relay_unavailable');
  return view(row);
}
export async function readPersonalPolygonRelayHistory(database: Database, userId: string, allowUsdc = false, usdcSchema = false) {
  const owner = ownerSchema.parse(userId);
  const rows = usdcSchema && allowUsdc
    ? await database.execute(sql`SELECT * FROM payments.read_personal_polygon_relay_history_v2(${owner})`)
    : await database.execute(sql`SELECT * FROM payments.read_personal_polygon_relay_history(${owner})`);
  if (rows.length > 20) throw new Error('polygon_relay_unavailable');
  const payments = rows.map(row => one([row], owner)).filter(row => allowUsdc || row.token_address !== POLYGON_USDC_TOKEN).map(row => view(row));
  if (new Set(payments.map(row => row.paymentId)).size !== payments.length) throw new Error('polygon_relay_unavailable');
  return { walletKind: 'personal' as const, payments };
}
