# Isolated Wallet sandbox backend

This `wallet` release adds a dedicated `mindbliss-wallet-core` Worker and a
`WalletSandboxApi` container. Deploy it with
`deploy/cloudflare/core/wallet.wrangler.jsonc --env wallet`; do not redeploy the
existing production Core Worker, its containers, merchant or relayer settings.

The dedicated process mounts only `/api/member/sandbox-wallet/*` and internal
health. It reads the existing Better Auth session using the existing auth
service's credentials, but exposes no registration, OTP, authentication,
production payment, engine or broadcasting endpoints. Runtime secrets are an
explicit allowlist; the only merchant credential is `MELD_API_SANDBOX`.

SQL116 adds three sandbox-only tables and ten restricted functions. A five
minute, single-use EIP191 nonce proves a native session's ownership of a unique,
immutable EVM address. A session-bound grant lasts at most 24 hours and ends
with the native session. New attempts snapshot that verified address without
accepting a destination or provider from browser input.

Transak is the sole provider. BUY quotes use numeric source amounts; widget
sessions use string source amounts and locked source, destination, amount and
method fields. Requests use the dated MELD contract and sandbox HTTPS host;
there is no production fallback. Only validated sandbox checkout URLs launch.

The independent status GET searches `GET /payments/transactions`, then fetches
the transaction by ID. The full account/customer/session/reference/amount/
currency/method/provider/USDT Polygon destination must match the immutable
attempt. SQL116 pins transaction identity and rejects contradictory or older
proof versions. Sandbox confirmation never writes a real financial ledger,
balance, membership or commission.

The historical pool and its old request/proof functions are unchanged. Their
records never supply a proof for the new connected-wallet journal.

Validation includes 105 Native tests, 140 PostgreSQL probes in a restricted
offline fixture, and isolated Worker admission/secret-mapping tests. The live
migration operator verifies the frozen manifest, preserves existing schema
objects and checks actual runtime grants without exposing credentials.
