import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';

export const directory = path.dirname(fileURLToPath(import.meta.url));
const environmentNames = new Set(['staging', 'production']);
export const imageKeys = {
  postgres: 'POSTGRES_IMAGE', redis: 'REDIS_IMAGE', edge: 'CADDY_IMAGE', api: 'API_IMAGE',
  engine: 'ENGINE_IMAGE', payments: 'PAYMENTS_IMAGE', withdrawals: 'WITHDRAWALS_IMAGE',
  client: 'CLIENT_IMAGE', admin: 'ADMIN_IMAGE', backup: 'BACKUP_IMAGE',
};

export function validateConfig(config, environment, databaseMode = 'local') {
  const errors = [];
  const add = (condition, message) => { if (!condition) errors.push(message); };
  add(environmentNames.has(environment), 'Unknown environment');
  add(['local', 'rds'].includes(databaseMode), 'Unknown database mode');
  add(config.name === `mindbliss-${environment}`, 'Project name must isolate the selected environment');
  const services = config.services || {};
  for (const name of Object.keys(imageKeys)) {
    if (name === 'postgres' && databaseMode === 'rds') continue;
    const service = services[name];
    if (!service) { errors.push(`Missing service: ${name}`); continue; }
    add(!service.privileged && service.network_mode !== 'host', `${name}: privileged/host networking is forbidden`);
    add(Boolean(service.image) && !/:latest$/.test(service.image) && !/REPLACE_|CHANGEME/.test(service.image), `${name}: use a versioned image`);
    if (environment === 'production') {
      add(/@sha256:[a-f0-9]{64}$/.test(service.image || ''), `${name}: production requires an immutable registry digest`);
    }
    for (const [key, value] of Object.entries(service.environment || {})) {
      add(!/REPLACE_|CHANGEME|synthetic-qa|localdev/i.test(String(value)), `${name}: unresolved or unsafe ${key}`);
    }
    for (const port of service.ports || []) {
      if (name === 'edge') add([80, 443].includes(Number(port.published)), 'Only HTTP/HTTPS may be public');
      else add(environment === 'staging' && ['client', 'admin'].includes(name) && port.host_ip === '127.0.0.1', `${name}: unexpected published port`);
    }
    if (['api', 'engine', 'payments', 'withdrawals', 'client', 'admin'].includes(name)) {
      add(service.read_only === true, `${name}: filesystem must be read-only`);
      add((service.cap_drop || []).includes('ALL'), `${name}: capabilities must be dropped`);
    }
  }
  const env = name => services[name]?.environment || {};
  if (databaseMode === 'rds') add(!services.postgres, 'RDS mode must not start a local Postgres service');
  else {
    add(services.postgres?.volumes?.some(v => v.type === 'volume' && v.target === '/var/lib/postgresql/data'), 'Postgres needs a persistent named volume');
    add(!services.postgres?.tmpfs?.length, 'Postgres data must not be ephemeral');
  }
  add(env('client').DEMO_LOGIN_ENABLED === '0' && env('admin').DEMO_LOGIN_ENABLED === '0', 'Demo login must stay disabled');
  add(env('payments').REQUIRE_VERIFIED_IDENTITY === 'true', 'Verified payment identity must remain required');
  add(env('withdrawals').WITHDRAWALS_REQUIRE_BMP === 'true', 'BMP withdrawal protection must remain enabled');
  add(env('engine').GRPC_TLS_REQUIRE_CLIENT_CERT === 'true', 'Engine client certificates must remain required');
  add(env('api').ENGINE_MTLS_REQUIRED === 'true', 'API must use engine mTLS');
  add(env('engine').BONUS_ENGINE_BINARY_CYCLE_ENABLED === 'false', 'Initial rollout must not activate a second binary scheduler');
  add(env('engine').BONUS_ENGINE_SCHEDULER_ENABLED === 'false', 'Initial rollout must keep ALL financial schedules disabled');
  add(env('withdrawals').WITHDRAWALS_REQUIRE_VERIFIED_IDENTITY === 'true', 'Withdrawals must require verified identity');
  const token = env('payments').PAYMENTS_SERVICE_TOKEN;
  add(typeof token === 'string' && token.length >= 32, 'Service token must contain at least 32 characters');
  for (const name of ['client', 'admin']) add(env(name).PAYMENTS_SERVICE_TOKEN === token, `${name}: service token mismatch`);
  add(env('withdrawals').SERVICE_TOKEN === token, 'Withdrawal service token mismatch');
  add(env('payments').REDIS_PASSWORD === env('redis').REDIS_PASSWORD, 'Redis credentials mismatch');
  add(String(env('redis').REDIS_PASSWORD || '').length >= 24, 'Redis password must contain at least 24 characters');
  if (databaseMode === 'local') add(String(env('postgres').POSTGRES_PASSWORD || '').length >= 24, 'Postgres password must contain at least 24 characters');
  add(String(env('api').BETTER_AUTH_SECRET || '').length >= 32, 'Auth secret must contain at least 32 characters');
  const dbName = databaseMode === 'rds' ? env('api').DATABASE_EXPECTED_NAME : env('postgres').POSTGRES_DB;
  const dbHost = databaseMode === 'rds' ? env('api').DATABASE_EXPECTED_HOST : 'postgres';
  if (databaseMode === 'rds') {
    add(/^[a-z0-9.-]+\.rds\.aliyuncs\.com$/.test(dbHost || ''), 'Set the exact Alibaba RDS private endpoint');
    add(env('api').DATABASE_CA_FILE === '/run/db-ca/server-ca.pem', 'API needs the mounted RDS CA');
    add(env('client').MEMBER_DB_SSL === 'verify-full' && env('client').MEMBER_DB_CA_FILE === '/run/db-ca/server-ca.pem', 'Client must verify RDS certificates');
  }
  add(typeof dbName === 'string' && dbName.includes(environment), 'Database name must identify its environment');
  const users = new Set();
  for (const name of ['api', 'engine', 'payments', 'withdrawals', 'client', 'backup']) {
    try {
      const uri = new URL(env(name)[name === 'client' ? 'MEMBER_DATABASE_URL' : 'DATABASE_URL']);
      add(['postgres:', 'postgresql:'].includes(uri.protocol) && uri.hostname === dbHost, `${name}: database host mismatch`);
      if (databaseMode === 'rds') {
        add(uri.searchParams.get('sslmode') === 'verify-full', `${name}: RDS requires sslmode=verify-full`);
        if (!['api', 'client'].includes(name)) add(uri.searchParams.get('sslrootcert') === '/run/db-ca/server-ca.pem', `${name}: configure RDS sslrootcert`);
        add(services[name].volumes?.some(v => v.target === '/run/db-ca' && v.type === 'bind' && v.read_only), `${name}: CA must be mounted read-only`);
        add(!services[name].depends_on?.postgres, `${name}: external RDS cannot depend on local Postgres`);
      }
      add(decodeURIComponent(uri.pathname.slice(1)) === dbName, `${name}: database mismatch`);
      add(Boolean(uri.username) && decodeURIComponent(uri.password).length >= 24, `${name}: use a named role and strong password`);
      if (name !== 'backup') {
        add(uri.username !== 'postgres' && uri.username !== env('postgres').POSTGRES_USER, `${name}: superuser credentials are forbidden`);
        add(!users.has(uri.username), `${name}: use a distinct least-privilege database role`);
        users.add(uri.username);
      }
    } catch { errors.push(`${name}: invalid database URI`); }
  }
  for (const name of ['client', 'admin', 'payments']) {
    add(Boolean(env(name).COGNITO_USER_POOL_ID) && Boolean(env(name).COGNITO_CLIENT_ID), `${name}: Cognito must be configured`);
    add(env(name).COGNITO_USER_POOL_ID === env('payments').COGNITO_USER_POOL_ID && env(name).COGNITO_CLIENT_ID === env('payments').COGNITO_CLIENT_ID, `${name}: Cognito configuration mismatch`);
  }
  const stripe = String(env('payments').STRIPE_SECRET_KEY || '');
  add(environment === 'production' ? /^(sk|rk)_live_/.test(stripe) : /^(sk|rk)_test_/.test(stripe), 'Stripe key does not match environment');
  add(String(env('payments').STRIPE_WEBHOOK_SECRET || '').startsWith('whsec_'), 'Stripe webhook signing secret is missing');
  add(Boolean(env('backup').BACKUP_AGE_RECIPIENT), 'Backup encryption recipient is required');
  const root = Number(env('payments').PAYMENTS_COMPANY_ROOT_AFFILIATE_ID);
  add(Number.isSafeInteger(root) && root > 0 && String(root) === env('engine').BONUS_ENGINE_COMPANY_ROOT_AFFILIATE_ID, 'Set the same validated company root in payments and engine');
  const issuer = `https://cognito-idp.${env('payments').AWS_REGION}.amazonaws.com/${env('payments').COGNITO_USER_POOL_ID}`;
  add(env('withdrawals').COGNITO_ISSUER === issuer && env('withdrawals').COGNITO_CLIENT_ID === env('payments').COGNITO_CLIENT_ID, 'Withdrawal Cognito issuer/audience mismatch');
  try {
    const origin = new URL(env('withdrawals').BMP_BASE_URL);
    add(origin.protocol === 'https:' && origin.pathname === '/' && !origin.search && !origin.hash && !origin.username, 'BMP must use an explicit HTTPS origin without a path');
  } catch { errors.push('BMP origin is required'); }
  for (const name of ['engine', 'payments', 'withdrawals']) add(env(name).ENV === environment, `${name}: ENV mismatch`);
  if (environment === 'production') {
    add(String(env('backup').BACKUP_S3_URI || '').startsWith('s3://'), 'Production requires an off-provider backup destination');
  }
  return errors;
}

