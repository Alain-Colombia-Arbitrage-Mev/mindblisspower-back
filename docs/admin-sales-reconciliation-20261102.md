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
