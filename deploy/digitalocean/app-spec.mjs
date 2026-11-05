import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const general = (key, value) => ({ key, value, scope: 'RUN_TIME', type: 'GENERAL' });
const secret = key => ({ key, value: `REPLACE_${key}`, scope: 'RUN_TIME', type: 'SECRET' });

// Structural templates only. Secrets, real image digests and DBs are supplied later.
export function appSpec(environment, images, options = {}) {
  if (!['staging', 'production'].includes(environment)) throw new Error('Use staging or production');
  const hosts = options.hosts ?? Object.fromEntries(['client', 'admin', 'api'].map(name => [name, `${name}.${environment}.example.invalid`]));
  if (new Set(Object.values(hosts)).size !== 3 || ['client', 'admin', 'api'].some(name => !/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(hosts[name] ?? ''))) throw new Error('Use three distinct DNS hostnames without scheme, port or path');
  const services = ['api', 'engine', 'payments', 'withdrawals', 'client', 'admin'].map(name => {
    const image = images?.[name] ?? { repository: `mindbliss-${name}`, digest: `sha256:${'0'.repeat(64)}` };
    if (!/^[a-z0-9][a-z0-9/_-]*$/.test(image.repository) || !/^sha256:[a-f0-9]{64}$/.test(image.digest)) throw new Error('Use a repository and immutable SHA256 digest');
    return {
      name, image: { registry_type: 'DOCR', ...image },
      // Scale only after shared OTP limits and concurrent financial jobs are verified.
      instance_count: 1,
      instance_size_slug: 'apps-s-1vcpu-1gb',
      health_check: { http_path: ['client', 'admin'].includes(name) ? '/login' : '/health', port: { api: 3000, engine: 9090, payments: 9095, withdrawals: 9097, client: 3000, admin: 3000 }[name], initial_delay_seconds: 15, period_seconds: 10, timeout_seconds: 5, failure_threshold: 6 },
      termination: { drain_seconds: 15, grace_period_seconds: 60 },
      envs: [general('ENV', environment), general('AWS_EC2_METADATA_DISABLED', 'true'),
        ...(['client', 'admin'].includes(name) ? [] : [secret('DATABASE_URL'), secret('DATABASE_CA_PEM')])],
    };
  });
  const [api, engine, payments, withdrawals] = services;
  api.http_port = 3000;
  api.envs.push(general('NODE_ENV', 'production'), general('PORT', '3000'), general('API_LISTEN_HOST', '0.0.0.0'),
    general('DATABASE_POOL_MAX', '10'), general('PGBOUNCER', 'false'),
    general('BETTER_AUTH_URL', `https://${hosts.api}`), general('BETTER_AUTH_TRUSTED_ORIGINS', `https://${hosts.client},https://${hosts.admin},https://${hosts.api}`), secret('BETTER_AUTH_SECRET'),
    general('VP_ENGINE_GRPC_URL', 'https://engine:50051'), general('VP_ENGINE_HTTP_URL', 'http://engine:9090'),
    general('ENGINE_MTLS_REQUIRED', 'true'), secret('VP_ENGINE_TLS_CA_PEM'), secret('VP_ENGINE_TLS_CERT_PEM'), secret('VP_ENGINE_TLS_KEY_PEM'));
  engine.internal_ports = [9090, 50051];
  engine.envs.push(general('HTTP_LISTEN_ADDR', '0.0.0.0:9090'), general('GRPC_LISTEN_ADDR', '0.0.0.0:50051'),
    general('DB_MAX_CONNS', '10'),
    general('NATS_URL', ''), general('BONUS_ENGINE_SCHEDULER_ENABLED', 'false'), general('BONUS_ENGINE_BINARY_CYCLE_ENABLED', 'false'),
    general('GRPC_TLS_REQUIRE_CLIENT_CERT', 'true'), secret('GRPC_TLS_CERT_PEM'), secret('GRPC_TLS_KEY_PEM'), secret('GRPC_TLS_CLIENT_CA_PEM'), secret('BONUS_ENGINE_COMPANY_ROOT_AFFILIATE_ID'));
  payments.http_port = 9095;
  payments.envs.push(general('PAYMENTS_HTTP_ADDR', '0.0.0.0:9095'), general('VP_ENGINE_URL', 'http://engine:9090'),
    general('REQUIRE_VERIFIED_IDENTITY', 'true'), general('PAYMENTS_RECONCILE_INTERVAL_MIN', '0'),
    general('PAYMENTS_CART_REMINDER_ENABLED', 'false'), general('COMMS_ENABLED', 'false'),
    ...['PAYMENTS_SERVICE_TOKEN', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'COGNITO_ISSUER', 'COGNITO_CLIENT_ID',
      'PAYMENTS_ADMIN_EMAILS', 'PAYMENTS_SUPER_ADMIN_EMAILS', 'PAYMENTS_COMPANY_ROOT_AFFILIATE_ID'].map(secret));
  withdrawals.internal_ports = [9097];
  withdrawals.envs.push(general('WITHDRAWALS_HTTP_ADDR', '0.0.0.0:9097'), general('WITHDRAWALS_REQUIRE_BMP', 'true'),
    general('WITHDRAWALS_REQUIRE_VERIFIED_IDENTITY', 'true'),
    ...['SERVICE_TOKEN', 'COGNITO_ISSUER', 'COGNITO_CLIENT_ID', 'ADMIN_EMAILS', 'SUPER_ADMIN_EMAILS', 'BMP_BASE_URL', 'BMP_CLIENT_ID', 'BMP_CLIENT_SECRET'].map(secret));
  for (const name of ['client', 'admin']) {
    const service = services.find(s => s.name === name);
    service.http_port = 3000;
    service.envs.push(general('NODE_ENV', 'production'), general('HOSTNAME', '0.0.0.0'), general('PORT', '3000'),
      general('DEMO_LOGIN_ENABLED', '0'), general('VP_FORWARD_ID_TOKEN', '1'),
      general('VP_PAYMENTS_URL', 'http://payments:9095'), general('VP_WITHDRAWALS_URL', 'http://withdrawals:9097'),
      general('VP_ENGINE_HTTP_URL', 'http://engine:9090'), secret('PAYMENTS_SERVICE_TOKEN'),
      ...['COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID', 'COGNITO_CLIENT_SECRET', 'COGNITO_DOMAIN'].map(secret));
    if (name === 'client') service.envs.push(secret('MEMBER_DATABASE_URL'), general('MEMBER_DB_SSL', 'verify-full'),
      secret('MEMBER_DB_CA_PEM'), general('MEMBER_DB_PGBOUNCER', 'false'));
  }
  return { name: `mindbliss-${environment}`, region: 'nyc', services,
    ...(options.vpcId ? { vpc: { id: options.vpcId } } : {}),
    domains: Object.values(hosts).map((domain, index) => ({ domain, type: index === 0 ? 'PRIMARY' : 'ALIAS' })),
    ingress: { rules: [
      { match: { authority: { exact: hosts.api }, path: { exact: '/api/webhooks/stripe' } }, component: { name: 'payments', preserve_path_prefix: true } },
      ...['client', 'admin', 'api'].map(name => ({ match: { authority: { exact: hosts[name] }, path: { prefix: '/' } }, component: { name, preserve_path_prefix: true } })),
    ] }, alerts: [{ rule: 'DEPLOYMENT_FAILED' }, { rule: 'DOMAIN_FAILED' }] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { config: { type: 'string' }, release: { type: 'string' } } });
  const release = values.release ? JSON.parse(readFileSync(values.release, 'utf8')) : undefined;
  const options = values.config ? JSON.parse(readFileSync(values.config, 'utf8')) : {};
  const images = release && Object.fromEntries(Object.entries(release.images).map(([name, item]) => [name, { registry: release.registry, repository: item.repository, digest: item.digest }]));
  console.log(JSON.stringify(appSpec(positionals[0], images, options), null, 2));
}
