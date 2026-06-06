import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from './db/client';
import * as schema from './db/schema/auth';

/**
 * Better Auth configuration. The drizzleAdapter writes to the `auth` schema
 * declared in schema_mlm.sql. Sessions cached in Redis (configure via the
 * `secondaryStorage` option once Redis client is wired in).
 *
 * Cost model: zero per-MAU. We pay only for the Postgres rows in auth.session
 * (TTL 7d) and auth.account (per OAuth link). Compare to Cognito ~$0.0055/MAU.
 */
export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
    // The DDL puts auth tables in the `auth` schema; tell the adapter so it
    // qualifies queries correctly.
    usePlural: false,
  }),

  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET!,
  trustedOrigins: process.env.BETTER_AUTH_TRUSTED_ORIGINS?.split(',') ?? [],

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 12,
    autoSignIn: false,
  },

  // Email verification + password reset wired through Resend
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      const { Resend } = await import('resend');
      const resend = new Resend(process.env.RESEND_API_KEY!);
      await resend.emails.send({
        from: 'no-reply@vicionpower.com',
        to: user.email,
        subject: 'Verifica tu cuenta VicionPower',
        html: `<p>Verifica tu correo: <a href="${url}">${url}</a></p>`,
      });
    },
  },

  socialProviders: process.env.GOOGLE_CLIENT_ID
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        },
      }
    : undefined,

  session: {
    expiresIn: 60 * 60 * 24 * 7,        // 7 days
    updateAge: 60 * 60 * 24,            // refresh once per day
    cookieCache: { enabled: true, maxAge: 60 * 5 },
  },

  rateLimit: {
    enabled: true,
    window: 60,
    max: 30,
  },

  // Hook: when a user signs up, create the corresponding mlm.person row.
  // The mlm.affiliate row is created later via /api/affiliate/place once
  // sponsorship + tree position are validated (see server/affiliate.ts).
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          const { createPersonFromUser } = await import('./server/affiliate');
          await createPersonFromUser({
            userId: user.id,
            email: user.email,
            name: user.name ?? user.email.split('@')[0]!,
          });
        },
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
