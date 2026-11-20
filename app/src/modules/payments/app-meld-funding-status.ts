import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { IdentityDatabase } from '../identity/model';
import { productionMeldJson, productionOperation, productionScope } from './meld-production-http';
import { ARBITRUM_USDC_CHAIN_ID, checkCompanyPaymentChain, COMPANY_PAYMENT_TRANSFER_TOPIC, createArbitrumUsdcReadRpc, createCompanyPaymentRpc, createEthereumUsdcReadRpc } from './personal-company-rpc';
import { createAdministrativePreflightGate } from './wallet-funding';
import { appMeldAsset, appMeldCountry, appMeldCurrency, appMeldDestination, appMeldMethod, appMeldNetwork, appMeldProvider, appMeldRecordedRoute } from './app-meld-funding-policy';

type Database = Pick<IdentityDatabase, 'execute'>;
type Environment = Record<string, string | undefined>;
type Dependencies = { nativeSessionId?: string; environment?: Environment; fetchImpl?: typeof fetch; signal?: AbortSignal };

const ownerInput = z.string().min(1).max(255);
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const wallet = z.string().regex(/^0x[0-9a-f]{40}$/i).transform(value => value.toLowerCase());
const hexWord = z.string().regex(/^0x[0-9a-f]{64}$/i).transform(value => value.toLowerCase());
const hexQuantity = z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i);
const amount = z.number().finite().min(0.01).max(1_000_000_000)
  .refine(value => Number(value.toFixed(2)) === value);
const chainId = z.union([z.literal(137), z.literal(ARBITRUM_USDC_CHAIN_ID), z.literal(1)]);
const status = z.enum(['initiated', 'session_created', 'unavailable']);
const providerStatus = z.enum(['PENDING_CREATED', 'PENDING CREATED', 'PENDING', 'PROCESSING', 'AUTHORIZED', 'ACCEPTED',
  'PARTIALLY_SETTLED', 'SETTLING', 'TWO_FA_REQUIRED', 'TWO_FA_PROVIDED', 'ERROR', 'SETTLED', 'FAILED', 'DECLINED',
  'CANCELLED', 'REFUNDED', 'VOIDED', 'AUTHORIZATION_EXPIRED']);
const terminalFailures: ReadonlySet<string> = new Set(['FAILED', 'DECLINED', 'CANCELLED', 'REFUNDED', 'VOIDED', 'AUTHORIZATION_EXPIRED']);
const unavailable = () => Error('wallet_funding_provider_unavailable');

const attempt = z.object({ id: uuid, subject: ownerInput, wallet_address: wallet, customer_reference: uuid,
  country_code: appMeldCountry, source_currency: appMeldCurrency, destination_currency: appMeldAsset, chain_id: chainId,
  requested_amount: z.union([z.number(), z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/)]).transform(Number).pipe(amount),
  payment_method: appMeldMethod, service_provider: appMeldProvider, account_id: identifier, status,
  provider_session_id: identifier.nullable(), provider_customer_id: identifier.nullable(), created_at: z.coerce.date(),
}).refine(row => {
  return (row.status === 'session_created' ? row.provider_session_id && row.provider_customer_id
    : row.provider_session_id === null && row.provider_customer_id === null)
    && row.chain_id === appMeldNetwork(row.destination_currency).chainId
    && appMeldRecordedRoute(row.country_code, row.source_currency, row.service_provider, row.payment_method,
      row.destination_currency, row.requested_amount);
});
type Attempt = z.infer<typeof attempt>;
type ProofOwner = { nativeSessionId: string } | { leaseId: string };
type ExpectedAccountingSettlement = { transactionId: string; grossUsdMinor: string; receivedAtomic: string; transactionHash: string;
  blockNumber: string; blockHash: string; logIndex: number };

function ownedAttempt(value: unknown, owner: string) {
  const parsed = attempt.safeParse(value);
  if (!parsed.success || parsed.data.subject !== owner) throw Error('wallet_funding_unavailable');
  return parsed.data;
}

const destination = (row: Attempt) => appMeldDestination(row.destination_currency, row.wallet_address);
const unconfirmed = () => ({ state: 'unconfirmed' as const, source: 'none' as const, testMode: false as const });

export async function readAppMeldFundingHistory(database: Database, subject: string) {
  const owner = ownerInput.parse(subject);
  const rows = await database.execute(sql`SELECT * FROM payments.read_app_meld_funding_v3(${owner},NULL::uuid)`);
  if (rows.length > 20) throw Error('wallet_funding_unavailable');
  const records = rows.map(value => {
    const row = ownedAttempt(value, owner);
    return { checkoutReference: row.id, provider: 'meld' as const, serviceProvider: row.service_provider,
      status: row.status, country: row.country_code, requestedAmount: row.requested_amount, sourceCurrencyCode: row.source_currency,
      paymentMethodType: row.payment_method, destination: destination(row), createdAt: row.created_at.toISOString() };
  });
  if (new Set(records.map(record => record.checkoutReference)).size !== records.length) throw Error('wallet_funding_unavailable');
  return records;
}

