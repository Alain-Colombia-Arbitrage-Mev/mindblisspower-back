import { expect, test } from 'bun:test';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory';
import { createAuthOptions } from './options';
import { atomicEmailVerificationHandler, atomicEmailVerificationOptions, type AtomicEmailVerificationState } from './atomic-email-verification';
import type { AuthEnvironment, EmailMessage } from './delivery';

const env: AuthEnvironment = {
  BETTER_AUTH_SECRET: 'synthetic-atomic-email-verification-secret-at-least-32',
  BETTER_AUTH_URL: 'https://auth.example.test', BETTER_AUTH_TRUSTED_ORIGINS: 'https://portal.example.test',
  BETTER_AUTH_EMAIL_OTP_ENABLED: 'true', BETTER_AUTH_PHONE_OTP_ENABLED: 'false', BETTER_AUTH_JWT_ENABLED: 'false',
  AUTH_EMAIL_PROVIDER: 'resend', AUTH_EMAIL_FROM: 'codes@example.test', RESEND_API_KEY: 'synthetic-only',
};
type Fault = 'none' | 'provision' | 'session-insert' | 'post-proof-client' | 'commit' | 'commit-unknown';
let sequence = 0;
function fixture() {
  const email = `atomic-verification-${++sequence}@example.test`;
  const store: MemoryDB = { user: [], account: [], session: [], verification: [], rateLimit: [], jwks: [] };
  const messages: EmailMessage[] = [];
  let fault: Fault = 'none', spent = false, ip = 0, transactions = 0, nativeCalls = 0;
  const fail = (stage: Fault) => {
    if (fault !== stage || spent) return;
    spent = true;
    if (stage === 'post-proof-client') throw new APIError('BAD_REQUEST', { message: 'Synthetic post-proof policy failure' });
    throw new Error('Synthetic private atomic verification failure');
  };
  const options = () => {
    const factory = memoryAdapter(store);
    const result = createAuthOptions(env, configuration => {
      const base = factory(configuration);
      return { ...base, create: async input => { if (input.model === 'session') fail('session-insert'); return base.create(input); } };
    }, { registrationAllowed: async () => true, binding: async () => ({ status: 'existing' }), provision: async () => {
      if (store.user!.some(user => user.emailVerified === true)) fail('provision');
      return { status: 'existing' };
    } }, { email: async message => { messages.push(message); }, phone: async () => { throw new Error('No synthetic SMS'); } });
    const previous = result.emailVerification!.beforeEmailVerification;
    result.emailVerification = { ...result.emailVerification, beforeEmailVerification: async (user, request) => {
      await previous?.(user, request); fail('post-proof-client');
    } };
    return result;
  };
  const original = betterAuth(options());
  const handler = atomicEmailVerificationHandler(original.handler, async (state, work) => {
    transactions++;
    const before = structuredClone(store);
    let committed = false;
    try {
      const native = betterAuth(atomicEmailVerificationOptions(options(), state));
      const response = await work(async request => { nativeCalls++; return native.handler(request); });
      fail('commit');
      committed = true;
      fail('commit-unknown');
      return response;
    } catch (error) {
      if (!committed) Object.assign(store, before);
      throw error;
    }
  });
  const request = (path: string, body?: unknown, cookie = '') => handler(new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { origin: 'https://portal.example.test', 'content-type': 'application/json',
      'x-forwarded-for': `192.0.2.${++ip}`, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const signup = () => request('/sign-up/email', { email, name: 'Synthetic Atomic Member', password: 'Synthetic-Registration-Password-123' });
  const code = () => messages.at(-1)!.template!.variables.OTP;
  const verify = (otp = code(), cookie = '') => request('/email-otp/verify-email', { email, otp }, cookie);
  const snapshot = () => ({ verified: store.user![0]?.emailVerified === true, sessions: store.session!.length,
    credentials: store.account!.length, codes: store.verification!.filter(row => row.identifier === `email-verification-otp-${email}`).length });
  return { email, store, messages, request, signup, code, verify, snapshot,
    setFault(value: Fault) { fault = value; spent = false; },
    counters: () => ({ transactions, nativeCalls }),
  };
}
async function assertUnavailable(response: Response) {
  expect(response.status).toBe(503);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.has('set-cookie')).toBe(false); expect(response.headers.has('set-auth-jwt')).toBe(false);
  expect(await response.json()).toEqual({ code: 'EMAIL_VERIFICATION_UNAVAILABLE', message: 'Email verification is temporarily unavailable' });
}

test('ordinary signup stays outside the transaction; one first valid OTP creates one owner session and replay stays invalid', async () => {
  const app = fixture(); expect((await app.signup()).status).toBe(200);
  expect(app.messages).toHaveLength(1); expect(app.counters().transactions).toBe(0);
  const code = app.code(), response = await app.verify(code);
  expect(response.status).toBe(200); expect(response.headers.has('set-cookie')).toBe(true);
  expect(app.snapshot()).toEqual({ verified: true, sessions: 1, credentials: 0, codes: 0 });
  expect((await app.verify(code)).status).toBe(400);
  expect(app.snapshot().sessions).toBe(1); expect(app.messages).toHaveLength(1);
  expect(app.counters()).toEqual({ transactions: 2, nativeCalls: 2 });
});

for (const fault of ['provision', 'session-insert', 'post-proof-client', 'commit'] as const) {
  test(`known ${fault} rollback preserves first correct proof for an explicit retry without another email`, async () => {
    const app = fixture(); expect((await app.signup()).status).toBe(200);
    const code = app.code(); app.setFault(fault);
    await assertUnavailable(await app.verify(code));
    expect(app.snapshot()).toEqual({ verified: false, sessions: 0, credentials: 1, codes: 1 });
    expect((await app.verify(code)).status).toBe(200);
    expect(app.snapshot()).toEqual({ verified: true, sessions: 1, credentials: 0, codes: 0 });
    expect(app.messages).toHaveLength(1); expect(app.counters().nativeCalls).toBe(2);
    expect((await app.verify(code)).status).toBe(400); expect(app.snapshot().sessions).toBe(1);
  });
}

test('an ambiguous commit acknowledgement never claims success or promises that consumed proof was restored', async () => {
  const app = fixture(); expect((await app.signup()).status).toBe(200);
  const code = app.code(); app.setFault('commit-unknown'); await assertUnavailable(await app.verify(code));
  expect(app.snapshot()).toEqual({ verified: true, sessions: 1, credentials: 0, codes: 0 });
  expect((await app.verify(code)).status).toBe(400); expect(app.messages).toHaveLength(1);
});

test('wrong OTP accounting commits every attempt and the fourth correct attempt cannot bypass lockout', async () => {
  const app = fixture(); expect((await app.signup()).status).toBe(200);
  const wrong = app.code() === '000000' ? '111111' : '000000';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await app.verify(wrong);
    expect(response.status).toBe(400); expect(response.headers.has('set-cookie')).toBe(false);
    const row = app.store.verification!.find(value => value.identifier === `email-verification-otp-${app.email}`)!;
    expect(Number(String(row.value).split(':').at(-1))).toBe(attempt);
    expect(app.snapshot().sessions).toBe(0);
  }
  const locked = await app.verify(); expect(locked.status).toBe(403); expect(locked.headers.has('set-cookie')).toBe(false);
  expect(app.snapshot().verified).toBe(false); expect(app.messages).toHaveLength(1);
});

