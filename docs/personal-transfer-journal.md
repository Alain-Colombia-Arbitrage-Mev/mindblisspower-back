# Personal transfers initiated in Mindbliss

The journal covers the personal USDT transfer flow initiated in Mindbliss on Ethereum (1) and Polygon (137). It is not an indexer of external wallet transactions. Administrative MELD sandbox funding, personal Reown funding, and company payments retain their separate records.

## Canonical receipt and activity journal

`payments.personal_company_payment` remains the authoritative receipt. Its immutable owner, wallet, network, token, recipient and amount cannot be replaced by browser activity. Its existing transitions remain `prepared → submitted → confirmed|failed`; abandoning an unsigned draft preserves that draft and permits recovery of a late real transaction.

Migration 101 adds `payments.personal_company_payment_event`. An AFTER trigger emits canonical `prepared`, `submitted`, `confirmed`, `failed` and `abandoned` events atomically with receipt changes. Existing receipts receive one `snapshot`, recorded at migration time with their actual current `canonical_status`; the migration does not invent past transition timestamps. Events cannot be updated, deleted or truncated. Runtime has no direct table/sequence access; only the two reviewed owner-scoped SQL capabilities are executable.

Browser observations use `source: "client_reported"` and `canonicalStatus: null`. They record wallet prompts, rejection/errors, uncertain broadcast, observed hashes, recovery, registration errors and verification requests/errors. They cannot confirm a payment, credit a balance, allocate a membership or calculate a commission. A browser-reported hash is unverified until the existing submission/receipt verifier accepts it.

## HTTP contract

All routes require the verified Better Auth owner session, the personal portal origin and signed private BFF envelope. JSON request bodies are limited to 2048 bytes. Responses are private and uncached. The owner, wallet, network, token, amount and recipient come from the existing owned receipt, never from the event body.

- `POST /api/member/company-payments/events`: exact `eventId`, `paymentId`, `event`; optional `attemptId`, `transactionHash`, `code`. Event IDs are idempotent only for exactly the same owned payload. UUID v5 is acceptable for deterministic retry IDs and is not an authorization credential.
- `GET /api/member/company-payments/events?paymentId=<uuid>&limit=20&cursor=<event-uuid>`: one owned payment's journal.
- `GET /api/member/company-payments/activity?limit=20&cursor=<event-uuid>`: all owned transfer activity.

`limit` is optional, defaults to 20, and is at most 50. `cursor` is optional. Query keys follow the order shown; unknown or duplicate selectors are rejected. SQL seek pagination resolves cursor ownership and payment scope, fetches one extra row, and returns the last displayed event ID as `nextCursor` when another page exists. The legacy receipt `/history` endpoint still displays its latest 20 records; this does not delete retained receipts or journal events.

Client events are limited to 30 per owner in ten minutes; exact idempotent retries do not consume another slot. A non-null `attemptId` belongs to one owner/payment globally; cross-payment reuse returns a conflict. Owner and attempt locks serialize these checks. Canonical database events do not share that quota. Client event collection is best effort and cannot block the real transfer or its canonical registration.

The public API invokes the writer in its normal autocommit `READ COMMITTED` transaction. Migration 101's advisory-lock/count checks do not claim equivalent quota/attempt serialization for external callers holding an older `REPEATABLE READ` snapshot. The browser cannot select transaction isolation; supporting that separate caller model requires a later reviewed schema change.

No free-form provider errors, signatures, typed-data signatures, email addresses or client timestamps are accepted. `recordedAt` is assigned by the database. Each full event includes its fixed payment snapshot, `source` and `canonicalStatus` so consumers can distinguish a browser claim from verified state.

## Separate sponsored execution journal

[Personal Polygon sponsorship](personal-polygon-sponsored-relay.md) replaces the earlier unsigned simulation prototype. SQL105 records native authorizations, sponsor reservations, fenced dispatch attempts, encrypted signed operations and canonical outcomes in separate append-only records. It does not create a legacy direct-payment parent or change existing receipts. A common request registry prevents duplicate IDs and concurrent pending transfers across the direct and sponsored flows.

The sponsored API defaults to disabled and has a separate broadcast gate. It checks the exact USDT0 contract/domain, native user signature and fixed company transfer; it submits through a dedicated Safe service account only after durable budget and operation persistence. Receipt proof scopes the exact token logs to that UserOperation and requires 12 confirmations. Neither a client observation nor a provider callback can confirm it. Accepted native signatures have no onchain expiry; only an unsigned preparation may be abandoned. Expired service dispatches and ambiguous outcomes retain their audit evidence and cannot trigger an automatic resend.

The existing direct-transfer verifier still requires the real user's transaction sender and exact ERC20 calldata. It has not been relaxed to accept arbitrary relayers. Ethereum's existing USDT contract does not expose Polygon's native meta-transaction capability.

Better Auth authorizes access to the application. It does not possess the wallet key. A restored Reown signing session or a connected external wallet still has to authorize a transfer; neither a webhook nor an activity event substitutes for that authorization. No SIWX/authentication setting changes are part of this phase.

Primary references: [Polygon native meta-transaction implementation](https://raw.githubusercontent.com/maticnetwork/pos-portal/master/contracts/common/legacy/NativeMetaTransactionLegacy.sol), [Polygon salt domain](https://raw.githubusercontent.com/maticnetwork/pos-portal/master/contracts/common/legacy/EIP712BaseLegacy.sol), [specific USDT0 Polygon audit and omitted EIP-3009 support](https://www.openzeppelin.com/news/usdt0-child-token-audit), [EIP-7702 delegation](https://eips.ethereum.org/EIPS/eip-7702), [ERC-4337 paymasters](https://eips.ethereum.org/EIPS/eip-4337).
