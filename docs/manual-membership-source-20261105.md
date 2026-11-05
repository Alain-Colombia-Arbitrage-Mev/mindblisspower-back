# Manual membership source — 2026-11-05

## Scope and authorization

The approved manual membership has USD 100 principal, 100 PV, a 3% fee (USD 3),
and a USD 97 commission/treasury base. Its effective date is the approval day,
2026-11-05 in `America/Bogota`; it is not a historical or provider-imported sale.
No beneficiary identifiers, email addresses, auth subjects or credentials belong
in this document or migration. The operator resolves the authorized person,
affiliate and active catalog package separately and records the approval
artifact SHA-256 plus a reason in the immutable manifest. A digest by itself
does not prove authorization or authorize execution.

The source remains `manual`. It is never recorded as a Stripe/NOWPayments
attempt, provider payment, webhook, receipt or auth verification. Existing
positions, sponsors, ranks, historical sales and balances are not rewritten.

## Preparation versus activation

`_meta/migration/91_manual_compensation_sources.sql` is explicit transactional
operator DDL, not an application startup migration. It creates no membership,
CD, financial obligation, wallet movement or manual sale. Applying the schema
does not enable a cron or prove a deployed engine supports the new source.
Future private scheduler/cron execution must use the shared scoped engine and
its existing bounded catch-up, advisory lock, funding, cap and risk checks;
it must be separately deployed and verified before activation. No global
financialguard bypass, external withdrawal or provider purchase is enabled.

The migration aborts if any existing binary state has `claimed_blocks>0`.
Previously consumed PV would require a separately approved lot-level backfill;
it cannot be silently repriced under the weighted rule. Existing NOW source
UUIDs, obligations, payments and monetary amounts are preserved. Their
historical table/column names remain for compatibility; typed canonical source
records determine the actual provider, not the `now:` internal reference prefix.
New manual/mixed accounting may use `comp:`; old references are never rewritten.
Every new positive `claimed_blocks` value also requires a non-null, lower-case
SHA-256 prefix hash; the engine must update the count and hash atomically.

Do not insert a manual manifest while an old engine/reader is deployed. The
safe release order is reviewed DDL, explicit minimum runtime ACLs, both source-
aware engine and member reader deployment, private readiness verification, then
the separately authorized operator activation transaction. Runtime permission
errors must stop checkout/accrual; never repair them with global grants.

## Schema contract

`payments.manual_membership_order` has these required facts:

- `id` UUID; `operation_key` unique, non-PII `manual-membership:` key;
  `source_kind='manual'`.
- `person_id`, `affiliate_id`, `package_id`, `affiliate_package_id`,
  `investment_cd_id`, `plan_config_id`, `roi_tier_id` explicit foreign keys.
- `gross_usd=100`, `fee_rate=.03`, `fee_usd=3`, `net_usd=97`, `pv=100`.
- `cd_lock_days=365`, `lifetime_cap_factor=2`, exact `plan_snapshot`, approved
  ROI rate snapshots from the active plan/tier.
- `effective_at`, `approved_at`, server-owned `created_at` timestamps;
  `actor_reason` and lower-case64hex `authorization_digest`.
- Initial `state='activated'`; subsequent changes may only retain immutable
  facts and move once to `risk_review` or `security_blocked`. No reactivation,
  deletion or truncation is allowed by normal DML.

Insertion locks/checks identity, active catalog, effective plan, ROI tier, linked
manual package, untouched cap and linked CD. Approval and activation must be on
the transaction's current Bogota day, approval no later than activation, and
activation no later than server `now()`. Use the same `now()` captured once in
the short activation transaction for package activation, CD start and manifest.
The package uses `payment_method='manual'` and
`transaction_hash='manual:production:'||manual_order_id`. No auth identity or
email-verification field is touched. The person/affiliate association is checked
under `FOR KEY SHARE`, independent of the separately existing foreign keys.