test('a forged cookie and somebody else\'s email cannot replace correct owner-bound OTP proof', async () => {
  const app = fixture(); expect((await app.signup()).status).toBe(200);
  const forged = '__Secure-better-auth.session_token=synthetic-forged-cookie';
  const denied = await app.request('/email-otp/verify-email', { email: 'different-owner@example.test', otp: app.code() }, forged);
  expect(denied.status).toBe(400); expect(denied.headers.has('set-cookie')).toBe(false);
  expect(app.snapshot()).toEqual({ verified: false, sessions: 0, credentials: 1, codes: 1 });
  const success = await app.verify(app.code(), forged); expect(success.status).toBe(200);
  expect((await success.json() as { user: { email: string } }).user.email).toBe(app.email);
  expect(app.snapshot().sessions).toBe(1); expect(app.messages).toHaveLength(1);
});

test('a blocked pre-proof response retains its ordinary status and never turns into a verified claim', async () => {
  let calls = 0;
  const handler = atomicEmailVerificationHandler(async () => { throw new Error('wrong fallback'); }, async (_state, work) => work(async () => {
    calls++; return Response.json({ code: 'FORBIDDEN' }, { status: 403 });
  }));
  const response = await handler(new Request('https://auth.example.test/api/auth/email-otp/verify-email', { method: 'POST' }));
  expect(response.status).toBe(403); expect(response.headers.has('set-cookie')).toBe(false); expect(calls).toBe(1);
});

