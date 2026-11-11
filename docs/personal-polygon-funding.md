# Personal USDT funding on Polygon

The next personal-wallet release uses `USDT_POLYGON` for every new Reown
checkout. Reown's production merchant discovers its own routes separately for
US/USD, MX/USD, MX/MXN and CO/USD. Only Swapped and Mercuryo are eligible;
Neteller and Skrill remain excluded. Mexico's MXN flow admits only SPEI.
Provider limits are intersected with the existing 30–15,000 USD policy or the
fixed 931 MXN minimum. The MXN rule does not claim an exchange-rate quotation.

Discovery responses include `destinationCurrencyCode: "USDT_POLYGON"`,
`network: "polygon"` and `chainId: 137`. An accepted intent also returns the
verified destination address and that same network. These fields describe the
checkout request; neither a created request nor a provider return URL confirms
settlement. Ethereum route data and caller-selected destinations fail closed.

Migration `106_personal_polygon_funding.sql` introduces
`payments.create_reown_funding_intent_v4(text,text,text,numeric,uuid,text,text)`.
It fixes the destination to Polygon, preserves owner/address checks, exact UUID
replays, the per-owner rate limit and the existing fiat policy. It accepts only
read-committed transactions so its advisory-lock/count checks use current state.
The Ethereum-specific v3 writer fails with `wallet_funding_network_changed`.
Deploying an older writer must not silently store Polygon and open Ethereum.

A narrow INSERT trigger also rejects new Ethereum direct-payment drafts with
`company_payment_network_changed`. Existing draft/terminal UUID replays,
transaction-hash registration, status, journal, history and receipt verification
continue to use their original network. No historical row is relabelled,
deleted or credited. Existing Ethereum balances remain available to the backend
for historical reads and recovery; the new personal UI selects Polygon.
The same guard fences funding INSERTs, including old writer invocations which
were already running and waiting on an owner lock when the cutover occurred.

Administrative Meld sandbox retains its own credential, route discovery,
session writer and records. Its methods and provider results never populate
personal Reown checkout choices. Sponsorship, relayer authorization, token
verification and the company recipient are unchanged by this funding cutover.

The isolated PostgreSQL probes validate v4 funding, fiat/method boundaries,
concurrency, quota, ownership, RLS/ACLs, untouched historical rows and functions,
mixed Ethereum/Polygon history, blocked old writers and late Ethereum receipts.
The operator metadata proof uses the actual operator queries and allowlist:
only two new functions, the v3 function body, one column default and two INSERT
triggers may change. All existing rows, prior owners, grants and policies remain
intact. These checks use disposable Docker databases with external networking
disabled and do not make purchases or transfers.

Application is a separate reviewed operator step. Once applied, an old API
that calls v3 cannot create new checkouts; a rollback must retain the Polygon
policy and v4 compatibility. Never edit or reapply migrations 99, 100 or 105 to
reverse this release, and never rewrite historic funding destinations.
