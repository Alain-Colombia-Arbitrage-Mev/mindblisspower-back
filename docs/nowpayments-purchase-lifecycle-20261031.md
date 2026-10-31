# NOWPayments purchase lifecycle

Scope: authenticated member purchase history, persisted invoice resumption,
local abandonment of a safely unpaid invoice, and multiple active purchases of
the same catalog package. Stripe initiation and external payouts remain disabled.

## Invariants

- Each explicit checkout intention has a nonzero canonical UUID
  `purchase_request_id`. Its subject/environment/attempt mapping is append-only.
  Replaying an activated or cancelled intention cannot create a new invoice.
- One outstanding checkout per person/package/environment is retained, including
  unknown provider outcomes. Reusing a known, unpaid invoice never calls the
  provider. A new explicit intention can purchase the same package after a prior
  purchase is activated or safely abandoned locally.
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
