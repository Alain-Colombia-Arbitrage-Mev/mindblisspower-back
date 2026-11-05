# NOWPayments purchase lifecycle

Scope: authenticated member purchase history, persisted invoice resumption,
local abandonment of a safely unpaid invoice, and multiple active purchases of
the same catalog package. Stripe initiation and external payouts remain disabled.

## Invariants

- Each explicit checkout intention has a nonzero canonical UUID
  `purchase_request_id`. Its subject/environment/attempt mapping is append-only.
  Replaying an activated or cancelled intention cannot create a new invoice.
- Migration 85 supersedes the one-outstanding-checkout-per-SKU rule from 84.
  Distinct explicit request UUIDs can have independent pending purchases of the
  same package. Existing invoices and review evidence are retained. Replaying an
  exact request never calls the provider again; its immutable mapping remains
  authoritative even after cancellation, activation or an unknown outcome.
- Every activated purchase has its own affiliate package, principal and 365-day
  investment CD. The existing catalog price, included 1% provider cost, net 99%
  commission base, calendar-month commission hold and scoped NOW engine remain
  unchanged. Checkout slot release is not principal release or a payout.
- Cancelling requires a known invoice, no payment ID, no capture/receipt/binding,
  an open checkout and an awaiting operational order. Unknown, creating, paid,
  processing or review-held purchases are not automatically cancelled.
- A cancellation is local merchant abandonment, **not provider revocation**.
  NOWPayments invoices do not expire and cannot be deleted through this API.
  The confirmation warns the buyer not to use the previous payment link.
  Later authenticated evidence is retained, but the terminal blocked order
  cannot activate a membership, principal, PV, ROI or compensation automatically.
  Such a payment requires reconciliation; no automatic refund is attempted.

## Transport and authorization

`GET /api/payments/nowpayments/purchases` returns up to 100 recent owner-bound
purchases and `has_more`. It does not list emails, other owners, raw provider
evidence or payment links. `POST .../resume` and `POST .../cancel` accept only a
canonical `order_id`; fixed BFF and private gateway routes check origin/session,
service authentication, JWT and current approved identity binding. Every response
is private/no-store. Resume returns only a persisted allowlisted provider URL.

History remains independent of the legacy recovered-Stripe summary. The report
reader receives exact SELECT columns only. The dedicated NOW operational writer
receives append-only request/cancellation inserts and one additional update
column, not global identity, Stripe, withdrawal or ledger privileges.

## Database and concurrency

Migration 84 adds request/cancellation evidence, `checkout_open`, bounded-history
and evidence lookup indexes, and the open-checkout partial unique index. Existing
payment snapshots are not rewritten. Activation closes the checkout slot in the
same transaction. Attempt -> operational order lock ordering is shared with
fulfillment; cancellation never locks the person first. A deferred constraint
requires cancellation audit, terminal blocked order and closed checkout to commit
together. Closed checkout slots and audit mappings cannot be reopened/rewritten.

Migration 85 replaces only the open-checkout unique index with an equivalent
nonunique lookup index; the exact subject/environment/request primary key stays
intact. New-checkout readiness validates this reviewed index and request key.
Existing webhook capture and fulfillment do not depend on the new checkout gate.
The 5000-order capacity guard is unchanged. Do not recreate the old unique index
after independent pending purchases exist or delete orders to force a rollback.

Do not run a destructive down migration once new request or cancellation evidence
exists. Do not replay historical unmatched webhook captures, create synthetic paid
events in production, or mark emails verified to exercise this feature.

## Verification boundaries

Tests use disposable PostgreSQL with actual restricted login roles and an injected
NOWPayments transport. They cover pending-invoice preservation, same/different-key
concurrency, processed-key replay, multiple CD365 purchases, owner isolation,
unknown outcomes, local cancellation, late evidence, terminal blocking and reader
ACLs. Production checks are metadata/readiness and anonymous auth guards only;
they are not a completed real-payment test. No real provider invoice or payment
is created as a deployment test.

Provider reference:
https://nowpayments.zendesk.com/hc/en-us/articles/18393446018461-Invoices-and-payments

## Production release evidence (2026-10-31 UTC)

- Source: backend `ef33d1c2135fed3003102a1b9e5ca65d9f0f3ee8`;
  portal `beefcf648eac6dc8baf008666c27fbf4ee118e8c` (both pushed).
- Migration 84 SHA-256:
  `f3c6d03413973eba2203a780c6fa9e4053b8646513967b3d520871343cb9f198`.
  Applied atomically to the pinned curated primary. Both existing attempt and
  operational order fingerprints matched before/after DDL. No cancellations,
  new credentials, role memberships or provider calls were performed by it.
- Payments container v12, pinned registry digest
  `sha256:5a040a3535859283b1884478e78584ca9eaa689ea5a5fce39431d0ca6661bac6`:
  rollout completed at 100%, one active instance, zero errors/failed/starting.
  Static Linux amd64, scratch runtime, UID/GID 65534, health check retained.
- Core Worker: `504ec9a0-1afc-4dc5-8a8a-7163083e2f6d` at 100%.
  Portal Worker: `e5c5e900-f970-463d-a6ec-8c8c0afec382` at 100%.
  Admin remained `3165879e-cf5e-4171-a30a-113580829d10` (not redeployed).
- Private readiness returned enabled/ready true. Control-plane image/version and
  flag checks passed. Eleven anonymous public checks passed, including history,
  resume and cancellation returning 401, foreign-origin cancellation returning
  403, unsigned webhook returning 401 and internal readiness returning 404.
- Verification: portal 497 tests, TypeScript, scoped ESLint, Linux/OpenNext,
  staging/production dry-runs, 80 workerd probes; Core 83 tests; restricted-role
  PostgreSQL lifecycle 10 scenarios under Linux CGO1 `-race`, plus activation,
  scoped engine and member-policy regressions. This is not an all-repository
  Go integration-suite or real completed-payment assertion.
- Historical Stripe sales (838) and affiliates (121072) retained their prior
  fingerprints. During rollout a legitimate `waiting` notification was recorded
  for an existing USD100 invoice; no confirmed inflow, activated membership or
  new engine obligation existed in the read-only audit. This provider event was
  not generated by the deployment tests and must not be treated as settled funds.

The security/PostgreSQL/accessibility review informed immutable request/audit
records, exact role grants, safe cancellation confirmation and preserved portal
styles. The existing 5000-order capacity guard was not expanded or recycled.
