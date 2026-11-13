import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Interface, formatUnits, getAddress, parseUnits, verifyMessage } from 'ethers';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { IdentityDatabase } from '../identity/model';
import { LEGACY_POLYGON_TOKEN } from './personal-company-rpc';

type Database = Pick<IdentityDatabase, 'execute'>;
type Environment = Record<string, string | undefined>;
export type AdministrativeSigningPrincipal = { subject: string; nativeSessionId: string };
type Dependencies = { environment?: Environment; now?: () => number; id?: () => string; nonce?: () => string; signal?: AbortSignal; timeoutMs?: number };
const ownerInput = z.string().min(1).max(255), uuid = z.string().uuid();
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const signature = z.string().regex(/^0x(?:[0-9a-f]{128}|[0-9a-f]{130})$/i);
const erc20 = new Interface(['function transfer(address recipient,uint256 amount)']);
const maximum = 1_000_000_000n * 1_000_000n;
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const principal = (value: AdministrativeSigningPrincipal) => ({ subject: ownerInput.parse(value.subject), nativeSessionId: ownerInput.parse(value.nativeSessionId) });
function boundedDatabase(database: Database, parent: AbortSignal | undefined, timeoutMs = 8000) {
  const controller = new AbortController(), abort = () => controller.abort();
  if (parent?.aborted) abort(); else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, Math.min(Math.max(timeoutMs, 1), 15000));
  return { execute(query: SQL) {
    return new Promise<unknown[]>((resolve, reject) => {
      let settled = false;
      const cancelled = () => { if (settled) return; settled = true; controller.signal.removeEventListener('abort', cancelled); reject(new Error('administrative_signing_unavailable')); };
      if (controller.signal.aborted) { cancelled(); return; }
      controller.signal.addEventListener('abort', cancelled, { once: true });
      Promise.resolve().then(() => { if (controller.signal.aborted) throw new Error('administrative_signing_unavailable'); return database.execute(query); }).then(rows => {
        if (settled) return; settled = true; controller.signal.removeEventListener('abort', cancelled); resolve(rows);
      }, error => { if (settled) return; settled = true; controller.signal.removeEventListener('abort', cancelled); reject(error); });
    });
  }, close() { clearTimeout(timer); parent?.removeEventListener('abort', abort); } };
}
export function administrativeSigningCapabilities(environment: Environment = process.env) {
  const configured = environment.ADMINISTRATIVE_WALLET_SIGNING_ENABLED === 'true' && environment.MELD_ADMIN_SANDBOX_ENABLED === 'true';
  const key = environment.MELD_API_SANDBOX, account = environment.MELD_ACCOUNT_ID;
  return { flow: 'administrative_signing' as const, configured, mode: 'external' as const, environment: 'sandbox' as const,
    chainId: 137 as const, broadcastEnabled: false as const, canBroadcast: false as const,
    canPrepareOfframp: configured && environment.ADMINISTRATIVE_MELD_OFFRAMP_ENABLED === 'true'
      && typeof key === 'string' && key.length > 0 && key.length <= 2048 && !/\s/.test(key)
      && typeof account === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(account) && account !== '.' && account !== '..' };
}
function requireConfiguration(environment: Environment) {
  if (!administrativeSigningCapabilities(environment).configured) throw new Error('administrative_signing_unconfigured');
}
function one<T>(rows: unknown[], input: z.ZodType<T>): T {
  const parsed = input.safeParse(rows[0]);
  if (rows.length !== 1 || !parsed.success) throw new Error('administrative_signing_unavailable');
  return parsed.data;
}
const statusInput = z.object({ wallet_address: address, verified: z.boolean(), binding_expires_at: z.coerce.date().nullable() });
function projectStatus(row: z.infer<typeof statusInput>, environment: Environment, now: number) {
  if (!Number.isFinite(now) || row.verified !== (row.binding_expires_at !== null)
    || (row.binding_expires_at && row.binding_expires_at.getTime() <= now)) throw new Error('administrative_signing_unavailable');
  return { ...administrativeSigningCapabilities(environment), assignedAddress: row.wallet_address, verified: row.verified,
    ...(row.binding_expires_at ? { expiresAt: row.binding_expires_at.toISOString() } : {}) };
}
export async function readAdministrativeSigningStatus(database: Database, input: AdministrativeSigningPrincipal,
  { environment = process.env, now = Date.now, signal, timeoutMs }: Dependencies = {}) {
  requireConfiguration(environment); const p = principal(input);
  const operation = boundedDatabase(database, signal, timeoutMs);
  try { return projectStatus(one(await operation.execute(sql`SELECT * FROM identity.read_administrative_wallet_signing_status(
    ${p.subject},${p.nativeSessionId})`), statusInput), environment, now()); } finally { operation.close(); }
}

