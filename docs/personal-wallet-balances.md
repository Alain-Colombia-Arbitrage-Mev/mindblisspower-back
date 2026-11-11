# Personal wallet balance reads

The personal wallet displays USDT on Ethereum mainnet and Polygon separately
for the same verified EVM address. Reading these balances does not require an
active Reown SDK connection. Signing and every new payment preparation remain
restricted to Ethereum mainnet; displaying Polygon does not enable new Polygon
transfers. The administrative wallet and its sandbox provider remain separate.

| Owned read endpoint | Result |
| --- | --- |
| `GET /api/member/company-payments/balance` | Ethereum USDT and native ETH snapshot used by the transfer form and Maximum. |
| `GET /api/member/company-payments/balances` | Two independent snapshots, ordered Ethereum (`1`) then Polygon (`137`), used for display. |

Both endpoints require the existing native session, signed BFF envelope and
allowed personal-portal origin. They accept no query parameters, client wallet
address, token, network or RPC URL. The backend resolves the eligible owner and
persisted verified wallet binding before making fixed, read-only RPC requests.
The dual endpoint reads that binding once and queries the two networks in
parallel. Each network must report its expected chain and six-decimal token.

Successful snapshots contain the wallet address, exact chain/token identity,
`asset: "USDT"`, network, canonical decimal `balanceAtomic`, canonical decimal
`nativeBalanceAtomic` and an ISO `observedAt`. Zero is a valid observed balance.
Native amounts are wei for ETH on Ethereum and POL on Polygon. USDT balances
are never added across networks or relabelled as a single spendable balance.

If one network fails, its entry retains its network identity and returns
`balanceAtomic`, `nativeBalanceAtomic` and `observedAt` as `null`, with
`error: "company_payment_rpc_unavailable"`. The healthy entry remains available.
Successful entries omit `error`; upstream messages are never exposed. A failed
read is not zero, and a cancelled refresh cannot publish an obsolete result.

Responses use `Cache-Control: private, no-store` and `Vary: Cookie`. The frontend
memory cache is scoped by session subject and normalized email, refreshes after
returning from checkout and does not establish authentication, ownership or
permission to sign. Authentication still comes from the server session, and a
new payment independently checks the authoritative Ethereum balance.

These endpoints perform identity/binding SELECTs and read-only RPC methods.
They create no payment or funding intent, broadcast no transaction, request no
signature, credit no balance and write no ledger, membership or commission.
This display change requires no schema migration. Historical receipts retain
their original network under the existing
[Ethereum cutover policy](personal-ethereum-network-cutover.md).

Validation for this release: 436 API tests pass with 38 explicit opt-in tests
skipped; 201 Core tests pass. Coverage includes zero and uint256 precision,
network/token separation, partial failure, cancellation, owner isolation,
selector rejection and the Ethereum-only transfer balance. The pinned Bun
1.4.4 Docker build passes type checking. Tests make no real payment.
