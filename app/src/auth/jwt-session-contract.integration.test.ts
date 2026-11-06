import { expect, test } from 'bun:test';
import { betterAuth } from 'better-auth';
import type { DBAdapter } from '@better-auth/core/db/adapter';
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory';
import { hashPassword } from 'better-auth/crypto';
import { createLocalJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { createAuthOptions, type BoundIdentity } from './options';
import { principalResult, type Principal } from '../modules/identity/model';

// Native Better Auth 1.6.22, JOSE and the real canonical identity reducer.
// Password fixtures avoid generating OTPs; all data and storage are synthetic.
const email = 'synthetic-jwt-member@example.test';
const subject = 'synthetic-jwt-member';
const publicId = '00000000-0000-4000-8000-000000000001';
const password = 'Synthetic-JWT-Session-Password-123';
const env = {
  BETTER_AUTH_SECRET: 'synthetic-jwt-session-contract-secret-over-thirty-two-characters',
  BETTER_AUTH_URL: 'https://auth.example.test', BETTER_AUTH_TRUSTED_ORIGINS: 'https://portal.example.test',
  BETTER_AUTH_EMAIL_OTP_ENABLED: 'false', BETTER_AUTH_PHONE_OTP_ENABLED: 'false', BETTER_AUTH_JWT_ENABLED: 'true',
  BETTER_AUTH_JWT_ISSUER: 'https://auth.example.test', BETTER_AUTH_JWT_AUDIENCE: 'synthetic-members',
};
function gate() {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return { ready, release };
}

// Portal's closed claim contract: do not make the consumer accept whitespace,
// a missing canonical node, unverified mail or an extended lifetime to fix JWTs.
function portalClaimsContract(payload: JWTPayload, now = Math.floor(Date.now() / 1000)) {
  return Boolean(typeof payload.sub === 'string' && payload.sub.trim()
    && typeof payload.person_public_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.person_public_id)
    && payload.email_verified === true && payload.authVerified === true
    && typeof payload.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)
    && Number.isInteger(payload.iat) && Number.isInteger(payload.exp)
    && payload.iat! <= now + 30 && payload.exp! > now && payload.exp! > payload.iat! && payload.exp! - payload.iat! <= 300);
}

