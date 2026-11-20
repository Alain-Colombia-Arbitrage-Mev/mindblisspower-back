import { expect, test } from 'bun:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { IdentityDatabase } from '../identity/model';
import { readAppMeldFundingHistory, readAppMeldFundingStatus } from './app-meld-funding-status';
import { ARBITRUM_USDC_TOKEN, COMPANY_PAYMENT_TRANSFER_TOPIC, LEGACY_POLYGON_TOKEN } from './personal-company-rpc';

const id = '6d492c47-80be-4e14-bc5f-54afaa56fc23';
const customer = 'aa0ecbcc-54d8-4a6e-a0ac-4a662ac8ed44';
const wallet = '0x' + '2'.repeat(40), anotherWallet = '0x' + '3'.repeat(40);
const txHash = '0x' + '4'.repeat(64), blockHash = '0x' + '5'.repeat(64);
const addressTopic = (address: string) => '0x' + address.slice(2).padStart(64, '0');
const environment = { MELD_PRODUCTION_API_KEYS: 'fixture-key', MELD_PRODUCTION_ACCOUNT_ID: 'merchant-account',
  REOWN_PROJECT_ID: 'a'.repeat(32), PERSONAL_COMPANY_PAYMENTS_ENABLED: 'true' };
const now = '2026-11-20T10:00:00.000Z';
const row = { id, subject: 'app-owner', wallet_address: wallet, account_id: environment.MELD_PRODUCTION_ACCOUNT_ID,
  customer_reference: customer, destination_currency: 'USDT_POLYGON', chain_id: 137, source_currency: 'MXN', country_code: 'MX',
  requested_amount: '1000.00', payment_method: 'CREDIT_DEBIT_CARD', service_provider: 'MERCURYO', status: 'session_created',
  provider_session_id: 'merchant-session', provider_customer_id: 'merchant-customer', created_at: new Date(now) };
const transaction = { id: 'merchant-transaction', accountId: row.account_id, sessionId: row.provider_session_id,
  customerId: row.provider_customer_id, externalSessionId: row.id, externalCustomerId: row.customer_reference,
  transactionType: 'CRYPTO_PURCHASE', serviceProvider: 'MERCURYO', countryCode: 'MX', sourceCurrencyCode: 'MXN',
  sourceAmount: 1000, destinationCurrencyCode: 'USDT_POLYGON', destinationAmount: 48.706979,
  paymentMethodType: 'CREDIT_DEBIT_CARD', status: 'SETTLED', updatedAt: now,
  cryptoDetails: { destinationWalletAddress: wallet.toUpperCase().replace('0X','0x'), chainId: '137', blockchainTransactionId: txHash } };
const receipt = { transactionHash: txHash, blockHash, blockNumber: '0x100', status: '0x1', logs: [{ address: LEGACY_POLYGON_TOKEN,
  topics: [COMPANY_PAYMENT_TRANSFER_TOPIC, addressTopic(anotherWallet), addressTopic(wallet)],
  data: '0x' + (48_706_979).toString(16).padStart(64, '0') }] };

function database(rows: unknown[]) {
  const queries: { sql: string; params: unknown[] }[] = [];
  return { queries, db: { execute: async query => {
    queries.push(new PgDialect().sqlToQuery(query as SQL));
    return rows;
  } } as Pick<IdentityDatabase, 'execute'> };
}