const challengeInput = z.object({ id: uuid, address, chain_id: z.coerce.number().refine(value => value === 137),
  nonce: digest, message: z.string().min(1).max(4096), message_hash: digest, issued_at: z.coerce.date(), expires_at: z.coerce.date(), session_context_hash: digest });
export function administrativeWalletOwnershipMessage(input: { address: string; challengeId: string; nonce: string; issuedAt: Date;
  expiresAt: Date; sessionContextHash: string }) {
  return `wallet.mindblisspower.com wants you to verify control of this administrative wallet:\n${input.address}\n\nMindbliss administrative wallet ownership only. No transaction or transfer of funds.\nSession context: ${input.sessionContextHash}\n\nURI: https://wallet.mindblisspower.com/dashboard/wallet-administrative\nVersion: 1\nChain ID: 137\nNonce: ${input.nonce}\nIssued At: ${input.issuedAt.toISOString()}\nExpiration Time: ${input.expiresAt.toISOString()}\nRequest ID: ${input.challengeId}`;
}
function challenge(rows: unknown[], p: AdministrativeSigningPrincipal, now: number) {
  const row = one(rows, challengeInput), expectedContext = sha256(`${p.subject}\n${p.nativeSessionId}`);
  const message = administrativeWalletOwnershipMessage({ address: row.address, challengeId: row.id, nonce: row.nonce,
    issuedAt: row.issued_at, expiresAt: row.expires_at, sessionContextHash: expectedContext });
  if (!Number.isFinite(now) || row.expires_at.getTime() <= now || row.issued_at.getTime() > now + 30_000
    || row.expires_at.getTime() - row.issued_at.getTime() > 300_000 || row.expires_at <= row.issued_at
    || row.session_context_hash !== expectedContext || row.message !== message || row.message_hash !== sha256(message)) {
    throw new Error('administrative_signing_invalid_challenge');
  }
  return row;
}

