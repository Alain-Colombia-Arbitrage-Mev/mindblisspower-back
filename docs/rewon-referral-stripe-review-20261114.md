# Rewon: permanent referral and historical Stripe review

Review date: 2026-11-14 (America/Bogota). Scope: `rewon`; no change to
`main` or `wallet`. Gas sponsorship remains limited to the fixed Mindbliss
payment destination, not arbitrary wallet recipients.

## Authoritative source

The active reviewed Stripe CSV is `unified_payments(1) - Stripe Dashboard.csv`:

- Batch: `9f488abd-f4fd-421e-8bb7-3d92ca4ca199`.
- File SHA-256: `e8d27b0af998f8a290a478d8f4e8b907e1f361e30b2ba0e350395a0405c38e20`.
- 737 source rows; 733 attributed Mindbliss membership rows are in the active
  reporting scope. Four unattributed rows remain excluded for review.
- Of those 733: 543 paid with no recorded dispute, 2 paid/disputed, and 188
  under review. Reporting a CSV payment does not activate an operational package.
- There are no exact activated Stripe purchase intents and no active operational
  package for these CSV affiliates in the reviewed snapshot.

Do not use the older, broader canonical Stripe export to reinclude sales outside
the currently reviewed CSV. Import evidence and its source statuses are immutable.

## Activation dry run

Read-only reconciliation initially finds 542 paid, identity/catalog-corroborated,
source-eligible rows without recorded Stripe risk. Enforcing matching affiliate
ownership and active, unrestricted people/affiliates reduces this to **505 rows
for 505 people**. Their gross source amount is **57,974 USD**.

| Source package | Rows | Base per sale | Gross including source fee |
| --- | ---: | ---: | ---: |
| 1001 | 489 | 100 USD | 101 USD |
| 1002 | 6 | 250 USD | 252.50 USD |
| 1003 | 6 | 500 USD | 505 USD |
| 1004 | 4 | 1,000 USD | 1,010 USD |

Each of those 505 rows has one exact current catalog match by amount and PV;
matching by price or package ID alone is insufficient. Payments range from
2026-07-25 to 2026-08-27. This is an import-evidence cohort, not authorization
to reactivate historical investment terms or proof of each payment's current
Stripe refund/dispute state. A fresh single-payment audit was performed only
for the reported member case.

No activation was applied. The existing activation path and even a direct active
`mlm.affiliate_package` insert affect package caps and economic eligibility.
Before financial changes, decide whether the requested outcome is membership
access recognition or full economic participation, including effective dates.
Never replay a Stripe webhook or invent a purchase intent to backfill this source.

## Reported member case

The reported member has one verified canonical account and person, affiliate
10813, public referral code `antonia04`, recruitment sponsor 56500 and binary
parent 67238. Preserve both relationships: recruitment sponsor and binary parent
are different concepts.

Her single source sale is a 100 USD package plus a 1 USD source fee. One exact
authenticated Stripe **GET**, on 2026-11-15 UTC, confirmed the same live
PaymentIntent and charge: succeeded, captured, paid, 10,100 USD minor units,
Mindbliss product tag present, zero refunded amount, no dispute or pending review.
No Stripe mutation, email lookup, new charge or application financial write occurred.

## Referral behavior being repaired

Permanent invitation identity must not depend on buying a package or holding a
binary position. Browser storage is a hint, not sponsor authority. Existing
affiliate sponsors take precedence over hints or company defaults. A verified
new member without an invitation may be attributed to the configured company
root; this does not fabricate a binary placement or activate a package.

Capture must be owner-scoped and immutable after canonical acknowledgement.
Company attribution must never race an explicit referral or replace an existing
sponsor. Checkouts must use canonical stored attribution and fail before opening
a provider invoice if the necessary sponsor placement is not ready.

## Evidence and boundaries

Local redacted aggregate receipts, the narrow Stripe proof and the activation
design are under `.wrangler/rewon-referral-stripe-20261114/`. Private payment
references remain in ignored local evidence; no credentials, OTPs, payment tokens
or personal wallet keys are included in this document.

All production database inspections used explicit read-only transactions.
Production activation decisions applied: **0**. Real charges/transfers: **0**.

The separate reviewed SQL117 installation committed on 2026-11-15 UTC. Its
REPEATABLE READ installation checks verified matching function hashes and ACLs,
both guards and empty new metadata tables. Before/after digests of existing
people, affiliates, packages, Stripe source rows, purchase intents and NOW
attempts were identical. No member attribution was backfilled by installation.

Validation: 1,932 frontend tests; Native Bun 1.4.4: 646 passed, 40 optional
integration cases skipped, zero failures; 235 Core tests plus 25 final focused
availability checks; 131 isolated PostgreSQL probes; focused Go tests and a
Linux payments binary built from the reviewed deployed source overlay. The
manual-membership implementation and unrelated source files were preserved.
The Native read gate permits four simultaneous reads per owner to support
dashboard invitation and attribution callers without false 429 responses;
capture stays single-flight, with the existing frequency limits preserved.
