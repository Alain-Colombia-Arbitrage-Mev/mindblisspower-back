# Payment latency improvement — 2026-10-31

This change reduces application overhead before invoice redirect and after a
validated payment notification. It does not accelerate blockchain confirmations,
change accepted currencies/networks, or treat a redirect as proof of payment.

## Read-only baseline and its limits

At 06:15:50 UTC, production had two invoices awaiting payment, no activated NOW
orders and no verified `finished` capture. One matched `waiting` capture reached
its receipt after 22.993 seconds and its durable job update after 24.748 seconds.
This is **one non-final observation**, not a payment-confirmation P95 or evidence
that a completed payment was delayed by this amount. One invoice without later
updates had 3.860 seconds between attempt creation and invoice attachment; this
includes database/provider work, not only provider latency. Mutable `updated_at`
must not be used as an invoice-creation benchmark after subsequent notifications.

Payments already has one in-process worker on a 30-second timer. The five-minute
Cloudflare cron is a recovery/wake-up fallback, not the normal activation delay.
The same cron ordinarily prevents the ten-minute Payments container sleep timer
from expiring. Auth can sleep separately. Observability is disabled, so container
creation timestamps do not establish cold-start distributions. No always-warm
service, instance count, cron frequency or paid tier was added by this change.

## Changes

- The purchase button reuses the existing member-session presentation context
  solely to select the local referral hint. When that context is ready, checkout
  no longer waits for a second `/api/auth/session` GET. Cold-context fallback is
  retained. The BFF still verifies its live cookie/JWT and checks referral email
  against the authoritative identity; stale client state cannot change owner.
- Purchase history stays at a stable React position across summary loading,
  errors and reloads. Refreshing the summary does not remount the history GET.
  Presentation styles and existing payment confirmation states are retained.
- New durable finished/risk evidence sends a nonblocking, capacity-one channel
  hint to the existing bounded worker **after** capture and job persistence.
  It does not execute financial work inside the webhook or spawn per-IPN
  goroutines. Ordinary waiting/confirming events and identical capture replays
  do not add engine runs. The same mutex, SQL leases, due-time backoff, startup
  sweep, 30-second timer and private cron remain the recovery authority.
- The enqueue result now means an actual durable insert/update, avoiding the
  extra existence SELECT for identical callback replay. An already-existing
  durable job remains protected and retried by the normal lease/timer logic.
- NOW operational checkout omits one global recovered-Stripe guard lookup whose
  result was already ignored for this separately approved capability. Its own
  identity, ban, pricing, idempotency, capacity and engine-readiness guards stay
  intact; the global guard still applies to non-operational provider flows.

## Verification and nonclaims

Client tests demonstrate one fewer GET when session context is ready, with the
same referral fallback and server-authoritative owner. A virtual 800ms session
request plus 250ms checkout illustrates 1050ms versus 250ms, but **is not a
production latency measurement**. No percentage improvement is asserted.

Worker tests exercise finished/risk-only hints, absent/failed enqueue, duplicates,
100 concurrent notifications, bounded coalescing and no inline runner call.
Restricted-role PostgreSQL lifecycle tests retain duplicate/cancellation/late
payment protections. No real invoice, signed synthetic production event, OTP,
balance mutation or actual payment is used as a performance test.

NOWPayments distinguishes waiting, blockchain confirmation and finished states;
the confirmation stage cannot be accelerated by this application:
https://nowpayments.zendesk.com/hc/en-us/articles/18395434917149-Payment-statuses
Its webhook documentation asks for a response within three seconds, so activation
remains asynchronous after durable capture:
https://nowpayments.zendesk.com/hc/en-us/articles/21395546303389-IPN-and-how-to-setup

Security and concurrency review informed the bounded wake-up signal and preserved
financial validation, rather than caching a paid result or trusting client state.
