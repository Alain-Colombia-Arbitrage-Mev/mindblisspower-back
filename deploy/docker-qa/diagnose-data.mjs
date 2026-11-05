import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.argv.includes('--qa-docker')) throw new Error('Requires --qa-docker; no external database or production URL is accepted');
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Docker diagnostic failed: ${args[0]}`);
  return result.stdout.trim();
}
function inspect(service) {
  const container = JSON.parse(docker(['inspect', `mindbliss-qa-${service}-1`]))[0];
  if (container.Config.Labels['com.docker.compose.project'] !== 'mindbliss-qa') throw new Error('Refusing a non-QA target');
  const env = Object.fromEntries(container.Config.Env.map(entry => { const at = entry.indexOf('='); return [entry.slice(0, at), entry.slice(at + 1)]; }));
  return { container, env };
}
const db = inspect('postgres');
if (db.env.POSTGRES_DB !== 'mindbliss_qa') throw new Error('Refusing a non-synthetic database');
const report = { generatedAt: new Date().toISOString(), environment: 'synthetic-docker-qa', frontend: {}, services: [], database: null, authenticatedBffVerified: false };
for (const service of ['client', 'admin']) {
  const { env } = inspect(service);
  report.frontend[service] = Object.fromEntries(['COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID', 'MEMBER_DATABASE_URL', 'VP_PAYMENTS_URL', 'VP_WITHDRAWALS_URL', 'PAYMENTS_SERVICE_TOKEN'].map(key => [key, Boolean(env[key])]));
}
const { env: payments } = inspect('payments');
if (payments.PAYMENTS_SERVICE_TOKEN !== 'synthetic-qa-only-not-for-production') throw new Error('Refusing unexpected service credentials');
const apiPaths = ['admins', 'users', 'summary', 'payments', 'finance', 'solvency', 'sales/report', 'carts/summary', 'tree/roots', 'network/health', 'network/sustainability', 'command-center/summary', 'command-center/alerts', 'blacklist', 'tickets'];
for (const endpoint of apiPaths) {
  const started = performance.now();
  try {
    const response = await fetch(`http://127.0.0.1:3305/api/admin/${endpoint}?email=admin@example.invalid`, { headers: { 'X-VP-Service-Token': payments.PAYMENTS_SERVICE_TOKEN }, signal: AbortSignal.timeout(20_000) });
    const body = await response.json().catch(() => null);
    report.services.push({ endpoint, status: response.status, elapsedMs: Math.round(performance.now() - started), validJson: body !== null,
      collections: Object.fromEntries(Object.entries(body || {}).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length])) });
  } catch { report.services.push({ endpoint, status: null, error: 'unreachable-or-timeout' }); }
}
const sql = `BEGIN READ ONLY; SELECT json_build_object('database',current_database(),'persons',(SELECT count(*) FROM mlm.person),'affiliates',(SELECT count(*) FROM mlm.affiliate),'purchaseIntents',(SELECT count(*) FROM payments.purchase_intent)); COMMIT;`;
const output = docker(['exec', 'mindbliss-qa-postgres-1', 'psql', '-X', '-q', '-U', 'postgres', '-d', 'mindbliss_qa', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
report.database = JSON.parse(output);
report.notes = ['UI fixtures on ports 64421/64422/64423/64424 never query PostgreSQL.', 'Unconfigured Cognito prevents authenticated browser/BFF verification. No auth bypass is introduced.', 'Empty QA collections are not the recovered historical customer database.'];
const destination = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..', 'reportes', 'data-diagnostics-20261024.json');
await mkdir(path.dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
console.log(`Aggregate-only report: ${destination}`);
if (report.services.some(service => service.status !== 200 || !service.validJson)) process.exitCode = 1;
