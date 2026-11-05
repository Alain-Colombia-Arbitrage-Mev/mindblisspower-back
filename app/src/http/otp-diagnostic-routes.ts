import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { diagnoseOtp, otpDiagnosticInput, type OtpDiagnostic } from '../auth/otp-diagnostic';
import { postTraceObservation, traceSecret } from '../auth/otp-trace';
import { requireAdmin } from '../server/admin-gate';
import { authProxyContext } from './auth-proxy-context';
import type { ApiApplication } from './types';

type Environment = Record<string, string | undefined>;
export const OTP_DIAGNOSTIC_PATH = '/api/admin/auth/otp-diagnostic';
export const OTP_READINESS_PATH = '/internal/otp-trace-readiness';
export const otpDiagnosticPrivacy: MiddlewareHandler = async (c, next) => {
  c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache');
  await next();
};
const signed: (env: Environment) => MiddlewareHandler = env => async (c, next) => {
  try { traceSecret(env); } catch { return c.json({ error: 'auth_proxy_unconfigured' }, 503); }
  if (new URL(c.req.url).search) return c.json({ error: 'invalid_request' }, 400);
  return authProxyContext(env.AUTH_BFF_SHARED_SECRET)(c, next);
};
const trustedDiagnosticOrigin: (env: Environment) => MiddlewareHandler = env => async (c, next) => {
  const origin = c.req.header('origin');
  const allowed = (env.BETTER_AUTH_TRUSTED_ORIGINS || '').split(',').map(value => value.trim()).some(value => {
    if (!origin || value !== origin) return false;
    try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value && !url.username && !url.password; }
    catch { return false; }
  });
  if (!allowed) return c.json({ error: 'forbidden' }, 403);
  await next();
};

/** Private native route; register before /api session middleware. No SQL/auth
 * handler/provider is invoked. This only proves bounded private TLS transport. */
export function registerOtpTraceReadiness(app: ApiApplication, env: Environment = process.env, fetchImpl: typeof fetch = globalThis.fetch) {
  app.use(OTP_READINESS_PATH, otpDiagnosticPrivacy);
  app.post(OTP_READINESS_PATH, bodyLimit({ maxSize: 2, onError: c => c.json({ error: 'otp_trace_unavailable' }, 503) }),
    async (c, next) => {
      if (env.AUTH_OTP_TRACE_ENABLED !== 'true' || c.req.raw.headers.has('cookie') || c.req.raw.headers.has('authorization')
        || c.req.header('x-vp-auth-client-ip') !== '127.0.0.1'
        || !/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type') || '')
        || await c.req.raw.clone().text() !== '{}') return c.json({ error: 'otp_trace_unavailable' }, 503);
      await next();
    }, async (c, next) => {
      const response = await signed(env)(c, next);
      if (response instanceof Response && response.status >= 400) return c.json({ error: 'otp_trace_unavailable' }, 503);
      return response;
    }, async c => {
      if (!await postTraceObservation(env, '/v1/probe', {}, fetchImpl, 2000)) return c.json({ error: 'otp_trace_unavailable' }, 503);
      return c.json({ ready: true });
    });
}

type DiagnosticLookup = (input: unknown) => Promise<OtpDiagnostic>;
export function registerOtpDiagnosticRoutes(app: ApiApplication, env: Environment = process.env,
  lookup: DiagnosticLookup = input => diagnoseOtp(env, input), admin: MiddlewareHandler = requireAdmin) {
  app.use(OTP_DIAGNOSTIC_PATH, otpDiagnosticPrivacy);
  app.post(OTP_DIAGNOSTIC_PATH, bodyLimit({ maxSize: 1024, onError: c => c.json({ error: 'request_too_large' }, 413) }),
    signed(env), trustedDiagnosticOrigin(env), admin, async c => {
      if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type') || '')) return c.json({ error: 'invalid_request' }, 400);
      let input: unknown;
      try { input = otpDiagnosticInput.parse(await c.req.json()); }
      catch { return c.json({ error: 'invalid_request' }, 400); }
      try { return c.json(await lookup(input)); }
      catch { return c.json({ error: 'otp_diagnostic_unavailable' }, 503); }
    });
}
