import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { IdentityDatabase } from '../identity/model';
import { verifyAppMeldAccountingLot } from './app-meld-funding-status';
import { productionOperation, productionScope } from './meld-production-http';
import { checkCompanyPaymentChain, createCompanyPaymentRpc } from './personal-company-rpc';
import { readPersonalPolygonRelay, verifyPersonalPolygonRelay } from './polygon-relay-payment';

type Database = Pick<IdentityDatabase, 'execute'>;
type Environment = Record<string, string | undefined>;
type Dependencies = { environment?: Environment; fetchImpl?: typeof fetch; signal?: AbortSignal };
const uuid = z.string().uuid();
const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const quantity = z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i).transform(BigInt);
const block = z.object({ number: quantity, hash });
const integer = z.union([z.string(), z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.bigint()])
  .transform(String).pipe(z.string().regex(/^[1-9][0-9]{0,18}$/));
const pending = z.array(z.object({ subject: z.string().min(1).max(255), payment_id: uuid })).max(5);
const lots = z.array(z.object({
  attempt_id: uuid,
  meld_transaction_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  gross_usd_minor: integer,
  received_atomic: integer,
  blockchain_tx_hash: hash,
  block_number: integer,
  block_hash: hash,
  transfer_log_index: z.number().int().nonnegative().max(2_147_483_647),
})).max(20).refine(items => new Set(items.map(item => item.attempt_id)).size === items.length);
const roiRun = z.object({ activated: z.number().int().nonnegative(), accrued_days: z.number().int().nonnegative() });

async function finalizedHeight(paymentBlock: bigint, paymentHash: string, environment: Environment,
  fetchImpl: typeof fetch, signal: AbortSignal) {
  const rpc = createCompanyPaymentRpc({ ...environment, PERSONAL_COMPANY_PAYMENTS_ENABLED: 'true' }, fetchImpl, signal, 137);
  try {
    await checkCompanyPaymentChain(rpc);
    const latest = block.parse(await rpc.call('eth_getBlockByNumber', ['finalized', false]));
    if (latest.number < paymentBlock || latest.number > 9_223_372_036_854_775_807n) return null;
    const proof = block.parse(await rpc.call('eth_getBlockByNumber', [`0x${paymentBlock.toString(16)}`, false]));
    return proof.number === paymentBlock && proof.hash === paymentHash ? latest.number.toString() : null;
  } finally { rpc.dispose(); }
}

/** Only the private scheduled worker supplies owner, payment and independently verified evidence. */
export async function runAppPagarAccounting(database: Database, {
  environment = process.env, fetchImpl = fetch, signal,
}: Dependencies = {}) {
  if (environment.ENV !== 'production' || environment.APP_PAGAR_ACCOUNTING_ENABLED !== 'true') return { recorded: 0 };
  const scope = productionScope(signal);
  let recorded = 0;
  try {
    const rows = pending.parse(await productionOperation(() => database.execute(sql`
      SELECT * FROM payments.read_app_pagar_pending_v1()
    `), scope.signal));
    for (const { subject, payment_id: paymentId } of rows) {
      if (scope.signal.aborted) break;
      try {
        const selected = lots.parse(await productionOperation(() => database.execute(sql`
          SELECT * FROM payments.read_app_pagar_candidates_v1(${subject},${paymentId}::uuid)
        `), scope.signal));
        if (!selected.length) continue;
        let payment = await productionOperation(() => readPersonalPolygonRelay(database, subject, paymentId, true), scope.signal);
        if (payment.userOperationHash && ['broadcasting', 'submitted', 'ambiguous'].includes(payment.status)) {
          payment = await verifyPersonalPolygonRelay(database, { paymentId }, subject,
            { environment, fetchImpl, signal: scope.signal, allowUsdc: true });
        }
        if (payment.status !== 'confirmed' || !payment.blockNumber || !payment.blockHash) continue;
        const height = await finalizedHeight(BigInt(payment.blockNumber), payment.blockHash, environment, fetchImpl, scope.signal);
        if (!height) continue;
        const verified: string[] = [];
        for (let offset = 0; offset < selected.length; offset += 4) {
          const batch = selected.slice(offset, offset + 4);
          const checks = await Promise.allSettled(batch.map(lot => verifyAppMeldAccountingLot(database, subject, lot.attempt_id, {
            transactionId: lot.meld_transaction_id, transactionHash: lot.blockchain_tx_hash,
            grossUsdMinor: lot.gross_usd_minor, receivedAtomic: lot.received_atomic,
            blockNumber: lot.block_number, blockHash: lot.block_hash, logIndex: lot.transfer_log_index,
          }, environment, fetchImpl, scope.signal)));
          if (checks.some(result => result.status !== 'fulfilled' || !result.value)) break;
          verified.push(...batch.map(lot => lot.attempt_id));
        }
        if (verified.length !== selected.length) continue;
        const ids = sql.join(verified.map(id => sql`${id}::uuid`), sql`,`);
        const posted = await productionOperation(() => database.execute(sql`
          SELECT payments.record_app_pagar_accounting_v1(${subject},${paymentId}::uuid,
            ${height}::bigint,ARRAY[${ids}]::uuid[]) AS recorded
        `), scope.signal);
        if (posted.length === 1 && posted[0]?.recorded === true) recorded++;
      } catch { /* Leave no accounting entry when any independent verification is unavailable. */ }
    }
    return { recorded };
  } finally { scope.close(); }
}

/** The Pagar-only investment job also attributes its PV in the activation transaction. */
export async function runAppPagarInvestment(database: Database, {
  environment = process.env, signal,
}: Dependencies = {}) {
  if (environment.ENV !== 'production' || environment.APP_PAGAR_ACCOUNTING_ENABLED !== 'true'
    || environment.APP_PAGAR_INVESTMENT_ENABLED !== 'true') return { activated: 0, accrued_days: 0 };
  const scope = productionScope(signal);
  try {
    const [result] = z.array(roiRun).length(1).parse(await productionOperation(() => database.execute(sql`
      SELECT * FROM payments.run_app_pagar_roi_v1()
    `), scope.signal));
    return result!;
  } finally { scope.close(); }
}
