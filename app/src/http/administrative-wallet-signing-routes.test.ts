import { createHash, createHmac } from 'node:crypto';
import { Wallet } from 'ethers';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { registerAdministrativeWalletSigningRoutes } from './administrative-wallet-signing-routes';
import { administrativeWalletOwnershipMessage } from '../modules/payments/administrative-wallet-signing';
import type { IdentityDatabase } from '../modules/identity/model';
import type { ApiEnvironment } from './types';

const prefix = '/api/member/administrative-wallet', origin = 'https://wallet.mindblisspower.com', secret = 's'.repeat(48);
const nativeSessionId = 'synthetic-native-session', subject = 'synthetic-owner', reference = '6d492c47-80be-4e14-bc5f-54afaa56fc23';
const wallet = new Wallet(`0x${'1'.repeat(64)}`), address = wallet.address.toLowerCase();
const environment = { AUTH_BFF_SHARED_SECRET: secret, ADMINISTRATIVE_WALLET_SIGNING_ENABLED: 'true', MELD_ADMIN_SANDBOX_ENABLED: 'true' };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function signed(path: string, raw: unknown, extra: Record<string, string> = {}) {
  const body = JSON.stringify(raw), timestamp = String(Math.floor(Date.now() / 1000)), ip = '192.0.2.1', cookie = 'better-auth.session_token=synthetic';
  const signature = createHmac('sha256', secret).update(['POST', path, timestamp, ip, hash(cookie), hash(body)].join('\n')).digest('hex');
  return { method: 'POST', body, headers: { origin, cookie, 'content-type': 'application/json', 'x-vp-auth-client-ip': ip,
    'x-vp-auth-timestamp': timestamp, 'x-vp-auth-signature': signature, ...extra } };
}
function application({ authenticated = true, hasNativeSession = true, enabled = true, execute = async () => [] }: {
  authenticated?: boolean; hasNativeSession?: boolean; enabled?: boolean; execute?: (query: SQL) => Promise<unknown[]>;
} = {}) {
  const app = new Hono<ApiEnvironment>(); app.use('*', async (context, next) => {
    context.set('session', authenticated ? { user: { id: subject }, ...(hasNativeSession ? { session: { id: nativeSessionId } } : {}) } as never : null);
    await next();
  });
  registerAdministrativeWalletSigningRoutes(app, { database: { execute } as unknown as Pick<IdentityDatabase, 'execute'>,
    environment: { AUTH_BFF_SHARED_SECRET: secret, ...(enabled ? environment : {}) } });
  return app;
}

test('administrative signer metadata and reads require an exact wallet origin, live native session identity and no acting-as overrides', async () => {
  let queries = 0; const app = application({ enabled: false, execute: async () => { queries++; throw Error('must not query'); } });
  const paths = [`${prefix}/signing/capabilities`, `${prefix}/signing/status`, `${prefix}/transfers/history`];
  const capability = await app.request(paths[0]!, { headers: { origin } }); expect(capability.status).toBe(200);
  expect(await capability.json()).toMatchObject({ configured: false, mode: 'external', canBroadcast: false, broadcastEnabled: false });
  for (const path of paths) {
    for (const headers of [{}, { origin: 'https://app.mindblisspower.com' }, { origin, 'x-vp-act-as': '' }] as Record<string, string>[]) {
      expect((await app.request(path, { headers })).status).toBe(403);
    }
    expect((await application({ authenticated: false }).request(path, { headers: { origin } })).status).toBe(401);
    expect((await application({ hasNativeSession: false }).request(path, { headers: { origin } })).status).toBe(401);
    expect((await app.request(path + '?subject=other', { headers: { origin } })).status).toBe(400);
  }
  expect((await app.request(paths[1]!, { headers: { origin } })).status).toBe(503); expect(queries).toBe(0);
});

