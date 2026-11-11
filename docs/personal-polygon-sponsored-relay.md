# Personal Polygon USDT sponsorship

The personal portal keeps Better Auth as its login authority and verifies the
existing EVM wallet binding before preparing any payment. Polygon sponsorship
does not authenticate a user, create an administrative wallet, credit a balance,
or assign a membership.

The user signs one exact USDT0 `MetaTransaction`: their address, token nonce, and
`transfer` of the reviewed amount to the fixed Mindbliss recipient. The server
verifies that EIP-712 signature, encrypts it with AES-GCM bound to owner/payment,
and retains an immutable native nonce claim. **This native token signature has no
onchain expiry.** Discarding an unsigned preparation is supported; an accepted
authorization cannot be revoked by closing the form or by a server timeout.

A dedicated service-owned Safe 1.4.1 account submits only the reviewed token
`executeMetaTransaction` through EntryPoint 0.7 and Pimlico on Polygon 137. The
service signer is separate from every user's wallet and holds no user's private
key. The API fixes the token, recipient, EntryPoint, factory and call structure;
the browser supplies no arbitrary transaction, RPC, paymaster or token selector.
Ethereum direct transfers and all prior Polygon records retain their existing
receipt verifier and ownership rules.

SQL105 reserves the sponsor budget and serializes the Safe's EntryPoint nonce
lane before any sponsorship quote or service signature. An expiring unsigned
lease has a fencing token. Signed operations are encrypted and durably persisted
before the first, single `eth_sendUserOperation`; `should_send` is true only for
that first persistence acknowledgement. A lost database or provider
acknowledgement cannot trigger a blind resend, replacement nonce or signature.
Each explicit dispatch also carries an exact, domain-separated 32-byte audit tag
derived from its payment and attempt UUIDs, using the Safe SDK's trailing
`onchainIdentifier` convention. It is included before sponsorship and signing
and rechecked after decryption. ERC-4337 hashes exclude the Safe signature, so
changing only signature expiry would otherwise leave an identical operation hash
when retrying the same nonce and quote. The tag changes no inner token call.

Receipt verification requires the exact UserOp hash, account, nonce and
paymaster; a canonical Polygon block with at least 12 confirmations; and the
exact USDT Transfer plus native meta-transaction event inside that particular
UserOperation's log segment. Events from another operation in the same bundler
transaction cannot confirm it. A successful operation with inconsistent token
evidence remains unresolved; neither client callbacks nor checkout returns
confirm payments.

Each Safe signature expires onchain after five minutes. A missing operation can
release its dispatch lane only after a canonical block beyond that expiry, an
unchanged EntryPoint nonce, and no provider receipt. The prior attempt and its
reserved cost remain recorded. If the token nonce is unchanged, the same payment
returns to `authorized`; an explicit user click may prepare another sponsored
attempt using the same exact native authorization. No background retry occurs.
A changed token nonce requires reconciliation: it does not prove whether that
authorization was executed elsewhere. The permanent nonce claim is preserved.

## Private API and configuration

`/api/member/polygon-relay` exposes authenticated `capabilities`, `prepare`,
`authorize`, `submit`, `verify`, `status`, `history` and unsigned-only `abandon`.
Every request requires the verified native session, personal portal origin and
signed BFF envelope. Responses are private/no-store and never include encrypted
blobs, raw signatures, signed operations, service keys or lease tokens.

`PERSONAL_POLYGON_RELAY_ENABLED` controls the isolated capability;
`PERSONAL_POLYGON_RELAY_BROADCAST_ENABLED` independently controls new preparations,
authorizations and submissions. Both default to disabled. Reads, verification
and unsigned abandonment remain available with only the base capability enabled.
The Core API container alone receives `API_PIMLICO_API_KEY`,
`API_POLYGON_RELAYER_PRIVATE_KEY` and `API_POLYGON_RELAY_ENCRYPTION_KEY`, mapped to
their unprefixed server names. Retain the encryption key for all accepted
authorizations and pending operations; rotation without retaining old-key
decryption is not implemented.

Maximum sponsor reservations default to 1 POL per attempt, 2 POL per owner per
UTC day, and 10 POL globally per UTC day; server configuration can lower these
limits. Values are exact POL wei, never USD or SOL. SQL enforces durable quotas,
cross-flow request ownership/pending state and conservative reservation retention
for uncertain operations. No real provider quote or transaction is needed by
the automated tests: the joined suite uses a marked disposable PostgreSQL
database, synthetic keys, signed Hono requests and synthetic RPC responses.

## Primary references

- [Pimlico Safe account integration](https://docs.pimlico.io/references/permissionless/reference/accounts/toSafeSmartAccount)
- [Pimlico sponsored operation endpoints](https://docs.pimlico.io/references/paymaster/verifying-paymaster/endpoints)
- [ERC-4337](https://eips.ethereum.org/EIPS/eip-4337)
- [Safe SDK identifier encoding](https://github.com/pimlicolabs/permissionless.js/blob/main/packages/permissionless/accounts/safe/toSafeSmartAccount.ts)
- [USDT0 child token audit](https://www.openzeppelin.com/news/usdt0-child-token-audit)
