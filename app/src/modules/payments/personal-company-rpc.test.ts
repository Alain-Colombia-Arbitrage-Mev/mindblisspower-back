import { expect, spyOn, test } from 'bun:test';
import { checkCompanyPaymentBalance, checkCompanyPaymentSubmission, companyPaymentAtomic, companyPaymentCalldata,
  createCompanyPaymentRpc, readCompanyPaymentBalances, readPersonalWalletNetworkBalances, LEGACY_POLYGON_TOKEN, verifyCompanyPaymentReceipt, COMPANY_PAYMENT_TOKEN, COMPANY_PAYMENT_RECIPIENT, COMPANY_PAYMENT_TRANSFER_TOPIC } from './personal-company-rpc';

export const companyFixture = {
  sender: `0x${'2'.repeat(40)}`, hash: `0x${'3'.repeat(64)}`, blockHash: `0x${'4'.repeat(64)}`, amount: '20000000',
};
export const companyEnvironment = { PERSONAL_COMPANY_PAYMENTS_ENABLED: 'true', REOWN_PROJECT_ID: 'a'.repeat(32) };
const word = (value: string) => `0x${value.replace(/^0x/, '').padStart(64, '0')}`;
export function companyRpcFixture() {
  const { sender, hash, blockHash, amount } = companyFixture;
  const log = { address: COMPANY_PAYMENT_TOKEN, topics: [COMPANY_PAYMENT_TRANSFER_TOPIC, word(sender), word(COMPANY_PAYMENT_RECIPIENT)],
    data: word(BigInt(amount).toString(16)), transactionHash: hash, blockHash, removed: false };
  return {
    transaction: { hash, from: sender, to: COMPANY_PAYMENT_TOKEN, input: companyPaymentCalldata(amount), value: '0x0', chainId: '0x1', blockNumber: '0x64', blockHash },
    receipt: { transactionHash: hash, from: sender, to: COMPANY_PAYMENT_TOKEN, blockNumber: '0x64', blockHash, status: '0x1', logs: [log] },
    head: '0x6f', block: { number: '0x64', hash: blockHash },
  };
}
export function companyFetch(fixture = companyRpcFixture(), extra: Record<string, unknown> = {}, seen: string[] = []): typeof fetch {
  return (async (url, init) => {
    expect(String(url)).toBe(`https://rpc.walletconnect.org/v1?chainId=eip155:1&projectId=${companyEnvironment.REOWN_PROJECT_ID}`);
    expect(init?.method).toBe('POST'); expect(init?.redirect).toBe('error'); expect(init?.credentials).toBe('omit');
    expect(new Headers(init?.headers).get('origin')).toBe('https://app.mindblisspower.com');
    const body = JSON.parse(String(init?.body)); seen.push(body.method);
    const results: Record<string, unknown> = { eth_chainId: '0x1', eth_getTransactionByHash: fixture.transaction,
      eth_getTransactionReceipt: fixture.receipt, eth_blockNumber: fixture.head, eth_getBlockByNumber: fixture.block, ...extra };
    const result = body.method === 'eth_call' ? word(body.params[0].data === '0x313ce567' ? '6' : BigInt(companyFixture.amount).toString(16)) : results[body.method];
    if (result === undefined) throw Error('unapproved RPC method');
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  }) as typeof fetch;
}
async function withRpc<T>(perform: (rpc: ReturnType<typeof createCompanyPaymentRpc>) => Promise<T>, fixture = companyRpcFixture(), extra: Record<string, unknown> = {}) {
  const rpc = createCompanyPaymentRpc(companyEnvironment, companyFetch(fixture, extra));
  try { return await perform(rpc); } finally { rpc.dispose(); }
}
test('default Ethereum USDT preparation supports all six-decimal balance without approving or sending funds', async () => {
  const methods: string[] = [];
  const rpc = createCompanyPaymentRpc(companyEnvironment, companyFetch(companyRpcFixture(), {}, methods));
  try {
    await checkCompanyPaymentBalance(rpc, companyFixture.sender, companyFixture.amount);
    await expect(checkCompanyPaymentBalance(rpc, companyFixture.sender, '20000001')).rejects.toThrow('company_payment_insufficient_balance');
    expect(methods.every(value => ['eth_chainId', 'eth_call'].includes(value))).toBe(true);
  } finally { rpc.dispose(); }
  for (const amount of ['0', '01', '-1', '1.1', '1e6', ' 1', (1n << 256n).toString()]) expect(companyPaymentAtomic(amount)).toBe(false);
  expect(companyPaymentAtomic(((1n << 256n) - 1n).toString())).toBe(true);
  for (const env of [{}, { ...companyEnvironment, PERSONAL_COMPANY_PAYMENTS_ENABLED: 'false' }, { ...companyEnvironment, REOWN_PROJECT_ID: 'https://127.0.0.1' }]) {
    expect(() => createCompanyPaymentRpc(env)).toThrow('company_payment_unconfigured');
  }
});
test('hash registration requires the actual bound sender, exact token, recipient, amount, chain and zero native value', async () => {
  await withRpc(rpc => checkCompanyPaymentSubmission(rpc, companyFixture.hash, companyFixture.sender, companyFixture.amount));
  for (const change of [{ from: `0x${'5'.repeat(40)}` }, { to: COMPANY_PAYMENT_RECIPIENT }, { input: companyPaymentCalldata('1') },
    { input: companyPaymentCalldata(companyFixture.amount) + '00' }, { value: '0x1' }, { chainId: '0x89' }, { hash: `0x${'6'.repeat(64)}` }]) {
    const fixture = companyRpcFixture(); Object.assign(fixture.transaction, change);
    await expect(withRpc(rpc => checkCompanyPaymentSubmission(rpc, companyFixture.hash, companyFixture.sender, companyFixture.amount), fixture))
      .rejects.toThrow('company_payment_transaction_mismatch');
  }
  await expect(withRpc(rpc => checkCompanyPaymentSubmission(rpc, companyFixture.hash, companyFixture.sender, companyFixture.amount), companyRpcFixture(),
    { eth_getTransactionByHash: null })).rejects.toThrow('company_payment_transaction_pending');
});
test('a canonical successful receipt with exactly one authentic USDT Transfer and twelve confirmations proves payment only', async () => {
  const result = await withRpc(rpc => verifyCompanyPaymentReceipt(rpc, companyFixture.hash, companyFixture.sender, companyFixture.amount));
  expect(result).toEqual({ state: 'confirmed', confirmations: 12, blockNumber: '100', blockHash: companyFixture.blockHash });
  expect(JSON.stringify(result)).not.toMatch(/membership|commission|balance/);
});
test('unmined transactions, insufficient confirmations and reorgs remain retryable without a terminal outcome', async () => {
  for (const [extra, confirmations] of [[{ eth_getTransactionReceipt: null }, 0], [{ eth_blockNumber: '0x6e' }, 11],
    [{ eth_getBlockByNumber: { number: '0x64', hash: `0x${'7'.repeat(64)}` } }, 0]] as const) {
    expect(await withRpc(rpc => verifyCompanyPaymentReceipt(rpc, companyFixture.hash, companyFixture.sender, companyFixture.amount), companyRpcFixture(), extra))
      .toEqual({ state: 'pending', confirmations });
  }
  const removed = companyRpcFixture(); removed.receipt.logs[0]!.removed = true;
  expect(await withRpc(rpc => verifyCompanyPaymentReceipt(rpc, companyFixture.hash, companyFixture.sender, companyFixture.amount), removed))
    .toEqual({ state: 'pending', confirmations: 0 });
  for (const change of [{ data: '0x1' }, { topics: [COMPANY_PAYMENT_TRANSFER_TOPIC, 'malformed', 'malformed'] },
    { blockHash: `0x${'7'.repeat(64)}` }]) {
    const malformed = companyRpcFixture(); Object.assign(malformed.receipt.logs[0]!, change);
    await expect(withRpc(rpc => verifyCompanyPaymentReceipt(rpc, companyFixture.hash, companyFixture.sender, companyFixture.amount), malformed))
      .rejects.toThrow('company_payment_rpc_unavailable');
  }
});
test('wrong logs, duplicate events, wrong receipt destination and reverted transfers cannot confirm', async () => {
  const variants = [
    (f: ReturnType<typeof companyRpcFixture>) => { f.receipt.logs[0]!.address = COMPANY_PAYMENT_RECIPIENT; },
    (f: ReturnType<typeof companyRpcFixture>) => { f.receipt.logs[0]!.data = word('1'); },
    (f: ReturnType<typeof companyRpcFixture>) => { f.receipt.logs[0]!.topics[2] = word(companyFixture.sender); },
    (f: ReturnType<typeof companyRpcFixture>) => { f.receipt.logs.push({ ...f.receipt.logs[0]! }); },
    (f: ReturnType<typeof companyRpcFixture>) => { f.receipt.to = COMPANY_PAYMENT_RECIPIENT; },
  ];
  for (const change of variants) {
    const fixture = companyRpcFixture(); change(fixture);
    expect(await withRpc(rpc => verifyCompanyPaymentReceipt(rpc, companyFixture.hash, companyFixture.sender, companyFixture.amount), fixture))
      .toEqual({ state: 'failed', reason: 'transaction_mismatch' });
  }
  const reverted = companyRpcFixture(); reverted.receipt.status = '0x0'; reverted.receipt.logs = [];
  expect(await withRpc(rpc => verifyCompanyPaymentReceipt(rpc, companyFixture.hash, companyFixture.sender, companyFixture.amount), reverted))
    .toEqual({ state: 'failed', reason: 'transaction_reverted' });
});
test('provider failures, malformed envelopes and wrong RPC chains never become payment evidence', async () => {
  await expect(withRpc(rpc => verifyCompanyPaymentReceipt(rpc, companyFixture.hash, companyFixture.sender, companyFixture.amount), companyRpcFixture(),
    { eth_chainId: '0x89' })).rejects.toThrow('company_payment_rpc_unavailable');
  for (const response of [Response.json({ jsonrpc: '2.0', id: 999, result: '0x1' }), Response.json({ private: 'provider details' }, { status: 503 }),
    new Response('[]', { status: 302, headers: { location: 'http://127.0.0.1' } }),
    new Response('private provider details', { headers: { 'content-type': 'application/json', 'content-length': '262145' } }),
    new Response('x'.repeat(262145), { headers: { 'content-type': 'application/json' } })]) {
    const rpc = createCompanyPaymentRpc(companyEnvironment, (async () => response) as unknown as typeof fetch);
    try { await expect(checkCompanyPaymentSubmission(rpc, companyFixture.hash, companyFixture.sender, companyFixture.amount)).rejects.toThrow('company_payment_rpc_unavailable'); }
    finally { rpc.dispose(); }
  }
});
test('the fixed RPC deadline also bounds a provider that ignores cancellation entirely', async () => {
  const original = globalThis.setTimeout;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementationOnce(((callback: () => void) => original(callback, 5)) as typeof setTimeout);
  let rpc: ReturnType<typeof createCompanyPaymentRpc> | undefined;
  try {
    rpc = createCompanyPaymentRpc(companyEnvironment, (() => new Promise(() => {})) as unknown as typeof fetch);
    await expect(checkCompanyPaymentSubmission(rpc, companyFixture.hash, companyFixture.sender, companyFixture.amount))
      .rejects.toThrow('company_payment_rpc_unavailable');
  } finally { rpc?.dispose(); timer.mockRestore(); }
});
test('cancelling non-abortable RPC work stops verification and ignores late successful-looking results', async () => {
  const controller = new AbortController(); let release!: (response: Response) => void, called!: () => void;
  const started = new Promise<void>(resolve => { called = resolve; });
  const rpc = createCompanyPaymentRpc(companyEnvironment, (async () => { called(); return new Promise<Response>(resolve => { release = resolve; }); }) as unknown as typeof fetch, controller.signal);
  try {
    const pending = checkCompanyPaymentSubmission(rpc, companyFixture.hash, companyFixture.sender, companyFixture.amount);
    await started; controller.abort(); await expect(pending).rejects.toHaveProperty('name', 'AbortError');
    release(Response.json({ jsonrpc: '2.0', id: 1, result: '0x1' }));
    await Promise.resolve();
  } finally { rpc.dispose(); }
});