test('a mismatched new session owner cannot escape the proof-owner hook', async () => {
  const state: AtomicEmailVerificationState = { proofAccepted: false };
  const options = atomicEmailVerificationOptions({ emailVerification: { autoSignInAfterVerification: true }, verification: { storeInDatabase: true } }, state);
  await options.emailVerification!.beforeEmailVerification!({ id: 'correct-owner', email: 'owner@example.test' } as never, undefined);
  await expect(options.databaseHooks!.session!.create!.after!({ userId: 'other-owner', token: 'synthetic-token' } as never, null)).rejects.toThrow();
  expect(state.sessionToken).toBeUndefined();
});

test('a known client abort after correct native proof rolls back before releasing a session cookie', async () => {
  const controller = new AbortController(); let rollback = false;
  const handler = atomicEmailVerificationHandler(async () => { throw new Error('wrong fallback'); }, async (state, work) => {
    try { return await work(async () => {
      Object.assign(state, { proofAccepted: true, subject: 'owner', email: 'owner@example.test', sessionToken: 'synthetic-token' });
      controller.abort();
      return Response.json({ status: true, token: 'synthetic-token', user: { id: 'owner', email: 'owner@example.test', emailVerified: true } },
        { headers: { 'set-cookie': '__Secure-better-auth.session_token=synthetic-token.synthetic-signature; Secure; HttpOnly' } });
    }); } catch (error) { rollback = true; throw error; }
  });
  await assertUnavailable(await handler(new Request('https://auth.example.test/api/auth/email-otp/verify-email', { method: 'POST', signal: controller.signal })));
  expect(rollback).toBe(true);
});

test('a pre-cancelled verification does no work, while an aborted wrong attempt still commits its accounting', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const handler = atomicEmailVerificationHandler(async () => { throw new Error('wrong fallback'); }, async () => { calls++; throw new Error('unexpected work'); });
  await assertUnavailable(await handler(new Request('https://auth.example.test/api/auth/email-otp/verify-email', { method: 'POST', signal: controller.signal })));
  expect(calls).toBe(0);
  const inFlight = new AbortController(); let committed = false;
  const wrong = atomicEmailVerificationHandler(async () => { throw new Error('wrong fallback'); }, async (_state, work) => {
    const response = await work(async () => { inFlight.abort(); return Response.json({ code: 'INVALID_OTP' }, { status: 400 }); });
    committed = true; return response;
  });
  const response = await wrong(new Request('https://auth.example.test/api/auth/email-otp/verify-email', { method: 'POST', signal: inFlight.signal }));
  expect(response.status).toBe(400); expect(committed).toBe(true); expect(response.headers.has('set-cookie')).toBe(false);
});
