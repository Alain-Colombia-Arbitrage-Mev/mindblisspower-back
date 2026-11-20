import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { IdentityDatabase } from '../identity/model';
import { productionMeldJson, productionOperation, productionScope } from './meld-production-http';
import { checkCompanyPaymentChain, COMPANY_PAYMENT_TRANSFER_TOPIC, createCompanyPaymentRpc, LEGACY_POLYGON_TOKEN } from './personal-company-rpc';
import { createAdministrativePreflightGate } from './wallet-funding';
import { PERSONAL_FUNDING_MAXIMUM_USD, PERSONAL_FUNDING_MINIMUM_MXN, PERSONAL_FUNDING_MINIMUM_USD } from './reown-funding-options';

type Database = Pick<IdentityDatabase, 'execute'>;
type Environment = Record<string, string | undefined>;
type Dependencies = { environment?: Environment; fetchImpl?: typeof fetch; signal?: AbortSignal };

const ownerInput = z.string().min(1).max(255);
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const wallet = z.string().regex(/^0x[0-9a-f]{40}$/i).transform(value => value.toLowerCase());
const hexWord = z.string().regex(/^0x[0-9a-f]{64}$/i).transform(value => value.toLowerCase());
const hexQuantity = z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i);
const amount = z.number().finite().min(0.01).max(1_000_000_000)
  .refine(value => Number(value.toFixed(2)) === value);
const asset = 'USDT_POLYGON' as const;
const currency = z.enum(['USD', 'MXN']);
const provider = z.enum(['MERCURYO', 'ONRAMPMONEY']);
const method = z.enum(['CREDIT_DEBIT_CARD', 'SPEI']);
const status = z.enum(['initiated', 'session_created', 'unavailable']);
const providerStatus = z.enum(['PENDING_CREATED', 'PENDING CREATED', 'PENDING', 'PROCESSING', 'AUTHORIZED', 'ACCEPTED',
  'PARTIALLY_SETTLED', 'SETTLING', 'TWO_FA_REQUIRED', 'TWO_FA_PROVIDED', 'ERROR', 'SETTLED', 'FAILED', 'DECLINED',
  'CANCELLED', 'REFUNDED', 'VOIDED', 'AUTHORIZATION_EXPIRED']);
const terminalFailures: ReadonlySet<string> = new Set(['FAILED', 'DECLINED', 'CANCELLED', 'REFUNDED', 'VOIDED', 'AUTHORIZATION_EXPIRED']);
const unavailable = () => Error('wallet_funding_provider_unavailable');

const attempt = z.object({ id: uuid, subject: ownerInput, wallet_address: wallet, customer_reference: uuid,
  country_code: z.literal('MX'), source_currency: currency, destination_currency: z.literal(asset), chain_id: z.literal(137),
  requested_amount: z.union([z.number(), z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/)]).transform(Number).pipe(amount),
  payment_method: method, service_provider: provider, account_id: identifier, status,
  provider_session_id: identifier.nullable(), provider_customer_id: identifier.nullable(), created_at: z.coerce.date(),
}).refine(row => (row.status === 'session_created' ? row.provider_session_id && row.provider_customer_id
  : row.provider_session_id === null && row.provider_customer_id === null)
  && (row.source_currency === 'USD' ? row.requested_amount >= PERSONAL_FUNDING_MINIMUM_USD && row.requested_amount <= PERSONAL_FUNDING_MAXIMUM_USD
    : row.requested_amount >= PERSONAL_FUNDING_MINIMUM_MXN)
  && (row.service_provider === 'MERCURYO' ? row.payment_method === 'CREDIT_DEBIT_CARD'
    : row.source_currency === 'MXN' && row.payment_method === 'SPEI'));
type Attempt = z.infer<typeof attempt>;

function ownedAttempt(value: unknown, owner: string) {
  const parsed = attempt.safeParse(value);
  if (!parsed.success || parsed.data.subject !== owner) throw Error('wallet_funding_unavailable');
  return parsed.data;
}

const destination = (row: Attempt) => ({ address: row.wallet_address, asset: 'USDT' as const, network: 'polygon' as const, chainId: 137 as const });
const unconfirmed = () => ({ state: 'unconfirmed' as const, source: 'none' as const, testMode: false as const });

export async function readAppMeldFundingHistory(database: Database, subject: string) {
  const owner = ownerInput.parse(subject);
  const rows = await database.execute(sql`SELECT * FROM payments.read_app_meld_funding(${owner},NULL::uuid)`);
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
  id: identifier, accountId: identifier, sessionId: identifier, externalSessionId: uuid, customerId: identifier,
  externalCustomerId: uuid, transactionType: z.literal('CRYPTO_PURCHASE'), serviceProvider: provider, countryCode: z.literal('MX'),
  sourceCurrencyCode: currency, sourceAmount: amount, destinationCurrencyCode: z.literal(asset),
  destinationAmount: z.number().finite().nonnegative().max(1_000_000_000), paymentMethodType: method,
  status: providerStatus, updatedAt: z.string().datetime({ offset: true }),
  cryptoDetails: z.object({ destinationWalletAddress: wallet, chainId: z.union([z.literal('137'), z.literal(137)]),
    blockchainTransactionId: z.unknown().optional() }),
}) });

const block = z.object({ hash: hexWord, number: hexQuantity });
const receipt = z.object({ transactionHash: hexWord, blockHash: hexWord, blockNumber: hexQuantity, status: z.literal('0x1'),
  logs: z.array(z.unknown()).max(1024) });
const transfer = z.object({ address: wallet, topics: z.tuple([hexWord, hexWord, hexWord]), data: hexWord, removed: z.boolean().optional() });