async function fixture(overrides: Partial<Principal> = {}, bindingOverride?: BoundIdentity) {
  const now = new Date();
  const principal: Principal = { subject, auth_email: email, email_verified: true, name: 'Synthetic Member',
    person_id: '1', public_id: publicId, person_email: email, person_status: 'active', blacklisted: false,
    user_id: subject, is_admin: false, access_restricted: false, ...overrides };
  const store: MemoryDB = {
    user: [{ id: subject, email, name: 'Synthetic Member', emailVerified: true, createdAt: now, updatedAt: now }],
    account: [{ id: 'synthetic-credential', userId: subject, accountId: subject, providerId: 'credential',
      password: await hashPassword(password), createdAt: now, updatedAt: now }],
    session: [], verification: [], rateLimit: [], jwks: [],
  };
  const controls = { failSession: false, failJwks: false, sessionReads: 0, providerCalls: 0,
    failedTokens: new Set<string>(), heldTokens: new Map<string, { entered: ReturnType<typeof gate>; proceed: ReturnType<typeof gate> }>() };
  const factory = memoryAdapter(store);
  const adapter = (configuration: Parameters<typeof factory>[0]): DBAdapter => {
    const base = factory(configuration);
    return { ...base,
      findOne: async <T>(input: Parameters<DBAdapter['findOne']>[0]): Promise<T | null> => {
        if (input.model === 'session') {
          controls.sessionReads++;
          const token = input.where?.find(condition => condition.field === 'token')?.value;
          const held = typeof token === 'string' ? controls.heldTokens.get(token) : undefined;
          if (held) { held.entered.release(); await held.proceed.ready; }
          if (controls.failSession || (typeof token === 'string' && controls.failedTokens.has(token))) {
            throw new Error('synthetic-sensitive-session-storage-failure');
          }
        }
        return base.findOne<T>(input);
      },
      findMany: async <T>(input: Parameters<DBAdapter['findMany']>[0]): Promise<T[]> => {
        if (input.model === 'jwks' && controls.failJwks) throw new Error('synthetic-sensitive-jwks-storage-failure');
        return base.findMany<T>(input);
      },
    };
  };
  const bound = () => bindingOverride ?? principalResult(principal);
  const options = createAuthOptions(env, adapter, {
    provision: async () => bound(), binding: async () => bound(), registrationAllowed: async () => true,
  }, { email: async () => { controls.providerCalls++; throw new Error('No synthetic provider calls allowed'); },
    phone: async () => { controls.providerCalls++; throw new Error('No synthetic provider calls allowed'); } });
  options.advanced = { ...options.advanced, disableOriginCheck: false, disableCSRFCheck: false };
  const auth = betterAuth(options);
  let nextIP = 1;
  const request = (path: string, cookie = '', body?: unknown) => auth.handler(new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { origin: 'https://portal.example.test', 'content-type': 'application/json',
      'x-forwarded-for': `192.0.2.${nextIP++}`, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const login = async () => {
    const response = await request('/sign-in/email', '', { email, password });
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    expect(cookie).toContain('__Secure-better-auth.session_token=');
    return cookie;
  };
  const verify = async (response: Response) => {
    expect(response.status).toBe(200);
    const value = await response.json() as { token: string };
    const jwks = await (await request('/jwks')).json() as Parameters<typeof createLocalJWKSet>[0];
    return (await jwtVerify(value.token, createLocalJWKSet(jwks), {
      issuer: env.BETTER_AUTH_JWT_ISSUER, audience: env.BETTER_AUTH_JWT_AUDIENCE,
    })).payload;
  };
  return { store, principal, controls, request, login, verify, bound, options };
}

test('canonical legacy email whitespace is normalized only in the signed JWT, preserving native session and portal proof requirements', async () => {
  const app = await fixture({ person_email: ` \t${email.toUpperCase()} \n` });
  expect(app.bound().status).toBe('existing');
  const before = JSON.stringify(app.principal);
  const cookie = await app.login();
  const nativeSession = await app.request('/get-session', cookie);
  expect(nativeSession.status).toBe(200);
  expect((await nativeSession.json() as { user: { emailVerified: boolean } }).user.emailVerified).toBe(true);
  const payload = await app.verify(await app.request('/token', cookie));
  expect(payload.email).toBe(email);
  expect(payload.person_public_id).toBe(publicId);
  expect(payload.email_verified).toBe(true);
  expect(payload.authVerified).toBe(true);
  expect(payload.exp! - payload.iat!).toBe(300);
  expect(portalClaimsContract({ ...payload, email: app.principal.person_email })).toBe(false);
  expect(portalClaimsContract(payload)).toBe(true);
  expect(JSON.stringify(app.principal)).toBe(before);
  expect(app.store.session).toHaveLength(1);
  expect(app.options.session?.expiresIn).toBe(7 * 86400);
  const lifetime = new Date(app.store.session![0]!.expiresAt).getTime() - new Date(app.store.session![0]!.createdAt).getTime();
  expect(lifetime).toBeGreaterThanOrEqual(7 * 86400_000 - 1000);
  expect(lifetime).toBeLessThanOrEqual(7 * 86400_000 + 1000);
  expect(app.store.verification).toHaveLength(0);
  expect(app.controls.providerCalls).toBe(0);
});

for (const [name, principal] of [
  ['explicit blacklist', { blacklisted: true }], ['restricted affiliate', { access_restricted: true }],
  ['banned person', { person_status: 'banned' }], ['another subject', { user_id: 'synthetic-other-subject' }],
  ['missing public identity', { public_id: null }], ['different email', { person_email: 'synthetic-other@example.test' }],
] as const) {
  test(`a native session cannot mint a JWT for ${name}`, async () => {
    const app = await fixture(principal);
    const cookie = await app.login();
    const snapshot = JSON.stringify(app.principal);
    expect((await app.request('/get-session', cookie)).status).toBe(200);
    const response = await app.request('/token', cookie);
    expect(response.status).toBe(403);
    expect(await response.clone().json()).toEqual({ code: 'AUTH_IDENTITY_REVIEW_REQUIRED', message: 'Identity review required' });
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(await response.text()).not.toContain('token');
    expect(JSON.stringify(app.principal)).toBe(snapshot);
    expect(app.store.verification).toHaveLength(0);
    expect(app.controls.providerCalls).toBe(0);
  });
}

test('an existing-status binding with a different email still fails the final native JWT check', async () => {
  const app = await fixture({}, { status: 'existing', publicId, email: 'synthetic-other@example.test' });
  const response = await app.request('/token', await app.login());
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'AUTH_IDENTITY_REVIEW_REQUIRED' });
});