export async function initialize(environment, target) {
  if (!environmentNames.has(environment)) throw new Error('Use staging or production');
  const absolute = path.resolve(target);
  await mkdir(absolute, { recursive: true });
  // Exclusive creation prevents a repeated init from overwriting live secrets.
  const templates = await readdir(path.join(directory, 'env.example'));
  for (const template of templates) {
    const content = (await readFile(path.join(directory, 'env.example', template), 'utf8'))
      .replaceAll('mindbliss_staging', `mindbliss_${environment}`);
    await writeFile(path.join(absolute, template.replace(/\.example$/, '')), content, { flag: 'wx', mode: 0o600 });
  }
  await mkdir(path.join(absolute, 'tls', 'server'), { recursive: true });
  await mkdir(path.join(absolute, 'tls', 'client'), { recursive: true });
  await mkdir(path.join(absolute, 'backups'), { recursive: true });
  const project = (await readFile(path.join(directory, 'project.env.example'), 'utf8'))
    .replace('DEPLOY_ENV=staging', `DEPLOY_ENV=${environment}`)
    .replace('REPLACE_ABSOLUTE_RUNTIME_DIRECTORY', absolute.replaceAll('\\', '/'))
    .replace('REPLACE_ABSOLUTE_BACKUP_DIRECTORY', path.join(absolute, 'backups').replaceAll('\\', '/'));
  await writeFile(path.join(absolute, 'project.env'), project, { flag: 'wx', mode: 0o600 });
  return absolute;
}

