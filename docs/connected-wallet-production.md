# Connected Wallet production funding

The `wallet` portal uses its dedicated Reown project to establish wallet
ownership, and its own MELD production merchant for new deposits. Better Auth
remains the application session authority. Neither wallet connection nor a
checkout callback authenticates a user or proves a payment.

## Deployment boundary

- Frontend: `mindbliss-wallet`, `wallet.mindblisspower.com`.
- Private API: `mindbliss-wallet-core`, `wallet.wrangler.jsonc --env wallet`.
- Native entrypoint: `Dockerfile.wallet`, `src/sandbox-wallet-server.ts`.
- Runtime-only secrets: `MELD_PRODUCTION_API_KEYS`,
  `MELD_PRODUCTION_ACCOUNT_ID`. Set `WALLET_MELD_PRODUCTION_ENABLED=true`.
- Do not deploy the shared `mindbliss-core-production` or change `main`/`rewon`.
- The production process does not receive sandbox merchant or relayer secrets.

The public `/api/member/wallet-funding/production/*` namespace maps to the
private `/api/member/wallet-funding/*` API. It provides account-scoped country,
fiat and payment discovery, explicit quotes, session preparation and owned
status/history. The browser cannot supply a destination, user or environment.
Quotes and checkout sessions use the immutable SQL116 ownership binding.
Receiving does not require renewing a signing lease. Sending funds is not
authorized by this receiving permission.

SQL121 records immutable production attempts separately from sandbox. It never
credits an internal balance, commission, ROI, PV or bonus. Status confirmation
requires an independent production transaction read matching owner references,
merchant, provider, session, country, fiat amount/method and USDT Polygon
destination. Sandbox callbacks and cached test results cannot satisfy it.

No production webhook profile/signing key was available at release. Status
verification is explicit or follows the owned checkout return. Do not attach
the existing sandbox webhook secret to this production merchant.

## Verified availability, November 19, 2026

Real production API quotes passed the Native adapter and frontend contract for:

| Country | Fiat | Method | Valid provider(s) |
| --- | --- | --- | --- |
| Mexico | MXN | SPEI | Onramp Money |
| Colombia | COP | PSE | Onramp Money |
| Spain | EUR | SEPA | Banxa, Onramp Money |
| Chile | CLP | Khipu | Banxa |
| Peru | PEN | Local bank transfer | Onramp Money |
| India | INR | UPI | Onmeta, Onramp Money |
| Kenya | KES | M-Pesa | Onramp Money |
| Vietnam | VND | VietQR | Banxa, Onramp Money |
| South Africa | ZAR | Local bank transfer | Banxa |

These are quote checks, not completed purchases. Availability and fees can
change. Discovery metadata is not a guarantee: providers with invalid quotes
are removed before checkout. In particular, Banxa advertised card/mobile-wallet
routes but returned `INVALID_CRYPTO_CURRENCY` for the checked USDT Polygon
card quotes, including USD. More successful USD/card providers require merchant
enablement/correction. Mercuryo and Binance Connect are excluded.

The production dashboard has Alchemy Pay, Banxa, Mercuryo, Onmeta, Onramp Money,
Rampnow and Yellow Card connected. This does not mean each offers a working
USDT Polygon route. Transak was connected in sandbox; Topper and Transak were
listed as available integrations requiring their own production credentials.
The portal uses only account-returned routes with documented destination locks
and a valid quote. It does not borrow the Reown merchant or sandbox credentials.

The connected wallet was ownership-verified once by the user and its canonical
address survived a full page reload, without another connect/activation CTA.
AppKit's provider returned the numeric chain ID `137`; the client now strictly
normalizes numeric, decimal and hexadecimal chain IDs before checking Polygon.

One Banxa production checkout was prepared without payment or identity
submission. The API and immutable journal consistently specified 2,000 MXN for
SPEI and approximately 100.74 USDT, but the vendor checkout labelled the fiat
total as 2,000 USD, even after selecting Mexico. Consequently new Banxa
MX/MXN/SPEI quotes and preparations are quarantined before provider session
creation. Onramp Money remains available for that route. Previously prepared
attempts retain their original MXN facts and remain readable; this restriction
does not rewrite their history or proof contracts.

The merchant incident report remains an unsent local draft. No funds were
sent, charged or credited by these checks. Private receipts and credentials
remain outside tracked source.
