# Current eligibility review of three Stripe disputes

Owner instruction on 17 November 2026: inspect the three remaining disputed
purchases; enable access, ROI and points only for a resolved payment with funds
retained by Mindbliss, otherwise disable that purchase's eligibility. This scope
does not authorize changing unrelated purchases, accounts, the 729 access-only
historical rights or the separately reconciled manual activation.

## Stripe readback

Six bounded authenticated GET requests read the three exact PaymentIntents and
their filtered disputes. The snapshot was taken at 22:44 UTC on 17 November.
No charge, refund, transfer, evidence submission or other provider mutation was
performed. Provider response bodies were discarded after hashing; only scoped
non-customer evidence is saved in restricted local receipts.

| Original CSV source row | Dispute state | Dispute principal balance movement | Eligibility |
| --- | --- | ---: | --- |
|393|prevented|-101.00 USD; no reinstatement|Disabled|
|573|needs_response|-101.00 USD; no reinstatement|Disabled|
|593|prevented|-101.00 USD; no reinstatement|Disabled|

The row573 dispute also shows a 15.00 USD fee, making its net debit 116.00 USD.
The other two net debits are 101.00 USD each. All movements are available USD
adjustments linked to their exact dispute; no positive reinstatement is present.
The original captured amount includes the historical package's 1% handling fee.

Stripe defines `prevented` as a dispute prevented from becoming a formal
chargeback, and `won` as a dispute resolved in the merchant's favor. A prevented
chargeback is not proof that the merchant retained the payment. Here the actual
balance movements are debits, so none meets the activation condition. Charge
objects still show captured/succeeded and zero refunded; a dispute adjustment
must not be falsified as a Charge refund.

References: [Dispute object](https://docs.stripe.com/api/disputes/object),
[filtered dispute listing](https://docs.stripe.com/api/disputes/list),
[balance transaction object](https://docs.stripe.com/api/balance_transactions/object).

## Effective backend deactivation

Live inventory confirmed zero operational packages, CDs, manual orders,
purchase intents or historical rights for all three purchases/owners, and zero
tree events referencing their PaymentIntent, charge or original intent. Thus
there was no ROI deposit to close, point event to reverse or money to claw back.
Accounts, sponsors, tree positions and unrelated activity remain unchanged.

The frozen import predated the row573 dispute. Its derived `source_eligible=true`
still made its 100 PV available to the **read-only local rank projection** and to
`payments.v_stripe_sales.ready_for_local_rank_projection`. Both consumers read
the flag dynamically; neither is an authority to award a bonus or post money.

The reviewed transaction changes **only two derived fields on that one row**:
`source_eligible=false` and a deterministic
`current_dispute_eligibility_disabled` review reason. The other two source rows
were already excluded and remain byte-identical. All three now report false
projection readiness. No package, CD, rights record, wallet movement, rank or
PV tree event is created or reversed.

The original import hash, dates, captured/refunded amounts, metadata, provider
JSON and original dispute counters remain intact. In particular,573's original
`dispute_count=0` describes the October capture and is not a current status.
The fresh current dispute is documented in three appended `audit.activity_log`
observations with before/after derived eligibility, linked balance movements,
provider body digests, timestamps and the explicit owner authorization. The
audit actor FK is null; the payload records the operator provenance without
inventing a staff identity.

The import hash continues to identify the original captured evidence, not the
later operational eligibility decision. The strict legacy importer will refuse
to overwrite this subsequent decision with the old derived flags; never bypass
that check or blindly reimport to reactivate these payments.

## Verification and scope

Operation:`9c01d4b0-1c0e-48e1-9b8b-02c72b854719`.
Committed 17 November 22:54:01 UTC. Result: one derived eligibility correction,
three audit observations, zero access/ROI activations and zero point awards.

The transaction row-locked the exact three source payments. Before COMMIT,
REPEATABLE READ digests proved all original provider fields except the two
explicit derived fields unchanged; all other Stripe sales, legacy financial
and authentication tables, 729 rights/runs/events, 189 review decisions, previous
audit rows and function definitions/permissions remained exact. Actual view
queries confirmed all three purchases ineligible. The same DML was replayed
within the transaction and produced zero updates and zero audit duplicates.

This is an existing backend data-policy update: no schema migration, role grant,
API change, worker/image deployment or frontend build is required. Source and
documentation changes are confined to `rewon`; `main` and `wallet` deployments
and branches are protected. The 729 earlier access-only recognitions are not
converted into economic packages by this instruction.

Local restricted proof, before-images, report and transaction receipt are under
`.wrangler/stripe-disputes-20261117/`. No private payment list or credential is
committed. Future activation requires a new review of the actual dispute outcome
and funds; this change does not automatically reactivate a disputed payment.