const search = z.object({ transactions: z.array(z.object({ id: identifier })).max(1) });
const result = z.object({ transaction: z.object({
  id: identifier, accountId: identifier, sessionId: identifier, externalSessionId: uuid,
  customerId: identifier.nullish(), customer: z.object({ id: identifier }).nullish(),
  externalCustomerId: uuid, transactionType: z.literal('CRYPTO_PURCHASE'), serviceProvider: appMeldProvider, countryCode: appMeldCountry,
  sourceCurrencyCode: appMeldCurrency, sourceAmount: amount, destinationCurrencyCode: appMeldAsset,
  destinationAmount: z.number().finite().nonnegative().max(1_000_000_000), paymentMethodType: appMeldMethod,
  status: providerStatus, updatedAt: z.string().datetime({ offset: true }),
  fiatAmountInUsd: z.unknown().optional(),
  cryptoDetails: z.object({ destinationWalletAddress: wallet, chainId: z.union([z.literal('137'), z.literal('42161'), z.literal('1'), chainId]).transform(Number),
    blockchainTransactionId: z.unknown().optional(), totalFeeInUsd: z.unknown().optional() }),
}) });

const block = z.object({ hash: hexWord, number: hexQuantity });
const receipt = z.object({ transactionHash: hexWord, blockHash: hexWord, blockNumber: hexQuantity, status: z.literal('0x1'),
  logs: z.array(z.unknown()).max(1024) });
const transfer = z.object({ address: wallet, topics: z.tuple([hexWord, hexWord, hexWord]), data: hexWord,
  logIndex: hexQuantity, removed: z.boolean().optional() });

function usdMinor(value: unknown, allowZero = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000_000) return null;
  const cents = BigInt(value.toFixed(2).replace('.', ''));
  return cents > 0n || allowZero ? cents : null;
}

/** A settled provider transaction alone cannot prove delivery to the owned wallet. */
async function deliveredOnNetwork(row: Attempt, hash: string, amountReceived: bigint, environment: Environment,
  fetchImpl: typeof fetch, signal: AbortSignal) {
  const rpc = row.chain_id === ARBITRUM_USDC_CHAIN_ID ? createArbitrumUsdcReadRpc(environment, fetchImpl, signal)
    : row.chain_id === 1 ? createEthereumUsdcReadRpc(environment, fetchImpl, signal)
      : createCompanyPaymentRpc(environment, fetchImpl, signal, 137, row.destination_currency === 'USDC_POLYGON' ? 'USDC' : 'USDT');
  try {
    await checkCompanyPaymentChain(rpc);
    const [rawReceipt, rawFinalized] = await Promise.all([
      rpc.call('eth_getTransactionReceipt', [hash]), rpc.call('eth_getBlockByNumber', ['finalized', false]),
    ]);
    const mined = receipt.safeParse(rawReceipt), finalized = block.safeParse(rawFinalized);
    if (!mined.success || !finalized.success || mined.data.transactionHash !== hash
      || BigInt(mined.data.blockNumber) > BigInt(finalized.data.number)) return null;
    const receiver = '0x' + row.wallet_address.slice(2).padStart(64, '0');
    const token = rpc.policy.tokenAddress;
    const matches = mined.data.logs.flatMap(value => {
      const event = transfer.safeParse(value);
      if (!event.success || event.data.removed || event.data.address !== token
        || event.data.topics[0] !== COMPANY_PAYMENT_TRANSFER_TOPIC || event.data.topics[2] !== receiver
        || BigInt(event.data.data) !== amountReceived || BigInt(event.data.logIndex) > 2_147_483_647n) return [];
      return [Number(BigInt(event.data.logIndex))];
    });
    const blockNumber = BigInt(mined.data.blockNumber);
    if (matches.length !== 1 || blockNumber > 9_223_372_036_854_775_807n) return null;
    const canonical = block.safeParse(await rpc.call('eth_getBlockByNumber', [mined.data.blockNumber, false]));
    if (!canonical.success || canonical.data.hash !== mined.data.blockHash
      || BigInt(canonical.data.number) !== blockNumber) return null;
    return { blockNumber, blockHash: mined.data.blockHash, logIndex: matches[0]! };
  } finally { rpc.dispose(); }
}