test('read-only Ethereum balances preserve zero and exact uint256 values without preparing or sending funds', async () => {
  for (const [tokenBalance, nativeBalance] of [[0n, 0n], [10_000_000n, 123_456_789n], [(1n << 256n) - 1n, (1n << 256n) - 1n]]) {
    const calls: string[] = [];
    const rpc = createCompanyPaymentRpc(companyEnvironment, (async (url, init) => {
      expect(String(url)).toContain('chainId=eip155:1&');
      const request = JSON.parse(String(init?.body)); calls.push(request.method);
      let result;
      if (request.method === 'eth_chainId') result = '0x1';
      else if (request.method === 'eth_getBalance') {
        expect(request.params).toEqual([companyFixture.sender, 'latest']);
        result = `0x${nativeBalance!.toString(16)}`;
      } else {
        expect(request.method).toBe('eth_call');
        expect(request.params[0].to).toBe(COMPANY_PAYMENT_TOKEN);
        expect(request.params[1]).toBe('latest');
        const selector = request.params[0].data;
        expect(['0x313ce567', `0x70a08231${companyFixture.sender.slice(2).padStart(64, '0')}`]).toContain(selector);
        result = word(selector === '0x313ce567' ? '6' : tokenBalance!.toString(16));
      }
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    }) as typeof fetch);
    try {
      expect(await readCompanyPaymentBalances(rpc, companyFixture.sender)).toEqual({ balanceAtomic: tokenBalance!.toString(), nativeBalanceAtomic: nativeBalance!.toString() });
      expect(calls.sort()).toEqual(['eth_call', 'eth_call', 'eth_chainId', 'eth_getBalance']);
    } finally { rpc.dispose(); }
  }
});

