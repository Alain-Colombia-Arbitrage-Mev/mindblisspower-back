# Personal USDT company-payment receipts

Status: migration 98 was applied on 2026-11-10 after encrypted schema/catalog
backups and 329 disposable-database probes. The reviewed release transaction
proved the protected existing records unchanged and the new receipt register
empty. Tests use synthetic wallets without external payment calls; no real token
transfer was sent by this task.

Ethereum cutover: migration 99 was applied on 2026-11-10 with the existing
records in all 118 protected tables unchanged. New personal payments use Ethereum
mainnet, chain 1, through the matching API/frontend release. The
complete cutover and legacy recovery policy is in
[personal-ethereum-network-cutover.md](personal-ethereum-network-cutover.md).

The user chose to register the payment and assign the membership afterwards.
This feature records a payment receipt with purpose `company_payment`. It does
not allocate a package, activate a membership, credit either wallet, pay a
commission or mutate the existing financial, purchase or funding ledgers.

The receiver is fixed to `0x0a600b03ef5f8e7f3e182b83440c6d292033db0e`.
Migration 98 originally used Polygon PoS, chain 137, and its six-decimal USDT/USDT0 proxy
`0xc2132d05d31c914a87c6611c10748aeb04b58e8f`. The address appears in both the
[official Polygon mapped-token list](https://docs.polygon.technology/pos/reference/mapped-tokens/)
and [official USDT0 deployments](https://docs.usdt0.to/technical-documentation/deployments).
Those historical identities remain immutable. Migration 99 adds the exact
Ethereum pair, chain 1 and six-decimal USDT contract
`0xdac17f958d2ee523a2206206994597c13d831ec7`, for all new preparations. Neither
chain nor token nor recipient is a browser-supplied payment parameter.

The service reads the authenticated user's persisted personal-wallet binding and
checks the production chain, token decimals and authoritative balance before
preparing the MAX payment. The immutable `amount_atomic` is a canonical positive
uint256 decimal string; no JavaScript floating point, fiat conversion or client
assertion can establish the amount. The SQL prepare capability also checks the
passed sender against the current binding, protecting the boundary between the
RPC balance read and persistence.

At the Ethereum cutover, new drafts use the versioned SQL prepare capability.
The old preparation capability fails closed, so a warm API cannot keep creating
Polygon drafts. A pre-existing Polygon draft can be abandoned if unsigned;
already-broadcast Polygon payments retain submission and receipt verification
against their original chain. Reading a legacy receipt never permits another
Polygon wallet prompt. Ethereum USDT balances use Ethereum RPC, and ETH pays the
network gas fee; Polygon balances and POL are separate assets.

The independent `payments.personal_company_payment` registry follows
`prepared → submitted → confirmed/failed`. A prepared snapshot expires after
15 minutes for the purpose of prompting a new transfer. A new prepare request
is blocked while the user has a submitted payment or an unexpired preparation.
Exact request-ID replay returns the same snapshot, including its later status.
There are at most five new preparations per user in ten minutes. The latest
20 owned receipts are readable for recovery after a refresh.

The owner can explicitly abandon an unsigned prepared draft. This records only
`abandoned_at`; it preserves the amount, destination, timestamps, identifier and
history, and lets the owner prepare a different amount without waiting 15
minutes. Repeating abandonment preserves the original audit timestamp. Submitted
and terminal receipts cannot be abandoned. The frontend offers this action only
when no signing/broadcast recovery marker or known transaction hash exists; an
ambiguous transfer is never dismissed or automatically resent.

An already-broadcast transaction can be registered after the preparation's
expiry or abandonment, retaining `abandoned_at` through submission/confirmation.
Never discard a real payment because the user approved it before expiry
and returned late. This recovery case can coexist with a later preparation; it
does not authorize a second transfer or a second membership allocation.

Every transaction hash is globally unique and immutable. Before claiming that
hash in SQL, the service must obtain the real transaction and check the bound
sender, chain, fixed token, zero native value and exact ERC20 transfer calldata
for this receiver and amount. This prevents another user from reserving a public
transaction hash. A missing or temporarily unavailable RPC response leaves the
hash unclaimed and retryable; retrying registration must never resend the transfer.

Confirmation is a server capability, not a browser-supplied success flag. The
HTTP verifier independently checks the transaction, successful receipt, exact
USDT Transfer event, canonical receipt/block hash and at least 12 confirmations.
SQL then records the validated block number/hash and confirmation snapshot.
Terminal records, source amount, receiver, token, sender and transaction hash are
immutable. Exact terminal replay is safe. An objective transaction revert or
mismatch can mark a submitted receipt failed; RPC outages, malformed responses,
missing receipts and uncertain reorgs remain retryable rather than recording a
financial outcome.

SQL cannot itself prove an RPC response. Its trust boundary is the authenticated
backend verifier: only the restricted service role can execute the narrow
prepare/read/submit/verify/reject functions. The table has RLS with no direct
runtime access; inherited/default read grants are removed. The internal ownership
helper has no runtime execute grant. Every definer function fixes `search_path`
to `pg_catalog`, and public execute is revoked.

Validation: 329 disposable PostgreSQL probes cover migrations 93–98, including
the existing funding/currency regressions, exact fixed payment policy, full
uint256 amounts, forbidden ownership, request replay, pending/rate limits,
expired-broadcast recovery, terminal immutability, globally unique transaction
hashes under concurrent submission, latest-20 ownership and removal of inherited
table/function grants. Draft abandonment preserves immutable snapshots and is
idempotent; its race against late submission never loses the real hash.
Financial, purchase, funding and catalogue snapshots stay
unchanged throughout the company-payment scenarios.

The migration 99 cutover validation passes 388 SQL probes plus two joined API
scenarios with 225 assertions against a real disposable PostgreSQL instance.
The joined scenarios simulate card funding and MXN/SPEI, deposit USDT into a mock
Ethereum chain, transfer MAX through the real API workflow, and verify the
immutable receipt after 12 confirmations. External network access is disabled.
Historical rows, administrative sandbox requests and protected financial/catalogue
data remain unchanged by the DDL. The test also rejects a disabled immutability
trigger, mismatched chain/token pairs, old creation capabilities, cross-network
request-ID reuse and forbidden grants. No production payment is made.

The operator's exact REPEATABLE READ wrapper is validated with the same probes. Three
additional synthetic release checks reject an old-ledger mutation and an
unexpected function change, while allowing a concurrent writer without changing
the migration's consistent view. No production database is used by those checks.

The explicit local release operator pins the reviewed migration and requires a
fresh encrypted, round-trip-readable schema and catalogue backup. It compares
all protected pre-existing data inside one REPEATABLE READ transaction, before
and after the DDL, and verifies the exact new function/grant/RLS profile before
commit. This observes concurrent operations through a consistent MVCC snapshot;
it does not exempt ledger rows, identity assignments, configuration or heartbeat
fields. The new receipt table must be empty at migration time. No real wallet
transaction is needed for the migration or its validation.

If a later deployment is rolled back, first disable creation/submission of new
company payments while keeping receipt recovery available. Never drop an
existing receipt registry or delete submitted/confirmed records to undo the UI.
Membership allocation remains a separate, explicitly reviewed operation.
After migration 99, an old Polygon-only API is not a safe write rollback. Keep
the chain-aware recovery API and immutable Ethereum receipts, and disable new
payment creation until a compatible release is available.
