# NOWPayments isolated operational release

## Approved scope

New, authenticated membership purchases only. The catalogue price is the buyer's
total; an included 1% pricing-policy cost leaves a 99% monetary commission base.
This policy is not a claim about the provider's actual settlement fee. Principal
and catalogue PV remain gross. Stripe initiation and Chatwoot stay disabled.

The owner approved migration 33's baseline: referral 5%, royalty 5%, founder
referral/matched binary 10%/10%, nominal binary USD 10 per 500 PV, CD 365 days,
annual base ROI 25%, qualified ROI 30–50% by tier. Monetary commission awards
apply the 99% factor (regular binary USD 9.90 per block before treasury/caps).
Referral/royalty do not consume the ROI/binary lifetime package cap. Historical
Stripe volume is not fed into this executor; legacy balances remain under review.
This release does not enable external withdrawals or provider payouts.

## Release artifacts

- API: `mindbliss/api-verified-link-20261031@sha256:7e14a9faae32428eda7b932bcea12d5de4f2b2ebe6f949ad8027db59ecf38f97`.
- Payments: `mindbliss/payments-now-live-20261031@sha256:26819997f46a4a8b6a12cd16d35b99e6643c96582887fce98e4fe20ea9ae5777` (includes the READ ONLY readiness regression fix, commit `f711034`). The release alias has identical bytes and forces a fresh process after correcting runtime connection routing to port 5432.
- Registry: `registry.cloudflare.com/ed805ed2b05218b41fc1d4d2440e658e/`.
- Core Engine and Withdrawals images stay at their previously published digests.
- Migrations 33, 77, 78, 79, 80 and the exact explicit runtime ACL manifest are
  operator-applied together; never run schema migrations at application startup.

The runtime uses a third restricted NOW writer, separate from reports, capture
and authentication. The operator credential is never deployed. Checkout binds
the verified JWT subject to the stable person binding, not just a supplied email.
Migration 78 permits only unique eligible nonprivileged legacy email linking
after verification; conflicting/blocked/privileged accounts retain review.
The runtime writer must match the report/capture host, **port 5432**, database
and complete PlanetScale branch-routing suffix. The local operator's pooled
6432 URL is not a runtime template. Verify a fresh restricted login with TLS
and READ ONLY before publishing a corrected secret; then restart Payments
through the pinned rollout so a running process adopts the new environment.

## Backup and rollout gates

The local full database COPY transfer did not complete. Partial encrypted
archives are **not** verified backups and must not authorize restoration.
A separately labelled `schema-only-additive-release` archive must be encrypted,
restored without network access, and have matching schema fingerprints before
this additive DDL. The plan and membership-attempt tables must still be empty;
new operational tables must be absent. The DDL does not update/delete historical
rows. Its transaction must roll back completely if any precondition fails.

That schema archive contains **no business/authentication rows, sequence current
values, ownership or ACL recovery**. It is not disaster recovery. Establish and
verify a native full-data/PITR backup before scaling financial operations.

After schema/role publication, deploy the pinned API/Payments artifacts with
only the isolated NOW capability enabled. Keep the portal checkout gate closed
until control-plane rollouts are healthy and the private zero-argument
`PrivateCoreProbe.nowpaymentsReadiness()` returns `{enabled:true,ready:true}`.
Then enable portal checkout, verify anonymous auth gates and rejection of an
unsigned webhook. Do not manufacture a paid event or bypass email/session
verification to simulate an end-to-end financial transaction.

## Runtime limits and incident response

Signed webhook evidence is persisted before acknowledgment; a leased outbox
fulfils only verified owned operational orders. The public callback is
`https://mindblisspower.com/api/webhooks/nowpayments`. The status popup claims
activation only after the owned order actually reaches `activated`.

The five-minute private Cron and bounded in-process tick retry delivery and
NOW-only accruals. ROI catch-up commits at most four daily accruals per run and
reserves commit time. The weekly close is atomic: the 5,000 reserved-order limit
is a hard admission ceiling, **not a demonstrated PlanetScale latency/SLO**.
Monitor leases, retry/risk states, pending obligations and period-close progress
before increasing volume. Funding constraints retain held obligations; they do
not imply cash was paid out.

To pause new purchases, first set portal `NOWPAYMENTS_MEMBERSHIPS_ENABLED=false`.
If the executor itself is suspect, close the three Core NOW gates and keep
signature-verified capture enabled. Preserve all orders, captures, obligations,
bindings and plan snapshots. Reconcile captured in-flight events through the
reviewed executor after repair; do not assume a successful IPN acknowledgment
means membership delivery.

After traffic starts, repair forward. Do **not** drop the new financial tables,
delete the seeded plan, restore an empty schema over production, or revert the
identity CHECK: new verified-email bindings and financial references may already
exist. A schema backup cannot undo those runtime writes.

## Published verification, 2026-10-31

- Core Worker `250a9571-58a9-401b-9e29-c7a38f610641`, 100%.
- Portal Worker `381fe1f6-708e-4bc3-ae4d-94549d06dc73`, 100%, NOW admission enabled.
- API Container v8 and Payments Container v10: pinned images, completed rollouts,
  100% target version, zero reported deployment errors. Engine v1 and Withdrawals
  v3 unchanged. Admin Worker `3165879e-cf5e-4171-a30a-113580829d10` unchanged.
- Real private readiness returned HTTP 200, `enabled:true`, `ready:true`; the new
  restricted login was independently checked with TLS and READ ONLY. Complete
  runtime branch/host/port/database comparisons passed.
- Public portal/admin login and portal JWKS: 200. Anonymous packages: 307 to
  login; anonymous same-origin checkout: 401; unsigned IPN: 401; public internal
  readiness path: 404. Responses remained private/no-store. One local DNS lookup
  failed transiently; the bounded read-only login repeat returned 200.
- Final read-only database audit: 838 Stripe sales and 121,072 affiliate rows
  retain their exact pre-release hashes; identity bindings remain two. One active
  plan and engine schema v1; no operational orders, PV, inflows, jobs or awards.
- Core: 74 unit tests. Portal: 474 tests and 74 workerd smoke probes on the Linux
  bundle. Go targeted/full-provider race suites and the restricted PostgreSQL
  fixture with Linux `-race` passed. No test invoice, charge or email was created.

These checks certify deployment, configuration and safety boundaries, **not an
actual provider payment or financial disbursement**. The first real owner-initiated
purchase must still verify invoice creation, signed event delivery, atomic
activation and the owned activation popup end to end. Historical settlements
and external withdrawals remain disabled/reviewed.