const reconcileGates = new WeakMap<Database, ReturnType<typeof createAdministrativePreflightGate>>();
async function reconcile(database: Database, row: Attempt, proofOwner: ProofOwner | undefined,
  environment: Environment, fetchImpl: typeof fetch, signal: AbortSignal, expected?: ExpectedAccountingSettlement) {
  if (row.status !== 'session_created' || row.provider_session_id === null || row.provider_customer_id === null) return unconfirmed();
  const key = environment.MELD_PRODUCTION_API_KEYS;
  const account = identifier.safeParse(environment.MELD_PRODUCTION_ACCOUNT_ID);
  if (!key || !/^[\x21-\x7e]{1,2048}$/.test(key) || !account.success) throw Error('wallet_funding_unconfigured');
  if (row.account_id !== account.data) throw unavailable();
  const transport = { key, account: account.data, fetchImpl, signal };
  // The private accounting batch has its own bounded claim and sequential reads.
  // Public status checks keep their independent per-owner rate limit.
  let release: (() => void) | undefined;
  if (!expected) {
    let gate = reconcileGates.get(database);
    if (!gate) { gate = createAdministrativePreflightGate(); reconcileGates.set(database, gate); }
    release = gate(row.subject, randomUUID());
  }
  try {
    const query = new URLSearchParams({ externalSessionIds: row.id, sessionIds: row.provider_session_id,
      externalCustomerIds: row.customer_reference, serviceProviders: row.service_provider, types: 'CRYPTO_PURCHASE', limit: '2' });
    const searched = await productionMeldJson(`/payments/transactions?${query}`, transport);
    const found = search.safeParse(searched.data);
    if (!searched.ok || !found.success) throw unavailable();
    const id = found.data.transactions[0]?.id;
    if (!id) return unconfirmed();
    const fetched = await productionMeldJson(`/payments/transactions/${encodeURIComponent(id)}`, transport);
    const parsed = result.safeParse(fetched.data);
    if (!fetched.ok || !parsed.success) throw unavailable();
    const item = parsed.data.transaction;
    const providerCustomerId = item.customer?.id ?? item.customerId;
    if (item.id !== id || item.accountId !== row.account_id || item.sessionId !== row.provider_session_id
      || item.externalSessionId !== row.id || providerCustomerId !== row.provider_customer_id
      || (item.customerId != null && item.customerId !== providerCustomerId) || item.externalCustomerId !== row.customer_reference
      || item.serviceProvider !== row.service_provider || item.countryCode !== row.country_code
      || item.sourceCurrencyCode !== row.source_currency || item.sourceAmount !== row.requested_amount || item.destinationCurrencyCode !== row.destination_currency
      || item.paymentMethodType !== row.payment_method || item.cryptoDetails.destinationWalletAddress !== row.wallet_address
      || item.cryptoDetails.chainId !== row.chain_id) throw unavailable();
    const fixedAmount = item.destinationAmount.toFixed(6);
    if (Number(fixedAmount) !== item.destinationAmount) throw unavailable();
    const metadata = { source: 'meld_production_api' as const, testMode: false as const, transactionId: id,
      providerStatus: item.status === 'PENDING CREATED' ? 'PENDING_CREATED' : item.status };
    if (terminalFailures.has(item.status)) return { ...metadata, state: 'failed' as const };
    if (item.status !== 'SETTLED') return { ...metadata, state: 'pending' as const };
    const received = BigInt(fixedAmount.replace('.', ''));
    const hash = hexWord.safeParse(item.cryptoDetails.blockchainTransactionId);
    const delivered = received > 0n && hash.success
      ? await deliveredOnNetwork(row, hash.data, received, environment, fetchImpl, signal).catch(() => null) : null;
    if (!delivered) return { ...metadata, state: 'pending' as const, providerStatus: 'SETTLING' as const };
    const grossUsd = usdMinor(item.sourceCurrencyCode === 'USD' ? item.sourceAmount : item.fiatAmountInUsd);
    if (expected && (expected.transactionId !== id || !hash.success || expected.transactionHash !== hash.data
      || expected.grossUsdMinor !== grossUsd?.toString() || expected.receivedAtomic !== received.toString()
      || expected.blockNumber !== delivered.blockNumber.toString() || expected.blockHash !== delivered.blockHash
      || expected.logIndex !== delivered.logIndex)) throw unavailable();
    if (proofOwner && hash.success) {
      const reportedFeeUsd = usdMinor(item.cryptoDetails.totalFeeInUsd, true);
      const feeUsd = grossUsd !== null && reportedFeeUsd !== null && reportedFeeUsd > grossUsd ? null : reportedFeeUsd;
      const evidence = sql`${id},${hash.data},${delivered.logIndex}::integer,${delivered.blockNumber.toString()}::bigint,
        ${delivered.blockHash},${item.updatedAt}::timestamptz,${grossUsd?.toString() ?? null}::bigint,
        ${feeUsd?.toString() ?? null}::bigint,${received.toString()}::bigint`;
      const write = 'nativeSessionId' in proofOwner
        ? sql`SELECT payments.record_app_meld_settlement_v1(${row.subject},${proofOwner.nativeSessionId},${row.id}::uuid,${evidence}) AS recorded`
        : sql`SELECT payments.record_app_meld_scheduled_settlement_v1(${row.id}::uuid,${proofOwner.leaseId}::uuid,${evidence}) AS recorded`;
      const stored = await productionOperation(() => database.execute(write), signal);
      if (stored.length !== 1 || stored[0]?.recorded !== true) throw unavailable();
    }
    return { ...metadata, state: 'confirmed' as const, receivedAmount: fixedAmount.replace(/\.?0+$/, ''), confirmedAt: item.updatedAt };
  } finally { release?.(); }
}

