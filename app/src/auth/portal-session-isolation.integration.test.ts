import { expect, test } from 'bun:test';
import { betterAuth } from 'better-auth';
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory';
import { createAuthOptions, type AuthIdentity } from './options';
import type { AuthDelivery, AuthEnvironment, EmailMessage } from './delivery';

test('personal and administrative portals use the same account store with independent host-only native session cookies', async () => {
  const personal = 'https://app.mindblisspower.com';
  const administrative = 'https://wallet.mindblisspower.com';
  const email = 'synthetic-portal-member@example.test';
  const store: MemoryDB = { user: [{ id: 'same-native-user', email, emailVerified: true, name: 'Synthetic Member',
    createdAt: new Date(), updatedAt: new Date() }], session: [], account: [], verification: [], rateLimit: [], jwks: [] };
  const messages: EmailMessage[] = [];
  const identity: AuthIdentity = { registrationAllowed: async () => true, provision: async () => ({ status: 'existing' }),
    binding: async () => ({ status: 'existing', email, publicId: '00000000-0000-4000-8000-000000000002' }) };
  const env: AuthEnvironment = { BETTER_AUTH_SECRET: 'synthetic-portal-session-secret-at-least-32-characters',
    BETTER_AUTH_URL: 'https://auth.example.test', BETTER_AUTH_TRUSTED_ORIGINS: `${personal},${administrative}`,
    BETTER_AUTH_EMAIL_OTP_ENABLED: 'true', BETTER_AUTH_PHONE_OTP_ENABLED: 'false', BETTER_AUTH_JWT_ENABLED: 'false',
    CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000002',
    CLOUDFLARE_EMAIL_API_TOKEN: 'synthetic-email-key', AUTH_EMAIL_FROM: 'codes@example.test' };
  const delivery: AuthDelivery = { email: async message => { messages.push(message); }, phone: async () => {} };
  const options = createAuthOptions(env, memoryAdapter(store), identity, delivery);
  expect(options.advanced?.crossSubDomainCookies?.enabled).toBe(false);
  expect(options.advanced?.disableOriginCheck).not.toBe(true);
  expect(options.advanced?.disableCSRFCheck).not.toBe(true);
  // Better Auth relaxes these checks in test mode; exercise the production policy.
  options.advanced = { ...options.advanced, disableOriginCheck: false, disableCSRFCheck: false };
  const auth = betterAuth(options);
  const request = (origin: string, path: string, body?: unknown, cookie?: string) => auth.handler(new Request(
    `${env.BETTER_AUTH_URL}/api/auth${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { origin, 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.20', ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const login = async (origin: string) => {
    expect((await request(origin, '/email-otp/send-verification-otp', { email, type: 'sign-in' })).status).toBe(200);
    const otp = /\b(\d{6})\b/.exec(messages.at(-1)!.text)?.[1];
    expect(otp).toBeTruthy();
    const response = await request(origin, '/sign-in/email-otp', { email, otp });
    expect(response.status).toBe(200);
    const sessionCookie = response.headers.getSetCookie().find(value => value.includes('better-auth.session_token='));
    expect(sessionCookie).toContain('Secure');
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('SameSite=Lax');
    expect(sessionCookie).not.toMatch(/(?:^|;)\s*Domain=/i);
    return sessionCookie!.split(';')[0]!;
  };
  const personalCookie = await login(personal);
  const personalSession = await request(personal, '/get-session', undefined, personalCookie);
  expect((await personalSession.json() as { user: { id: string } }).user.id).toBe('same-native-user');
  // Browsers do not attach the app host's cookie when entering the wallet host.
  expect(await (await request(administrative, '/get-session')).json()).toBeNull();
  // A second host must not bypass the same backend's recipient send cooldown.
  expect((await request(administrative, '/email-otp/send-verification-otp', { email, type: 'sign-in' })).status).toBe(429);
  expect(messages).toHaveLength(1);
  // Age only the synthetic fixture's cooldown, representing a later wallet login.
  for (const row of store.rateLimit ?? []) if (String(row.key).startsWith('auth-recipient:')) row.lastRequest = Date.now() - 60_001;
  const administrativeCookie = await login(administrative);
  expect(administrativeCookie).not.toBe(personalCookie);
  const administrativeSession = await request(administrative, '/get-session', undefined, administrativeCookie);
  expect((await administrativeSession.json() as { user: { id: string } }).user.id).toBe('same-native-user');
  expect(store.user).toHaveLength(1);
  expect(store.session).toHaveLength(2);
  const deliveries = messages.length;
  expect((await request('https://wallet.mindblisspower.com.evil.test', '/sign-out', {}, administrativeCookie)).status).toBe(403);
  expect(store.session).toHaveLength(2);
  expect(messages).toHaveLength(deliveries);
});
