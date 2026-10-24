# Local Docker QA

This is a disposable rehearsal, NOT a production deployment. Run from the backend
repository with the sibling repositories `mindblisspowerfront` and
`mindblisspower-admin` checked out on the matching QA branch.

## Isolation

- Project name: `mindbliss-qa`. No external volumes, historical databases, AWS
  credentials, host environment files or production secrets are mounted.
- PostgreSQL uses tmpfs: stopping/recreating it discards all QA data. Redis is
  disposable and separate from any existing Redis on the host.
- Application services use an internal Docker network with no Internet route.
  A credential-free gateway bridges only predefined HTTP services to loopback
  ports (Docker cannot publish directly from internal networks).
  Stripe keys and service tokens are synthetic.
- Login is fail-closed without Cognito; the demo login is disabled. These previews
  validate login rendering, assets and authorization, not real OTP delivery.
- Go tests need the Docker socket to create/clean up their own Postgres
  containers. This grants host Docker privileges: run only trusted repository
  code. These tests have network access for testcontainers; they do NOT receive
  the host's environment or credentials. The historical recovery container is
  never passed to the tests.
- The QA services intentionally use the legacy service-token identity mode on
  synthetic data. This configuration MUST NOT be promoted to production.
  Production requires verified Cognito identity, TLS and managed secrets.

## Commands

```powershell
docker compose -f deploy/docker-qa/compose.yml --profile test build
docker compose -f deploy/docker-qa/compose.yml up -d --wait
docker compose -f deploy/docker-qa/compose.yml run --rm client-tests
docker compose -f deploy/docker-qa/compose.yml run --rm admin-tests
docker compose -f deploy/docker-qa/compose.yml run --rm bun-tests
docker compose -f deploy/docker-qa/compose.yml run --rm go-tests
docker compose -f deploy/docker-qa/compose.yml run --rm cache-tests
node deploy/docker-qa/smoke.mjs
```

Client: http://127.0.0.1:3300/login. Admin: http://127.0.0.1:3301/login.
API health: ports 3302 (Bun), 3305 (payments), 3307 (withdrawals).

## Member Tree Reads

The customer tree/referral/rank BFF reads PostgreSQL directly, not through Go.
The QA client now uses the dedicated `qa_member_read` role. It only reads the
required mlm tables/views, defaults to read-only transactions and cannot read
auth or write affiliates. Its password is deliberately synthetic, not a secret
for any real environment. Cognito remains unconfigured and fail-closed.

For an already-running QA database created before this role was added, prepare
the role without recreating the database, then replace only the client:

```powershell
node deploy/docker-qa/prepare-member-read.mjs --qa-docker
docker compose -f deploy/docker-qa/compose.yml --profile test build client client-tests
docker compose -f deploy/docker-qa/compose.yml up -d --no-deps --no-build --wait client
node deploy/docker-qa/diagnose-member.mjs --qa-docker
```

The diagnostic runs the actual `memberDb` module from the test image in the
client's network namespace and reports only aggregates and permission flags.
It also verifies that anonymous tree/referral/payment requests return 401.
It does not authenticate a real customer. From the client repository, run
`node scripts/test-member-tree-query.mjs --qa-docker` to test partial/full tree
SQL with transactionally rolled-back synthetic rows and the read-only role.

The Go suite runs with Linux's race detector, with two package workers. Each
integration test applies schema/migrations to a newly created test container.
The preview database bootstrap follows the payments/withdrawals test harnesses;
it is not a full historical database restoration or a production migration plan.

Stop only this project:

```powershell
docker compose -f deploy/docker-qa/compose.yml down
```

Never use a global prune or remove the historical recovery container. Before
production, separately verify real Cognito/OTP, Stripe sandbox webhooks, BMP,
SES, durable backups/restoration, infrastructure, TLS and a realistic load test.
