# Review of the remaining historical Stripe purchases

Scope: the owner requested review of the 192 remaining imported purchases,
correction of demonstrable identity errors, and access recognition only, without
ROI, PV, bonuses or commission activation. Access stays active until revoked.
Only `rewon` and `app.mindblisspower.com` are release targets.

## Reconciliation

The same immutable 733-membership-row source was reviewed. An exact read-only
Stripe PaymentIntent/Charge retrieval for each remaining row found 189 captured
payments without refunds, disputes or associated Radar reviews, and three
currently disputed charges. No provider mutation, Radar approval, payment,
transfer, refund or webhook replay was performed.

The final proof also compared fresh `PaymentIntent.metadata.email` as an exact
normalized SHA-256, metadata person/package identifiers and original source
record hashes. Customer/card details, secrets, sessions and raw provider bodies
are not stored in this repository. Body hashes are audit digests, not Stripe
signatures. Proof requests were bounded, without automatic retries.

Of those 189 payments, **188 CSV-review purchases receive rights-only access**.
Their canonical identities were already corroborated. Their historical CSV
status remains `En Revisión`; a separate reviewed decision records the current
evidence rather than rewriting source history. Together with the earlier 541,
this gives **729 recognized purchase rights**.

One captured Link payment reports `not_assessed`, rather than normal risk. An
additional exact GET confirmed `authorized`, `approved_by_network`, captured,
zero refunded, no dispute and no Radar review. This distinction and its separate
evidence digest are preserved in the decision reason; it is not represented as
a normal fraud assessment.

## Identity conflict retained for manual reconciliation

The remaining identity-conflict purchase has a unique metadata ID/email and
verified Better Auth corroboration for person15451/affiliate115533. The old CSV
owner is null and the financial recovery mapping is person15450/affiliate88610.
No global identity, email, binding, sponsor, parent or financial record was edited.

The correct target already owns an activated manual 100 USD order and active
package, dated 5 November. The order does not explicitly reference this Stripe
PaymentIntent, so equal package amounts do not prove whether these are separate
payments. The original canary attempt stopped at the existing manual-overlap
gate and rolled back completely: 541 prior rights, zero new decisions/runs.

A new 188-purchase manifest excludes that purchase. It remains held pending the
owner's clarification about the manual payment, alongside the three disputes.
Do not bypass the manual-overlap gate or duplicate the manual access. The
unused identity-review path is pinned to one PaymentIntent hash and one
corroborated target; it does not grant authority to change financial identity.

## Additive implementation and controls

Migration120 adds one private append-only decision table, two private evidence
helpers and an operator-only approval function. Only the owner-only evidence
helper from119 is extended with an approved-review fallback. The118 run and
recognition writers,119 grant gates and owner-scoped read projection retain
their definitions. Existing541 snapshots, runs and decision events stay exact.

Each decision binds original and approved snapshots, their canonical JSON
hashes, exact current provider proof, identity proof, no-Radar proof, actor and
reason. Radar references, incomplete proofs, refunds, disputes, ambiguous
identities and existing entitlements fail closed. Application identities have
no raw table access or approval permission.

Run: `d841c7a2-e85f-4f21-b092-1ac4992ea950`.
Manifest SHA-256:
`791eaa62728d45ad95bd4c963123fa805e5acad0d880ae5cbd6f9479542c4018`.
SQL120 SHA-256:
`f98676cf6d1d2973153cb58018cbafbbceed50eab723ac13fa89afeaf230a064`.

The first two CSV purchases were recognized as a canary; completion creates186
more and reuses those two. Exact replay creates no new review decision or right.
Transactions check before/after digests of 30 legacy financial/source/binding
tables, authentication users/sessions, the original541 rights/runs/events, and
all relevant function bodies, owners, settings and ACLs before COMMIT.

Verification: 106 isolated PostgreSQL probes cover approval proof validation,
concurrency, duplicate prevention, Native owner isolation, revocation/replay,
identity corroboration, RLS/ACLs and unchanged non-rights state. A single
explicit in-memory hash substitution permits a synthetic positive test of the
pinned identity branch without committing the real PaymentIntent identifier;
canonical function hashes normalize only that asserted literal.
An actual existing native session also confirmed a newly recognized right,
owner-only results, original/recognition dates and the until-revoked term,
with economic activation, ROI and commissions false. Session identifiers stayed
inside the rolled-back SQL read; no cookies or tokens were retrieved or minted.

## Temporary frontend entry pause

Login and registration fields/design remain, while their buttons and handlers
reject new password, OTP, resend, social and registration actions, including
Enter and programmatic form submission. The notice has four translations.
Existing sessions, recovery, BFF/backend authorization and wallet flows are
unchanged. This is a UI pause; direct API authentication is not disabled.

Frontend: 1,975 tests passed, typecheck/scoped lint passed, Cloudflare build and
public login/register notice/disabled-control checks passed. No OTP was sent.
The `main` and `wallet` branches and their deployments remain protected.

Restricted receipts and the per-row review report are kept locally under
`.wrangler/stripe-rights-held-20261115/`; private lists are not committed.
