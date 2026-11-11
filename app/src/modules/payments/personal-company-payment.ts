import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { IdentityDatabase } from '../identity/model';
import { readWalletBinding } from '../identity/wallet-link';
import { checkCompanyPaymentBalance, checkCompanyPaymentSubmission, companyPaymentAtomic, createCompanyPaymentRpc,
  verifyCompanyPaymentReceipt, COMPANY_PAYMENT_CHAIN_ID, COMPANY_PAYMENT_TOKEN, COMPANY_PAYMENT_RECIPIENT,
  COMPANY_PAYMENT_DECIMALS, COMPANY_PAYMENT_CONFIRMATIONS, companyPaymentNetwork, readCompanyPaymentBalances, readPersonalWalletNetworkBalances, LEGACY_POLYGON_TOKEN } from './personal-company-rpc';

type Database = Pick<IdentityDatabase, 'execute'>;
type Options = { environment?: Record<string, string | undefined>; fetchImpl?: typeof fetch; signal?: AbortSignal };
const uuid = z.string().uuid();
const subject = z.string().min(1).max(255);
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const atomic = z.string().refine(companyPaymentAtomic);
const paymentChainId = z.union([z.literal(1), z.literal(137)]);
export const prepareCompanyPaymentInput = z.object({ requestId: uuid, amountAtomic: atomic, chainId: paymentChainId.default(1) }).strict();
export const submitCompanyPaymentInput = z.object({ paymentId: uuid, transactionHash: hash }).strict();
export const verifyCompanyPaymentInput = z.object({ paymentId: uuid }).strict();
const rowSchema = z.object({ id: uuid, wallet_address: address, recipient_address: z.literal(COMPANY_PAYMENT_RECIPIENT),
  chain_id: paymentChainId, token_address: address, token_decimals: z.literal(COMPANY_PAYMENT_DECIMALS),
  amount_atomic: atomic, status: z.enum(['prepared', 'submitted', 'confirmed', 'failed']), expires_at: z.coerce.date(), created_at: z.coerce.date(),
  transaction_hash: hash.nullable(), block_number: z.string().regex(/^[1-9][0-9]{0,18}$/).nullable(), block_hash: hash.nullable(),
  abandoned_at: z.coerce.date().nullable(),
  confirmations: z.number().int().min(0).max(1_000_000_000), failure_reason: z.enum(['transaction_reverted', 'transaction_mismatch']).nullable() });
type PaymentRow = z.infer<typeof rowSchema>;
function one(rows: unknown[], paymentId?: string): PaymentRow {
  if (!rows.length) throw new Error('company_payment_not_found');
  if (rows.length !== 1) throw new Error('company_payment_unavailable');
  const parsed = rowSchema.safeParse(rows[0]);
  if (!parsed.success) throw new Error('company_payment_unavailable');
  const row = parsed.data;
  if (!companyPaymentNetwork(row.chain_id, row.token_address) || (paymentId && row.id !== paymentId) || row.expires_at <= row.created_at || (row.abandoned_at !== null && row.abandoned_at < row.created_at)
    || (row.status === 'prepared' && (row.transaction_hash !== null || row.block_number !== null || row.block_hash !== null || row.confirmations !== 0 || row.failure_reason !== null))
    || (row.status !== 'prepared' && row.transaction_hash === null)
    || (row.status === 'confirmed' && (row.block_number === null || row.block_hash === null || row.confirmations < COMPANY_PAYMENT_CONFIRMATIONS || row.failure_reason !== null))
    || (row.status === 'failed' && row.failure_reason === null)
    || (!['confirmed', 'failed'].includes(row.status) && row.failure_reason !== null)) throw new Error('company_payment_unavailable');
  return row;
}
function view(row: PaymentRow, confirmations = row.confirmations) {
  return { paymentId: row.id, walletKind: 'personal' as const, walletAddress: row.wallet_address, recipientAddress: row.recipient_address,
    chainId: row.chain_id, tokenAddress: row.token_address, tokenDecimals: row.token_decimals, amountAtomic: row.amount_atomic,
    status: row.status, expiresAt: row.expires_at.toISOString(), createdAt: row.created_at.toISOString(), abandonedAt: row.abandoned_at?.toISOString() ?? null,
    transactionHash: row.transaction_hash, blockNumber: row.block_number, blockHash: row.block_hash, confirmations,
    requiredConfirmations: COMPANY_PAYMENT_CONFIRMATIONS, failureReason: row.failure_reason,
    membershipAssignment: 'pending' as const };
}
function active(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); }
async function readRow(database: Database, owner: string, paymentId: string) {
  return one(await database.execute(sql`SELECT * FROM payments.read_personal_company_payment(${owner},${paymentId}::uuid)`), paymentId);
}

