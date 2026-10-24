# Alibaba delivery: GitHub Actions + Docker + Terraform

Superseded target (2026-10-24): the user selected DigitalOcean App Platform and
local testing first. See [the active preparation guide](../digitalocean/README.md).
This optional Alibaba proposal remains inactive; no cloud apply was performed.

Status (2026-10-24): local implementation and synthetic verification. No cloud
resources, remote plan, database migration, image publication or production
deployment have been performed. AWS/BMP/Cognito integrations still exist.

## What is implemented

- `postgres-rds.yml`: PR/reusable gates for vanilla PostgreSQL 17, Go integration
  tests, API typecheck/TLS tests, dependency audits and mocked Terraform tests.
- The former `alibaba-images.yml` publisher has been replaced by
  `container-images.yml`, targeting DigitalOcean DOCR only. This inactive
  Alibaba proposal has no image publisher. See the active DigitalOcean guide.
- `alibaba-terraform-plan.yml`: protected, manual OIDC infrastructure PLAN only.
  It never runs apply/destroy, migrates a DB, or uploads state/plan artifacts.
- Terraform provisions a NEW isolated VPC, two app subnets, two DB subnets,
  encrypted RDS PG17 HA across two zones, TLS, deletion protection and data/log
  backups. It does NOT yet provision ECS, ALB/WAF, Redis, NAT, IAM bootstrap,
  monitoring or application accounts. Those are separate reviewed stages.
- `compose.rds.yml`: external RDS overlay for SINGLE-HOST staging validation,
  with local Postgres disabled and CA mounts. Not the final multi-host topology.

Do not call this an active CI/CD system before the branches are reviewed/pushed,
GitHub settings are configured, gates run remotely and staging is accepted.

## PostgreSQL without Timescale

The recovered historical database has no Timescale extension. Do not modify or
mount `mindbliss-local-recovery-20261022`. The older QA database DOES use Timescale:
do not reuse its storage with the new image. Changing an image is not conversion.

For a NEW vanilla PG17 destination, restore a verified portable backup, recreate
reviewed owners/grants/RLS and apply `_meta/migration/05_postgresql.sql` explicitly
as the schema owner. This script preserves source tables, rows, keys, triggers
and tree positions. It aborts on Timescale databases and does not activate jobs,
partition existing tables, delete audit history or run financial calculations.

Reporting replaces `time_bucket` with explicit UTC `date_trunc`; three native
materialized views start WITH NO DATA to avoid an unexpected historical scan.
They are not a source of financial truth. No application reader currently relies
on these views. Before adopting them, run `05_postgresql_refresh.sql` with a direct
connection as the owner/app_admin. It handles first population and later
concurrent refresh, with a session advisory lock to avoid overlapping refreshes.
Set cadence after measuring full-refresh cost; no incremental refresh is claimed.
Do not use transaction pooling for this maintenance script.

`69_tree_pv_truth_safe_path.sql` fixes a reconciliation-view error found in the
plain PG17 tests: guard `subpath` inside CASE because join evaluation order is
not guaranteed. Apply after the affiliate closure schema exists. It does not
move affiliates or recalculate balances. Review drift separately from repairs.

DO NOT run historical `05_partitioning_rds.sql` on a populated database: it is an
empty-database-only DROP/CREATE bootstrap, not our Alibaba migration path.
Do not DROP EXTENSION timescaledb CASCADE or edit a dump with text replacements.
If the actual migration source has hypertables, first prepare a separate,
explicit row-export/schema-conversion plan and reconcile counts/amounts before
cutover. The legacy Timescale-aware backup reader remains for old backups.

Compatibility gates include ltree SQL version 1.2, matching the currently
documented RDS PG17 extension version. Recheck the actual instance, restore
roles/functions, sequences, enums, triggers, tree closure, ban placeholders,
Stripe reconciliation, ledger balances and webhook idempotency in staging.
Vanilla PG tests are not a certification of Alibaba's restricted admin role.

## GitHub and infrastructure bootstrap

1. Review the backend branch and the client TLS branch. Keep main protected;
   require `postgres-rds` checks. Do not execute untrusted PR code on a runner
   with cloud permissions or give PR workflows `id-token: write`.
2. Bootstrap Alibaba manually with MFA and individual RAM users. Create a GitHub
   OIDC provider: issuer `https://token.actions.githubusercontent.com`, audience
   `sts.aliyuncs.com`. Use the official Alibaba credentials action pinned by SHA.
3. Create separate PLAN roles per environment. Trust the EXACT subject
   `repo:OWNER/REPOSITORY:environment:staging` or `...:environment:production`.
   Do not trust `repo:OWNER/REPOSITORY:*`. Allow only necessary read/discovery
   APIs plus narrowly scoped state/locking access, not resource creation.
4. Create private, encrypted, versioned OSS state storage and a TableStore lock
   table with a String primary key `LockID`. Separate state prefixes/credentials
   per environment. Back up state independently; never commit it or credentials.
5. Configure protected GitHub environments `staging`, `production` and
   `alibaba-images`, reviewers and main-only deployment rules. These controls
   are GitHub settings, not automatically created by workflow YAML.