test('the backward-compatible single-balance read rejects Polygon, invalid address, wrong chain, token decimals and malformed native quantities', async () => {
  for (const [chain, owner] of [[137, companyFixture.sender], [1, 'not-an-address']] as const) {
    const rpc = createCompanyPaymentRpc(companyEnvironment, (async () => { throw Error('unapproved balance read reached RPC'); }) as unknown as typeof fetch, undefined, chain);
    try { await expect(readCompanyPaymentBalances(rpc, owner)).rejects.toThrow('company_payment_rpc_unavailable'); }
    finally { rpc.dispose(); }
  }
  for (const variant of ['wrong-chain', 'wrong-decimals', 'malformed-token', 'empty-native', 'leading-zero-native', 'overflow-native']) {
    const rpc = createCompanyPaymentRpc(companyEnvironment, (async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const result = request.method === 'eth_chainId' ? (variant === 'wrong-chain' ? '0x89' : '0x1')
        : request.method === 'eth_getBalance' ? ({ 'empty-native': '0x', 'leading-zero-native': '0x00', 'overflow-native': `0x1${'0'.repeat(64)}` }[variant] ?? '0x0')
        : request.params[0].data === '0x313ce567' ? word(variant === 'wrong-decimals' ? '18' : '6')
        : variant === 'malformed-token' ? '0x0' : word('0');
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    }) as typeof fetch);
    try { await expect(readCompanyPaymentBalances(rpc, companyFixture.sender)).rejects.toThrow('company_payment_rpc_unavailable'); }
    finally { rpc.dispose(); }
  }
});


