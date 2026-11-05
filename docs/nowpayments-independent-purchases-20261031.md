# Independent pending membership purchases

The buyer explicitly chose to create another USD100 purchase and retain the
existing pending invoice. This change applies that policy to same-package
independent requests without cancelling, reusing or marking the old invoice paid.

## Invariants and rollout

- Idempotency is exact verified subject + environment + request UUID. Replaying
  the same key is immutable, including a conflicting package, processed order,
  provider timeout or unsafe-to-resume evidence. Only a new explicit UUID can
  create a separate order/invoice of the same SKU.
- Migration 85 is reviewed operator-only index DDL, never a service migration.
  SHA256: `de3a1ea435530ace835ca6e77f1aebd7ad5542aa064bc398be713529beec13f3`.
  It replaces one partial unique index with a nonunique lookup index. It does
  not rewrite rows, change roles, financial formulas, ownership or cancellation
  guards. Its preconditions and checkout readiness verify the exact index/PK.
- Local reservation retries cover only serialization errors and the exact request
  PK/capacity-slot uniqueness races, before any external provider request.
- Portal tab storage retains only the request UUID, scoped by opaque verified
  subject and package. Reloads, ambiguous responses and Back preserve it. An
  explicit separate-purchase action clears only that intent, without sending a
  checkout. The BFF compares the expected subject with the live verified session
  before private transport; it never forwards or trusts the hint as identity.
- Catalog controls remain mounted during summary loading/toggling. Existing
  visual styles, payment-status checks and distinction between settled payment
  and activated membership remain unchanged.
- Deploy the portal protection before 85 and the new Payments runtime. During
  the short transition, old Payments may still map a new UUID to an existing
  open invoice; this is safe but requires the explicit new-purchase action after
  cutover. Never test by creating a real production invoice.
- Stripe initiation, external withdrawals, broad Core networking and Chatwoot
  remain disabled. API, Engine and Withdrawals image pins must not change.

## Verification boundary

Restricted-role PostgreSQL17 and Linux CGO1 race tests cover 14 lifecycle cases:
independent pending requests, concurrent exact replay, conflicting package,
existing waiting evidence, independent CD365 memberships, owner isolation,
cancel/late evidence and exact schema gate. Unit suites cover bounded retries.
This is not an all-repository Go integration-suite assertion.

An encrypted schema/scoped-purchase backup is restored to disposable PostgreSQL
with no network before operator DDL. It contains data for only four purchase
tables and is not a full business disaster-recovery backup. Historical Stripe and
affiliate fingerprints, purchase rows, request PK, grants and triggers must match
before/after the index change. Deployment checks use metadata/private readiness
and anonymous auth/signature guards, not real invoices, payments or OTP messages.

## Published verification (2026-10-31 UTC)

- Backend source `4988129`; portal source `f96e899`, both pushed.
- Migration 85 committed atomically at 07:04:14 UTC on the pinned curated primary.
  All four purchase-table fingerprints, historical Stripe838/affiliate121072,
  request PK, relation ACLs and triggers matched before/after. Zero business-row
  changes, provider requests, messages, new credentials or role memberships.
- Encrypted scoped backup and isolated restore/local85 proof passed. Source
  archive sizes: schema417248 bytes, scoped data6821 bytes. This is not a full DR
  backup. A post-DDL read-only preflight independently verified unchanged rows.
- Core Worker `da706b6c-777a-4ed3-abd6-50613e84aec4` and portal Worker
  `f4589036-1f6c-46a3-bf48-7a37e8bd8ae9` each active at100%.
  Payments v14 digest
  `sha256:adcb12b65f666e30fc8c2e02389c3cfdcbd8da658b80af6d6f158d1dec5846ba`:
  rollout completed, one healthy instance, zero failed/starting/errors, 07:05:34.
  Static Linuxamd64 scratch image, nonroot65534, health probe retained.
- APIv8, Enginev1, Withdrawalsv3 and admin Worker were unchanged. Flag/secret-name
  checks passed; private status-only readiness returned enabled/ready true.
- Portal530 tests, TypeScript, ESLint, Linux/OpenNext build, both deployment
  dry-runs and85 network-disabled workerd probes passed. Core83 tests and the
  targeted Go/Linux race plus14 real restricted-role PG lifecycle cases passed.
- Thirteen anonymous production auth/origin/signature checks passed. Published
  chunks matched the local reviewed build by SHA256, including the explicit new
  purchase action and durable subject-scoped intent. The operator Windows DNS
  resolver transiently failed; fixed public-domain checks used process-local
  Cloudflare DoH resolution with original hostname/TLS validation retained.
- No real invoice/payment, provider-status lookup, signed synthetic event, OTP
  or financial job was initiated as a release test. The old pending invoice was
  preserved; creating the new independent invoice remains the buyer's action.

Security review informed the persistent exact-request protection and live-session
equality guard. Cloudflare deployment checks retained existing flags/image pins.