6. Set repository variable `DEPLOYMENT_PROVIDER=alibaba` only when switching
   delivery. This disables backend AWS ECR/SSM jobs and the client's old AWS
   deploy job. Other repositories, including admin, still need their legacy
   deploy workflows audited/disabled before migration.
7. In each protected environment configure variables `ALIBABA_PLAN_ROLE_ARN`,
   `ALIBABA_OIDC_PROVIDER_ARN`, `TF_VARIABLES_JSON` and `TF_BACKEND_JSON`.
   These contain IDs/settings only, not database passwords or AccessKeys.
   JSON variables must match the target environment. See Terraform examples;
   confirm both zones, exact instance class, price and an authorized KMS key.
8. Run `alibaba-terraform-plan` from main. Review the diff and estimated costs.
   Applying infrastructure is a SEPARATE reviewed operation from a controlled
   operator using the same commit and protected, locked remote state. It is
   intentionally not automated in this initial delivery.

The Terraform lock file pins the provider. Offline/mocked verification:

```sh
cd deploy/alibaba/terraform
terraform init -backend=false -input=false -lockfile=readonly
terraform fmt -check
terraform validate
terraform test
```

Backend image publishing does not build the other repositories. The existing
`deploy/portable/release.mjs` coordinates eight images across backend/client/admin
for a complete release. Preserve a manifest of all THREE source SHAs and verified
digests, using a read-only scoped GitHub App if CI needs cross-repository access.
Never use a broad personal token or silently combine different front/back releases.
Image vulnerability scanning, signing and a reviewed ECS rollout workflow remain
additional release gates before enabling automatic deployment.

## External RDS staging configuration

Use `manage.mjs init` as documented in `deploy/portable/README.md`. In project.env
add `RDS_HOSTNAME` with the exact private endpoint (not a custom alias/IP), and
`RDS_DATABASE=mindbliss_staging`. Store the downloaded/verified RDS CA as
`RUNTIME_DIR/db-ca/server-ca.pem`; rotate before expiration. No keys go in images.

Set each service's DATABASE_URL (client: MEMBER_DATABASE_URL) to its OWN role,
same endpoint/environment DB, `sslmode=verify-full`. For Go and backup also set
`sslrootcert=/run/db-ca/server-ca.pem` in the URL. The API uses DATABASE_CA_FILE;
the client's TLS branch adds MEMBER_DB_SSL=verify-full and MEMBER_DB_CA_FILE.
These are mounted by the RDS overlay. Without the client TLS change, its legacy
`ssl=require` encrypts traffic but does NOT verify server identity.

Budget the sum of pools across replicas. API defaults to 10 connections and
accepts DATABASE_POOL_MAX=1..50; member read pool is 4. Start on direct 5432.
Adopt RDS PgBouncer only after testing prepared statements/session settings;
set PGBOUNCER=true in the API and MEMBER_DB_PGBOUNCER=true in the client when
appropriate. Keep migrations, dumps and reporting refresh on direct connections.

Preflight (prints errors, not DSNs/secrets):

```sh
node deploy/portable/manage.mjs check --environment staging \
  --env-file /PRIVATE/staging/project.env --database rds
```

The overlay requires Docker Compose supporting `!override`/`!reset` (2.24.4+).
It is for staging validation only. For three ECS nodes, split the application
and motor services and configure private DNS, per-node CA identities, readiness,
ALB routing and authenticated internal APIs before deployment. Never launch the
whole stack on both app nodes: the engine still has a daily financial scheduler.

## Production acceptance and recovery

- First verify the latest authoritative data source and cutover boundary. A
  recovered historical copy does not contain transactions created after it.
- Test a NEW RDS restore without enabling payouts, reconciliation, SMTP or
  real Stripe mutations. Compare counts, amounts, IDs, tree edges and bans.
- Finish the Better Auth/Cognito/BMP identity plan before removing AWS access.
- Test 1,100-user traffic patterns, DB pool saturation, Redis failure, RDS
  failover/reconnection and webhook retries; do not infer capacity from vCPUs.
- Configure CloudMonitor/SLS alerts and external synthetic checks. Alert on
  failed/old backups, queue age, error rate, latency, disk, connections and costs.
- Test native RDS PITR and independent encrypted pg_dump restores. Cross-region
  RDS backups are a separate option with instance-type eligibility to confirm.
- Deploy approved digests one app node at a time; migration execution stays
  separate. Rollback images only when schemas remain backward-compatible.
  Never restore an old backup over newer financial transactions as a rollback.

References: [RDS extensions](https://www.alibabacloud.com/help/en/rds/apsaradb-rds-for-postgresql/extensions-supported-by-apsaradb-rds-for-postgresql),
[OSS state locking](https://developer.hashicorp.com/terraform/language/backend/oss),
[official OIDC action](https://github.com/aliyun/configure-aliyun-credentials-action),
[PostgreSQL materialized views](https://www.postgresql.org/docs/17/rules-materializedviews.html).