`payments.compensation_source(id,source_kind,nowpayments_attempt_id,manual_order_id)`
has exactly one typed foreign key, and its UUID equals that source UUID. An
AFTER INSERT invoker trigger classifies both source types. Classification alone
does not assert provider payment evidence or engine eligibility.

`payments.v_compensation_source` is a security-invoker, security-barrier view:

```text
source_id, source_kind, affiliate_id, affiliate_package_id, investment_cd_id,
pv, gross_usd, net_usd, roi_base_annual_rate, roi_qualified_annual_rate,
activated_at, start_at, matures_at, cd_status, plan_snapshot, active,
package_status, cap_closed_at, package_expired_at, cd_closed_at, roi_tier_id,
state, person_id
```

The NOW branch retains its existing production attempt, price, inflow, PV,
receipt/capture, unique payment and CD checks. The manual branch requires its
own approved manifest and matching package/CD/cap facts. An activated source
missing from this view is an error, not permission to ignore it. The engine
must compare the activated NOW + manual count to loaded source count and freeze
on either source's risk hold. Source sharing/locking stays explicit on the
underlying manifests; a UNION view is not a row-lock substitute.

Obligation lineage is deliberately separate from ownership. The historical
`source_attempt_id` still points to the beneficiary's own membership for cap,
ROI and package ownership checks. New `earning_source_id` identifies the actual
causal sale for direct/referral and royalty obligations; it is required and its
net/gross factor must match the validated sale. Binary obligations have no
single earning source and use the immutable allocation rows instead. ROI has
its own membership as origin (the explicit field may remain NULL).

`payments.v_compensation_obligation_origin(obligation_id,source_provider)` reports
`manual`, `nowpayments`, `mixed` or `unattributed` from those actual identities.
It must not label commissions using the beneficiary's payment method. A later
risk hold does not rewrite lineage. Existing direct/royalty obligations without
approved origin backfills cause the migration to abort; no historical origins
are guessed or silently reattributed. The extra view is security-invoker and
requires SELECT on obligations (including `earning_source_id`), canonical
sources and binary allocations; it grants no privileges itself.

## ROI, maturity and weighted binary evidence

ROI uses USD 100 principal, not USD 97. Principal and ROI retain the existing
365-day maturity lock; commission availability retains one calendar month in
Bogota from each obligation's creation. Both use existing exact timestamps and
cap/ledger rules, not an invented immediate withdrawable balance.

Binary block factors follow the actual source PV consumed. NOW lots use .99;
manual lots use .97. Each completed block consumes 500 PV on each leg; for
example, 500 NOW PV and 500 manual PV produce a weighted factor .98 and USD 9.80
for a USD 10 gross block. This rule is authorized; a beneficiary's own membership
fee must not reprice unrelated sources. Precision is retained per lot and final
monetary rounding follows the scoped engine's cumulative-cent rules.

`payments.compensation_binary_allocation` stores:

```text
affiliate_id bigint, block_no bigint, leg L|R, source_id uuid,
pv numeric(20,8), commission_factor numeric(8,6), obligation_id bigint,
created_at timestamptz
PRIMARY KEY(affiliate_id,block_no,leg,source_id)
```

Each source factor is checked against the validated view; the obligation must
be `binary_bonus` for the same ancestor and match its own canonical membership
and package. Deferred constraints require exactly
500 PV per leg and one obligation per block at commit, reject binary obligations
without allocations, and require the obligation's six-decimal audit factor to
match `round(sum(pv*factor)/sum(pv),6)`. Entitlement is exactly
`trunc(unit_gross_usd*sum(pv*factor)/1000,2)`, with a USD 10 regular or USD 50
founder gross unit. A batch may contain several complete blocks; no per-lot
rounding is used. Allocations are append-only. Application tests must additionally prove deterministic FIFO source
selection, tree/leg/depth eligibility, no per-ancestor source PV overconsumption,
one-way claimed-prefix hashes, correct weighted aggregate entitlement and
idempotent retries. Database allocation rows do not replace those checks.

