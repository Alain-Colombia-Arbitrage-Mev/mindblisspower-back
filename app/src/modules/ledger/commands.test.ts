import { expect, test } from 'bun:test';
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { PostTransactionResponseSchema } from '../../gen/proto/vicionpower/v1/ledger_pb';
import { FinancialRecoveryPendingError } from '../../server/financial-readiness';
import { createLedgerCommands } from './commands';

type Dependencies = Parameters<typeof createLedgerCommands>[0];
const postedAt = new Date('2026-10-25T12:00:00Z');
const input = {
  externalRef: 'synthetic:source', description: 'Synthetic ledger transaction', initiatedByPersonId: 7n,
  actor: { userId: 'verified-user', isAdmin: true },
  movements: [{ walletId: 1n, affiliateId: 2n, conceptId: 3, amount: '999999999999.99999999', postedAt }],
};

function fixture(recovery: boolean | undefined) {
  const queries: string[] = [];
  const requests: Parameters<Dependencies['ledger']['postTransaction']>[0][] = [];
  const dialect = new PgDialect();
  const database = { execute: async (statement: SQL) => {
    queries.push(dialect.sqlToQuery(statement).sql);
    return queries.length === 1 ? recovery === undefined ? [] : [{ recovery }] : [];
  } } as unknown as Dependencies['database'];
  const ledger: Dependencies['ledger'] = { postTransaction: async request => {
    requests.push(request);
    return create(PostTransactionResponseSchema, { transactionId: 'synthetic-txn', wasIdempotentReplay: true, postedAt: timestampFromDate(postedAt) });
  } };
  return { commands: createLedgerCommands({ database, ledger }), queries, requests };
}

test('real ledger commands fail closed before RPC or PV writes during recovery', async () => {
  for (const recovery of [true, undefined]) {
    const posting = fixture(recovery);
    await expect(posting.commands.postTransaction(input)).rejects.toBeInstanceOf(FinancialRecoveryPendingError);
    expect(posting.requests).toHaveLength(0);
    expect(posting.queries).toHaveLength(1);
    expect(posting.queries[0]).toContain('to_regclass');

    const credit = fixture(recovery);
    await expect(credit.commands.registerPvCredit({ externalRef: 'synthetic:pv', affiliateId: 1n, pv: 10 })).rejects.toBeInstanceOf(FinancialRecoveryPendingError);
    expect(credit.queries).toHaveLength(1);
    expect(credit.queries[0]).not.toContain('INSERT');
  }
});

test('operational ledger preserves exact money, actor, IDs and RPC idempotency response', async () => {
  const { commands, queries, requests } = fixture(false);
  const result = await commands.postTransaction(input);
  expect(queries).toHaveLength(1);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.actor?.personId).toBe(7n);
  expect(requests[0]!.actor?.userId).toBe('verified-user');
  expect(requests[0]!.actor?.isAdmin).toBe(true);
  expect(requests[0]!.movements?.[0]?.amount).toBe(input.movements[0]!.amount);
  expect(requests[0]!.movements?.[0]?.walletId).toBe(1n);
  expect(result).toEqual({ txnId: 'synthetic-txn', wasIdempotentReplay: true, postedAt });
});

test('operational PV command checks readiness before its idempotent insert', async () => {
  const { commands, queries, requests } = fixture(false);
  await commands.registerPvCredit({ externalRef: 'synthetic:pv', affiliateId: 1n, pv: 10 });
  expect(queries).toHaveLength(2);
  expect(queries[0]).toContain('to_regclass');
  expect(queries[1]).toContain('ON CONFLICT (external_ref) DO NOTHING');
  expect(requests).toHaveLength(0);
});

test('direct domain calls also reject out-of-range money or dates without RPC', async () => {
  for (const change of [{ amount: '0.000000001' }, { amount: '1000000000000' }, { postedAt: new Date('0000-01-01T00:00:00Z') }]) {
    const { commands, queries, requests } = fixture(false);
    await expect(commands.postTransaction({ ...input, movements: [{ ...input.movements[0]!, ...change }] })).rejects.toThrow();
    expect(requests).toHaveLength(0);
    expect(queries).toHaveLength(0);
  }
});
