import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PgDialect } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { sql, type SQL } from 'drizzle-orm';
import { Wallet, Interface, TypedDataEncoder } from 'ethers';
import { registerPersonalPolygonRelayRoutes } from '../../http/personal-polygon-relay-routes';
import type { ApiEnvironment } from '../../http/types';
import type { IdentityDatabase } from '../identity/model';
import { POLYGON_RELAY_DOMAIN, POLYGON_RELAY_ABI, POLYGON_RELAY_IMPLEMENTATION, POLYGON_RELAY_ENTRY_POINT } from './polygon-relay-policy';
import { COMPANY_PAYMENT_RECIPIENT, LEGACY_POLYGON_TOKEN, companyPaymentCalldata } from './personal-company-rpc';
import type { createPolygonAaRelayer } from './polygon-relay-aa';

// No host .env or production DSN is inherited. Providers, signatures and user
// balances below are entirely synthetic; PostgreSQL capabilities are REAL.
const enabled = process.env.PERSONAL_POLYGON_RELAY_SYNTHETIC_DOCKER === '1';
function target(raw: string | undefined) {
  const url = new URL(raw || 'postgres://invalid');
  if (url.protocol !== 'postgres:' || url.hostname !== '127.0.0.1' || url.port !== '5432' || url.pathname !== '/mindbliss_curated_20261025'
    || url.username !== 'personal_flow_fixture' || url.password || url.search || url.hash) throw Error('Relay integration requires the marked disposable Docker fixture');
  return url.href;
}
if (!enabled) test.skip('Polygon sponsored relay joined flow requires the explicit disposable Docker harness', () => {});
else describe('Polygon relay real SQL + signed Hono boundary + fake provider', () => {
  const client = postgres(target(process.env.PERSONAL_POLYGON_RELAY_DATABASE_URL), { max: 4, prepare: false, connection: { statement_timeout: 5000, lock_timeout: 4000 }, onnotice() {} });
  const database = drizzle(client), secret = 'synthetic-relay-bff-secret'.repeat(2), prefix = '/api/member/polygon-relay';
  const environment = { PERSONAL_POLYGON_RELAY_ENABLED: 'true', PERSONAL_POLYGON_RELAY_BROADCAST_ENABLED: 'true', AUTH_BFF_SHARED_SECRET: secret,
    REOWN_PROJECT_ID: 'a'.repeat(32), PIMLICO_API_KEY: 'synthetic-provider-secret', POLYGON_RELAYER_PRIVATE_KEY: `0x${'1'.repeat(64)}`,
    POLYGON_RELAY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') };
  const aa = `0x${'4'.repeat(40)}`, paymaster = `0x${'5'.repeat(40)}`, txHash = `0x${'86'.repeat(32)}`, blockHash = `0x${'97'.repeat(32)}`;
  const ep = new Interface(['event BeforeExecution()', 'event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)', 'function getNonce(address,uint192) view returns(uint256)']);
  const token = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)', 'event MetaTransactionExecuted(address userAddress,address relayerAddress,bytes functionSignature)']);
  const safe = new Interface(['function executeUserOpWithErrorString(address,uint256,bytes,uint8)']);
  const previousFetch = globalThis.fetch; let realExternalCalls = 0, aaNonce = 0n;
  let handleBff: (request: Request, action: string, options: any) => Promise<Response>;
  let dispatchCore: (request: Request, environment: any, resolver: any) => Promise<Response>;
  beforeAll(async () => {
    expect(Bun.version).toBe('1.4.4');
    globalThis.fetch = (() => { realExternalCalls++; throw Error('Disposable relay flow prohibits all real provider access'); }) as unknown as typeof fetch;
    const [identity] = await client`SELECT current_user AS role,current_setting('mindbliss.personal_wallet_flow_fixture',true) AS marker`;
    expect(identity).toEqual({ role: 'personal_flow_fixture', marker: 'isolated-v1' });
    const [acl] = await client`SELECT has_table_privilege(current_user,'payments.personal_polygon_relay','INSERT,UPDATE,DELETE') AS unsafe`;
    expect(acl!.unsafe).toBe(false);
    // Fixed readonly source mounts supplied by the disposable harness. No
    // copied signing stub: exercise the actual frontend BFF and Core gateway.
    const frontendPath = '/personal-front/lib/polygon-relay-bff.mjs', corePath = '/backend-core/routing.mjs';
    handleBff = (await import(frontendPath)).handlePolygonRelay;
    dispatchCore = (await import(corePath)).dispatchCore;
    expect(typeof handleBff).toBe('function'); expect(typeof dispatchCore).toBe('function');
  });
  afterAll(async () => { globalThis.fetch = previousFetch; await client.end({ timeout: 2 }); expect(realExternalCalls).toBe(0); });
  function signed(path: string, value?: unknown, origin = 'https://app.mindblisspower.com') {
    const body = value === undefined ? '' : JSON.stringify(value), method = value === undefined ? 'GET' : 'POST';
    const timestamp = String(Math.floor(Date.now() / 1000)), ip = '192.0.2.1', cookie = 'better-auth.session_token=synthetic';
    const digest = (raw: string) => createHash('sha256').update(raw).digest('hex');
    return { method, headers: { origin, cookie, 'content-type': 'application/json', 'x-vp-auth-client-ip': ip, 'x-vp-auth-timestamp': timestamp,
      'x-vp-auth-signature': createHmac('sha256', secret).update([method, path.split('?')[0], timestamp, ip, digest(cookie), digest(body)].join('\n')).digest('hex') },
      ...(value === undefined ? {} : { body }) };
  }
  for (const scenario of [
    { owner: 'relay-success', key: '2', mode: 'success' },
    { owner: 'relay-ack-loss', key: '3', mode: 'lost-ack' },
    { owner: 'relay-concurrent', key: '4', mode: 'concurrent' },
  ]) test(`${scenario.mode}: durable authorization/budget/dispatch and canonical recovery remain owner-isolated`, async () => {
    const wallet = new Wallet(`0x${scenario.key.repeat(64)}`), sender = wallet.address.toLowerCase(), paymentId = randomUUID(), amountAtomic = '30000000';
    let phase: 'preparation' | 'receipt' | 'expired' = 'preparation', sends = 0, quotes = 0, signatures = 0, lostAck = scenario.mode === 'lost-ack';
    const methods: string[] = [];
    const read = async () => (await database.execute(sql`SELECT * FROM payments.read_personal_polygon_relay(${scenario.owner},${paymentId}::uuid)`))[0] as Record<string, unknown>;
    const callLog = (abi: Interface, name: string, args: unknown[], address = POLYGON_RELAY_ENTRY_POINT) => ({ address, ...abi.encodeEventLog(abi.getEvent(name)!, args), removed: false });
    const fakeProvider = (async (url, init) => {
      const request = JSON.parse(String(init?.body)), method = request.method; methods.push(method);
      expect(['rpc.walletconnect.org', 'api.pimlico.io']).toContain(new URL(String(url)).hostname);
      let result: unknown;
      if (method === 'eth_chainId') result = '0x89';
      else if (method === 'eth_call') {
        const data = request.params[0].data;
        result = data === '0x313ce567' ? `0x${'6'.padStart(64, '0')}`
          : data.startsWith('0x70a08231') ? `0x${BigInt(amountAtomic).toString(16).padStart(64, '0')}`
          : data === POLYGON_RELAY_ABI.encodeFunctionData('getNonce', [sender]) ? `0x${(phase === 'receipt' ? 8n : 7n).toString(16).padStart(64, '0')}`
          : data === POLYGON_RELAY_ABI.encodeFunctionData('implementation') ? `0x${POLYGON_RELAY_IMPLEMENTATION.slice(2).padStart(64, '0')}`
          : data === POLYGON_RELAY_ABI.encodeFunctionData('getDomainSeperator') ? TypedDataEncoder.hashDomain(POLYGON_RELAY_DOMAIN)
          : data === ep.encodeFunctionData('getNonce', [aa, 0]) ? `0x${aaNonce.toString(16).padStart(64, '0')}` : undefined;
      } else if (method === 'eth_sendUserOperation') {
        sends++; const stored = await read();
        expect(stored.status).toBe('broadcasting'); expect(stored.operation_ciphertext).toBeString(); expect(stored.user_operation_hash).toBeString();
        result = stored.user_operation_hash;
      } else if (method === 'eth_getUserOperationReceipt') result = phase === 'receipt' ? { userOpHash: (await read()).user_operation_hash, receipt: { transactionHash: txHash } } : null;
      else if (method === 'eth_blockNumber') result = phase === 'expired' ? '0x1f4' : '0x6f';
      else if (method === 'eth_getBlockByNumber') result = { number: phase === 'expired' ? '0x1e9' : '0x64', hash: blockHash,
        timestamp: `0x${BigInt(Math.floor(Date.now() / 1000)).toString(16)}` };
      else if (method === 'eth_getTransactionByHash') result = { hash: txHash, to: POLYGON_RELAY_ENTRY_POINT, from: `0x${'a'.repeat(40)}`, value: '0x0', chainId: '0x89', blockNumber: '0x64', blockHash };
      else if (method === 'eth_getTransactionReceipt') {
        const row = await read();
        result = { transactionHash: txHash, to: POLYGON_RELAY_ENTRY_POINT, blockNumber: '0x64', blockHash, status: '0x1', logs: [
          callLog(ep, 'BeforeExecution', []), callLog(token, 'Transfer', [sender, COMPANY_PAYMENT_RECIPIENT, amountAtomic], LEGACY_POLYGON_TOKEN),
          callLog(token, 'MetaTransactionExecuted', [sender, aa, companyPaymentCalldata(amountAtomic)], LEGACY_POLYGON_TOKEN),
          callLog(ep, 'UserOperationEvent', [row.user_operation_hash, aa, paymaster, aaNonce, true, 1000n, 100n]),
        ] };
      }
      if (result === undefined) throw Error('unapproved synthetic provider method');
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    }) as typeof fetch;
    const createRelayer = (async () => {
      const after = Math.floor(Date.now() / 1000) - 30, until = after + (scenario.mode === 'lost-ack' ? 32 : 330);
      return { relayerAddress: aa, operationValidAfter: after, operationValidUntil: until,
        account: { getNonce: async () => aaNonce, getFactoryArgs: async () => ({}),
          encodeCalls: async (calls: { data: string }[]) => safe.encodeFunctionData('executeUserOpWithErrorString', [LEGACY_POLYGON_TOKEN, 0n, calls[0]!.data, 0]),
          signUserOperation: async () => { signatures++; return `0x${after.toString(16).padStart(12, '0')}${until.toString(16).padStart(12, '0')}${'a'.repeat(130)}`; } },
        client: { prepareUserOperation: async ({ callData, nonce }: { callData: string; nonce: bigint }) => {
          quotes++; const stored = await read(); expect(stored.status).toBe('broadcasting'); expect(stored.lease_token).toBeString();
          expect(stored.operation_ciphertext).toBeNull(); methods.push('pm_sponsorUserOperation');
          return { sender: aa, nonce, callData,
            callGasLimit: 1000n, verificationGasLimit: 1000n, preVerificationGas: 1000n, paymasterVerificationGasLimit: 1000n, paymasterPostOpGasLimit: 1000n,
            maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n, paymaster, paymasterData: '0x1234' };
        } },
      };
    }) as unknown as typeof createPolygonAaRelayer;
    const wrapped = { execute: async (query: SQL) => {
      const rows = await database.execute(query);
      if (lostAck && new PgDialect().sqlToQuery(query).sql.includes('persist_personal_polygon_relay_operation')) { lostAck = false; throw Error('synthetic committed SQL acknowledgement lost'); }
      return rows;
    } } as Pick<IdentityDatabase, 'execute'>;
    const application = (owner: string) => {
      const app = new Hono<ApiEnvironment>();
      app.use('*', async (context, next) => { context.set('session', { user: { id: owner } } as never); await next(); });
      registerPersonalPolygonRelayRoutes(app, { database: wrapped, environment, fetchImpl: fakeProvider, createRelayer }); return app;
    };
    const browser = (native: Hono<ApiEnvironment>) => ({ request: async (path: string, init: RequestInit) => {
      const headers = new Headers(init.headers); headers.set('cf-connecting-ip', '192.0.2.1');
      const request = new Request(`https://app.mindblisspower.com${path}`, { ...init, headers });
      const fetchCore = (async (target: string | URL | Request, options?: RequestInit) => dispatchCore(target instanceof Request ? new Request(target, options) : new Request(String(target), options), {
        ...environment, CORE_ENV: 'production', AUTH_SERVICES_ENABLED: 'true', CORE_DATA_ACCESS_VERIFIED: 'true', AUTH_CUTOVER_VERIFIED: 'true',
        CORE_SERVICES_ENABLED: 'false', CORE_NETWORK_VERIFIED: 'false',
      }, (service: string, instance: string) => { expect(service).toBe('api'); expect(instance).toBe('singleton'); return { fetch: (forwarded: Request) => native.fetch(forwarded) }; })) as typeof fetch;
      return handleBff(request, new URL(request.url).pathname.split('/').at(-1)!, { env: { ...environment, NODE_ENV: 'production',
        AUTH_PROVIDER: 'better-auth', AUTH_PUBLIC_ORIGIN: 'https://app.mindblisspower.com', BETTER_AUTH_BACKEND_URL: 'https://auth.core.internal' }, fetchImpl: fetchCore });
    } });
    const app = browser(application(scenario.owner)), foreign = browser(application(scenario.owner === 'relay-success' ? 'relay-concurrent' : 'relay-success'));
    const preparePath = `${prefix}/prepare`, prepared = await app.request(preparePath, signed(preparePath, { requestId: paymentId, amountAtomic }));
    expect(prepared.status).toBe(200); const preview = await prepared.json() as any;
    expect(preview.status).toBe('prepared'); expect(preview.walletAddress).toBe(sender); expect(preview.recipientAddress).toBe(COMPANY_PAYMENT_RECIPIENT);
    expect(preview.typedData).toBeObject(); expect(preview.authorizationHasOnchainExpiry).toBe(false);
    expect(sends).toBe(0); expect(quotes).toBe(0); expect(signatures).toBe(0);
    const typed = preview.typedData, signature = await wallet.signTypedData(typed.domain, typed.types, typed.message), authPath = `${prefix}/authorize`;
    expect((await app.request(authPath, signed(authPath, { paymentId, signature }))).status).toBe(200);
    const owned = await read(); expect(owned.status).toBe('authorized'); expect(String(owned.authorization_ciphertext)).not.toContain(signature.slice(2));
    const submitPath = `${prefix}/submit`, submit = () => app.request(submitPath, signed(submitPath, { paymentId }));
    if (scenario.mode === 'concurrent') {
      const responses = await Promise.all([submit(), submit()]); expect(responses.filter(response => response.ok).length).toBeGreaterThanOrEqual(1);
    } else {
      const response = await submit(); expect(response.status).toBe(scenario.mode === 'lost-ack' ? 409 : 200);
    }
    expect(quotes).toBe(1); expect(signatures).toBe(1); expect(sends).toBe(scenario.mode === 'lost-ack' ? 0 : 1);
    expect((await read()).operation_ciphertext).toBeString();
    // A replay can only read the persisted operation; it cannot sign/sponsor/send.
    expect((await submit()).status).toBe(200); expect(quotes).toBe(1); expect(signatures).toBe(1);
    const statusPath = `${prefix}/status?paymentId=${paymentId}`;
    const status = await app.request(statusPath, signed(statusPath)); expect(status.status).toBe(200);
    const projected = await status.json(); expect(JSON.stringify(projected)).not.toMatch(/cipher|lease|signature|subject/);
    expect((await foreign.request(statusPath, signed(statusPath))).status).toBe(404);
    expect((await app.request(submitPath, signed(submitPath, { paymentId }, 'https://wallet.mindblisspower.com'))).status).toBe(403);
    if (scenario.mode === 'lost-ack') await new Promise(resolve => setTimeout(resolve, 3100));
    const verifyPath = `${prefix}/verify`; phase = scenario.mode === 'lost-ack' ? 'expired' : 'receipt';
    const verified = await app.request(verifyPath, signed(verifyPath, { paymentId })); expect(verified.status).toBe(200);
    let result = await verified.json() as any;
    if (scenario.mode === 'lost-ack') {
      expect(result.status).toBe('authorized'); expect(result.userOperationHash).toBeNull(); expect(result.transactionHash).toBeNull(); expect(sends).toBe(0);
      const expiredHash = (projected as any).userOperationHash;
      // Same native signature/amount/AA nonce and byte-identical quote fields.
      // Only the server-generated, immutable dispatch tag distinguishes retry.
      const retried = await submit(); expect(retried.status).toBe(200);
      const next = await retried.json() as any; expect(next.userOperationHash).not.toBe(expiredHash); expect(next.authorizationDigest).toBe(preview.authorizationDigest);
      expect(quotes).toBe(2); expect(signatures).toBe(2); expect(sends).toBe(1);
      phase = 'receipt'; const retryProof = await app.request(verifyPath, signed(verifyPath, { paymentId })); expect(retryProof.status).toBe(200);
      result = await retryProof.json() as any; expect(result.status).toBe('confirmed'); aaNonce++;
    } else {
      expect(result.status).toBe('confirmed'); expect(result.transactionHash).toBe(txHash); expect(result.confirmations).toBe(12); expect(result.membershipAssignment).toBe('pending'); aaNonce++;
    }
    const historyPath = `${prefix}/history`, history = await app.request(historyPath, signed(historyPath)); expect(history.status).toBe(200);
    expect((await history.json() as any).payments.some((row: any) => row.paymentId === paymentId && row.status === result.status)).toBe(true);
    const replay = await app.request(preparePath, signed(preparePath, { requestId: paymentId, amountAtomic })); expect(replay.status).toBe(200);
    expect((await replay.json() as any).status).toBe(result.status);
    expect(methods.filter(value => value === 'eth_sendUserOperation')).toHaveLength(1);
    expect(realExternalCalls).toBe(0);
  }, 30_000);
});