## Operator transaction contract (not an executable beneficiary script)

1. Verify authorization artifact and expected current identities without
   changing auth users, email verification, tree placement or ranks.
2. Begin a short SERIALIZABLE transaction; acquire the existing scoped-engine
   advisory lock; select one server `now()` and one new source UUID.
3. Check `operation_key` first. If it already exists, compare all immutable
   authorized facts and linked records and return that operation; never UPDATE
   it or silently accept a different payload under the same key.
4. Lock/check the live person/affiliate/catalog/plan/tier. Create one active
   manual affiliate package and its ordinary cap, one USD 100 CD starting at the
   captured timestamp with 365-day maturity, then insert the manifest below.
   The canonical source is inserted by its invoker trigger in that transaction.
5. Confirm exactly one valid canonical view row for the new source and commit.
   Do not insert a provider receipt, global PV event or wallet earnings to
   simulate activation. Subsequent accrual uses only the shared scoped engine.

Parameterized manifest insert columns, after the linked package/CD exist:

```sql
INSERT INTO payments.manual_membership_order(
  id,operation_key,person_id,affiliate_id,package_id,affiliate_package_id,
  investment_cd_id,plan_config_id,roi_tier_id,cd_lock_days,lifetime_cap_factor,
  plan_snapshot,roi_base_annual_rate,roi_qualified_annual_rate,
  gross_usd,fee_rate,fee_usd,net_usd,pv,effective_at,approved_at,
  actor_reason,authorization_digest
) VALUES(
  $1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,365,2,$10::jsonb,$11,$12,
  100,.03,3,97,100,$13::timestamptz,$14::timestamptz,$15,$16
) RETURNING id;
```

No operation parameters, approval digest or financial credentials should be
placed in public logs. The initial state and server timestamp use table defaults.
SQL arithmetic rejects mismatches rather than adjusting money or PV silently.

## Permissions and verification

New objects strip PUBLIC and object-specific inherited default ACLs; the
migration changes no global default privileges and grants no runtime access.
The source manifest is operator-owned; runtime engine/reader receives SELECT
only after explicit review. The NOW checkout writer needs narrowly reviewed
SELECT/INSERT on the canonical registry because its invoker classifier runs
inside normal order creation. Engine allocation evidence needs SELECT/INSERT
only; never UPDATE/DELETE/TRUNCATE. The source-aware view is invoker, so all
required underlying SELECT permissions must be reviewed as well. No function
is SECURITY DEFINER. Owner/superuser DDL can still disable/drop protections and
must remain unavailable to application logins.

Synthetic PostgreSQL verification must cover successful 100/3/97/PV100 binding;
wrong identity/catalog/plan/tier/cap/CD/provider/maturity; prior-day/future
approval; duplicate operation key; immutable financial fields; one-way holds;
DELETE/TRUNCATE rejection; defaultACL stripping and runtime role denials;
NOW backfill/insert classification; strict source XOR; old UUID/FK preservation;
invalid NOW evidence rejection; weighted allocations .99/.97, both complete
legs, duplicate blocks, mixed obligations and mutation denial; and migration
abort when historical claimed binary blocks exist. Run fixtures only against a
disposable database. DDL preparation is not production test evidence.

The explicit local rehearsal is:

```powershell
node app/scripts/test-manual-compensation-sources-postgres.mjs --synthetic-docker
```

It requires the already-present pinned PostgreSQL 17.11 image, refuses other
arguments, uses a randomly named disposable container with `--network none`,
publishes no ports, accepts no DSN and reads no project environment file. It
loads the actual payment test schema files plus migrations 70/74/75/77/79/80/82
and 91. Its cleanup removes only the uniquely named container it created.
Separate Go integration tests must verify actual shared-engine/ledger behavior;
passing this schema rehearsal alone does not authorize production activation.