/** A financial lot must still agree with fresh provider detail and its finalized chain credit. */
export async function verifyAppMeldAccountingLot(database: Database, subject: string, reference: string,
  expected: ExpectedAccountingSettlement, environment: Environment, fetchImpl: typeof fetch, signal: AbortSignal) {
  const owner = ownerInput.parse(subject), requestId = uuid.parse(reference);
  const rows = await productionOperation(() => database.execute(sql`SELECT * FROM payments.read_app_meld_funding_v3(${owner},${requestId}::uuid)`), signal);
  if (rows.length !== 1) return false;
  const row = ownedAttempt(rows[0], owner);
  if (row.id !== requestId) return false;
  const proof = await reconcile(database, row, undefined, environment, fetchImpl, signal, expected);
  return proof.state === 'confirmed';
}

/** Owned App reference reconciled against the production MELD session and its delivery chain. */
export async function readAppMeldFundingStatus(database: Database, subject: string, reference: string, {
  nativeSessionId, environment = process.env, fetchImpl = fetch, signal,
}: Dependencies = {}) {
  const owner = ownerInput.parse(subject), requestId = uuid.parse(reference), scope = productionScope(signal);
  try {
    const rows = await productionOperation(() => database.execute(sql`SELECT * FROM payments.read_app_meld_funding_v3(${owner},${requestId}::uuid)`), scope.signal);
    if (!rows.length) return null;
    if (rows.length !== 1) throw Error('wallet_funding_unavailable');
    const row = ownedAttempt(rows[0], owner);
    if (row.id !== requestId) throw Error('wallet_funding_unavailable');
    const confirmation = await reconcile(database, row, nativeSessionId ? { nativeSessionId } : undefined,
      environment, fetchImpl, scope.signal);
    return { checkoutReference: row.id, walletKind: 'personal' as const, environment: 'production' as const, provider: 'meld' as const,
      serviceProvider: row.service_provider, country: row.country_code, requestedAmount: row.requested_amount,
      sourceCurrencyCode: row.source_currency, paymentMethodType: row.payment_method, requestStatus: row.status,
      destination: destination(row), confirmation };
  } finally { scope.close(); }
}

/** Private bounded scan of App checkout attempts. The lease also fences every database write. */
export async function runAppMeldReconciliation(database: Database, {
  environment = process.env, fetchImpl = fetch, signal,
}: Dependencies = {}) {
  if (environment.APP_MELD_PRODUCTION_ENABLED !== 'true') throw Error('wallet_funding_unconfigured');
  const scope = productionScope(signal);
  try {
    const rows = await productionOperation(() => database.execute(sql`SELECT * FROM payments.claim_app_meld_reconciliation_v1()`), scope.signal);
    const leases = z.array(z.object({ id: uuid, lease_id: uuid })).max(5).parse(rows);
    if (new Set(leases.map(lease => lease.id)).size !== leases.length) throw unavailable();
    const handled = await Promise.all(leases.map(async ({ id, lease_id }, index) => {
      let outcome: 'confirmed' | 'pending' | 'failed' = 'pending';
      try {
        const current = attempt.parse(rows[index]);
        const proof = await reconcile(database, current, { leaseId: lease_id }, environment, fetchImpl, scope.signal);
        if (proof.state === 'confirmed' || proof.state === 'failed') outcome = proof.state;
      } catch { /* Transient or invalid evidence is left pending for the leased retry. */ }
      const finished = await productionOperation(() => database.execute(sql`
        SELECT payments.finish_app_meld_reconciliation_v1(${id}::uuid,${lease_id}::uuid,${outcome}) AS finished
      `), scope.signal);
      return finished.length === 1 && finished[0]?.finished === true;
    }));
    return { processed: handled.filter(Boolean).length };
  } finally { scope.close(); }
}
