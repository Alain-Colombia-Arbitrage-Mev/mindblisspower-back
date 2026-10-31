// Actual Core Worker + Bun client + Go Engine + Go JWT verifier, synthetic DB only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSyntheticDockerProxy } from './synthetic-docker-proxy.mjs';

if (process.platform === 'win32') throw new Error('Use Linux/WSL for local Containers; never substitute remote dev.');
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../../..');
const runtime = path.join(here, 'runtime'); mkdirSync(runtime, { recursive: true });
const pki = process.env.SPIKE_PKI_DIR || mkdtempSync(path.join(runtime, 'core-pki-'));
assert.equal(path.dirname(path.resolve(pki)), runtime, 'PKI must be an isolated synthetic runtime directory');
const ssl = args => execFileSync(process.env.SPIKE_OPENSSL || 'openssl', args, { cwd: pki, stdio: 'pipe', timeout: 30_000 });
const docker = (args, options = {}) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000, ...options }).trim();
// Wrangler copies Dockerfiles to a temporary name, losing filename-specific
// ignore rules. Build this local-only image first, then use a FROM-only wrapper.
docker(['build', '--network', 'none', '-f', path.join(here, 'Dockerfile.real-client'), '-t', 'mindbliss/cf-core-client-test:20261025', root], { timeout: 120_000 });
if (!process.env.SPIKE_PKI_DIR) {
ssl(['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-days', '1', '-subj', '/CN=Synthetic core transport CA', '-keyout', 'ca.key', '-out', 'ca.crt', '-addext', 'basicConstraints=critical,CA:TRUE']);
for (const [name, usage, hostname] of [['engine', 'serverAuth', 'engine.original.invalid'], ['database', 'serverAuth', 'host.docker.internal'], ['client', 'clientAuth', 'synthetic-client']]) {
  ssl(['req', '-new', '-newkey', 'rsa:2048', '-noenc', '-subj', `/CN=${hostname}`, '-keyout', `${name}.key`, '-out', `${name}.csr`]);
  writeFileSync(path.join(pki, `${name}.ext`), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=${usage}\n${usage === 'serverAuth' ? `subjectAltName=DNS:${hostname}\n` : ''}`);
  ssl(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-out', `${name}.crt`, '-extfile', `${name}.ext`]);
}
ssl(['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-days', '1', '-subj', '/CN=Synthetic untrusted client', '-keyout', 'alien.key', '-out', 'alien.crt']);
}
const read = name => readFileSync(path.join(pki, name), 'utf8');
const dbName = `mindbliss-cf-private-transport-db-${process.pid}-${randomBytes(3).toString('hex')}`;
assert.match(dbName, /^mindbliss-cf-private-transport-db-\d+-[a-f0-9]{6}$/);
const dbPassword = randomBytes(24).toString('hex'), adminPassword = randomBytes(24).toString('hex');
const pg = sql => docker(['exec', '-i', dbName, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'transport_synthetic'], { input: sql });
const snapshot = () => JSON.parse(pg(`BEGIN READ ONLY; SELECT json_build_object('walletHash',(SELECT md5(string_agg(to_jsonb(w)::text,'' ORDER BY id)) FROM mlm.wallet w),'movements',(SELECT count(*) FROM mlm.wallet_movement),'stripeSales',(SELECT count(*) FROM payments.stripe_sale),'writable',has_table_privilege('engine_reader','mlm.wallet','INSERT,UPDATE,DELETE'),'sleeping',(SELECT count(*) FROM pg_stat_activity WHERE application_name='vp-engine' AND wait_event='PgSleep'));ROLLBACK;`));
process.env.WRANGLER_SEND_METRICS = 'false';
let syntheticDocker;
const previousDockerHost = process.env.WRANGLER_DOCKER_HOST;
if (process.env.SPIKE_DOCKER_GATEWAY) {
  const gateway = JSON.parse(docker(['network', 'inspect', 'bridge']))[0].IPAM.Config[0].Gateway;
  assert.equal(process.env.SPIKE_DOCKER_GATEWAY, gateway, 'Override must match the actual local Docker bridge');
  const socket = `/tmp/mindbliss-synthetic-docker-${process.pid}.sock`;
  syntheticDocker = await startSyntheticDockerProxy(socket, gateway);
  process.env.WRANGLER_DOCKER_HOST = `unix://${socket}`;
}
const { unstable_dev } = await import(process.env.SPIKE_TOOL_ROOT ? `${process.env.SPIKE_TOOL_ROOT}/node_modules/wrangler/wrangler-dist/cli.js` : '../core/node_modules/wrangler/wrangler-dist/cli.js');
let worker, dbStarted = false;
try {
  docker(['run', '--detach', '--name', dbName, '--label', 'mindbliss.synthetic=private-core-transport', '--tmpfs', '/var/lib/postgresql', '-p', '127.0.0.1::5432',
    '--mount', `type=bind,source=${path.join(pki, 'database.key')},target=/input/server.key,readonly`,
    '--mount', `type=bind,source=${path.join(pki, 'database.crt')},target=/input/server.crt,readonly`,
    '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=transport_synthetic', '--entrypoint', 'sh', 'postgres:18.6-alpine3.23', '-ec',
    'cp /input/server.key /var/lib/postgresql/server.key; cp /input/server.crt /var/lib/postgresql/server.crt; chmod 600 /var/lib/postgresql/server.key; chown postgres:postgres /var/lib/postgresql/server.key /var/lib/postgresql/server.crt; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/var/lib/postgresql/server.crt -c ssl_key_file=/var/lib/postgresql/server.key'],
    { env: { ...process.env, POSTGRES_PASSWORD: adminPassword } });
  dbStarted = true;
  for (let attempt = 0; ; attempt++) {
    try { docker(['exec', dbName, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'transport_synthetic']); break; }
    catch { if (attempt > 40) throw new Error('Synthetic PG startup failed'); await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  pg(`CREATE SCHEMA mlm; CREATE SCHEMA payments;
    CREATE TABLE mlm.wallet(id bigint PRIMARY KEY,affiliate_id bigint,asset_id integer,balance numeric(20,6));
    CREATE TABLE mlm.wallet_movement(wallet_id bigint,posted_at timestamptz);
    CREATE TABLE payments.stripe_sale(id bigint PRIMARY KEY);
    INSERT INTO mlm.wallet VALUES(1,4242,1,123.45),(2,4242,1,123.45);
    CREATE FUNCTION mlm.synthetic_read_delay(value bigint) RETURNS boolean LANGUAGE plpgsql AS $$BEGIN IF value=2 THEN PERFORM pg_sleep(2); END IF; RETURN true; END$$;
    ALTER TABLE mlm.wallet ENABLE ROW LEVEL SECURITY;
    CREATE POLICY synthetic_reader ON mlm.wallet FOR SELECT USING(mlm.synthetic_read_delay(id));
    CREATE ROLE engine_reader LOGIN PASSWORD '${dbPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT CONNECT ON DATABASE transport_synthetic TO engine_reader; GRANT USAGE ON SCHEMA mlm,payments TO engine_reader;
    GRANT SELECT ON mlm.wallet,mlm.wallet_movement,payments.stripe_sale TO engine_reader;
    ALTER ROLE engine_reader SET default_transaction_read_only=on;
    ALTER ROLE engine_reader SET statement_timeout='5s';`);
  const before = snapshot(); assert.equal(before.writable, false);
  const port = JSON.parse(docker(['inspect', dbName]))[0].NetworkSettings.Ports['5432/tcp'][0].HostPort;
  const dsn = `postgresql://engine_reader:${dbPassword}@host.docker.internal:${port}/transport_synthetic?sslmode=verify-full`;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), alg: 'RS256', use: 'sig', kid: 'synthetic-core' };
  const encode = input => Buffer.from(JSON.stringify(input)).toString('base64url');
  const now = Math.floor(Date.now() / 1000), unsigned = `${encode({ alg: 'RS256', typ: 'JWT', kid: jwk.kid })}.${encode({ iss: 'https://auth.synthetic.invalid', aud: 'synthetic-core', sub: 'transport-fixture', email: 'transport-fixture@example.invalid', email_verified: true, authVerified: true, iat: now, exp: now + 240 })}`;
  const token = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
  const vars = { CORE_ENV: 'production', CORE_SERVICES_ENABLED: 'true', CORE_NETWORK_VERIFIED: 'true', CORE_DATA_ACCESS_VERIFIED: 'true', AUTH_CUTOVER_VERIFIED: 'false',
    API_DATABASE_URL: dsn, API_AUTH_DATABASE_URL: dsn.replace('engine_reader:', 'auth_fixture:'), API_AUTH_SECRET: 'a'.repeat(48), API_BFF_SHARED_SECRET: 'b'.repeat(48),
    API_AUTH_URL: 'https://auth.synthetic.invalid', API_AUTH_ORIGINS: 'https://auth.synthetic.invalid', API_ENGINE_GRPC_URL: 'https://engine.original.invalid:50051',
    API_ENGINE_TLS_CA_PEM: read('ca.crt'), API_ENGINE_TLS_CERT_PEM: read('client.crt'), API_ENGINE_TLS_KEY_PEM: read('client.key'),
    ENGINE_DATABASE_URL: dsn, ENGINE_ROOT_AFFILIATE_ID: '4242', ENGINE_TLS_CERT_PEM: read('engine.crt'), ENGINE_TLS_KEY_PEM: read('engine.key'), ENGINE_TLS_CLIENT_CA_PEM: read('ca.crt'),
    PAYMENTS_DATABASE_URL: dsn, PAYMENTS_SERVICE_TOKEN: 'synthetic-only', PAYMENTS_STRIPE_SECRET_KEY: 'synthetic-never-used', PAYMENTS_STRIPE_WEBHOOK_SECRET: 'synthetic-never-used', PAYMENTS_ROOT_AFFILIATE_ID: '4242',
    AUTH_JWT_ISSUER: 'https://auth.synthetic.invalid', AUTH_JWT_AUDIENCE: 'synthetic-core', SYNTHETIC_DATABASE_CA: read('ca.crt'),
    SYNTHETIC_NEGATIVE_PEMS: JSON.stringify({ alienCert: read('alien.crt'), alienKey: read('alien.key') }), SYNTHETIC_JWKS: JSON.stringify({ keys: [jwk] }), SYNTHETIC_JWT: token };
  const config = { name: 'mindbliss-real-core-synthetic-local-only', main: path.join(here, 'core-real-worker.mjs'), compatibility_date: '2026-10-25', compatibility_flags: ['nodejs_compat'], workers_dev: false, preview_urls: false,
    containers: [ ['FixtureApi', 'Dockerfile.real-client-ref'], ['FixtureEngine', 'Dockerfile.real-engine'], ['FixtureProbe', 'Dockerfile.real-client-ref'] ].map(([class_name, image]) => ({ class_name, image: path.join(here, image), image_build_context: root, max_instances: 1, instance_type: 'basic' })),
    durable_objects: { bindings: [['API_CONTAINER', 'FixtureApi'], ['ENGINE_CONTAINER', 'FixtureEngine'], ['PAYMENTS_CONTAINER', 'FixtureProbe']].map(([name, class_name]) => ({ name, class_name })) },
    migrations: [{ tag: 'synthetic-core-local-only-v1', new_sqlite_classes: ['FixtureApi', 'FixtureEngine', 'FixtureProbe'] }], dev: { ip: '127.0.0.1', port: 8798 } };
  const configFile = path.join(runtime, 'core-local.wrangler.json'); writeFileSync(configFile, JSON.stringify(config));
  worker = await unstable_dev(config.main, { config: configFile, local: true, envFiles: [], port: 8798, persist: false, vars, logLevel: 'error', experimental: { forceLocal: true, enableContainers: true, disableExperimentalWarning: true, disableDevRegistry: true, watch: false } });
  assert.equal((await worker.fetch('https://attacker.example/health')).status, 404);
  assert.equal((await worker.fetch('http://local.synthetic/public-tunnel-rejection')).status, 404);
  const response = await worker.fetch('http://local.synthetic/run', { signal: AbortSignal.timeout(120_000) });
  const body = await response.json();
  writeFileSync(path.join(runtime, 'core-last-result.json'), JSON.stringify({ synthetic: true, localOnly: true, status: response.status, financialCorrectnessCertified: false, result: body }, null, 2));
  if (!response.ok) console.log(JSON.stringify({ synthetic: true, failure: body }));
  assert.equal(response.status, 200); assert.equal(body.api.realGoEngine, true); assert.equal(body.jwks.realGoVerifier, true);
  await new Promise(resolve => setTimeout(resolve, 250));
  const after = snapshot(); assert.deepEqual(after, before);
  docker(['pause', dbName]);
  const down = await worker.fetch('http://local.synthetic/new-channel', { signal: AbortSignal.timeout(10_000) });
  assert.equal((await down.json()).rejected, true); docker(['unpause', dbName]);
  assert.deepEqual(snapshot(), before);
  const report = { synthetic: true, localOnly: true, actualCoreAndGo: true, publicRoutesRejected: true, databaseUnchanged: true, readinessDependencyFailureRejected: true, financialCorrectnessCertified: false, before, after: snapshot(), result: body };
  writeFileSync(path.join(runtime, 'core-last-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await worker?.stop();
  const names = docker(['ps', '-a', '--filter', 'name=workerd-mindbliss-real-core-synthetic-local-only-', '--format', '{{.Names}}']).split('\n').filter(Boolean);
  for (const name of names) {
    if (!/^workerd-mindbliss-real-core-synthetic-local-only-Fixture(?:Engine|Api|Probe)-[a-f0-9]{64}(?:-proxy)?$/.test(name)) throw new Error('Unsafe synthetic cleanup target');
    docker(['rm', '-f', name]);
  }
  if (dbStarted) { try { docker(['unpause', dbName]); } catch {} docker(['rm', '-f', dbName]); }
  await syntheticDocker?.close();
  if (previousDockerHost === undefined) delete process.env.WRANGLER_DOCKER_HOST;
  else process.env.WRANGLER_DOCKER_HOST = previousDockerHost;
}