const gates = new WeakMap<Database, Map<string, { count: number; reset: number; active: boolean }>>();
function acquire(database: Database, p: AdministrativeSigningPrincipal, now: number) {
  let values = gates.get(database); if (!values) { values = new Map(); gates.set(database, values); }
  for (const [key, value] of values) if (!value.active && value.reset <= now) values.delete(key);
  const key = `${p.subject}\0${p.nativeSessionId}`;
  let value = values.get(key);
  if (!Number.isFinite(now) || value?.active || (value && value.count >= 30) || (!value && values.size >= 10_000)) throw new Error('administrative_signing_rate_limited');
  if (!value) { value = { count: 0, reset: now + 600_000, active: false }; values.set(key, value); }
  value.count++; value.active = true;
  return () => { value.active = false; };
}
export async function createAdministrativeSigningChallenge(database: Database, raw: unknown, input: AdministrativeSigningPrincipal,
  { environment = process.env, now = Date.now, id = randomUUID, nonce = () => randomBytes(32).toString('hex'), signal, timeoutMs }: Dependencies = {}) {
  requireConfiguration(environment); z.object({}).strict().parse(raw); const p = principal(input), current = now();
  const challengeId = uuid.parse(id()).toLowerCase(), nonceValue = digest.parse(nonce());
  const release = acquire(database, p, current);
  const operation = boundedDatabase(database, signal, timeoutMs);
  try {
    const row = challenge(await operation.execute(sql`SELECT * FROM identity.create_administrative_wallet_signing_challenge(
      ${p.subject},${p.nativeSessionId},${challengeId}::uuid,${nonceValue})`), p, current);
    if (row.id !== challengeId || row.nonce !== nonceValue) throw new Error('administrative_signing_unavailable');
    return { challengeId: row.id, address: row.address, chainId: 137 as const, message: row.message, expiresAt: row.expires_at.toISOString(), method: 'personal_sign' as const };
  } finally { operation.close(); release(); }
}
export const verifyAdministrativeSigningInput = z.object({ challengeId: uuid, signature }).strict();
export async function verifyAdministrativeSigningChallenge(database: Database, raw: unknown, input: AdministrativeSigningPrincipal,
  { environment = process.env, now = Date.now, signal, timeoutMs }: Dependencies = {}) {
  requireConfiguration(environment); const value = verifyAdministrativeSigningInput.parse(raw), p = principal(input), current = now();
  const release = acquire(database, p, current);
  const operation = boundedDatabase(database, signal, timeoutMs);
  try {
    const rows = await operation.execute(sql`SELECT * FROM identity.read_administrative_wallet_signing_challenge(
      ${p.subject},${p.nativeSessionId},${value.challengeId}::uuid)`);
    if (!rows.length) throw new Error('administrative_signing_invalid_challenge');
    const row = challenge(rows, p, current);
    if (row.id.toLowerCase() !== value.challengeId.toLowerCase()) throw new Error('administrative_signing_invalid_challenge');
    let recovered: string;
    try { recovered = getAddress(verifyMessage(row.message, value.signature)).toLowerCase(); }
    catch { throw new Error('administrative_signing_signature_invalid'); }
    if (recovered !== row.address) throw new Error('administrative_signing_signature_invalid');
    const saved = one(await operation.execute(sql`SELECT * FROM identity.consume_administrative_wallet_signing_challenge(
      ${p.subject},${p.nativeSessionId},${row.id}::uuid,${recovered},${row.message_hash},${sha256(value.signature)})`),
    z.object({ verified: z.literal(true), binding_expires_at: z.coerce.date(), address, chain_id: z.coerce.number().refine(chain => chain === 137) }));
    if (saved.address !== row.address || saved.binding_expires_at.getTime() <= current) throw new Error('administrative_signing_unavailable');
    return projectStatus({ wallet_address: row.address, verified: true, binding_expires_at: saved.binding_expires_at }, environment, current);
  } finally { operation.close(); release(); }
}

const amountText = z.string().max(17).regex(/^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,6})?$/);
export const administrativeTransferInput = z.object({ requestId: uuid, recipient: z.string().regex(/^0x[0-9a-f]{40}$/i), amount: amountText }).strict();
export function administrativeTransferSnapshot(from: string, recipient: string, amount: string) {
  let source: string, target: string, atomic: bigint;
  try { source = getAddress(from).toLowerCase(); target = getAddress(recipient).toLowerCase(); } catch { throw new Error('administrative_transfer_invalid_recipient'); }
  try { amountText.parse(amount); atomic = parseUnits(amount, 6); } catch { throw new Error('administrative_transfer_invalid_amount'); }
  if (atomic <= 0n || atomic > maximum) throw new Error('administrative_transfer_invalid_amount');
  if (target === `0x${'0'.repeat(40)}` || target === source || target === LEGACY_POLYGON_TOKEN) throw new Error('administrative_transfer_invalid_recipient');
  const data = erc20.encodeFunctionData('transfer', [target, atomic]).toLowerCase();
  const canonical = JSON.stringify({ version: 1, chainId: 137, from: source, to: LEGACY_POLYGON_TOKEN, recipient: target,
    amountUnits: atomic.toString(), data, value: '0x0' });
  return { source, recipient: target, amount: formatUnits(atomic, 6).replace(/\.?0+$/, ''), amountUnits: atomic.toString(),
    transaction: { chainId: 137 as const, from: source, to: LEGACY_POLYGON_TOKEN, data, value: '0x0' as const }, preparationHash: sha256(canonical) };
}
const draftInput = z.object({ id: uuid, wallet_address: address, recipient_address: address,
  amount_atomic: z.string().regex(/^[1-9][0-9]{0,15}$/), calldata: z.string().regex(/^0xa9059cbb[0-9a-f]{128}$/),
  preparation_hash: digest, created_at: z.coerce.date(), expires_at: z.coerce.date() });