/** A settled provider transaction alone cannot prove delivery to the owned wallet. */
async function deliveredOnPolygon(row: Attempt, hash: string, amountReceived: bigint, environment: Environment,
  fetchImpl: typeof fetch, signal: AbortSignal) {
  const rpc = createCompanyPaymentRpc(environment, fetchImpl, signal, 137);
  try {
    await checkCompanyPaymentChain(rpc);
    const [rawReceipt, rawFinalized] = await Promise.all([
      rpc.call('eth_getTransactionReceipt', [hash]), rpc.call('eth_getBlockByNumber', ['finalized', false]),
    ]);
    const mined = receipt.safeParse(rawReceipt), finalized = block.safeParse(rawFinalized);
    if (!mined.success || !finalized.success || mined.data.transactionHash !== hash
      || BigInt(mined.data.blockNumber) > BigInt(finalized.data.number)) return false;
    const receiver = '0x' + row.wallet_address.slice(2).padStart(64, '0');
    const matched = mined.data.logs.some(value => {
      const event = transfer.safeParse(value);
      return event.success && !event.data.removed && event.data.address === LEGACY_POLYGON_TOKEN
        && event.data.topics[0] === COMPANY_PAYMENT_TRANSFER_TOPIC && event.data.topics[2] === receiver
        && BigInt(event.data.data) === amountReceived;
    });
    if (!matched) return false;
    const canonical = block.safeParse(await rpc.call('eth_getBlockByNumber', [mined.data.blockNumber, false]));
    return canonical.success && canonical.data.hash === mined.data.blockHash
      && BigInt(canonical.data.number) === BigInt(mined.data.blockNumber);
  } finally { rpc.dispose(); }
}

const reconcileGates = new WeakMap<Database, ReturnType<typeof createAdministrativePreflightGate>>();
async function reconcile(database: Database, row: Attempt, environment: Environment, fetchImpl: typeof fetch, signal: AbortSignal) {
  if (row.status !== 'session_created' || row.provider_session_id === null || row.provider_customer_id === null) return unconfirmed();
  const key = environment.MELD_PRODUCTION_API_KEYS;
  const account = identifier.safeParse(environment.MELD_PRODUCTION_ACCOUNT_ID);
  if (!key || !/^[\x21-\x7e]{1,2048}$/.test(key) || !account.success) throw Error('wallet_funding_unconfigured');
  if (row.account_id !== account.data) throw unavailable();
  const transport = { key, account: account.data, fetchImpl, signal };
  let gate = reconcileGates.get(database);
  if (!gate) { gate = createAdministrativePreflightGate(); reconcileGates.set(database, gate); }
  const release = gate(row.subject, randomUUID());
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
    if (item.id !== id || item.accountId !== row.account_id || item.sessionId !== row.provider_session_id
      || item.externalSessionId !== row.id || item.customerId !== row.provider_customer_id || item.externalCustomerId !== row.customer_reference
      || item.serviceProvider !== row.service_provider || item.countryCode !== row.country_code
      || item.sourceCurrencyCode !== row.source_currency || item.sourceAmount !== row.requested_amount
      || item.paymentMethodType !== row.payment_method || item.cryptoDetails.destinationWalletAddress !== row.wallet_address) throw unavailable();
    const fixedAmount = item.destinationAmount.toFixed(6);
    if (Number(fixedAmount) !== item.destinationAmount) throw unavailable();
    const metadata = { source: 'meld_production_api' as const, testMode: false as const, transactionId: id,
      providerStatus: item.status === 'PENDING CREATED' ? 'PENDING_CREATED' : item.status };
    if (terminalFailures.has(item.status)) return { ...metadata, state: 'failed' as const };
    if (item.status !== 'SETTLED') return { ...metadata, state: 'pending' as const };
    const received = BigInt(fixedAmount.replace('.', ''));
    const hash = hexWord.safeParse(item.cryptoDetails.blockchainTransactionId);
    const delivered = received > 0n && hash.success
      && await deliveredOnPolygon(row, hash.data, received, environment, fetchImpl, signal).catch(() => false);
    if (!delivered) return { ...metadata, state: 'pending' as const, providerStatus: 'SETTLING' as const };
    return { ...metadata, state: 'confirmed' as const, receivedAmount: fixedAmount.replace(/\.?0+$/, ''), confirmedAt: item.updatedAt };
  } finally { release(); }
}

/** Owned App reference, independently reconciled against production MELD and Polygon. */
export async function readAppMeldFundingStatus(database: Database, subject: string, reference: string, {
  environment = process.env, fetchImpl = fetch, signal,
}: Dependencies = {}) {
  const owner = ownerInput.parse(subject), requestId = uuid.parse(reference), scope = productionScope(signal);
  try {
    const rows = await productionOperation(() => database.execute(sql`SELECT * FROM payments.read_app_meld_funding(${owner},${requestId}::uuid)`), scope.signal);
    if (!rows.length) return null;
    if (rows.length !== 1) throw Error('wallet_funding_unavailable');
    const row = ownedAttempt(rows[0], owner);
    if (row.id !== requestId) throw Error('wallet_funding_unavailable');
    const confirmation = await reconcile(database, row, environment, fetchImpl, scope.signal);
    return { checkoutReference: row.id, walletKind: 'personal' as const, environment: 'production' as const, provider: 'meld' as const,
      serviceProvider: row.service_provider, country: row.country_code, requestedAmount: row.requested_amount,
      sourceCurrencyCode: row.source_currency, paymentMethodType: row.payment_method, requestStatus: row.status,
      destination: destination(row), confirmation };
  } finally { scope.close(); }
}
