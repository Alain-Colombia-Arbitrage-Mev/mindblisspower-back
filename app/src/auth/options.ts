import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { emailOTP } from 'better-auth/plugins/email-otp';
import { phoneNumber } from 'better-auth/plugins/phone-number';
import { jwt } from 'better-auth/plugins/jwt';
import { authActionMessage, cloudflareEmailConfigured, createAuthDelivery, validPhone, type AuthDelivery, type AuthEnvironment } from './delivery';
import { limitRecipient, otpHash, recipientBudgetKey, securePhoneVerification, securePhoneVerifyEndpoint } from './phone-otp';

export type BoundIdentity = { status: string; publicId?: string; email?: string };
export type AuthIdentity = {
  provision: (userId: string) => Promise<BoundIdentity>;
  binding: (userId: string) => Promise<BoundIdentity>;
};
const messagePaths = new Set(['/sign-up/email', '/send-verification-email', '/request-password-reset',
  '/email-otp/send-verification-otp', '/email-otp/request-password-reset', '/forget-password/email-otp', '/phone-number/send-otp']);

/** Pure composition: tests supply an adapter, identity policy and mock senders. */
export function createAuthOptions(env: AuthEnvironment, database: BetterAuthOptions['database'], identity: AuthIdentity,
  delivery: AuthDelivery = createAuthDelivery(env)): BetterAuthOptions {
  const emailEnabled = env.BETTER_AUTH_EMAIL_OTP_ENABLED === 'true';
  const phoneEnabled = env.BETTER_AUTH_PHONE_OTP_ENABLED === 'true';
  const jwtEnabled = env.BETTER_AUTH_JWT_ENABLED === 'true';
  const secret = env.BETTER_AUTH_SECRET || '';
  if ((emailEnabled || phoneEnabled || jwtEnabled) && (secret.length < 32 || !env.BETTER_AUTH_URL)) throw new Error('Better Auth feature configuration incomplete');
  if (emailEnabled || phoneEnabled || jwtEnabled) {
    for (const value of [env.BETTER_AUTH_URL, ...(env.BETTER_AUTH_TRUSTED_ORIGINS || '').split(','), ...(jwtEnabled ? [env.BETTER_AUTH_JWT_ISSUER] : [])].filter(Boolean)) {
      let url: URL;
      try { url = new URL(value!.trim()); } catch { throw new Error('Authentication URLs must be explicit and valid'); }
      if (url.username || url.password || url.hash || url.search || (url.protocol !== 'https:'
        && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('Authentication URLs must use HTTPS');
    }
  }
  if (phoneEnabled && (!env.SENTDM_API_KEY || !env.SENTDM_OTP_TEMPLATE_ID || !env.SENTDM_OTP_CHANNEL)) throw new Error('Phone authentication delivery is not configured');
  if (phoneEnabled && !['sms', 'whatsapp'].includes(env.SENTDM_OTP_CHANNEL!)) throw new Error('Select one configured phone authentication channel');
  if (emailEnabled && !cloudflareEmailConfigured(env)) throw new Error('Cloudflare email authentication delivery is not configured');
  if (jwtEnabled && (!env.BETTER_AUTH_JWT_ISSUER || !env.BETTER_AUTH_JWT_AUDIENCE)) throw new Error('JWT issuer and audience must be explicit');
  const plugins: BetterAuthPlugin[] = [];
  if (emailEnabled) plugins.push(emailOTP({ otpLength: 6, expiresIn: 300, allowedAttempts: 3,
    disableSignUp: true, storeOTP: { hash: async code => otpHash(secret, 'email-otp', code) },
    overrideDefaultEmailVerification: true, resendStrategy: 'rotate', rateLimit: { window: 60, max: 5 },
    sendVerificationOTP: async ({ email, otp, type }) => delivery.email({ to: email,
      subject: type === 'forget-password' ? 'Código para restablecer tu contraseña' : 'Código de acceso de Mindbliss Power',
      text: `Tu código es ${otp}. Vence en 5 minutos. No compartas este código.` }) }));
  if (phoneEnabled) {
    const phone = phoneNumber({ otpLength: 6, expiresIn: 300, allowedAttempts: 3,
      requireVerification: true, phoneNumberValidator: validPhone,
      sendOTP: async ({ phoneNumber: destination, code }) => delivery.phone(destination, code) });
    plugins.push({ ...phone, endpoints: { ...phone.endpoints, verifyPhoneNumber: securePhoneVerifyEndpoint(secret) } });
  }
  if (jwtEnabled) plugins.push(jwt({ disableSettingJwtHeader: true,
    jwks: { keyPairConfig: { alg: 'RS256', modulusLength: 2048 }, rotationInterval: 86400 * 30 },
    jwt: { issuer: env.BETTER_AUTH_JWT_ISSUER!, audience: env.BETTER_AUTH_JWT_AUDIENCE!, expirationTime: '5m',
      definePayload: async ({ user }) => {
        if (user.emailVerified !== true) throw new APIError('FORBIDDEN', { message: 'Verified identity required' });
        const bound = await identity.binding(user.id);
        if (!['created', 'existing'].includes(bound.status) || !bound.publicId || !bound.email
          || bound.email.trim().toLowerCase() !== user.email.trim().toLowerCase()) throw new APIError('FORBIDDEN', { message: 'Identity review required' });
        return { email: bound.email, email_verified: true, authVerified: true, person_public_id: bound.publicId };
      } } }));
  return {
    database, baseURL: env.BETTER_AUTH_URL, secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: (env.BETTER_AUTH_TRUSTED_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean),
    ...(env.AUTH_BFF_SHARED_SECRET ? { advanced: { ipAddress: { ipAddressHeaders: ['x-vp-auth-client-ip'] } } } : {}),
    logger: { disabled: true }, plugins,
    // better-call logs unhandled errors even when Better Auth's logger is off.
    // Replace unexpected DB/provider errors before that outer fallback sees
    // them; SQL parameters may contain destinations or verification secrets.
    onAPIError: { onError(error) {
      if (!(error instanceof APIError) || error.statusCode >= 500) {
        throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Authentication temporarily unavailable' });
      }
    } },
    emailAndPassword: { enabled: true, requireEmailVerification: true, minPasswordLength: 12, autoSignIn: false,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => delivery.email(authActionMessage(env, user.email, url, true)) },
    emailVerification: { sendOnSignUp: true, autoSignInAfterVerification: false,
      // Do not shadow the emailOTP plugin's override during Better Auth init.
      ...(emailEnabled ? {} : { sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => delivery.email(authActionMessage(env, user.email, url, false)) }) },
    socialProviders: env.GOOGLE_CLIENT_ID ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET! } } : undefined,
    account: { accountLinking: { enabled: false } },
    session: { expiresIn: 86400 * 7, updateAge: 86400, cookieCache: { enabled: false } },
    verification: { storeInDatabase: true },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 30 },
    disabledPaths: ['/phone-number/request-password-reset', '/phone-number/reset-password'],
    hooks: { before: createAuthMiddleware(async ctx => {
      if (ctx.path === '/sign-in/phone-number' && typeof ctx.body?.phoneNumber === 'string') {
        const user = await ctx.context.adapter.findOne<{ phoneNumberVerified: boolean }>({ model: 'user',
          where: [{ field: 'phoneNumber', value: ctx.body.phoneNumber }] });
        // The stock plugin sends before checking the password. Verification is
        // an explicit, rate-limited send flow instead of a login side effect.
        if (user && user.phoneNumberVerified !== true) throw new APIError('FORBIDDEN', { message: 'Phone verification required' });
      }
      if (messagePaths.has(ctx.path)) {
        const recipient = ctx.body?.email || ctx.body?.phoneNumber;
        if (typeof recipient === 'string') await limitRecipient(secret, recipient, ctx, typeof ctx.body?.email === 'string' ? 300_000 : 60_000);
      }
    }) },
    databaseHooks: {
      verification: { create: { before: async (value, ctx) => {
        const secured = phoneEnabled ? securePhoneVerification(secret, value) : value;
        const newEmailCode = emailEnabled && /^(sign-in|email-verification|forget-password|change-email)-otp-/.test(value.identifier)
          && /^[a-f0-9]{64}:0$/.test(value.value);
        if (secured.value !== value.value || newEmailCode) {
          if (!ctx) throw new APIError('SERVICE_UNAVAILABLE', { message: 'Verification context required' });
          // A resend must invalidate ALL older codes, not merely consume
          // the newest one while an older row remains redeemable underneath it.
          await ctx.context.adapter.deleteMany({ model: 'verification', where: [{ field: 'identifier', value: value.identifier }] });
          if (newEmailCode) {
            const recipient = value.identifier.slice(value.identifier.indexOf('-otp-') + 5);
            // Native email OTP retries recreate a row. Until that plugin gains
            // a persistent generation/CAS verifier, don't allow any new send
            // before the ORIGINAL challenge expires. Store allowed-after in
            // lastRequest so native rate-limit pruning can't erase it early.
            await ctx.context.adapter.incrementOne({ model: 'rateLimit', where: [{ field: 'key', value: recipientBudgetKey(secret, recipient) },
              { field: 'lastRequest', operator: 'lt', value: value.expiresAt.getTime() + 1 }], increment: {}, set: { lastRequest: value.expiresAt.getTime() + 1 } });
          }
        }
        return { data: secured };
      } } },
      user: { create: { after: async user => { await identity.provision(user.id); } } },
      session: { create: { before: async (session, ctx) => {
        const user = await ctx?.context.internalAdapter.findUserById(session.userId);
        if (!user || user.emailVerified !== true) return false;
        // claim_required/quarantined may have a limited auth session. No JWT is
        // issued until the separate, approved identity-binding policy succeeds.
        await identity.provision(user.id);
      } } },
    },
  };
}