export async function validateCertificates(config) {
  const errors = [];
  const authorities = [];
  for (const [service, role] of [['engine', 'server'], ['api', 'client']]) {
    try {
      const mount = config.services[service].volumes.find(volume => volume.target === '/run/tls');
      if (mount.type !== 'bind' || !mount.read_only) throw new Error();
      const certificate = new X509Certificate(await readFile(path.join(mount.source, `${role}.crt`)));
      const authority = new X509Certificate(await readFile(path.join(mount.source, 'ca.crt')));
      const privateKey = createPrivateKey(await readFile(path.join(mount.source, `${role}.key`)));
      const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
      const now = Date.now();
      if (!certificate.publicKey.export({ type: 'spki', format: 'der' }).equals(publicKey) || !certificate.verify(authority.publicKey) ||
          !authority.ca || Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) < now + 14 * 86400000 ||
          Date.parse(authority.validTo) < now + 14 * 86400000) throw new Error();
      if (role === 'server' && !certificate.checkHost('engine')) throw new Error();
      const expectedUsage = role === 'server' ? '1.3.6.1.5.5.7.3.1' : '1.3.6.1.5.5.7.3.2';
      if (!certificate.keyUsage?.includes(expectedUsage)) throw new Error();
      authorities.push(authority.fingerprint256);
    } catch { errors.push(`${service}: missing/invalid mTLS identity, CA, hostname, purpose or expiry (at least 14 days required)`); }
  }
  if (authorities.length === 2 && authorities[0] !== authorities[1]) errors.push('API and engine do not trust the same CA');
  return errors;
}

export function composeArgs(environment, envFile, imageFile, databaseMode = 'local') {
  if (!environmentNames.has(environment)) throw new Error('Use staging or production');
  if (!['local', 'rds'].includes(databaseMode)) throw new Error('Use local or rds database mode');
  return ['compose', '--env-file', path.resolve(envFile), ...(imageFile ? ['--env-file', path.resolve(imageFile)] : []),
    '-f', path.join(directory, 'compose.yml'), '-f', path.join(directory, `compose.${environment}.yml`),
    ...(databaseMode === 'rds' ? ['-f', path.join(directory, 'compose.rds.yml')] : [])];
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    environment: { type: 'string' }, directory: { type: 'string' },
    'env-file': { type: 'string' }, 'images-file': { type: 'string' },
    database: { type: 'string', default: 'local' },
  } });
  const environment = values.environment;
  if (positionals[0] === 'init' && values.directory) {
    console.log(`Templates created at ${await initialize(environment, values.directory)}. Fill secrets and roles before deployment.`);
    return;
  }
  if (positionals[0] !== 'check' || !values['env-file']) throw new Error('Usage: manage.mjs init --environment staging|production --directory DIR; or check --environment ENV --env-file FILE [--images-file FILE]');
  const args = [...composeArgs(environment, values['env-file'], values['images-file'], values.database), '--profile', 'edge', '--profile', 'ops', 'config', '--format', 'json'];
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('Compose could not resolve the configuration. Check file paths and required variables; no secrets printed.');
  const config = JSON.parse(result.stdout);
  const errors = [...validateConfig(config, environment, values.database), ...await validateCertificates(config)];
  if (values.database === 'rds') {
    try {
      const mount = config.services.api.volumes.find(v => v.target === '/run/db-ca');
      const ca = new X509Certificate(await readFile(path.join(mount.source, 'server-ca.pem')));
      if (!ca.ca || Date.parse(ca.validFrom) > Date.now() || Date.parse(ca.validTo) < Date.now() + 14 * 86400000) throw new Error();
    } catch { errors.push('RDS CA missing, invalid or expires in less than 14 days'); }
  }
  if (errors.length) throw new Error(errors.map(e => `- ${e}`).join('\n'));
  console.log(`Configuration checks passed for ${environment}. Still required: certificate, schema, role grants, webhook and restore drill verification.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
