import { expect, test } from 'bun:test';
import { atomicPasswordResetHandler, atomicPasswordResetOptions, type AuthHandler,
  type PasswordResetTransaction } from './atomic-password-reset';
import type { BetterAuthOptions } from 'better-auth';

const url = 'https://auth.example.test/api/auth/email-otp/reset-password';
const request = (path = url, method = 'POST') => new Request(path, { method });
const success = () => Response.json({ success: true });
function fixture(native: AuthHandler, failCommit = false) {
  const stages: string[] = [];
  const transaction: PasswordResetTransaction = async (state, work) => {
    stages.push('begin');
    try {
      const response = await work(async req => {
        state.credentialChanged = true;
        return native(req);
      });
      if (failCommit) throw new Error('Synthetic private commit diagnostics');
      stages.push('commit');
      return response;
    } catch (error) { stages.push('rollback'); throw error; }
  };
  return { stages, handler: atomicPasswordResetHandler(async () => { throw new Error('Unexpected fallback'); }, transaction) };
}

test('other endpoints retain their original handler and never enter the reset transaction', async () => {
  let delegated = 0;
  const handler = atomicPasswordResetHandler(async () => { delegated++; return Response.json({ original: true }); },
    async () => { throw new Error('Other flows must not open this transaction'); });
  for (const [path, method] of [[url, 'GET'], ['https://auth.example.test/api/auth/sign-in/email', 'POST'],
    ['https://auth.example.test/api/auth/sign-up/email', 'POST'], ['https://auth.example.test/api/auth/get-session', 'GET']]) {
    expect(await (await handler(request(path!, method!))).json()).toEqual({ original: true });
  }
  expect(delegated).toBe(4);
});

test('success cannot escape the handler until the database COMMIT has completed', async () => {
  let finishCommit!: () => void;
  const gate = new Promise<void>(resolve => { finishCommit = resolve; });
  let inside!: () => void;
  const reached = new Promise<void>(resolve => { inside = resolve; });
  let returned = false;
  const handler = atomicPasswordResetHandler(async () => { throw new Error('fallback'); }, async (state, work) => {
    state.credentialChanged = true;
    const result = await work(async () => success());
    inside(); await gate;
    return result;
  });
  const pending = handler(request()).then(response => { returned = true; return response; });
  await reached;
  expect(returned).toBe(false);
  finishCommit();
  expect(await (await pending).json()).toEqual({ success: true });
  expect(returned).toBe(true);
});

test('native errors, late client errors and failed COMMIT yield rollback and a secret-free failure', async () => {
  for (const [native, failedCommit] of [
    [async () => Response.json({ message: 'Synthetic private SQL' }, { status: 500 }), false],
    [async () => { throw new Error('Synthetic password/OTP diagnostics'); }, false],
    [async () => Response.json({ message: 'Synthetic late hook' }, { status: 400 }), false],
    [async () => success(), true],
  ] as [AuthHandler, boolean][]) {
    const app = fixture(native, failedCommit);
    const result = await app.handler(request());
    expect(result.status).toBe(500);
    expect(result.headers.get('cache-control')).toBe('private, no-store');
    expect(result.headers.has('set-cookie')).toBe(false);
    expect(await result.text()).not.toContain('Synthetic');
    expect(app.stages).toEqual(['begin', 'rollback']);
  }
});

test('rejected codes preserve their native 4xx and spent attempts when credentials were not touched', async () => {
  for (const status of [400, 403, 429]) {
    let committed = false;
    const handler = atomicPasswordResetHandler(async () => { throw new Error('fallback'); }, async (state, work) => {
      expect(state.credentialChanged).toBe(false);
      const result = await work(async () => Response.json({ code: 'INVALID_OTP' }, { status }));
      committed = true;
      return result;
    });
    expect((await handler(request())).status).toBe(status);
    expect(committed).toBe(true);
  }
});

test('unexpected acknowledgements, redirect responses or session authority never commit a reset', async () => {
  for (const response of [Response.json({ success: true }, { status: 201 }), Response.json({ success: 'true' }),
    Response.json({ success: true, token: 'Synthetic token' }), Response.json({ success: true, user: {} }),
    new Response('malformed'), new Response(null, { status: 302, headers: { location: '/dashboard' } }),
    Response.json({ success: true }, { headers: { 'set-cookie': 'Synthetic cookie' } }),
    Response.json({ success: true }, { headers: { 'set-auth-jwt': 'Synthetic JWT' } })]) {
    const app = fixture(async () => response);
    expect((await app.handler(request())).status).toBe(500);
    expect(app.stages).toEqual(['begin', 'rollback']);
  }
  const handler = atomicPasswordResetHandler(async () => { throw new Error('fallback'); }, (_state, work) => work(async () => success()));
  // Native success without a credential mutation must fail closed.
  expect((await handler(request())).status).toBe(500);
});

test('request-local mutation state cannot leak from a successful reset into another rejected challenge', async () => {
  let run = 0;
  const states: unknown[] = [];
  const handler = atomicPasswordResetHandler(async () => { throw new Error('fallback'); }, async (state, work) => {
    states.push(state);
    const current = run++;
    return work(async () => {
      if (current === 0) { state.credentialChanged = true; return success(); }
      return Response.json({ code: 'INVALID_OTP' }, { status: 400 });
    });
  });
  const results = await Promise.all([handler(request()), handler(request())]);
  expect(results.map(result => result.status)).toEqual([200, 400]);
  expect(states[0]).not.toBe(states[1]);
});

test('scoped options preserve the native hook while marking the credential mutation before a late hook failure', async () => {
  const state = { credentialChanged: false };
  const options: BetterAuthOptions = { emailAndPassword: { enabled: true, revokeSessionsOnPasswordReset: true,
    onPasswordReset: async () => { expect(state.credentialChanged).toBe(true); throw new Error('Synthetic late failure'); } },
    session: { cookieCache: { enabled: false } } };
  const scoped = atomicPasswordResetOptions(options, state);
  expect(scoped).not.toBe(options);
  expect(scoped.emailAndPassword).not.toBe(options.emailAndPassword);
  expect(state.credentialChanged).toBe(false);
  const user = { id: 'synthetic', name: 'Synthetic', email: 'synthetic@example.test', emailVerified: true,
    createdAt: new Date(), updatedAt: new Date() };
  await expect(scoped.emailAndPassword!.onPasswordReset!({ user }, request())).rejects.toThrow('Synthetic late failure');
  expect(state.credentialChanged).toBe(true);
  for (const config of [{}, { emailAndPassword: { enabled: true } },
    { ...options, secondaryStorage: { get: async () => null, getAndDelete: async () => null,
      increment: async () => 1, set: async () => {}, delete: async () => {} } },
    { ...options, session: { cookieCache: { enabled: true } } }]) {
    expect(() => atomicPasswordResetOptions(config, { credentialChanged: false })).toThrow();
  }
});
