# Verified entry and referral attribution — 2026-11-03

Approved policy: a unique eligible non-administrative legacy email match may
link automatically after email verification. Collisions, restricted identities
and privileged claims remain reviewed. Existing bindings and positions are not
rewritten. The last valid explicit referral choice before a new purchase wins
for an unpositioned owner; existing purchase snapshots remain unchanged.

## Boundaries

- OTP/password/registration success enters the dashboard only after the current
  canonical authorized session matches the just-verified recipient.
- `/api/member/referral-attribution` is a same-origin, uncached portal BFF. Its
  private Core/Payments capability independently checks the service token,
  signed verified subject/email, immutable binding and current eligibility.
- Only the narrow `payments.verified_registration_referral` SECURITY DEFINER
  function may persist an unpositioned owner's metadata. Its NOLOGIN owner has
  no financial permissions. Payments receives EXECUTE, not table DML or owner
  membership. The function locks the buyer and ignores links after placement.
- A current explicit verified visit may save once in the background; dashboard
  entry does not wait. Old browser hints are never replayed automatically. A
  failed/unconfirmed choice blocks invoice creation and offers an explicit
  retry/choice. Existing server attribution wins over stale browser backup.
- Referrals with ambiguous case-insensitive matches fail closed; exact legacy
  codes and supported MP IDs keep their reviewed precedence.
- Identity/JWT/claim eligibility also checks affiliate restrictions and stored
  blacklist identifiers. It does not lift any restriction or change a password.

## Database application

Migrations 68, 89 and 90 were reviewed, rehearsed with rollback, and applied in
one transaction to primary `mindbliss_curated_20261025`. No business DML was run.
68 qualifies the existing unaccent dependency without changing normalization
semantics. 89 adds the narrow metadata capability. 90 adds SELECT on exactly
10 missing eligibility columns to the existing auth reader role.

Post-application assertions confirmed runtime EXECUTE, fixed definer ownership
and search_path, no PUBLIC EXECUTE, no runtime table DML, no person UPDATE, no
runtime owner membership, and the expected inherited auth reads. Secrets were
not logged. Migrations are operator actions, never application startup tasks.

## Verification

- Portal: 720 tests; compiled workerd fixture: 105 probes, real RSA verification,
  no external network/messages/database queries; touched runtime files linted.
- API Bun 1.4.4: 274 passed, 36 explicit skips, 0 failures; 3,784 assertions.
  Critical skipped DB suites ran separately: identity 34 passed/288 assertions,
  atomic recovery 30 passed/480 assertions; contact/role fixture 46 assertions.
  Four pre-existing business-persistence tests still lack their own fixture.
- API typecheck, dependency toolchain and 24 HTTP pentest probes passed offline.
- Core: 134 tests. Payments focused HTTP/race and real PostgreSQL tests cover
  owner checks, least privilege, ambiguous codes and both buyer-lock orderings.
  Go 1.26.10 broad Payments/NOW suite: 221 primary tests and 1,133 subtests
  passed with the race detector; 32 explicit short-mode skips, zero failures.
  The new critical PostgreSQL capability suite also passed separately.
  A separate non-short PostgreSQL/race run passed 8 primary tests and 37
  subtests, with no skips, covering restricted NOW engine roles, membership
  activation/lifecycle, idempotency and tree-cache authorization.
- No production OTP, payment, invoice, customer placement or rank promotion was
  executed as a test. Application deployment checks must use metadata/public
  anonymous requests, not bypass email verification.

## Rank limitation retained

The portal distinguishes a confirmed rank from unavailable, empty, unknown or
unpositioned data. Catalog failure cannot imply "maximum". NOWPayments rank
promotions remain unsupported by its operational engine: enabling its ranks
flag currently fails readiness. Its PV ledger is separate from legacy rank
sources. This release does not turn that flag on, run global promotions, change
binary caps, pay rank bonuses, or change ROI/withdrawal policy.

Deployment scope: portal, API, Payments and private Core routing only. Admin,
Engine and Withdrawals images and all existing flags/secrets are preserved.

## Published release

- Portal source: `4c4c92c86052c856d41159eda0930c4322f3b868`.
  Worker `e1bfc256-f81a-42a0-b50f-f1790393d6ad`, 100%.
- Backend runtime source: `13b04785068961ded1b8570c4037761829f64ead`.
  Core Worker `c3784a31-fd4c-47b6-8aec-cb50ad758d7d`, 100%.
- API container v15 and Payments v16: 100%, expected digest matches, healthy,
  no rollout errors. Engine v1 and Withdrawals v3 unchanged.
- Admin Worker remains `eca0250c-1d12-47ab-8c8c-b35c708821ba`.
- Anonymous production checks passed for login/registration guidance, private
  no-store headers, unauthenticated referral GET (401), foreign-origin POST
  (403), and matching immutable hashes of all affected public chunks. No owner
  metadata, OTP, invoice or payment was written by these checks.
- Existing portal artifact was preserved locally before replacement. Release
  verification confirmed unchanged portal/admin binding and secret-name
  fingerprints, and unchanged Core flags and inactive-service image digests.

## Referral routing and binary-placement follow-up

Portal source `04c109e17d6953d9f770346cd382776f6adb3a18` is published as Worker
`ce5eb476-501c-44fc-9088-923de54286a4`. Legacy root `/?ref=...&side=...` links now
temporarily redirect to registration, carrying only the public code and branch.
Both auth navigation tabs preserve those hints. Public GET checks verified both
branches and login/registration destinations with no-store headers. Verification:
727 portal tests, 110 compiled workerd probes, matching runtime source hashes.

Payments source `fc4e336eca79849c5ee2f30daf431b58dfe3f2e5` changes only the NOW
ancestor-counter lock to FOR NO KEY UPDATE, retaining depth order, formulas,
advisory locks, FK/unique-slot protection, placement strategy and isolation.
The deterministic new PostgreSQL regression first reproduced SQLSTATE 40P01
with the prior implementation. The corrected regression plus activation and
membership lifecycle passed 3 primary tests and 18 subtests with the race
detector, zero failures/skips. All data was synthetic in disposable PostgreSQL.

Core Worker `3a0a5c56-26e2-4cec-9492-76191dfbb47b` targets Payments v17 with
image digest `ea54fcafc9000eb0991b1ed0562340fdf3b11eba15b7895b67da1851916e67ac`.
API, Engine, Withdrawals, admin, flags, credentials, database schema and existing
positions are unchanged by this follow-up. No real payment or account was used
as a test.

Placement still occurs after the first verified membership payment. Explicit
L/R links spill down that same leg; absent a preference the existing weak-leg
rule applies. No unpaid registration or existing member is repositioned. The
separate reader Store may retain its tree snapshot until its 15-second TTL;
this release does not claim instantaneous visual refresh across Store caches.
