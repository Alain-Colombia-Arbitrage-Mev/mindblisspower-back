# Historical membership access recognition

Owner-approved scope on 15 November 2026: recognize the package and access from
the already imported historical Stripe CSV, **without recalculating economic
benefits**. Access remains active until explicitly revoked. Original purchase
dates are preserved; recognition/access start dates are separate.

## Source and reconciliation

The reviewed source remains batch `9f488abd-f4fd-421e-8bb7-3d92ca4ca199`,
`unified_payments(1) - Stripe Dashboard.csv`, file SHA-256
`e8d27b0af998f8a290a478d8f4e8b907e1f361e30b2ba0e350395a0405c38e20`.
Its 733 membership rows were reconciled by exact PaymentIntent, corroborated
person/affiliate, historical catalog, paid amount, source status and risk.

The earlier 505-row estimate required operationally active people/affiliates.
For access-only recognition, 37 otherwise eligible pending accounts also
qualify, without changing their account or affiliate status. This yields 542
candidates. One bounded, read-only Stripe GET per candidate confirmed 541;
one additional current dispute was detected and held. No Stripe mutation,
charge, transfer, refund or webhook replay occurred.

Result: **541 individual access rights recognized; 192 membership rows held
for review**. The held set consists of 188 source-review rows, one unmatched
identity and three disputed payments, including the newly observed dispute.
The four unattributed non-membership source rows remain excluded.

| Historical package base | Recognized purchases |
| --- | ---: |
| 100 USD | 521 |
| 250 USD | 6 |
| 500 USD | 8 |
| 1,000 USD | 6 |

The base price is historical package information, not a balance credit,
principal booking, current investment, or promise of earnings. Source fees
are not added to the package base displayed to the member.

## Representation and isolation

Migration118 adds three private append-only tables: an approved run manifest,
one globally unique entitlement per Stripe PaymentIntent, and ordered decision
events. A dedicated non-login operator can execute the three reviewed writer
functions; it has no raw table DML or application login. Native authentication
can execute only the owner-scoped read function. There is no public grant or
revocation endpoint, login hook, registration hook or automatic provider retry.

The read model reports access status, original purchase date, recognition date,
historical base price and the explicit `until_revoked` term. It checks the live
native session and canonical person binding. Identity/source evidence drift
is held for review rather than silently assigning access to another person.

Migration119 separates recognition eligibility from continuing access evidence.
The active reporting-batch pointer and later manual/operational purchases gate
new recognition only. They do not revoke an existing approved right. Reads
continue to verify the original immutable import, catalog, identity and risk.
Existing entitlement snapshots, hashes, grants and decision events are preserved.

The existing `mlm.affiliate_package`, capacity, investment CD, PV, rank, ROI,
commission, wallet and payment workflows do not consume these access rights.
The UI does not merge them into `active_packages` or financial qualification.
Profile shows the historical recognition; the overview uses its existing
membership-card space. The hidden Memberships menu remains hidden.

## Applied run and invariants

Run ID: `9fdd82e1-93c1-4783-9cf1-afd0c1e2253f`.
Canonical approved manifest SHA-256:
`1700b8d831cb343f2eca93b9ad5918228926937d803ef7b25ab48dc84dd08300`.
SQL118 SHA-256:
`9a2237b18c8e041f10312ce2640d2a2f08b4b3197008a377a6b1c4a2b27d7790`.

The specifically reported member was recognized first: person57/affiliate10813,
100 USD package, original purchase `2026-07-28T02:52:57Z`. Her sponsor56500 and
binary parent67238 were preserved. The actual session-bound read projection
confirmed one active right with economic activation, ROI and commissions false.
Repeating the canary recognition did not add another right or decision event.
The remaining run created 540 rights and reused the existing canary exactly once.

Each installation/recognition transaction used REPEATABLE READ before/after
digests for 30 protected tables: people, affiliations, operational packages,
caps, CDs, transactions, wallets/movements, tree events, rank achievements,
payout/withdrawal state, periods, source evidence and wallet bindings.
Existing function bodies, owners, ACLs and settings were also compared.
All protected state remained identical within these transactions.

## Verification and operation

- PostgreSQL: 145 network-isolated synthetic probes, including null-proof
  rejection, current disputes, ownership, pending users, concurrent idempotency,
  revoked-right replay, ACL/RLS and unchanged economic state.
- Validity follow-up: 70 additional isolated PostgreSQL probes preserve existing
  access after reporting-pointer or unrelated purchase changes, while keeping
  source/identity/risk drift on hold and recognition gates enforced.
- Native Bun1.4.4: 657 passed, 40 optional integrations skipped, zero failures.
- Frontend: 1,960 passed; typecheck and scoped lint passed.
- Core: 239 passed; only the explicit app-origin GET capability was added.

Revocation/suspension requires an operator-reviewed append-only decision with
actor, reason and evidence digest, using
`payments.record_stripe_membership_rights_decision`. Replaying recognition does
not reactivate a revoked right. A later refund/dispute must be reviewed and
recorded through this access-decision workflow; no new financial posting is
invented. Original imports and purchase dates must never be rewritten.

Restricted local receipts are under `.wrangler/stripe-rights-20261115/`.
Raw provider bodies, secrets, session tokens, customer/card data and full member
lists are not included in the repository. Work and deployment scope: `rewon`;
the `main` and `wallet` branches and their portal deployments are protected.
