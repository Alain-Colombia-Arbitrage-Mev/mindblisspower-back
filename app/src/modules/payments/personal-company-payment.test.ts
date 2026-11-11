import { expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { IdentityDatabase } from '../identity/model';
import { preparePersonalCompanyPayment, submitPersonalCompanyPayment, verifyPersonalCompanyPayment,
  readPersonalCompanyPayment, readPersonalCompanyPaymentHistory, abandonPersonalCompanyPayment } from './personal-company-payment';
import { COMPANY_PAYMENT_RECIPIENT, COMPANY_PAYMENT_TOKEN, COMPANY_PAYMENT_TRANSFER_TOPIC, companyPaymentCalldata } from './personal-company-rpc';
const id = '11111111-1111-4111-8111-111111111111';
const address = `0x${'2'.repeat(40)}`, hash = `0x${'3'.repeat(64)}`, blockHash = `0x${'4'.repeat(64)}`;
const amount = '20000123', created = new Date('2026-11-10T20:00:00Z');
const environment = { PERSONAL_COMPANY_PAYMENTS_ENABLED: 'true', REOWN_PROJECT_ID: 'a'.repeat(32) };
const base = { id, wallet_address: address, recipient_address: COMPANY_PAYMENT_RECIPIENT, chain_id: 137, token_address: COMPANY_PAYMENT_TOKEN,
  token_decimals: 6, amount_atomic: amount, status: 'prepared', expires_at: new Date(created.getTime() + 900_000), created_at: created,
  transaction_hash: null, block_number: null, block_hash: null, confirmations: 0, failure_reason: null, abandoned_at: null };
const principal = { subject: 'owner', auth_email: 'synthetic@example.invalid', email_verified: true, person_id: '1', public_id: '1',
  person_email: 'synthetic@example.invalid', person_status: 'active', user_id: 'owner', blacklisted: false, access_restricted: false };
function queued(results: unknown[][]) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const database = { execute: async (input: unknown) => { queries.push(new PgDialect().sqlToQuery(input as SQL));
    if (!results.length) throw Error('unexpected database write'); return results.shift(); } } as Pick<IdentityDatabase, 'execute'>;
  return { database, queries };
}
function rpcFetch(overrides: Record<string, unknown> = {}, seen: string[] = []): typeof fetch {
  const word = (value: string) => `0x${value.replace(/^0x/, '').padStart(64, '0')}`;
  return (async (_url, init) => {
    const request = JSON.parse(String(init?.body)); seen.push(request.method);
    const tx = { hash, from: address, to: COMPANY_PAYMENT_TOKEN, input: companyPaymentCalldata(amount), value: '0x0', chainId: '0x89', blockNumber: '0x64', blockHash };
    const values: Record<string, unknown> = { eth_chainId: '0x89', eth_getTransactionByHash: tx, eth_blockNumber: '0x6f',
      eth_getBlockByNumber: { number: '0x64', hash: blockHash },
      eth_getTransactionReceipt: { transactionHash: hash, from: address, to: COMPANY_PAYMENT_TOKEN, blockNumber: '0x64', blockHash, status: '0x1',
        logs: [{ address: COMPANY_PAYMENT_TOKEN, topics: [COMPANY_PAYMENT_TRANSFER_TOPIC, word(address), word(COMPANY_PAYMENT_RECIPIENT)], data: word(BigInt(amount).toString(16)) }] }, ...overrides };
    const result = request.method === 'eth_call' ? word(request.params[0].data === '0x313ce567' ? '6' : BigInt(amount).toString(16)) : values[request.method];
    if (result === undefined) throw Error('unapproved RPC operation');
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  }) as typeof fetch;
}
test('preparation derives its verified sender and stores only a fixed personal payment snapshot after real balance checks', async () => {
  const db = queued([[], [principal], [{ address, chain_id: 1, verified_at: created }], [base]]), seen: string[] = [];
  const result = await preparePersonalCompanyPayment(db.database, { requestId: id, amountAtomic: amount }, 'owner', { environment, fetchImpl: rpcFetch({}, seen) });
  expect(result).toMatchObject({ paymentId: id, walletKind: 'personal', walletAddress: address, recipientAddress: COMPANY_PAYMENT_RECIPIENT,
    chainId: 137, tokenAddress: COMPANY_PAYMENT_TOKEN, tokenDecimals: 6, amountAtomic: amount, status: 'prepared', membershipAssignment: 'pending' });
  expect(db.queries.at(-1)!.params).toEqual(['owner', address, amount, id]);
  expect(db.queries.at(-1)!.sql).toContain('prepare_personal_company_payment');
  expect(seen.sort()).toEqual(['eth_call', 'eth_call', 'eth_chainId']);
  expect(db.queries.map(row => row.sql).join(' ')).not.toMatch(/administrative|commission|membership|INSERT INTO.*ledger/i);
});
test('preparation replays preserve one immutable intent and refresh balance only while it can still prompt a transfer', async () => {
  const db = queued([[base]]);
  expect((await preparePersonalCompanyPayment(db.database, { requestId: id, amountAtomic: amount }, 'owner', { environment, fetchImpl: rpcFetch() })).paymentId).toBe(id);
  expect(db.queries).toHaveLength(1);
  await expect(preparePersonalCompanyPayment(queued([[base]]).database, { requestId: id, amountAtomic: '1' }, 'owner', { environment,
    fetchImpl: (async () => { throw Error('conflicting request contacted RPC'); }) as unknown as typeof fetch })).rejects.toThrow('company_payment_request_already_used');
  const submitted = { ...base, status: 'submitted', transaction_hash: hash };
  expect((await preparePersonalCompanyPayment(queued([[submitted]]).database, { requestId: id, amountAtomic: amount }, 'owner', { environment,
    fetchImpl: (async () => { throw Error('replay tried to prepare another transfer'); }) as unknown as typeof fetch })).status).toBe('submitted');
});
test('forged owners, destinations, amounts and unverified identities cannot create a payment', async () => {
  for (const extra of [{ walletAddress: address }, { recipientAddress: address }, { chainId: 1 }, { tokenAddress: address }, { subject: 'other' }]) {
    const db = queued([]);
    await expect(preparePersonalCompanyPayment(db.database, { requestId: id, amountAtomic: amount, ...extra }, 'owner', { environment })).rejects.toThrow();
    expect(db.queries).toHaveLength(0);
  }
  const db = queued([[], [{ ...principal, email_verified: false }]]);
  await expect(preparePersonalCompanyPayment(db.database, { requestId: id, amountAtomic: amount }, 'owner', { environment,
    fetchImpl: (async () => { throw Error('ineligible identity contacted RPC'); }) as unknown as typeof fetch })).rejects.toThrow('wallet_identity_unavailable');
  expect(db.queries).toHaveLength(2);
});
test('hash claims happen only after real transaction ownership proof; unindexed or foreign hashes cannot squat another payment', async () => {
  const db = queued([[base], [{ ...base, status: 'submitted', transaction_hash: hash }]]);
  const result = await submitPersonalCompanyPayment(db.database, { paymentId: id, transactionHash: hash }, 'owner', { environment, fetchImpl: rpcFetch() });
  expect(result.status).toBe('submitted'); expect(db.queries[1]!.params).toEqual(['owner', id, hash]);
  for (const [value, code] of [[null, 'company_payment_transaction_pending'], [{ hash, from: COMPANY_PAYMENT_RECIPIENT, to: COMPANY_PAYMENT_TOKEN,
    input: companyPaymentCalldata(amount), value: '0x0', chainId: '0x89' }, 'company_payment_transaction_mismatch']] as const) {
    const blocked = queued([[base]]);
    await expect(submitPersonalCompanyPayment(blocked.database, { paymentId: id, transactionHash: hash }, 'owner', { environment,
      fetchImpl: rpcFetch({ eth_getTransactionByHash: value }) })).rejects.toThrow(code);
    expect(blocked.queries).toHaveLength(1);
  }
  const duplicate = queued([[{ ...base, status: 'submitted', transaction_hash: hash }]]);
  await submitPersonalCompanyPayment(duplicate.database, { paymentId: id, transactionHash: hash }, 'owner', { environment,
    fetchImpl: (async () => { throw Error('idempotent registration repeated RPC'); }) as unknown as typeof fetch });
  expect(duplicate.queries).toHaveLength(1);
});
test('receipt confirmation calls only its isolated verifier writer and leaves membership assignment pending', async () => {
  const submitted = { ...base, status: 'submitted', transaction_hash: hash }, confirmed = { ...submitted, status: 'confirmed',
    block_number: '100', block_hash: blockHash, confirmations: 12 };
  const db = queued([[submitted], [confirmed]]);
  const result = await verifyPersonalCompanyPayment(db.database, { paymentId: id }, 'owner', { environment, fetchImpl: rpcFetch() });
  expect(result).toMatchObject({ status: 'confirmed', confirmations: 12, membershipAssignment: 'pending' });
  expect(db.queries[1]!.params).toEqual(['owner', id, hash, '100', blockHash, 12]);
  expect(db.queries[1]!.sql).toContain('verify_personal_company_payment');
  const pending = queued([[submitted]]);
  expect(await verifyPersonalCompanyPayment(pending.database, { paymentId: id }, 'owner', { environment, fetchImpl: rpcFetch({ eth_blockNumber: '0x6e' }) }))
    .toMatchObject({ status: 'submitted', confirmations: 11 });
  expect(pending.queries).toHaveLength(1);
  const concurrent = queued([[submitted], [confirmed]]);
  expect(await verifyPersonalCompanyPayment(concurrent.database, { paymentId: id }, 'owner', { environment,
    fetchImpl: rpcFetch({ eth_blockNumber: '0x70' }) })).toMatchObject({ status: 'confirmed', confirmations: 12 });
  expect(concurrent.queries[1]!.params.at(-1)).toBe(13);
});
test('owned status and recovery history expose explicit policy and reject crossed or corrupt persisted rows', async () => {
  expect((await readPersonalCompanyPayment(queued([[base]]).database, 'owner', id)).amountAtomic).toBe(amount);
  expect((await readPersonalCompanyPaymentHistory(queued([[base]]).database, 'owner')).records).toHaveLength(1);
  for (const change of [{ recipient_address: address }, { token_address: address }, { chain_id: 1 }, { token_decimals: 18 },
    { amount_atomic: '01' }, { status: 'confirmed', transaction_hash: hash, confirmations: 0 }]) {
    await expect(readPersonalCompanyPayment(queued([[{ ...base, ...change }]]).database, 'owner', id)).rejects.toThrow('company_payment_unavailable');
  }
  await expect(readPersonalCompanyPaymentHistory(queued([[base, base]]).database, 'owner')).rejects.toThrow('company_payment_unavailable');
});
test('cancellation of a pending proof prevents submission persistence and never broadcasts on the backend', async () => {
  const db = queued([[base]]), controller = new AbortController();
  await expect(submitPersonalCompanyPayment(db.database, { paymentId: id, transactionHash: hash }, 'owner', { environment, signal: controller.signal,
    fetchImpl: (async (_url, init) => { controller.abort(); const body = JSON.parse(String(init?.body));
      return Response.json({ jsonrpc: '2.0', id: body.id, result: '0x89' }); }) as typeof fetch })).rejects.toHaveProperty('name', 'AbortError');
  expect(db.queries).toHaveLength(1);
});

