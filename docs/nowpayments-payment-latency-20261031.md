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

## Published verification

- Backend runtime source `a0d8b7c111c488f0897905bb65d6266e709cdb2a`;
  image pin and additional rejection assertions `3e4bf67`.
  Portal source `302e79d0549953c2ecbb2615cf900edbd446df60`. Both repositories pushed.
- Payments container v13 at 100%, rollout completed, one healthy instance,
  zero errors/failed/starting. Registry digest:
  `sha256:211d3e14ca1b995aa7133adb613f09deff44ee023ca0e9e60446c0cc97f210c7`.
  Core Worker `9e493b56-f34d-470b-bc2e-c653c32cc842`; portal Worker
  `8f6e7758-3e5b-4d99-9120-f6d8c95ca964`, both at 100% on 06:22:57 UTC.
  Admin/API/Engine/Withdrawals versions were not changed.
- Portal: 499 tests, TypeScript, scoped ESLint, Linux Next/OpenNext build,
  staging/production dry-runs, 80 network-disabled workerd probes passed.
  Core: 83 tests passed. Targeted Linux CGO1 race suites and 11 real PostgreSQL
  restricted-role lifecycle cases passed. Ten runs of 100 simultaneous wake-up
  notifications passed; failure-signature/provider/persistence assertions passed.
  This does not claim the unrelated all-repository Go integration suite passed.
- Private readiness and deployment pin/flag checks passed. Eleven production
  anonymous auth/origin/signature guards passed, without creating invoices,
  sending messages, generating signed events or making real test payments.
- Read-only audit retained the historical Stripe/affiliate fingerprints,
  two NOW orders, zero NOW confirmed inflows/engine obligations/payments and
  both identity bindings. No migrations, role grants or historical data changes.

End-to-end post-improvement settlement latency is still unmeasured: no completed
production payment was synthesized to benchmark it. A real buyer payment can
later supply that evidence without treating the `waiting` state as paid.