function upstream(detail = transaction, proof: typeof receipt | null = receipt, finalized = '0x104', ids = [{ id: transaction.id }]) {
  const calls: string[] = [];
  const fetchImpl = (async (target, init) => {
    const url = new URL(String(target));
    calls.push(url.origin + url.pathname);
    expect(init?.redirect).toBe('error');
    if (url.origin === 'https://api.meld.io') {
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).get('Meld-Account-Id')).toBe(row.account_id);
      if (url.pathname === '/payments/transactions') {
        expect(Object.fromEntries(url.searchParams)).toEqual({ externalSessionIds: id, sessionIds: row.provider_session_id,
          externalCustomerIds: customer, serviceProviders: detail.serviceProvider, types: 'CRYPTO_PURCHASE', limit: '2' });
        return Response.json({ transactions: ids });
      }
      expect(url.pathname).toBe('/payments/transactions/' + transaction.id);
      return Response.json({ transaction: detail });
    }
    expect(url.origin).toBe('https://rpc.walletconnect.org');
    expect(url.searchParams.get('chainId')).toBe('eip155:' + detail.cryptoDetails.chainId);
    expect(new Headers(init?.headers).has('Authorization')).toBeFalse();
    const rpc = JSON.parse(String(init?.body));
    const result = rpc.method === 'eth_chainId' ? '0x' + Number(detail.cryptoDetails.chainId).toString(16) : rpc.method === 'eth_getTransactionReceipt' ? proof
      : { number: rpc.params[0] === 'finalized' ? finalized : '0x100', hash: blockHash };
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test('App MELD history reads only the owned journal without a merchant request', async () => {
  const { db, queries } = database([row]);
  expect(await readAppMeldFundingHistory(db, row.subject)).toEqual([{ checkoutReference: id, provider: 'meld', serviceProvider: 'MERCURYO',
    country: 'MX', requestedAmount: 1000, sourceCurrencyCode: 'MXN', paymentMethodType: 'CREDIT_DEBIT_CARD',
    destination: { address: wallet, asset: 'USDT', network: 'polygon', chainId: 137 }, status: 'session_created', createdAt: now }]);
  expect(queries[0]).toMatchObject({ sql: 'SELECT * FROM payments.read_app_meld_funding_v2($1,NULL::uuid)', params: [row.subject] });
  await expect(readAppMeldFundingHistory(database([row]).db, 'another-owner')).rejects.toThrow('wallet_funding_unavailable');
});

test('App lets the caller fall back only for missing references and never reconciles another owner or merchant', async () => {
  const { calls, fetchImpl } = upstream();
  expect(await readAppMeldFundingStatus(database([]).db, row.subject, id, { environment, fetchImpl })).toBeNull();
  await expect(readAppMeldFundingStatus(database([row]).db, 'another-owner', id, { environment, fetchImpl })).rejects.toThrow('wallet_funding_unavailable');
  await expect(readAppMeldFundingStatus(database([{ ...row, account_id: 'different' }]).db, row.subject, id,
    { environment, fetchImpl })).rejects.toThrow('wallet_funding_provider_unavailable');
  expect(calls).toHaveLength(0);
});

test('App confirms only the bound amount of canonical, finalized Polygon USDT', async () => {
  const { db } = database([row]);
  const { fetchImpl } = upstream();
  const value = await readAppMeldFundingStatus(db, row.subject, id, { environment, fetchImpl });
  expect(value?.confirmation).toEqual({ state: 'confirmed', source: 'meld_production_api', testMode: false,
    transactionId: transaction.id, providerStatus: 'SETTLED', receivedAmount: '48.706979', confirmedAt: now });

  for (const probe of [upstream(transaction, null), upstream(transaction, receipt, '0xff'), upstream(transaction, {
    ...receipt, logs: [{ ...receipt.logs[0]!, topics: [COMPANY_PAYMENT_TRANSFER_TOPIC, addressTopic(wallet), addressTopic(anotherWallet)] }],
  }), upstream(transaction, { ...receipt, logs: [{ ...receipt.logs[0]!, address: anotherWallet }] })]) {
    const value = await readAppMeldFundingStatus(db, row.subject, id, { environment, fetchImpl: probe.fetchImpl });
    expect(value?.confirmation).toEqual({ state: 'pending', source: 'meld_production_api', testMode: false,
      transactionId: transaction.id, providerStatus: 'SETTLING' });
  }
});

test('App rejects ambiguous merchant results and wrong immutable transaction details', async () => {
  for (const probe of [upstream({ ...transaction, sourceAmount: 1001 }), upstream({ ...transaction, sessionId: 'wrong' }),
    upstream({ ...transaction, cryptoDetails: { ...transaction.cryptoDetails, destinationWalletAddress: anotherWallet } }),
    upstream(transaction, receipt, '0x104', [{ id: 'one' }, { id: 'two' }])]) {
    await expect(readAppMeldFundingStatus(database([row]).db, row.subject, id, { environment, fetchImpl: probe.fetchImpl }))
      .rejects.toThrow('wallet_funding_provider_unavailable');
    expect(probe.calls.every(url => url.startsWith('https://api.meld.io/'))).toBeTrue();
  }
});

test('App USDC reconciliation requires the registered Polygon asset and its actual token transfer', async () => {
  const usdc = { ...row, destination_currency: 'USDC_POLYGON', source_currency: 'USD', country_code: 'US',
    requested_amount: '100.00', payment_method: 'GOOGLE_PAY', service_provider: 'RAMPNOW' };
  const detail = { ...transaction, destinationCurrencyCode: 'USDC_POLYGON', sourceCurrencyCode: 'USD', countryCode: 'US',
    sourceAmount: 100, paymentMethodType: 'GOOGLE_PAY', serviceProvider: 'RAMPNOW' };
  const { db } = database([usdc]);
  const wrongToken = await readAppMeldFundingStatus(db, row.subject, id, { environment, fetchImpl: upstream(detail).fetchImpl });
  expect(wrongToken?.confirmation.state).toBe('pending');
  const wrongAsset = upstream({ ...detail, destinationCurrencyCode: 'USDT_POLYGON' });
  await expect(readAppMeldFundingStatus(db, row.subject, id, { environment, fetchImpl: wrongAsset.fetchImpl }))
    .rejects.toThrow('wallet_funding_provider_unavailable');
  expect(wrongAsset.calls.every(url => url.startsWith('https://api.meld.io/'))).toBeTrue();
  const proof = { ...receipt, logs: [{ ...receipt.logs[0]!, address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359' }] };
  const confirmed = await readAppMeldFundingStatus(db, row.subject, id, { environment, fetchImpl: upstream(detail, proof).fetchImpl });
  expect(confirmed).toMatchObject({ destination: { address: wallet, asset: 'USDC', chainId: 137 }, confirmation: { state: 'confirmed' } });
});

test('Brazil Pix confirms only native USDC on Arbitrum in the linked wallet', async () => {
  const brazil = { ...row, country_code: 'BR', source_currency: 'BRL', requested_amount: '500.00',
    destination_currency: 'USDC_ARBITRUM', chain_id: 42161, service_provider: 'ALCHEMYPAY', payment_method: 'PIX' };
  const detail = { ...transaction, countryCode: 'BR', sourceCurrencyCode: 'BRL', sourceAmount: 500,
    destinationCurrencyCode: 'USDC_ARBITRUM', serviceProvider: 'ALCHEMYPAY', paymentMethodType: 'PIX',
    cryptoDetails: { ...transaction.cryptoDetails, chainId: '42161' } };
  const proof = { ...receipt, logs: [{ ...receipt.logs[0]!, address: ARBITRUM_USDC_TOKEN }] };
  const { db } = database([brazil]);
  const value = await readAppMeldFundingStatus(db, row.subject, id, { environment, fetchImpl: upstream(detail, proof).fetchImpl });
  expect(value).toMatchObject({ destination: { address: wallet, network: 'arbitrum', asset: 'USDC', chainId: 42161 },
    confirmation: { state: 'confirmed', receivedAmount: '48.706979' } });
  const wrongToken = await readAppMeldFundingStatus(db, row.subject, id, { environment, fetchImpl: upstream(detail).fetchImpl });
  expect(wrongToken?.confirmation.state).toBe('pending');
  for (const wrong of [{ ...detail, cryptoDetails: { ...detail.cryptoDetails, chainId: '137' } },
    { ...detail, paymentMethodType: 'CREDIT_DEBIT_CARD' }]) {
    const probe = upstream(wrong, proof);
    await expect(readAppMeldFundingStatus(db, row.subject, id, { environment, fetchImpl: probe.fetchImpl }))
      .rejects.toThrow('wallet_funding_provider_unavailable');
    expect(probe.calls).toHaveLength(2);
  }
});