test('display-only Polygon reads use its own authentic USDT token and native quantity while the backward-compatible single-balance helper stays Ethereum-only', async () => {
  const seen: string[] = [];
  const rpc = createCompanyPaymentRpc(companyEnvironment, (async (url, init) => {
    expect(String(url)).toContain('chainId=eip155:137&');
    const request = JSON.parse(String(init?.body)); seen.push(request.method);
    if (request.method === 'eth_call') expect(request.params[0].to).toBe(LEGACY_POLYGON_TOKEN);
    const result = request.method === 'eth_chainId' ? '0x89' : request.method === 'eth_getBalance' ? '0x0'
      : word(request.params[0].data === '0x313ce567' ? '6' : 'f4240');
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  }) as typeof fetch, undefined, 137);
  try {
    expect(await readPersonalWalletNetworkBalances(rpc, companyFixture.sender)).toEqual({ balanceAtomic: '1000000', nativeBalanceAtomic: '0' });
    expect(seen.sort()).toEqual(['eth_call', 'eth_call', 'eth_chainId', 'eth_getBalance']);
    await expect(readCompanyPaymentBalances(rpc, companyFixture.sender)).rejects.toThrow('company_payment_rpc_unavailable');
    expect(seen).toHaveLength(4);
  } finally { rpc.dispose(); }
});