async function boundPersonalWalletAddress(database: Database, userId: string, signal?: AbortSignal) {
  const owner = subject.parse(userId);
  active(signal);
  const binding = await readWalletBinding(database, { userId: owner });
  if (!binding.linked || typeof binding.address !== 'string') throw new Error('company_payment_wallet_not_linked');
  if (binding.chainId !== COMPANY_PAYMENT_CHAIN_ID) throw new Error('company_payment_unavailable');
  const walletAddress = address.parse(binding.address.toLowerCase());
  active(signal);
  return walletAddress;
}

/** The session selects one verified owner binding; no client address or financial writer is accepted. */
export async function readPersonalCompanyPaymentBalance(database: Database, userId: string, {
  environment = process.env, fetchImpl = fetch, signal,
}: Options = {}) {
  const walletAddress = await boundPersonalWalletAddress(database, userId, signal);
  const rpc = createCompanyPaymentRpc(environment, fetchImpl, signal);
  try {
    const balances = await readCompanyPaymentBalances(rpc, walletAddress);
    active(rpc.signal);
    return { walletKind: 'personal' as const, walletAddress, chainId: COMPANY_PAYMENT_CHAIN_ID,
      tokenAddress: COMPANY_PAYMENT_TOKEN, tokenDecimals: COMPANY_PAYMENT_DECIMALS, asset: 'USDT' as const, network: 'ethereum' as const,
      ...balances, observedAt: new Date().toISOString() };
  } finally { rpc.dispose(); }
}

/** Independent display snapshots. A failed network never overwrites the other network with zero. */
export async function readPersonalCompanyPaymentBalances(database: Database, userId: string, {
  environment = process.env, fetchImpl = fetch, signal,
}: Options = {}) {
  const walletAddress = await boundPersonalWalletAddress(database, userId, signal);
  const networks = [{ chainId: 1, tokenAddress: COMPANY_PAYMENT_TOKEN, network: 'ethereum' },
    { chainId: 137, tokenAddress: LEGACY_POLYGON_TOKEN, network: 'polygon' }] as const;
  const balances = await Promise.all(networks.map(async network => {
    const snapshot = { walletKind: 'personal' as const, walletAddress, ...network, tokenDecimals: COMPANY_PAYMENT_DECIMALS, asset: 'USDT' as const };
    let rpc: ReturnType<typeof createCompanyPaymentRpc> | undefined;
    try {
      rpc = createCompanyPaymentRpc(environment, fetchImpl, signal, network.chainId);
      const values = await readPersonalWalletNetworkBalances(rpc, walletAddress);
      active(rpc.signal);
      return { ...snapshot, ...values, observedAt: new Date().toISOString() };
    } catch {
      active(signal);
      return { ...snapshot, balanceAtomic: null, nativeBalanceAtomic: null, observedAt: null, error: 'company_payment_rpc_unavailable' as const };
    } finally { rpc?.dispose(); }
  }));
  active(signal);
  return { walletKind: 'personal' as const, walletAddress, balances };
}

/** Preparation fixes a payment snapshot. It cannot broadcast or approve token spending. */
export async function preparePersonalCompanyPayment(database: Database, raw: unknown, userId: string, {
  environment = process.env, fetchImpl = fetch, signal,
}: Options = {}) {
  const owner = subject.parse(userId), input = prepareCompanyPaymentInput.parse(raw);
  const rpc = createCompanyPaymentRpc(environment, fetchImpl, signal, input.chainId);
  try {
    active(signal);
    let previous: PaymentRow | undefined;
    try { previous = await readRow(database, owner, input.requestId); }
    catch (error) { if (!(error instanceof Error) || error.message !== 'company_payment_not_found') throw error; }
    if (previous) {
      if (previous.amount_atomic !== input.amountAtomic || previous.chain_id !== input.chainId) throw new Error('company_payment_request_already_used');
      if (previous.status === 'prepared' && previous.abandoned_at === null) await checkCompanyPaymentBalance(rpc, previous.wallet_address, previous.amount_atomic);
      active(rpc.signal);
      return view(previous);
    }
    const binding = await readWalletBinding(database, { userId: owner });
    if (!binding.linked || typeof binding.address !== 'string') throw new Error('company_payment_wallet_not_linked');
    const sender = binding.address.toLowerCase();
    await checkCompanyPaymentBalance(rpc, sender, input.amountAtomic);
    active(rpc.signal);
    const row = one(await database.execute(sql`SELECT * FROM payments.prepare_personal_company_payment_v3(
      ${owner},${sender},${input.amountAtomic},${input.requestId}::uuid,${input.chainId})`), input.requestId);
    if (row.chain_id !== input.chainId || row.token_address !== rpc.policy.tokenAddress || row.wallet_address !== sender || row.amount_atomic !== input.amountAtomic) throw new Error('company_payment_unavailable');
    return view(row);
  } finally { rpc.dispose(); }
}

