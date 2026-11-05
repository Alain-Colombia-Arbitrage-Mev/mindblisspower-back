import { expect, test } from 'bun:test';
import { betterAuth } from 'better-auth';
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory';
import type { DBAdapter } from '@better-auth/core/db/adapter';
import { createAuthOptions } from './options';
import type { EmailMessage } from './delivery';
import { guardVerificationCleanup } from './verification-consume-cleanup';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

for (const stage of ['consume', 'expired-read'] as const) {
test(`an expired delayed OTP ${stage} cannot delete the newer manually requested generation`, async () => {
  const email = 'synthetic-resend-race@example.test';
  const store: MemoryDB = { user: [{ id: 'synthetic-resend-race-user', email, emailVerified: true,
    name: 'Synthetic Resend Fixture', createdAt: new Date(), updatedAt: new Date() }],
    account: [], session: [], verification: [], rateLimit: [], jwks: [] };
  const arrived = deferred(), released = deferred();
  const messages: EmailMessage[] = [];
  let pause = false;
  const factory = memoryAdapter(store);
  const pausable = (configuration: Parameters<typeof factory>[0]): DBAdapter => {
    const base = factory(configuration);
    const wrapped: DBAdapter = guardVerificationCleanup({ ...base, consumeOne: async <T>(input: Parameters<DBAdapter['consumeOne']>[0]): Promise<T | null> => {
      const consumed = await base.consumeOne<T>(input);
      if (pause && stage === 'consume' && input.model === 'verification' && consumed) {
        pause = false;
        // The old exchange has consumed its row but its request is delayed
        // past that challenge's deadline. No production clock/budget is changed.
        (consumed as unknown as { expiresAt: Date }).expiresAt = new Date(Date.now() - 1000);
        arrived.resolve(); await released.promise;
      }
      return consumed;
    }, findMany: async <T>(input: Parameters<DBAdapter['findMany']>[0]): Promise<T[]> => {
      const rows = await base.findMany<T>(input);
      if (pause && stage === 'expired-read' && input.model === 'verification'
        && input.sortBy?.field === 'createdAt' && rows.length) {
        pause = false;
        const expired = { ...rows[0]!, expiresAt: new Date(Date.now() - 1000) };
        arrived.resolve(); await released.promise;
        return [expired];
      }
      return rows;
    }, transaction: async callback => callback(wrapped) });
    return wrapped;
  };
  const env = { BETTER_AUTH_SECRET: 'synthetic-resend-race-secret-at-least-32-characters',
    BETTER_AUTH_URL: 'https://auth.example.test', BETTER_AUTH_TRUSTED_ORIGINS: 'https://portal.example.test',
    BETTER_AUTH_EMAIL_OTP_ENABLED: 'true', BETTER_AUTH_PHONE_OTP_ENABLED: 'false', BETTER_AUTH_JWT_ENABLED: 'false',
    CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000001', CLOUDFLARE_EMAIL_API_TOKEN: 'synthetic-no-provider',
    AUTH_EMAIL_FROM: 'auth@example.test' };
  const identity = { provision: async () => ({ status: 'existing' }), binding: async () => ({ status: 'claim_required' }),
    registrationAllowed: async () => true };
  const delivery = { email: async (message: EmailMessage) => { messages.push(message); }, phone: async () => { throw new Error('No SMS'); } };
  const replicaA = betterAuth(createAuthOptions(env, pausable, identity, delivery));
  const replicaB = betterAuth(createAuthOptions(env, (configuration: Parameters<typeof factory>[0]) => {
    const wrapped: DBAdapter = guardVerificationCleanup({ ...factory(configuration), transaction: async callback => callback(wrapped) });
    return wrapped;
  }, identity, delivery));
  const request = (replica: typeof replicaA, path: string, body: unknown, ip: string) => replica.handler(new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
    method: 'POST', headers: { origin: 'https://portal.example.test', 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  }));
  const send = (replica: typeof replicaA) => request(replica, '/email-otp/send-verification-otp', { email, type: 'sign-in' }, '192.0.2.91');
  const code = () => /\b(\d{6})\b/.exec(messages.at(-1)!.text)![1]!;
  expect((await send(replicaA)).status).toBe(200);
  pause = true;
  const old = request(replicaA, '/sign-in/email-otp', { email, otp: code() }, '192.0.2.92');
  await arrived.promise;
  // Simulated elapsed cooldown in an isolated fixture, as if the request had
  // waited five minutes. A real user still waits the persistent server budget.
  for (const row of store.rateLimit!) row.lastRequest = Date.now() - 301000;
  try {
    expect((await send(replicaB)).status).toBe(200);
    expect(messages).toHaveLength(2);
    const newer = { ...store.verification![0]! };
    released.resolve();
    expect((await old).status).toBe(400);
    expect(store.session).toHaveLength(0);
    expect(store.verification!.some(row => row.id === newer.id && row.value === newer.value)).toBe(true);
    const confirmed = await request(replicaB, '/sign-in/email-otp', { email, otp: code() }, '192.0.2.93');
    expect(confirmed.status).toBe(200);
    expect(store.session).toHaveLength(1);
  } finally { released.resolve(); }
});
}
