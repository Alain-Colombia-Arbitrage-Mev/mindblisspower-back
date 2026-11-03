import { nowpaymentsOperationalReady } from './nowpayments-operation.mjs';

export const NOWPAYMENTS_JOB = 'https://payments.core.internal/api/payments/internal/nowpayments/run';

/** Only the Worker scheduled handler calls this. No caller parameters or retries. */
export async function runNOWPaymentsScheduled(env, resolve) {
  if (!nowpaymentsOperationalReady(env)) return { enabled: false };
  if (typeof env.PAYMENTS_SERVICE_TOKEN !== 'string' || env.PAYMENTS_SERVICE_TOKEN.length < 16
    || /[\r\n]/.test(env.PAYMENTS_SERVICE_TOKEN)) throw new Error('NOWPayments scheduled configuration unavailable');
  let response;
  try {
    response = await resolve('payments', 'singleton').fetch(new Request(NOWPAYMENTS_JOB, {
      method: 'POST', headers: { 'x-vp-service-token': env.PAYMENTS_SERVICE_TOKEN },
      redirect: 'manual', signal: AbortSignal.timeout(50000),
    }));
    if (response.status === 202) { await response.body?.cancel(); return { enabled: true, busy: true }; }
    if (response.status !== 200) { await response.body?.cancel(); throw new Error(); }
    const raw = await response.text();
    if (raw.length > 1024) throw new Error();
    const value = JSON.parse(raw);
    if (value?.engine_run !== true || !Number.isSafeInteger(value.processed) || value.processed < 0 || value.processed > 5) throw new Error();
    return { enabled: true, processed: value.processed, engineRun: true };
  } catch { throw new Error('NOWPayments scheduled processing unavailable'); }
}
