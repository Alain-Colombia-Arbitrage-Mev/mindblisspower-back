// No request URL, headers, payload, destination or identity enters this probe.
// A 200 here certifies neither financial invariants nor the gRPC transport.
const CHECKS = Object.freeze([
  ['apiHealth', 'api', 'https://auth.core.internal/health'],
  ['engineHealth', 'engine', 'http://engine.core.internal/health'],
  ['engineReady', 'engine', 'http://engine.core.internal/ready'],
  ['paymentsHealth', 'payments', 'https://payments.core.internal/health'],
  ['withdrawalsHealth', 'withdrawals', 'https://withdrawals.core.internal/health'],
].map(Object.freeze));
const TIMEOUT_MS = 30_000;

export function readinessProbeEnabled(env) {
  return ['staging', 'production'].includes(env.CORE_ENV) && env.CORE_READINESS_PROBE_ENABLED === 'true'
    && env.CORE_DATA_ACCESS_VERIFIED === 'true' && env.AUTH_CUTOVER_VERIFIED === 'true';
}

/** Status-only, fixed destinations, fixed singleton, no financial certification. */
export async function privateReadiness(env, resolve) {
  if (!readinessProbeEnabled(env)) return { status: 503, ok: false, financialCertified: false, checks: {} };
  const checks = Object.fromEntries(await Promise.all(CHECKS.map(async ([key, service, url]) => {
    const controller = new AbortController(); let timer;
    try {
      const response = await Promise.race([
        Promise.resolve().then(() => resolve(service, 'singleton').fetch(new Request(url, {
          method: 'GET', redirect: 'manual', signal: controller.signal,
        }))).then(response => {
          if (controller.signal.aborted) {
            void response.body?.cancel().catch(() => {});
            throw new Error('Readiness timeout');
          }
          return response;
        }),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Readiness timeout')); }, TIMEOUT_MS); }),
      ]);
      // Never consume or return a health payload, headers or provider exception.
      void response.body?.cancel().catch(() => {});
      return [key, { status: response.status, ok: response.ok }];
    } catch { return [key, { status: 503, ok: false }]; }
    finally { clearTimeout(timer); }
  })));
  const ok = Object.values(checks).every(check => check.ok);
  return { status: ok ? 200 : 503, ok, financialCertified: false, checks };
}
