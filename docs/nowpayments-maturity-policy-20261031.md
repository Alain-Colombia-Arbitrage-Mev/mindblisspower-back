# NOW maturity policy, 2026-10-31

## Approved business rule

- Commissions (direct, royalty and binary): one calendar month from the immutable
  generation timestamp, using America/Bogota. This is not 30 days and is not an
  end-of-month settlement delay. The weekly calculation cadence is unchanged.
- Month ends clamp to the last valid day while preserving wall-clock time and
  microseconds. January 31 matures February 28, or February 29 in a leap year.
  PostgreSQL computes the timestamp; the browser never decides availability.
  See the [official date/time arithmetic reference](https://www.postgresql.org/docs/current/functions-datetime.html).
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

## Published verification, 05:54 UTC

- Source implementation commit `41f1639`; portal source `8f39ef0`.
- Core Worker `c03dc7dc-1960-46c0-a873-2c7b982b60e0`, 100%.
- Portal Worker `f6e2cd50-a1c6-4735-aff6-184baa891a40`, 100%.
- Payments Container v11, completed healthy rollout, immutable image:
  `registry.cloudflare.com/ed805ed2b05218b41fc1d4d2440e658e/mindbliss/payments-calendar-policy-20261031@sha256:7aca10d3623bb3d7eb198973733c19557dd23e20e08098d009f02cc323f05d9c`.
  API v8, Engine v1, Withdrawals v3 and admin Worker remain unchanged.
- Migrations 82/83 applied atomically: validated monthly CHECK/index and exact
  effective column SELECT grants; no new credentials, membership or business-row
  writes. The two existing immutable order snapshots retained identical hashes.
- Private diagnostics: HTTP 200, enabled/ready true. Public login/JWKS 200;
  anonymous packages 307, checkout 401, unsigned webhook 401 and private path 404.
- Portal 483 tests, TypeScript/lint, Linux build/dry-runs and 74 isolated workerd
  probes pass. Core 77 tests and production dry-run pass. Restricted PostgreSQL
  engine tests include 14 calendar/timezone subtests, precision rejection,
  backfill cadence, source isolation and replay; Linux/CGO race execution passes.
  Exact report-reader PostgreSQL fixture passes, plus new read-model unit tests
  under Linux/CGO race detection.
- The attempted complete Linux `-race -short ./...` run is **not an all-suite
  pass**: legacy integration tests ignore short mode and require Docker/fixtures
  unavailable inside the builder. The scoped financial PostgreSQL/race checks
  above passed; no race was reported by the completed suites.
- Read-only production audit: historical Stripe sales (838) and affiliates
  (121,072) retain their exact previous hashes. Two owner-created invoices await
  payment; no verified NOW payment, activation, CD, commission, accrual or inflow.
  None of these release checks created an invoice, sent an email or paid money.

This verifies deployment, safety boundaries and calculation/read contracts, not
the user's authenticated production dashboard or a completed provider payment.
Do not mark an invoice paid, replay a quarantined event or invent a session to
complete that last end-to-end owner check.
