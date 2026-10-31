import { expect, test } from 'bun:test';
import { verifiedOtpSignInResponse } from './otp-sign-in-response';

function fixture() {
  const user = { id: 'synthetic-subject', email: 'member@example.test', emailVerified: false, name: 'Unchanged native name' };
  const returned = { token: 'synthetic-native-session-token', user, nativeExtra: 'preserved' };
  const newSession = { session: { userId: user.id, token: returned.token }, user: { ...user } };
  const canonical = { ...user, emailVerified: true, privateContact: 'never project', role: 'never project' };
  return { returned, newSession, canonical };
}

test('first OTP response changes only its stale verified bit after matching canonical session proof', async () => {
  const app = fixture();
  const before = structuredClone(app);
  let reads = 0;
  const result = await verifiedOtpSignInResponse(app.returned, app.newSession, ' Member@Example.Test ', async subject => {
    reads++; expect(subject).toBe(app.canonical.id); return app.canonical;
  });
  expect(reads).toBe(1);
  expect(result).toEqual({ ...app.returned, user: { ...app.returned.user, emailVerified: true } });
  expect(app).toEqual(before);
  expect(JSON.stringify(result)).not.toContain('never project');
});

test('already verified, error, malformed and interrupted results never trigger a canonical read or fabricate proof', async () => {
  const app = fixture();
  const noRead = async () => { throw new Error('Unexpected canonical read'); };
  for (const returned of [undefined, null, [], new Error('native failure'), { error: 'denied', ...app.returned },
    { code: 'INVALID_OTP', ...app.returned }, { ...app.returned, user: { ...app.returned.user, emailVerified: true } },
    { ...app.returned, user: { ...app.returned.user, emailVerified: undefined } }]) {
    expect(await verifiedOtpSignInResponse(returned, app.newSession, app.canonical.email, noRead)).toBeUndefined();
  }
  expect(await verifiedOtpSignInResponse(app.returned, null, app.canonical.email, noRead)).toBeUndefined();
});

test('mismatched native subject or token is rejected before reading another account', async () => {
  for (const change of [
    (app: ReturnType<typeof fixture>) => { app.returned.user.id = 'other-subject'; },
    (app: ReturnType<typeof fixture>) => { app.newSession.user.id = 'other-subject'; },
    (app: ReturnType<typeof fixture>) => { app.newSession.session.userId = ''; },
    (app: ReturnType<typeof fixture>) => { app.newSession.session.token = 'other-session'; },
    (app: ReturnType<typeof fixture>) => { app.returned.token = ''; },
  ]) {
    const app = fixture(); change(app);
    let reads = 0;
    await expect(verifiedOtpSignInResponse(app.returned, app.newSession, app.canonical.email, async () => { reads++; return app.canonical; })).rejects.toThrow();
    expect(reads).toBe(0);
  }
});

test('canonical verification, all email identities and database availability remain mandatory', async () => {
  for (const change of [
    (app: ReturnType<typeof fixture>) => { app.canonical.emailVerified = false; },
    (app: ReturnType<typeof fixture>) => { app.canonical.id = 'other-subject'; },
    (app: ReturnType<typeof fixture>) => { app.canonical.email = 'other@example.test'; },
    (app: ReturnType<typeof fixture>) => { app.returned.user.email = 'other@example.test'; },
    (app: ReturnType<typeof fixture>) => { app.newSession.user.email = 'other@example.test'; },
  ]) {
    const app = fixture(); change(app);
    await expect(verifiedOtpSignInResponse(app.returned, app.newSession, 'member@example.test', async () => app.canonical)).rejects.toThrow();
  }
  const app = fixture();
  for (const recipient of [undefined, '', 'other@example.test']) {
    await expect(verifiedOtpSignInResponse(app.returned, app.newSession, recipient, async () => app.canonical)).rejects.toThrow();
  }
  await expect(verifiedOtpSignInResponse(app.returned, app.newSession, app.canonical.email, async () => null)).rejects.toThrow();
  await expect(verifiedOtpSignInResponse(app.returned, app.newSession, app.canonical.email, async () => { throw new Error('synthetic database unavailable'); })).rejects.toThrow();
});