function draft(value: unknown) {
  const row = draftInput.safeParse(value); if (!row.success) throw new Error('administrative_transfer_unavailable');
  const r = row.data, atomic = BigInt(r.amount_atomic);
  let snapshot: ReturnType<typeof administrativeTransferSnapshot>;
  try { snapshot = administrativeTransferSnapshot(r.wallet_address, r.recipient_address, formatUnits(atomic, 6)); }
  catch { throw new Error('administrative_transfer_unavailable'); }
  if (snapshot.transaction.data !== r.calldata || snapshot.preparationHash !== r.preparation_hash || snapshot.amountUnits !== r.amount_atomic
    || r.expires_at <= r.created_at) throw new Error('administrative_transfer_unavailable');
  return { flow: 'administrative_transfer' as const, status: 'draft' as const, mode: 'dry_run' as const,
    broadcastEnabled: false as const, canBroadcast: false as const, draftReference: r.id,
    source: { address: snapshot.source, asset: 'USDT' as const, network: 'polygon' as const, chainId: 137 as const },
    recipient: snapshot.recipient, amount: snapshot.amount, transaction: snapshot.transaction, preparationHash: snapshot.preparationHash,
    createdAt: r.created_at.toISOString(), expiresAt: r.expires_at.toISOString() };
}
export async function prepareAdministrativeTransfer(database: Database, raw: unknown, input: AdministrativeSigningPrincipal,
  { environment = process.env, now = Date.now, signal, timeoutMs }: Dependencies = {}) {
  requireConfiguration(environment); const value = administrativeTransferInput.parse(raw), p = principal(input);
  const release = acquire(database, p, now());
  const operation = boundedDatabase(database, signal, timeoutMs);
  try {
    const status = projectStatus(one(await operation.execute(sql`SELECT * FROM identity.read_administrative_wallet_signing_status(
      ${p.subject},${p.nativeSessionId})`), statusInput), environment, now());
    if (!status.verified) throw new Error('administrative_transfer_binding_required');
    const snapshot = administrativeTransferSnapshot(status.assignedAddress, value.recipient, value.amount);
    const rows = await operation.execute(sql`SELECT * FROM payments.prepare_administrative_wallet_transfer(
      ${p.subject},${p.nativeSessionId},${value.requestId.toLowerCase()}::uuid,${snapshot.recipient},${snapshot.amount},${snapshot.transaction.data},${snapshot.preparationHash})`);
    if (rows.length !== 1) throw new Error('administrative_transfer_unavailable');
    const result = draft(rows[0]);
    if (result.draftReference !== value.requestId.toLowerCase() || result.source.address !== snapshot.source
      || result.recipient !== snapshot.recipient || result.preparationHash !== snapshot.preparationHash) throw new Error('administrative_transfer_unavailable');
    return result;
  } finally { operation.close(); release(); }
}
export async function readAdministrativeTransferHistory(database: Database, input: AdministrativeSigningPrincipal,
  { environment = process.env, signal, timeoutMs }: Dependencies = {}) {
  requireConfiguration(environment); const p = principal(input);
  const operation = boundedDatabase(database, signal, timeoutMs);
  try {
  const rows = await operation.execute(sql`SELECT * FROM payments.read_administrative_wallet_transfer_history(${p.subject},${p.nativeSessionId})`);
  if (rows.length > 50) throw new Error('administrative_transfer_unavailable');
  const records = rows.map(draft);
  if (new Set(records.map(row => row.draftReference)).size !== records.length) throw new Error('administrative_transfer_unavailable');
  return { flow: 'administrative_transfer' as const, mode: 'dry_run' as const, broadcastEnabled: false as const, canBroadcast: false as const, records };
  } finally { operation.close(); }
}
