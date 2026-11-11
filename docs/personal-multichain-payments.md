# Personal USDT payments on Ethereum and Polygon

Status: migration 100 was applied to production on 2026-11-10 (America/Bogota)
after 452 isolated SQL probes and three joined API scenarios with 292 assertions.
The reviewed operator confirmed unchanged content fingerprints for all 118
pre-existing tables and a verified encrypted metadata backup. No real transfer
or charge was performed. Migration SHA256:
`8e4e03e9073fc033b48658988711bdb28a6b38adec41bb609cc567fecfe5902f`.
The installed v3 definition MD5 is `655b1dc08cc2ccd354bac7fe7d07abba`.

Personal payments can explicitly select Ethereum mainnet (`chainId: 1`) or
Polygon (`chainId: 137`). The recipient remains the same fixed Mindbliss
company address. The backend maps each allowed chain to its existing exact
USDT contract and six decimals; it accepts no browser-selected token, receiver,
wallet address or RPC URL. Omitting `chainId` retains the Ethereum default for
older clients. Other chains, strings, null and additional selectors are rejected.

The prepare API calls
`payments.prepare_personal_company_payment_v3(subject, address, amount_atomic, id, chain_id)`
introduced by migration 100. Identity comes from the native session and the
persisted verified personal-wallet binding. Preflight reads the selected chain,
its token decimals and its token balance before creating the immutable receipt.
The returned chain/token pair must exactly match the requested approved policy.

Ethereum and Polygon balances remain separate. Maximum uses only the selected
network, and the wallet confirmation uses the prepared receipt's network. ETH
pays Ethereum gas; POL pays Polygon gas. No aggregate balance, implicit bridge,
conversion or cross-network deduction exists. New Reown onramp funding still
targets Ethereum USDT; displaying or paying Polygon does not relabel that funding.

Request UUID replay fixes the amount, owner, chain and token. The same UUID
cannot prepare another network, including after submission or confirmation.
The SQL capability retains the existing global per-user pending-payment
exclusion, rate limit and ownership lock across both networks. The older v2
prepare capability remains Ethereum-only, and v1 remains blocked for creation.

Submit and verify use the immutable receipt's original network, sender, token,
recipient and amount. They never broadcast a transaction. A successful canonical
receipt with the exact Transfer event and at least 12 confirmations establishes
the registered payment; onramp requests and return URLs establish no payment
outcome. Membership assignment remains pending under the existing receipt policy.

Both read-only balance endpoints retain their existing contracts, owner/session
isolation, partial-network errors and private no-store response policy. See
[personal-wallet-balances.md](personal-wallet-balances.md). Administrative MELD
sandbox wallets and their payment methods remain independent.

Deploy migration 100 before the matching API and frontend. It introduces the
versioned prepare function without relabelling existing rows or changing funding
records. Isolated validation retains the two Ethereum onramp scenarios and adds
an independently prefunded Polygon MAX/receipt scenario; no bridge or real
payment is simulated as a provider-confirmed deposit.

## SQL capability and reviewed release

Migration 99 already permits the two exact immutable chain/token pairs, so
migration 100 creates only the v3 prepare function and its restricted execution
grant. It does not change table defaults, constraints, historical records,
identity bindings, auth, administrative wallets, funding writers or ledgers.
The amount is still a canonical positive uint256 string with six token decimals.
The lock, pending exclusion and five-preparations-per-ten-minutes limit share
one per-member scope across networks.

The SQL preflight pins the reviewed migration 99 capability definitions and
existing ownership/receipt/immutability functions, exact paired-asset constraint,
object ownership, RLS, trigger and runtime isolation. The new definer capability
fixes `search_path=pg_catalog`, removes inherited default grants, and grants
execution only to the restricted runtime role. That role has no direct table
writes. Reapplication and predecessor drift fail closed.

Run `node scripts/test-wallet-funding-schema.mjs --personal-flow` for isolated
validation with real disposable PostgreSQL, no external network and no host
port. The SQL probes cover complete payment lifecycles on both chains, exact
tokens and recipient, invalid chain/amount inputs, cross-chain UUID replay,
global pending/rate limits, concurrent preparation, immutable terminal replay,
unchanged predecessor functions/constraints/rows and restricted grants. The API
scenarios retain two Ethereum onramps and add an independently prefunded Polygon
payment, with synthetic blockchain and provider calls only.

The final isolated run confirms three immutable receipts (two Ethereum, one
Polygon) while retaining exactly the two original Ethereum funding requests.
The backend unit suite passes 439 tests with 6,730 assertions; 38 separate
opt-in database tests are skipped there and do not replace the actual joined
PostgreSQL scenarios. Core policy tests pass 202 checks. Type checking and the
API Docker build pass. No schema preparation or validation test connects to
production or sends a real payment.

The reviewed local operator requires the exact migration SHA256, verified TLS
to the fixed curated primary using the existing object-owner credential, an
encrypted round-trip-readable schema/product-catalogue metadata backup and
unchanged counts/content fingerprints for all pre-existing non-system tables
in one REPEATABLE READ transaction. Its metadata postcheck permits exactly the
new v3 function and rejects changes to prior capabilities, policies, schema or
product catalogue. The backup is metadata plus product catalogue, not a full
customer-data disaster-recovery export. No payment is sent by the operator.

On rollback, retain chain-aware history and receipt recovery. Disable new
preparations until a compatible release is restored. Never delete receipts,
relabel Polygon as Ethereum, re-enable the blocked v1 writer, retry an ambiguous
transfer automatically, or change the company recipient to undo a UI release.
