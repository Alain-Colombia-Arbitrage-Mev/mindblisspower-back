# NOW maturity policy, 2026-10-31

## Approved business rule

- Commissions (direct, royalty and binary): one calendar month from the immutable
  generation timestamp, using America/Bogota. This is not 30 days and is not an
  end-of-month settlement delay. The weekly calculation cadence is unchanged.
- Month ends clamp to the last valid day while preserving wall-clock time and
  microseconds. January 31 matures February 28, or February 29 in a leap year.
  PostgreSQL computes the timestamp; the browser never decides availability.
- Membership principal and the existing CD ROI remain locked for 365 days from
  activation. Ordinary early reimbursement is not offered; applicable mandatory
  rights and provider risk/refund events are not disabled by this policy.
- After maturity, principal becomes temporally eligible, not automatically paid,
  reinvested or added again to commission wallets. External withdrawals remain
  disabled. A future principal withdrawal implementation must reserve each CD
  idempotently and reconcile paid/reserved amounts before enabling transfers.

## Accounting boundaries

`nowpayments_engine_obligation.available_at` is the exact authoritative timestamp.
Migration 82 validates a CHECK for every new non-ROI obligation: availability is
`created_at + interval '1 month'` in the explicit business timezone. ROI keeps its
separate annual maturity. No existing claim or immutable invoice is rewritten.

`paid_usd` and `nowpayments_engine_payment` record internal ledger accreditation,
not an external payment. Maturity does not remove funding, risk, cap, routing or
retirement restrictions. Prices, net-99% commission base, ROI rates and caps are
unchanged. No new principal ledger credit or refund endpoint is introduced.

The old ledger DATE field is rounded conservatively in UTC for its existing UTC
reader. It cannot authorize a NOW withdrawal and must not replace the exact
timestamp check. Arbitrary session timezones are not certified by that projection.

## Private read model and portal

`/api/payments/me` adds a separate `nowpayments` projection after the legacy
summary/cache path. The signed verified subject and current person binding select
the owner, not an email supplied by the client. Reads use a primary READ ONLY
snapshot. Migration 83 grants only the six sidecar column manifests required by
the existing report login; no new credentials, membership or DML permissions.

The projection separates commission maturity, uncredited funding retention,
internal accreditation, actual liquid USD ledger allocations, principal and ROI.
Retirement allocations and redirected beneficiaries are not liquid earnings of
the original owner. Recovery balances remain locked, never combined with NOW.
Unavailable reads are null, not zero. Risk or outstanding withdrawal review fails
closed; global NOW source risk mirrors the executor until detailed sale lineage
is available for every commission stream.

The portal reuses its existing components/styles in summary, finance and payment
views. It displays backend dates and the lock notice before a plan purchase.
There is no client-only acceptance checkbox pretending to persist legal consent.

## Verification scope

Tests cover month ends, leap years, timezone boundaries, microseconds, late weekly
catch-up, immutable timestamps, restricted PostgreSQL roles, source isolation,
risk freezes and replay. A completed provider payment is not manufactured to
test this rule. Preserve pending invoices and existing identity/tree/history.

The earlier encrypted backup is schema-only, not full-data disaster recovery.
Verified native full-data/PITR recovery remains a prerequisite for scaling.
