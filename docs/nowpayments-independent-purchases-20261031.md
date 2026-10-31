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

Production version pins and final verification are recorded after rollout.
