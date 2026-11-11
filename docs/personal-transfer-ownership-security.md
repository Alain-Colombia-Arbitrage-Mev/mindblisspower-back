# Personal transfers: ownership and approved amounts

This review covers transfers initiated inside Mindbliss on Polygon. It uses
synthetic users, wallets, signatures and isolated database fixtures; it does not
send transactions or request sponsorship from production providers.

## Ownership boundary

- The API gets the subject from the authenticated Better Auth session. Neither
  the browser nor the Core gateway can choose a subject, source wallet or raw
  operation through the transfer request body or query string.
- Preparation resolves the source address from the subject's verified wallet
  binding. SQL checks that binding again before creating an intent.
- Every existing-payment action selects by both subject and payment UUID and
  checks the verified binding. Knowing another user's UUID does not authorize
  reading, authorizing, submitting, verifying or abandoning their payment.
- The runtime validates returned rows against the expected subject and UUID.
  Authorization and operation ciphertext are also bound to the subject,
  payment UUID and, for operations, the attempt UUID.

## Amount boundary

- Preparation stores an immutable amount in atomic USDT units. Reusing a
  request UUID with a different amount is rejected.
- Approval signs a server-reconstructed intent containing the exact source,
  token, recipient, amount, network domain and native authorization nonce.
  A valid signature for a different amount or wallet cannot authorize it.
- After preparation, authorization accepts only the payment UUID and signature;
  submission accepts only the UUID. Neither accepts a replacement amount.
- Before sponsorship, after signing and when recovering a persisted operation,
  the server compares the complete operation with the saved intent. Recomputing
  a modified operation's hash does not make the operation acceptable.
- SQL keeps the payment snapshot, accepted authorization and operation immutable.
  Repeated requests recover the same payment rather than changing its amount or
  silently creating another transfer.

## Regression coverage

- Core ingress rejects source/subject/amount overrides on post-review actions,
  even when broad Core routing is enabled.
- HTTP and payment tests exercise two authenticated synthetic users, foreign
  payment UUIDs, forged source claims, changed signed request bodies, wrong-user
  signatures and changed amounts after approval.
- Database probes run the actual guarded SQL functions with isolated subjects,
  covering ownership checks, UUID reuse and immutable approved snapshots.
- Browser regressions cover asynchronous account/signer changes and stale
  confirmations; server authorization remains the security boundary.

Run the focused backend checks from the repository root:

```powershell
node --test deploy/cloudflare/core/test/polygon-relay.test.mjs
node scripts/test-polygon-relay-schema.mjs --ownership-amount
```

Run `bun test src/http/ownership-amount.security.test.ts
src/http/recipient-lock.security.test.ts` from `app/` with the repository's pinned
Bun toolchain. The SQL runner requires Docker and creates only a labelled,
network-disabled PostgreSQL fixture; it does not use a production database URL.

## Validation on 2026-11-11

- Frontend: 1,465 passing tests; typecheck and focused ESLint passed.
- API: 491 passing tests and 39 explicit opt-in integration skips. On Windows,
  the suite used `bun test --timeout 15000` because its subprocess fixtures have
  a 10-second deadline and cold imports exceeded Bun's 5-second default. No
  existing assertion or subprocess deadline was changed.
- Core gateway: 214 passing tests.
- Additional PostgreSQL ownership probes: syntax checked, execution pending
  because the local Docker Engine did not respond. Migrations 105 and 106 remain
  unchanged. Source review found the ownership checks and immutable snapshots
  already enforced by those migrations; this is not a claim that the new SQL
  probe completed successfully.

Changing local HTML can falsify the display but does not change the intent the
server authorizes. These controls apply to Mindbliss operations; a user still
controls their personal wallet outside the application.