test('abandonment dismisses only the owned prepared draft idempotently and preserves a late valid hash', async () => {
  const abandoned = { ...base, abandoned_at: new Date(created.getTime() + 1000) };
  const db = queued([[abandoned], [abandoned]]);
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await abandonPersonalCompanyPayment(db.database, { paymentId: id }, 'owner')).toMatchObject({ status: 'prepared',
      abandonedAt: abandoned.abandoned_at.toISOString(), amountAtomic: amount, transactionHash: null });
  }
  expect(db.queries[0]!.sql).toContain('payments.abandon_personal_company_payment');
  expect(db.queries[0]!.params).toEqual(['owner', id]);
  const replay = await preparePersonalCompanyPayment(queued([[abandoned]]).database, { requestId: id, amountAtomic: amount }, 'owner', { environment,
    fetchImpl: (async () => { throw Error('abandoned preparation asked for another transfer'); }) as unknown as typeof fetch });
  expect(replay.abandonedAt).toBe(abandoned.abandoned_at.toISOString());
  const late = queued([[abandoned], [{ ...abandoned, status: 'submitted', transaction_hash: hash }]]);
  expect(await submitPersonalCompanyPayment(late.database, { paymentId: id, transactionHash: hash }, 'owner', { environment, fetchImpl: rpcFetch() }))
    .toMatchObject({ status: 'submitted', abandonedAt: abandoned.abandoned_at.toISOString(), transactionHash: hash });
  for (const status of ['submitted', 'confirmed', 'failed']) {
    const unsafe = { ...abandoned, status, transaction_hash: hash, ...(status === 'confirmed' ? { block_number: '100', block_hash: blockHash, confirmations: 12 } : {}),
      failure_reason: status === 'failed' ? 'transaction_reverted' : null };
    await expect(abandonPersonalCompanyPayment(queued([[unsafe]]).database, { paymentId: id }, 'owner')).rejects.toThrow('company_payment_unavailable');
  }
  await expect(abandonPersonalCompanyPayment(queued([]).database, { paymentId: id, subject: 'other' }, 'owner')).rejects.toThrow();
});
