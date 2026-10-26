import assert from 'node:assert/strict';
import { createClient, Code, ConnectError } from '@connectrpc/connect';
import { createGrpcTransport, Http2SessionManager } from '@connectrpc/connect-node';
import { fromBinary } from '@bufbuild/protobuf';
import { connect as h2connect } from 'node:http2';
import { engineTransportOptions } from '../src/clients/engine-transport';
import { startEngineTunnel } from '../src/clients/engine-tunnel';
import { GetWalletBalanceResponseSchema, LedgerService } from '../src/gen/proto/vicionpower/v1/ledger_pb';

const env = process.env;
const probeOnly = env.FIXTURE_PROBE_ONLY === 'true';
const tunnel = probeOnly ? undefined : await startEngineTunnel(env);
const options = probeOnly ? undefined : engineTransportOptions(env, undefined, tunnel?.address);
const manager = options ? new Http2SessionManager(options.baseUrl, {}, options.nodeOptions) : undefined;
const client = options ? createClient(LedgerService, createGrpcTransport({ ...options, sessionManager: manager, defaultTimeoutMs: 10_000 })) : undefined;

async function goJwksProbe(trustInjectedCA: boolean) {
  const child = Bun.spawn(['/go-jwks-probe'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { ...env, ...(trustInjectedCA ? {} : { SSL_CERT_DIR: '/nonexistent-synthetic-root-directory' }) } });
  child.stdin.write(JSON.stringify({ token: env.FIXTURE_JWT })); child.stdin.end();
  const timer = setTimeout(() => child.kill(), 12_000);
  try { return { exitCode: await child.exited, result: JSON.parse(await new Response(child.stdout).text()) }; }
  finally { clearTimeout(timer); }
}

async function largeUnknownField() {
  const size = 512 * 1024;
  const payload = Buffer.concat([Buffer.from([8, 1, 0xa2, 6, 0x80, 0x80, 0x20]), Buffer.alloc(size)]);
  const frame = Buffer.alloc(5 + payload.length); frame.writeUInt32BE(payload.length, 1); payload.copy(frame, 5);
  const session = h2connect(options!.baseUrl, options!.nodeOptions);
  session.on('error', () => {});
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Synthetic large-frame deadline')), 10_000);
      session.once('error', reject);
      const request = session.request({ ':method': 'POST', ':path': '/vicionpower.v1.LedgerService/GetWalletBalance', 'content-type': 'application/grpc', te: 'trailers' });
      let grpcStatus; const chunks = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('trailers', values => { grpcStatus = values['grpc-status']; });
      request.on('error', reject);
      request.on('end', () => {
        clearTimeout(timer);
        try {
          assert.equal(grpcStatus, '0');
          const bytes = Buffer.concat(chunks); assert.equal(bytes[0], 0);
          const response = fromBinary(GetWalletBalanceResponseSchema, bytes.subarray(5));
          assert.equal(response.walletId, 1n); assert.equal(response.balance, '123.45'); resolve(true);
        } catch (error) { reject(error); }
      });
      request.end(frame);
    });
  } finally { session.destroy(); }
}

async function negativeIdentity(values: Record<string, string | undefined>) {
  const negative = engineTransportOptions({ ...env, ...values }, undefined, tunnel!.address);
  const isolated = new Http2SessionManager(negative.baseUrl, {}, negative.nodeOptions);
  try {
    const caller = createClient(LedgerService, createGrpcTransport({ ...negative, sessionManager: isolated, defaultTimeoutMs: 3000 }));
    await caller.getWalletBalance({ walletId: 1n }); return false;
  } catch { return true; }
  finally { isolated.abort(); }
}

Bun.serve({ hostname: '0.0.0.0', port: Number(env.PORT || env.PAYMENTS_HTTP_ADDR?.split(':').at(-1) || 3000),
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/health') return new Response('synthetic-only');
    if (path === '/api/auth/jwks' && !probeOnly) return new Response(env.FIXTURE_JWKS, { headers: { 'content-type': 'application/json' } });
    if (path === '/new-channel' && !probeOnly) {
      const isolated = new Http2SessionManager(options!.baseUrl, {}, options!.nodeOptions);
      try {
        const caller = createClient(LedgerService, createGrpcTransport({ ...options!, sessionManager: isolated, defaultTimeoutMs: 5000 }));
        await caller.getWalletBalance({ walletId: 1n }); return Response.json({ rejected: false });
      } catch { return Response.json({ rejected: true }); }
      finally { isolated.abort(); }
    }
    if (path !== '/run') return new Response('Not found', { status: 404 });
    try {
      if (probeOnly) {
        const trusted = await goJwksProbe(true), missingRoot = await goJwksProbe(false);
        assert.equal(trusted.exitCode, 0); assert.equal(trusted.result.verified, true);
        assert.notEqual(missingRoot.exitCode, 0); assert.equal(missingRoot.result.verified, false);
        return Response.json({ synthetic: true, realGoVerifier: true, httpsPrivateJwks: true, missingRootRejected: true });
      }
      const health = await fetch('http://engine.core.internal/ready', { signal: AbortSignal.timeout(10_000) });
      assert.equal(health.status, 200); await health.body?.cancel();
      const first = await client!.getWalletBalance({ walletId: 1n }); assert.equal(first.balance, '123.45');
      const parallel = await Promise.all(Array.from({ length: 8 }, () => client!.getWalletBalance({ walletId: 1n })));
      assert.ok(parallel.every(value => value.balance === '123.45'));
      assert.equal(await largeUnknownField(), true);
      manager!.abort();
      assert.equal((await client!.getWalletBalance({ walletId: 1n })).balance, '123.45');
      let cancelled = false;
      try { await client!.getWalletBalance({ walletId: 2n }, { timeoutMs: 120 }); }
      catch (error) { cancelled = error instanceof ConnectError && [Code.Canceled, Code.DeadlineExceeded].includes(error.code); }
      assert.equal(cancelled, true);
      let moneyBlocked = false;
      try { await client!.postTransaction({ externalRef: 'synthetic-never-write', movements: [{ walletId: 1n, amount: '1' }] }); }
      catch (error) { moneyBlocked = error instanceof ConnectError && error.code === Code.FailedPrecondition; }
      assert.equal(moneyBlocked, true);
      const negatives = JSON.parse(env.FIXTURE_NEGATIVE_PEMS!);
      assert.equal(await negativeIdentity({ VP_ENGINE_TLS_CERT_PEM: negatives.alienCert, VP_ENGINE_TLS_KEY_PEM: negatives.alienKey }), true);
      assert.equal(await negativeIdentity({ VP_ENGINE_GRPC_URL: 'https://wrong-host.synthetic.invalid:50051' }), true);
      assert.equal(await negativeIdentity({ VP_ENGINE_TLS_CA_PEM: negatives.alienCert }), true);
      return Response.json({ synthetic: true, realGoEngine: true, nativePrivateReadiness: true, balance: '123.45', parallelReads: 8, opaque512KiBRequest: true, reconnect: true, rpcDeadline: true, financialMutationBlocked: true, wrongClientRejected: true, wrongHostnameRejected: true, wrongCaRejected: true });
    } catch (error) {
      return Response.json({ synthetic: true, failed: true, code: error instanceof ConnectError ? error.code : error instanceof Error ? error.message : 'unknown' }, { status: 500 });
    }
  },
});
