# Administrative sales reconciliation — 2026-11-02

## Approved scope

Replace the active administrative Stripe sales dataset with the reviewed payment
detail in the owner-supplied CSV, not the former recovery totals. Keep previous
canonical provider evidence and financial history intact for audit and foreign
keys. This is a reporting replacement, not cancellation/refunding of purchases.

Source SHA256: `e8d27b0af998f8a290a478d8f4e8b907e1f361e30b2ba0e350395a0405c38e20`.
The file contains a settlement preamble, then93 payment columns beginning on
row24. Parse quoted CSV, UTF-8, UTC dates and exact minor-unit money. Never
evaluate cell text as code or retain card/address/customer payloads in Git.

The owner approved payment detail as authoritative over the inconsistent
preamble and explicitly excluded four unattributed USD230 payments from sales.
Import provenance may retain their exclusion controls; they must not enter the
active membership sales view or acquire a package/user by matching price/email.

## Source controls

| Scope | Payments | Gross USD | Reported processing USD |
| --- | ---: | ---: | ---: |
| Complete source file | 737 | 88,588.00 | 2,948.98 |
| Excluded, product not corroborated | 4 | 920.00 | 27.88 |
| Included Stripe memberships | 733 | 87,668.00 | 2,921.10 |
| Included Stripe source status Paid | 545 | 64,640.00 | 2,149.69 |
| Included Stripe source status En Revisión | 188 | 23,028.00 | 771.41 |

No file payment reports a refund. The preamble reports review USD23,025.60;
detail reports USD23,028.00. Preserve and display the USD2.40 difference without
inventing an adjustment. Preamble allocations are owner statements about the
whole file, not verified cash, not a per-period allocation and not a replacement
for bank/provider settlement evidence.

Two included payments retain independent canonical dispute flags, even though
the supplied status is Paid. One supplied processing fee exceeds immutable
provider settlement evidence by USD15. Keep source status/cost and corroborated
risk/cost as separate facts. A reporting import does not clear a financial hold.

## Ongoing NOWPayments

Use existing production membership receipts, operational orders and uniquely
linked inflows as the current read source. A verified final payment with its
persisted inflow is a sale. An open invoice, confirming/partial payment, failed
attempt, duplicate receipt or security-blocked attempt is not a completed sale.
Do not replay activation or compensation from the report or importer.

At the read-only preflight there was one corroborated NOWPayments sale:
USD50.00 gross, USD0.50 provider cost, USD49.50 net. Thus the initial combined
control is734 sales / USD87,718.00 gross / USD2,921.60 reported processing /
USD84,796.40 net after reported processing. These are a dated control, not
hardcoded API/UI values. New confirmed sales must enter automatically.

Net after costs is not bank cash, withdrawable balance, treasury or affiliate
liability. Do not recalculate existing commission, principal, maturity, ROI,
rank, position, sponsor, authentication or identity binding during this import.

## Operational safeguards

Use a versioned append-only import batch and one explicit active-source pointer.
Validate exact charge and PaymentIntent pairing against independent canonical
evidence; the file alone cannot bind a person or prove a product. Deny duplicate
IDs, invalid amounts, unsupported currency/mode/status and ambiguous metadata.
Use parameterized SQL and a bounded transaction. Take an encrypted private
before-image and audit the operator action without impersonating an admin.

Runtime readers receive SELECT only on narrow reporting views, not new write
permissions or general access to underlying NOWPayments evidence. Preserve the
existing recovery marker and all financial mutation guards.

Roll back display selection only by switching the reviewed active pointer;
never delete immutable evidence or reverse real financial effects as a rollback
for a reporting deployment. Check aggregate controls and financial/tree
fingerprints before and after the authorized import.

## Applied release and checks

Applied reviewed batch `9f488abd-f4fd-421e-8bb7-3d92ca4ca199`. The operator
transaction inserted a versioned source and active pointer, not financial sales
events. Before/after19 financial-source fingerprints and tree/closure controls
matched. Independent post-commit read-only checks confirmed734 active report
rows / USD87,718.00, the four exclusions, both disputes, both discrepancies, the
unchanged original Stripe evidence and the unchanged NOWPayments ledgers.
An audit event records a NULL actor rather than impersonating an administrator.

The role manifest was tested under a non-superuser CREATEROLE operator with
`createrole_self_grant=''`, matching production. Ownership transfer temporarily
permits SET only for the new narrow report owner, restores no-SET/no-INHERIT,
and revokes temporary schema CREATE before commit. Existing runtime column-level
permissions from earlier migrations remain unchanged; new runtime grants are
SELECT on the three report views only. The initial permission failure rolled
back atomically before the corrected reviewed transaction was applied.

Source commits: backend `c079461`, admin `258c5e2`, both pushed to the existing
feature branches. Production Core version `4abb7b2b-7d5c-4734-b6e2-043fe0364f7b`
and Admin version `af2ade1c-8d6f-418a-8139-a194b2880d33` serve100% traffic.
Paymentsv15 rollout completed healthy at21:34:56UTC, image digest
`sha256:90c9a0a51ee763c3f1ad8a6ec2c88ee4e0baf1cb1e7bd89b0b93059a15521a27`.
APIv9, Enginev1, Withdrawalsv3, portal version
`55c33838-bc7c-4fa6-8cbb-71f894386cf9` and all financial/auth capability flags
remain unchanged. Only the Payments container was replaced.

Validation passed:18 import unit tests,32 disposable PostgreSQL/ACL checks,
real PostgreSQL Go reporting integration with synthetic HTTP contracts,
`go vet`, the broader payments short suite (final SQL fixes rechecked by focused
integration),294 admin tests,89 Core tests, Linux builds, production dry-runs
and31 offline workerd probes. Five Go/PostgreSQL HTTP fixture contracts pass
the strict frontend guards without coercion. Public checks passed17 admin
page/asset/auth guards and13 existing portal/checkout/webhook guards. Served
sales/history/risk assets match the reviewed build by SHA256.

No real email, authentication session, new invoice, payment or provider event
was generated for these deployment checks. An authenticated production browser
session was not available; public asset checks and synthetic private HTTP/UI
contracts are not represented as a completed browser walkthrough.
