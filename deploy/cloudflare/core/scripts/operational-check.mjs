// Read-only operator/heartbeat check, Node >=24. No DB, sending, account writes,
// token output, container startup or private session is needed by this command.
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import { collectOperationalProviders } from '../src/observability-collectors.mjs';

const KEYS = ['RESEND_MONITOR_API_KEY', 'CLOUDFLARE_MONITOR_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID',
  'PLANETSCALE_MONITOR_SERVICE_TOKEN_ID', 'PLANETSCALE_MONITOR_SERVICE_TOKEN', 'PLANETSCALE_MONITOR_ORGANIZATION',
  'PLANETSCALE_MONITOR_DATABASE', 'PLANETSCALE_MONITOR_BRANCH'];
const TARGETS = ['https://mindblisspower.com/login', 'https://admin.mindblisspower.com/login'];

export function monitoringEnvironment(source) {
  return Object.fromEntries(KEYS.filter(key => typeof source[key] === 'string').map(key => [key, source[key]]));
}

async function publicAvailability(url, fetchImpl) {
  const began = Date.now();
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store',
      headers: { accept: 'text/html' }, signal: AbortSignal.timeout(8000) });
    void response.body?.cancel().catch(() => {});
    return { service: url.includes('admin.') ? 'admin' : 'portal', http_status: response.status,
      response_ms: Date.now() - began, status: response.status === 200 ? 'ok' : 'critical' };
  } catch { return { service: url.includes('admin.') ? 'admin' : 'portal', http_status: null,
    response_ms: Date.now() - began, status: 'critical' }; }
}

export async function checkOperations(environment, fetchImpl = fetch) {
  const env = monitoringEnvironment(environment);
  const [providers, availability] = await Promise.all([collectOperationalProviders(env, { fetchImpl }),
    Promise.all(TARGETS.map(target => publicAvailability(target, fetchImpl)))]);
  return { ...providers, availability, missing_configuration: KEYS.filter(key => !env[key]),
    scope: 'Read-only provider capacity and public login availability; not functional OTP, payment, Container or billing certification.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length && !(args.length === 2 && args[0] === '--env-file')) throw new Error('invalid_arguments');
    const file = args.length ? parseEnv(readFileSync(args[1], 'utf8')) : {};
    // Only explicitly scoped monitoring credentials reach the collector. All
    // other app, database, Stripe, NOWPayments and auth credentials are ignored.
    const report = await checkOperations({ ...monitoringEnvironment(file), ...monitoringEnvironment(process.env) });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch {
    process.stderr.write('Operational check unavailable; configuration or local read failed.\n');
    process.exitCode = 1;
  }
}
