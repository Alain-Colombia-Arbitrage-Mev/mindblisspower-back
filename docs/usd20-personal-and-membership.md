# Personal USD20 minimum and USD20 membership

Status: migrations 96–97 applied on 2026-11-10 after encrypted schema and catalogue
backups. The final function, constraint and grant profiles were verified. No
payment, membership activation or settlement was performed by this migration.

The user explicitly requested a personal-wallet minimum of USD20 and confirmed
the USD20 membership. Administrative wallet funding retains its USD50 minimum.

The canonical catalogue inspected on 2026-11-10 has IDs 1–16 and no USD20 SKU.
Migration `96_personal_usd20_membership_catalog.sql` adds ID17, `Pack 20 USD`,
USD20.00, PV20, regular type11001 and active availability. It preserves every
existing package, including the inactive USD10/USD25 rows and active USD50 SKU3.
It does not overwrite a historical SKU or alter purchase snapshots.

The transaction requires the existing single effective plan with CD365 and the
existing unique applicable tier. It changes no compensation rates or plan fields.
Conflicting IDs/prices, a changed existing USD50 package, ambiguous or changed
compensation, unexpected writer code or widened grants stop the migration.

The six-argument personal funding writer and its table constraint admit
USD20–25,000. Signature, ownership proof, replay checks, per-subject serialization,
rate limits, RLS and exact runtime grants remain unchanged. Administrative funding
still requires USD50–25,000. Existing personal/admin histories and the separate
MELD/financial ledgers are not rewritten or credited.

No provider price ID needs to be invented. NOWPayments reads the canonical
catalogue price and its included-cost policy produces a USD20.00 customer total,
USD0.2000 provider cost and USD19.8000 commission basis. This calculation does not
confirm payment, pay a commission or activate a membership. The independent Stripe
pricing policy and its disabled checkout gate remain unchanged.

The user subsequently chose the provider's own minimum for Mexico/MXN/SPEI,
including amounts below a USD20 equivalent. Migration 97 captures those personal
requests with their actual amount and explicit `source_currency='MXN'`; it does
not claim a dollar conversion. Only Mexico and canonical SPEI are eligible for
that local-currency writer. The HTTP service revalidates the fresh provider route
and its minimum/maximum before writing. USD remains USD20–25,000 and administrative
funding remains USD50–25,000. No other local-currency or administrative minimum is
changed by this policy.

The seven-argument personal writer includes currency in idempotency checks. Its
six-argument compatibility wrapper is USD-only, so a warm API cannot relabel an
MXN request. New owner-filtered V2 status/history readers project currency and
payment method. Legacy USD-only readers exclude MXN instead of presenting a
local amount as dollars. Historical amounts, currencies and destinations remain
unchanged.

Validation: the disposable PostgreSQL harness applies migrations 93–97 with no
external networking. Its 196 probes cover exact catalogue addition, failed-review
rollback, preserved requests/ledgers, personal USD20 eligibility, rejected amounts
below USD20, administrative USD50 eligibility, ownership, replay and runtime
isolation. They also cover MXN/SPEI metadata, rejected country/method/currency
combinations, cross-currency replay, currency-aware owner reads, safe legacy
reads and refusal to overwrite changed legacy reader functions. Go pricing and
fake-invoice tests also exercise USD20 without real provider calls.

Before applying, keep an encrypted, round-trip-verified schema and catalogue data
backup and a fresh read-only receipt of target identity, exact writer digest,
constraints/grants, catalogue, effective plan/tier, personal/admin request counts
and digests, and real ledger/purchase fingerprints. Compare all existing catalogue
rows excluding only new ID17 and require every request, plan, tier and financial
fingerprint to remain unchanged. The explicit local operator pins both reviewed
SQL sources and applies them in one outer transaction after one encrypted backup.
Its optional real runtime-login proof records request metadata only under an
outer ROLLBACK and makes no provider call. That SQL proof does not claim to verify
provider limits or complete a purchase. Never delete an SKU referenced by later orders
as a rollback; disabling new availability preserves those immutable records.

The release snapshot excludes only the operational heartbeat
`payments.nowpayments_engine_control.last_run_at`; row count and every other
column remain checked. A concurrent native login assigned one administrative
address while post-migration verification ran. That existing authentication
hook is independent of this migration; the financial, purchase and funding
request fingerprints remained unchanged. Local reconciliation evidence is kept
with the second backup manifest, without overwriting the first stopped attempt.