test('missing, tampered, expired and revoked native sessions remain unauthorized, not storage outages', async () => {
  for (const kind of ['missing', 'tampered', 'expired', 'revoked'] as const) {
    const app = await fixture();
    const cookie = await app.login();
    if (kind === 'expired') app.store.session![0]!.expiresAt = new Date(Date.now() - 1000);
    if (kind === 'revoked') app.store.session!.length = 0;
    const requestCookie = kind === 'missing' ? '' : kind === 'tampered' ? cookie.replace('=', '=synthetic-tampered-') : cookie;
    const response = await app.request('/token', requestCookie);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(app.controls.sessionReads).toBe(kind === 'missing' || kind === 'tampered' ? 0 : 1);
    expect(app.store.jwks).toHaveLength(0);
    expect(app.controls.providerCalls).toBe(0);
  }
});

test('native token middleware masks a storage fault as401 while get-session reports500 and the same cookie remains usable', async () => {
  const app = await fixture();
  const cookie = await app.login();
  const snapshot = JSON.stringify(app.store.session);
  app.controls.failSession = true;
  const failed = await app.request('/token', cookie);
  // The SDK catches getSession's storage exception inside sessionMiddleware.
  // The portal must distinguish this from a genuine absent session using its
  // bounded read-only get-session probe, not by bypassing native authentication.
  expect(failed.status).toBe(401);
  expect(await failed.clone().json()).toEqual({ code: 'UNAUTHORIZED', message: 'Unauthorized' });
  expect(failed.headers.has('set-cookie')).toBe(false);
  expect(failed.headers.has('set-auth-jwt')).toBe(false);
  expect(await failed.text()).not.toContain('synthetic-sensitive');
  expect(app.controls.sessionReads).toBe(1);
  expect(JSON.stringify(app.store.session)).toBe(snapshot);
  expect((await app.request('/get-session', cookie)).status).toBe(500);
  app.controls.failSession = false;
  expect(portalClaimsContract(await app.verify(await app.request('/token', cookie)))).toBe(true);
  expect(app.store.session).toHaveLength(1);
  expect(app.controls.providerCalls).toBe(0);
});

test('unrelated native JWKS failures are not relabelled as missing sessions or identity restrictions', async () => {
  const app = await fixture();
  const cookie = await app.login();
  app.controls.failJwks = true;
  const response = await app.request('/token', cookie);
  expect(response.status).toBe(500);
  const body = await response.text();
  for (const value of ['AUTH_SESSION_LOOKUP_UNAVAILABLE', 'AUTH_IDENTITY_REVIEW_REQUIRED', 'synthetic-sensitive']) expect(body).not.toContain(value);
  expect(response.headers.has('set-cookie')).toBe(false);
  expect(app.store.session).toHaveLength(1);
  expect(app.controls.providerCalls).toBe(0);
});

for (const held of ['failed', 'successful'] as const) {
  test(`a failed JWT session lookup cannot invalidate another session when ${held} lookup is held`, async () => {
    const app = await fixture();
    const failedCookie = await app.login(), acceptedCookie = await app.login();
    const failedToken = app.store.session![0]!.token as string, acceptedToken = app.store.session![1]!.token as string;
    app.controls.failedTokens.add(failedToken);
    const entered = gate(), proceed = gate();
    app.controls.heldTokens.set(held === 'failed' ? failedToken : acceptedToken, { entered, proceed });
    const first = app.request('/token', held === 'failed' ? failedCookie : acceptedCookie);
    await entered.ready;
    let second: Response;
    try { second = await app.request('/token', held === 'failed' ? acceptedCookie : failedCookie); }
    finally { proceed.release(); }
    const firstResponse = await first;
    const failed = held === 'failed' ? firstResponse : second;
    const accepted = held === 'successful' ? firstResponse : second;
    expect(failed.status).toBe(401);
    expect(await failed.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(accepted.status).toBe(200);
    expect(portalClaimsContract(await app.verify(accepted))).toBe(true);
    expect(failed.headers.has('set-cookie')).toBe(false);
    expect(accepted.headers.has('set-cookie')).toBe(false);
    expect((await app.request('/get-session', failedCookie)).status).toBe(500);
    const healthySession = await app.request('/get-session', acceptedCookie);
    expect(healthySession.status).toBe(200);
    expect((await healthySession.json() as { user: { emailVerified: boolean } }).user.emailVerified).toBe(true);
    expect(app.store.session).toHaveLength(2);
    expect(app.controls.sessionReads).toBe(4);
    expect(app.controls.providerCalls).toBe(0);
  });
}
