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
  `MELD_PRODUCTION_ACCOUNT_ID`, `MELD_PRODUCTION_CATALOGUE_ATTESTATION`.
  Set `WALLET_MELD_PRODUCTION_ENABLED=true`.
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

### Fiat minimum boundary checks

Authenticated production quotes independently confirmed Onramp Money SPEI's
minimum of 200 MXN and PSE's minimum of 42,300 COP. The exact minimum returned a
valid quote; one cent below each minimum returned `INVALID_AMOUNT_TOO_LOW`.
These are provider minima in the selected fiat, not a claimed USD equivalent.
The USD business range remains 50–25,000, further restricted by provider routes.
At 50 USD the checked Banxa card quotes in US/MX/CO still rejected USDT Polygon
with `INVALID_CRYPTO_CURRENCY`; increasing an amount does not fix that error.

### Hosted checkout URL normalization

The live Onramp Money preparation returned HTTP 200 with a valid session but a
MELD fallback URL written as `https://meldcrypto.com?token=...`. The prior
validator required the root slash and rejected this valid response after
recording an unavailable attempt. Accept exactly the documented opaque token
form with or without that slash, and return the canonical URL with `/` to the
browser. All host, token, query, port, credential and fragment restrictions
remain in force. No mutable Onramp Money destination URL is allowlisted.

## Quote-verified compatibility policy

`wallet-production-coverage-data.json` contains the reviewed positive results
for the production merchant and USDT on Polygon. It includes the initial local
default/USD audit and separately verified currency pairs. Generic MELD country,
fiat and route metadata is not sufficient to enable
a combination. Countries and currencies without a positive audited route are
removed; live options are intersected by exact provider and method, with bounds
rounded inward using that fiat's minor units. USD retains the 50–25,000 policy.

The private attestation is SHA256 of the catalogue scope, account and API key,
joined with newlines. It binds the reviewed policy to the current production
credential generation. Store it only as a secret on `mindbliss-wallet-core`;
never commit the attestation, credentials or their private fingerprints.
Credential changes require reviewed coverage and a matching new attestation.
The catalogue contains only public route facts and audit timestamps.

This is last-known compatibility configuration, not cached pricing, a checkout
guarantee or settlement evidence. It has no timer that disables the portal.
Every quote and preparation still validates current routes, the exact selected
amount and a fresh provider quote. A transport failure or provider outage is
not treated as evidence that a country is permanently unsupported. New routes
must be audited before being enabled. History, status and existing payment
proofs do not depend on catalogue approval and remain readable independently.

The November 19 audit covered 205 countries, 385 local-default/USD pairs and
1,008 generic provider/method quotes without customer data or checkout sessions.
It approved 110 combinations in 62 countries and 21 fiat currencies. There were
894 deterministic rejections and four generic Onmeta quote failures retained as
unknown rather than permanent incompatibilities; unknown rows are not enabled.
The permitted merchant integrations returned no positive USD or card/mobile-pay
quote for USDT Polygon. Those options, including US, are consequently absent.
MX retains Onramp Money SPEI in MXN; CO retains its PSE and local transfer in COP.

A follow-up audit of Onramp Money's bank payment limits verified EUR SEPA and
Open Banking in Bulgaria, Czechia, Hungary, Ireland, Iceland, Liechtenstein,
Lithuania, Romania and Sweden. A live quote succeeded at 10 EUR on each route.
The form shows every fiat verified by the backend, including EUR alongside SEK
for Sweden. Onmeta is restricted to India for new checkouts.

Costa Rica had no permitted CRC route. Its USD Banxa card, Apple Pay and Google
Pay routes all rejected USDT Polygon with `INVALID_CRYPTO_CURRENCY`; therefore
CR is absent from this release's verified policy. The independent Banxa
MX/MXN/SPEI quarantine remains in effect even when that provider returns a quote.

The frontend discards countries, currencies or providers withdrawn by a current
response, rejects late responses from an earlier selection and checks each
provider's own amount range before enabling checkout. No replacement country,
currency or provider is silently chosen. Provider diagnostics expose only
bounded stage/status/code classifications, never bodies, addresses or tokens.
