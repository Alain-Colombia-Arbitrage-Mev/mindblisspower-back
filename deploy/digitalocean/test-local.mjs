import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.argv.includes('--synthetic-docker') || process.argv.some(a => a.startsWith('--') && !['--synthetic-docker', '--keep'].includes(a))) {
  throw new Error('Use --synthetic-docker [--keep]; external databases and credentials are never accepted');
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const id = randomBytes(6).toString('hex');
const prefix = `mindbliss-app-platform-${id}`;
const artifact = path.join(root, 'deploy/digitalocean/artifacts', prefix);
const containers = [];
const networks = [];
const report = [];
const tool = 'mindbliss/backup:infra-20261023';
const node = 'node:24.16.0-bookworm-slim';
const images = { engine: 'mindbliss/app-platform-engine:test-20261024', api: 'mindbliss/app-platform-api:test-20261024',
  payments: 'mindbliss/app-platform-payments:test-20261024', withdrawals: 'mindbliss/app-platform-withdrawals:test-20261024' };
let success = false;
function docker(args, env = {}, input) {
  const result = spawnSync('docker', args, { input, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Docker ${args[0]} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
function run(name, network, image, env, args = [], options = []) {
  const fullName = `${prefix}-${name}`;
  const flags = Object.keys(env).flatMap(key => ['-e', key]);
  docker(['run', '-d', '--name', fullName, '--network', network, '--network-alias', name.split('-').at(-1),
    ...options, ...flags, image, ...args], env);
  containers.push(fullName);
  return fullName;
}
async function waitFor(name, command) {
  for (let attempt = 0; attempt < 90; attempt++) {
    if (docker(['inspect', '--format', '{{.State.Running}}', name]) !== 'true') break;
    const result = spawnSync('docker', ['exec', name, ...command], { encoding: 'utf8' });
    if (result.status === 0) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  // Synthetic credentials only; never copy this log collection to a real stack.
  throw new Error(`Synthetic readiness failed for ${name}: ${docker(['logs', '--tail', '80', name])}`);
}
try {
  await mkdir(artifact, { recursive: true });
  docker(['run', '--rm', '--network', 'none', '--user', '0', '-v', `${artifact}:/fixtures`,
    '-v', `${path.join(root, 'deploy/portable/certificates.py')}:/tools/certificates.py:ro`, '--entrypoint', 'python3', tool,
    '/tools/certificates.py', '--runtime', '/fixtures/runtime', '--offline-ca', '/fixtures/offline', '--dns', 'postgres']);
  const pem = async file => docker(['run', '--rm', '--network', 'none', '--user', '0', '-v', `${artifact}:/fixtures:ro`, '--entrypoint', 'cat', tool, `/fixtures/runtime/tls/${file}`]);
  const ca = await pem('client/ca.crt');
  const clientCert = await pem('client/client.crt');
  const clientKey = await pem('client/client.key');
  const serverCert = await pem('server/server.crt');
  const serverKey = await pem('server/server.key');
  const healthNetwork = `${prefix}-health`;
  docker(['network', 'create', healthNetwork]); networks.push(healthNetwork);
  for (const environment of ['staging', 'production']) {
    const network = `${prefix}-${environment}`;
    docker(['network', 'create', '--internal', network]); networks.push(network);
    const password = randomBytes(24).toString('hex');
    const serviceToken = randomBytes(32).toString('hex');
    const database = `mindbliss_${environment}`;
    const db = run(`${environment}-postgres`, network, 'mindbliss/rds-postgres-test:20261024', {
      POSTGRES_DB: 'mindbliss_qa', POSTGRES_PASSWORD: password, POSTGRES_TLS_CERT_PEM: serverCert, POSTGRES_TLS_KEY_PEM: serverKey,
    }, ['-ec', 'umask 077; mkdir /tmp/dbtls; printf "%s" "$POSTGRES_TLS_CERT_PEM" > /tmp/dbtls/server.crt; printf "%s" "$POSTGRES_TLS_KEY_PEM" > /tmp/dbtls/server.key; chown -R postgres:postgres /tmp/dbtls; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/dbtls/server.crt -c ssl_key_file=/tmp/dbtls/server.key -c shared_preload_libraries=pg_stat_statements'], ['--entrypoint', 'sh', '--tmpfs', '/var/lib/postgresql/data']);
    await waitFor(db, ['pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'mindbliss_qa']);
    // Keep the QA initializer's non-production guard intact; only rename this new synthetic DB.
    docker(['exec', db, 'psql', '-XqAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', `ALTER DATABASE mindbliss_qa RENAME TO ${database};`]);
    const query = sql => docker(['exec', db, 'psql', '-XqAt', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-c', sql]);
    const fingerprint = "SELECT jsonb_build_array((SELECT count(*) FROM mlm.wallet_movement),(SELECT count(*) FROM mlm.tree_event),(SELECT count(*) FROM mlm.affiliate));";
    const before = query(fingerprint);
    const identity = run(`${environment}-identity`, network, node, {}, ['node', '/tests/mock-identity.mjs'], ['--read-only', '-v', `${path.join(root, 'deploy/digitalocean/mock-identity.mjs')}:/tests/mock-identity.mjs:ro`]);
    await waitFor(identity, ['node', '-e', "fetch('http://127.0.0.1:8081/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]);
    run(`${environment}-redis`, network, 'redis:7-alpine', {}, ['redis-server', '--save', '', '--appendonly', 'no', '--requirepass', password], ['--read-only', '--tmpfs', '/data']);
    const common = { ENV: environment, DATABASE_URL: `postgres://postgres:${password}@postgres:5432/${database}?sslmode=verify-full`, DATABASE_CA_PEM: ca,
      AWS_EC2_METADATA_DISABLED: 'true', COGNITO_ISSUER: 'http://identity:8081', COGNITO_CLIENT_ID: 'synthetic-client' };
    run(`${environment}-engine`, network, images.engine, { ...common, HTTP_LISTEN_ADDR: '0.0.0.0:9090', GRPC_LISTEN_ADDR: '0.0.0.0:50051',
      GRPC_TLS_CERT_PEM: serverCert, GRPC_TLS_KEY_PEM: serverKey, GRPC_TLS_CLIENT_CA_PEM: ca, GRPC_TLS_REQUIRE_CLIENT_CERT: 'true',
      BONUS_ENGINE_SCHEDULER_ENABLED: 'false', BONUS_ENGINE_BINARY_CYCLE_ENABLED: 'false', NATS_URL: '' });
    const api = run(`${environment}-api`, network, images.api, { ...common, NODE_ENV: 'production', PORT: '3000', API_LISTEN_HOST: '0.0.0.0',
      BETTER_AUTH_SECRET: randomBytes(32).toString('hex'), BETTER_AUTH_URL: 'https://synthetic.example.invalid', BETTER_AUTH_TRUSTED_ORIGINS: 'https://synthetic.example.invalid',
      ENGINE_MTLS_REQUIRED: 'true', VP_ENGINE_GRPC_URL: 'https://engine:50051', VP_ENGINE_HTTP_URL: 'http://engine:9090',
      VP_ENGINE_TLS_CA_PEM: ca, VP_ENGINE_TLS_CERT_PEM: clientCert, VP_ENGINE_TLS_KEY_PEM: clientKey,
    });
    run(`${environment}-payments`, network, images.payments, { ...common, PAYMENTS_HTTP_ADDR: '0.0.0.0:9095', PAYMENTS_SERVICE_TOKEN: serviceToken,
      STRIPE_SECRET_KEY: 'sk_test_synthetic_invalid', STRIPE_WEBHOOK_SECRET: 'whsec_synthetic_invalid', REQUIRE_VERIFIED_IDENTITY: 'true',
      PAYMENTS_ADMIN_EMAILS: 'admin@example.invalid', PAYMENTS_SUPER_ADMIN_EMAILS: 'admin@example.invalid',
      REDIS_ADDR: 'redis:6379', REDIS_PASSWORD: password, PAYMENTS_RECONCILE_INTERVAL_MIN: '0', PAYMENTS_CART_REMINDER_ENABLED: 'false', COMMS_ENABLED: 'false',
      VP_ENGINE_URL: 'http://engine:9090',
    });
    run(`${environment}-withdrawals`, network, images.withdrawals, { ...common, WITHDRAWALS_HTTP_ADDR: '0.0.0.0:9097', SERVICE_TOKEN: serviceToken,
      ADMIN_EMAILS: 'admin@example.invalid', SUPER_ADMIN_EMAILS: 'admin@example.invalid', WITHDRAWALS_REQUIRE_BMP: 'true',
      WITHDRAWALS_REQUIRE_VERIFIED_IDENTITY: 'true', BMP_BASE_URL: 'https://bmp-disabled.invalid' });
    await waitFor(api, ['bun', '-e', "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]);
    // Private services are probed from inside the isolated network, not exposed on the host.
    for (let attempt = 0; attempt < 60; attempt++) {
      const result = spawnSync('docker', ['run', '--rm', '--network', network, node, 'node', '-e',
        "(async()=>{for(const u of ['http://engine:9090/health','http://payments:9095/health','http://withdrawals:9097/health']){if(!(await fetch(u)).ok)throw Error('not ready')}})().catch(()=>process.exit(1))"], { encoding: 'utf8' });
      if (result.status === 0) break;
      if (attempt === 59) throw new Error('Private backend services did not become ready');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const probeEnv = { SERVICE_TOKEN: serviceToken, TARGET_ENV: environment, VP_ENGINE_TLS_CA_PEM: ca, VP_ENGINE_TLS_CERT_PEM: clientCert, VP_ENGINE_TLS_KEY_PEM: clientKey };
    const output = docker(['run', '--rm', '--network', network, '--read-only', '-v', `${path.join(root, 'deploy/digitalocean/probe.mjs')}:/tests/probe.mjs:ro`,
      ...Object.keys(probeEnv).flatMap(key => ['-e', key]), node, 'node', '/tests/probe.mjs'], probeEnv);
    assert.equal(query(fingerprint), before, 'health/auth probes must not create financial transactions or move affiliates');
    assert.ok(Number(query('SELECT count(*) FROM pg_stat_ssl WHERE ssl AND pid <> pg_backend_pid();')) >= 4, 'backend DB connections must use TLS');
    const gateway = run(`${environment}-health`, healthNetwork, node, { HEALTH_TARGET: `http://${api}:3000/health` },
      ['node', '/tests/health-gateway.mjs'], ['--user', 'node', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '-v', `${path.join(root, 'deploy/digitalocean/health-gateway.mjs')}:/tests/health-gateway.mjs:ro`, '-p', '127.0.0.1::3000']);
    docker(['network', 'connect', network, gateway]);
    await waitFor(gateway, ['node', '-e', "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]);
    const published = JSON.parse(docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', gateway]));
    const port = published['3000/tcp'][0].HostPort;
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(10000) })).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/admin/finance`, { signal: AbortSignal.timeout(10000) })).status, 404);
    report.push({ ...JSON.parse(output), health: `http://127.0.0.1:${port}/health`, database, financialWrites: false });
    console.log(`PASS ${environment}: ${report.at(-1).passed} probes; ${report.at(-1).health}`);
  }
  await writeFile(path.join(artifact, 'report.json'), JSON.stringify({ synthetic: true, environments: report }, null, 2));
  success = true;
} finally {
  if (!(success && process.argv.includes('--keep'))) {
    for (const name of containers.reverse()) {
      assert.ok(name.startsWith(`${prefix}-`));
      docker(['rm', '-f', '-v', name]);
    }
    for (const name of networks.reverse()) { assert.ok(name.startsWith(`${prefix}-`)); docker(['network', 'rm', name]); }
  } else console.log(`Synthetic stacks kept: ${prefix}. Evidence: ${path.join(artifact, 'report.json')}`);
}
