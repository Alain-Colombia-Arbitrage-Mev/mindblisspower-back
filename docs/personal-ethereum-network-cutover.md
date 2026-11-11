# Personal wallet Ethereum network cutover

Status: migration 99 was applied to the curated primary on 2026-11-10 after
388 isolated SQL probes and 225 joined API assertions. The reviewed operator
verified a round-trip-readable encrypted metadata/catalogue backup and identical
row counts/content fingerprints for all 118 existing non-system tables in one
REPEATABLE READ transaction. The four new capability hashes match the tested
profile. No real transfer or charge was made by this release.

The user selected USDT on Ethereum (ERC-20). The personal wallet's new recargas,
balance reads and payments to Mindbliss use Ethereum mainnet, chain 1. The token
is six-decimal USDT at `0xdac17f958d2ee523a2206206994597c13d831ec7`; network fees
are paid in ETH. The fixed company recipient remains
`0x0a600b03ef5f8e7f3e182b83440c6d292033db0e`. Neither the browser nor an onramp
can choose an alternative company recipient, token or transfer network.

The administrative wallet remains an independent MELD sandbox integration with
its original Polygon asset and sandbox records. Its methods, credentials,
request writer and balance semantics are unchanged by this migration.

## New capabilities and historical records

Migration `99_personal_ethereum_only.sql` permits two exact immutable receipt
pairs: historical Polygon 137 with its original USDT token, and Ethereum 1 with
the Ethereum USDT token. It changes only the defaults and versioned creation
capabilities for new records. It does not update, relabel, delete or recreate
any existing payment, funding request, identity binding or financial row.

- `payments.prepare_personal_company_payment_v2` creates Ethereum receipts only.
  It preserves atomic integer amounts, ownership, rate limits, pending-payment
  exclusion and exact request replay. A historical Polygon request ID cannot be
  reused as an Ethereum preparation.
- `payments.create_reown_funding_intent_v3` records the canonical Reown/MELD
  Ethereum destination code `USDT`. Its amount limits remain 30–15,000 USD, or
  at least 931 MXN for Mexico/SPEI; a provider can impose a higher minimum.
  Supported countries remain US, MX and CO. Neteller and Skrill are rejected.
- Funding history and status v3 return the persisted `destination_currency`.
  Historical `USDT_POLYGON` requests remain distinguishable from new `USDT`.
  Old reader versions hide new Ethereum records rather than labelling them
  Polygon. Administrative requests retain `USDT_POLYGON` in every reader.
- Old personal preparation and funding writers fail closed. They cannot turn
  a warm Polygon API request into an Ethereum record or create a new Polygon
  operation after the cutover.

Existing Polygon payments retain ownership checks, unique immutable hashes and
their original chain/token metadata. A late, already-broadcast transaction may
still be registered and verified using Polygon RPC. A submitted payment stays
pending until the correct chain provides evidence; changing the default network
does not establish a payment outcome. The frontend must not offer another
Polygon signing prompt from a legacy preparation. An unsigned preparation can
be abandoned through the existing capability without losing its audit record.

The API selects the verification RPC and token from the validated immutable
receipt policy. It must never verify a Polygon hash with Ethereum RPC, read a
Polygon balance as an Ethereum balance, or derive settlement from an onramp
checkout opening or return URL. New payment preparation requires authoritative
Ethereum balance; confirmation still requires a canonical transaction, receipt,
exact Transfer event and at least 12 confirmations.

## Validation and release

Run `node scripts/test-wallet-funding-schema.mjs --personal-flow` from the
backend repository. The final isolated run passes 388 SQL probes and two API
scenarios with 225 assertions. PostgreSQL is real and disposable; provider
quotes, token deposits and blockchain transfers are synthetic. The container
has no external network and exposes no host port. The scenarios exercise card
and MXN/SPEI funding, exact MAX payment, backend registration, confirmation and
idempotent recovery. They make no production connections or charges.

The SQL preflight pins the reviewed predecessor functions, constraints, RLS and
immutability trigger. New definer functions fix `search_path` to `pg_catalog`,
strip inherited default grants and expose only the narrow runtime capabilities.
The runtime role has no direct payment/funding-table access. A second application
or unexpected predecessor drift fails closed.

Apply the reviewed migration before publishing the matching API and frontend.
During that transition, older creation routes deliberately fail closed; they
must not silently fall back to Polygon. The local reviewed operator requires
the exact migration SHA256, verified TLS to the curated primary, an encrypted
round-trip-readable schema/product-catalogue metadata backup, and unchanged
fingerprints of all protected tables within a single REPEATABLE READ
transaction. The backup is metadata plus product catalogue, not a full customer
data or disaster-recovery export. The operator does not perform token transfers.

On rollback, keep chain-aware history and receipt recovery available. Disable
new writes until a compatible release is restored. Do not revert Ethereum
records to Polygon, re-enable old writers, drop receipts, or allocate a
membership merely because a payment was submitted. Membership assignment and
any financial credit remain separate reviewed operations.