/** Registration is safe to repeat for the same hash; it never sends a transaction. */
export async function submitPersonalCompanyPayment(database: Database, raw: unknown, userId: string, {
  environment = process.env, fetchImpl = fetch, signal,
}: Options = {}) {
  const owner = subject.parse(userId), input = submitCompanyPaymentInput.parse(raw);
  const row = await readRow(database, owner, input.paymentId);
  if (row.transaction_hash) {
    if (row.transaction_hash !== input.transactionHash) throw new Error('company_payment_request_already_used');
    return view(row);
  }
  const rpc = createCompanyPaymentRpc(environment, fetchImpl, signal, row.chain_id);
  try {
    await checkCompanyPaymentSubmission(rpc, input.transactionHash, row.wallet_address, row.amount_atomic);
    active(rpc.signal);
    const saved = one(await database.execute(sql`SELECT * FROM payments.submit_personal_company_payment(
      ${owner},${input.paymentId}::uuid,${input.transactionHash})`), input.paymentId);
    if (saved.chain_id !== row.chain_id || saved.token_address !== row.token_address || saved.transaction_hash !== input.transactionHash || saved.wallet_address !== row.wallet_address || saved.amount_atomic !== row.amount_atomic) {
      throw new Error('company_payment_unavailable');
    }
    return view(saved);
  } finally { rpc.dispose(); }
}

/** Only a real canonical receipt can confirm payment. No membership or ledger writer is called. */
export async function verifyPersonalCompanyPayment(database: Database, raw: unknown, userId: string, {
  environment = process.env, fetchImpl = fetch, signal,
}: Options = {}) {
  const owner = subject.parse(userId), input = verifyCompanyPaymentInput.parse(raw);
  const row = await readRow(database, owner, input.paymentId);
  if (row.status !== 'submitted' || !row.transaction_hash) return view(row);
  const rpc = createCompanyPaymentRpc(environment, fetchImpl, signal, row.chain_id);
  try {
    const proof = await verifyCompanyPaymentReceipt(rpc, row.transaction_hash, row.wallet_address, row.amount_atomic);
    active(rpc.signal);
    if (proof.state === 'pending') return view(row, proof.confirmations);
    const rows = proof.state === 'confirmed'
      ? await database.execute(sql`SELECT * FROM payments.verify_personal_company_payment(${owner},${row.id}::uuid,
        ${row.transaction_hash},${proof.blockNumber},${proof.blockHash},${proof.confirmations})`)
      : await database.execute(sql`SELECT * FROM payments.reject_personal_company_payment(${owner},${row.id}::uuid,
        ${row.transaction_hash},${proof.reason})`);
    const saved = one(rows, input.paymentId);
    if (saved.chain_id !== row.chain_id || saved.token_address !== row.token_address || saved.transaction_hash !== row.transaction_hash || saved.amount_atomic !== row.amount_atomic || saved.wallet_address !== row.wallet_address
      || saved.status !== (proof.state === 'confirmed' ? 'confirmed' : 'failed')
      // Another verifier can have committed the same immutable receipt at an
      // earlier sufficient confirmation count. Never overwrite that snapshot.
      || (proof.state === 'confirmed' && (saved.block_number !== proof.blockNumber || saved.block_hash !== proof.blockHash || saved.confirmations < COMPANY_PAYMENT_CONFIRMATIONS))
      || (proof.state === 'failed' && saved.failure_reason !== proof.reason)) throw new Error('company_payment_unavailable');
    return view(saved);
  } finally { rpc.dispose(); }
}

export async function readPersonalCompanyPayment(database: Database, userId: string, paymentId: unknown) {
  return view(await readRow(database, subject.parse(userId), uuid.parse(paymentId)));
}
/** Dismiss an unsent draft only. The record and any late real transaction remain recoverable. */
export async function abandonPersonalCompanyPayment(database: Database, raw: unknown, userId: string, { signal }: Options = {}) {
  const owner = subject.parse(userId), input = verifyCompanyPaymentInput.parse(raw);
  active(signal);
  const row = one(await database.execute(sql`SELECT * FROM payments.abandon_personal_company_payment(${owner},${input.paymentId}::uuid)`), input.paymentId);
  if (row.status !== 'prepared' || row.transaction_hash !== null || row.abandoned_at === null) throw new Error('company_payment_unavailable');
  return view(row);
}
export async function readPersonalCompanyPaymentHistory(database: Database, userId: string) {
  const rows = await database.execute(sql`SELECT * FROM payments.read_personal_company_payment_history(${subject.parse(userId)})`);
  if (rows.length > 20) throw new Error('company_payment_unavailable');
  const records = rows.map(row => view(one([row])));
  if (new Set(records.map(row => row.paymentId)).size !== records.length) throw new Error('company_payment_unavailable');
  return { walletKind: 'personal' as const, records, membershipAssignment: 'pending' as const };
}