test('new signing writes require the signed native BFF envelope and strict owner-free JSON', async () => {
  let queries = 0; const app = application({ execute: async () => { queries++; throw Error('must not query'); } });
  const challenge = `${prefix}/signing/challenge`, verify = `${prefix}/signing/verify`, prepare = `${prefix}/transfers/prepare`;
  expect((await app.request(challenge, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
  expect((await app.request(challenge, signed(challenge, {}, { 'x-vp-act-as': '' }))).status).toBe(403);
  expect((await app.request(challenge, signed(challenge, {}, { origin: 'https://app.mindblisspower.com' }))).status).toBe(403);
  for (const raw of [{ address }, { subject: 'foreign' }, { nativeSessionId: 'foreign' }, { nonce: 'a'.repeat(64) }]) expect((await app.request(challenge, signed(challenge, raw))).status).toBe(400);
  const badVerify = { challengeId: reference, signature: '0x' + '0'.repeat(130), address };
  expect((await app.request(verify, signed(verify, badVerify))).status).toBe(400);
  for (const key of ['from', 'walletAddress', 'owner', 'nativeSessionId', 'token', 'chainId', 'data', 'preparationHash']) {
    expect((await app.request(prepare, signed(prepare, { requestId: reference, recipient: '0x' + '2'.repeat(40), amount: '1', [key]: 'forged' }))).status).toBe(400);
  }
  const changed = signed(challenge, {}); changed.body = '{"address":"forged"}'; expect((await app.request(challenge, changed)).status).toBe(403);
  expect(queries).toBe(0);
});

test('native HTTP proves the assigned offline wallet and retains the binding on status without accepting session identifiers from the browser', async () => {
  let stored: Record<string, unknown> | undefined, verified = false;
  const queries: { sql: string; params: unknown[] }[] = [];
  const app = application({ execute: async query => {
    const q = new PgDialect().sqlToQuery(query); queries.push(q); expect(q.params[0]).toBe(subject); expect(q.params[1]).toBe(nativeSessionId);
    if (q.sql.includes('create_administrative_wallet_signing_challenge')) {
      const issuedAt = new Date(), expiresAt = new Date(issuedAt.getTime() + 300000), id = String(q.params[2]), nonce = String(q.params[3]);
      const sessionContextHash = hash(`${subject}\n${nativeSessionId}`);
      const message = administrativeWalletOwnershipMessage({ address, challengeId: id, nonce, issuedAt, expiresAt, sessionContextHash });
      stored = { id, address, chain_id: 137, nonce, message, message_hash: hash(message), issued_at: issuedAt, expires_at: expiresAt, session_context_hash: sessionContextHash };
      return [stored];
    }
    if (q.sql.includes('read_administrative_wallet_signing_challenge')) return stored ? [stored] : [];
    if (q.sql.includes('consume_administrative_wallet_signing_challenge')) { verified = true; expect(q.params[3]).toBe(address); return [{ verified: true, address, chain_id: 137, binding_expires_at: new Date(Date.now() + 3600000) }]; }
    return [{ wallet_address: address, verified, binding_expires_at: verified ? new Date(Date.now() + 3600000) : null }];
  } });
  const path = `${prefix}/signing/challenge`, challenge = await app.request(path, signed(path, {})); expect(challenge.status).toBe(201);
  const row = await challenge.json() as { challengeId: string; message: string; address: string };
  expect(row.address).toBe(address); const signature = await wallet.signMessage(row.message);
  const verify = `${prefix}/signing/verify`, response = await app.request(verify, signed(verify, { challengeId: row.challengeId, signature }));
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ assignedAddress: address, verified: true, canBroadcast: false });
  const refreshed = await app.request(`${prefix}/signing/status`, { headers: { origin } }); expect(refreshed.status).toBe(200);
  expect(await refreshed.json()).toMatchObject({ assignedAddress: address, verified: true });
  expect(queries).toHaveLength(4); expect(JSON.stringify(queries)).not.toContain(signature);
});
