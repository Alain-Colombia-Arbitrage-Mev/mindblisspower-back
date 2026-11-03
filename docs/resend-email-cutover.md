# Resend email OTP cutover

Status (2026-11-02): Resend sender configuration and the compatible API image
have been published. See the dated release evidence below; source support alone
is not evidence of delivery. No subscription or DNS change was made.

Local verification: 145 authentication tests / 2,551 assertions and TypeScript
checking passed with Bun 1.4.4 in a read-only, network-disabled Container. Core
passed 97 tests, including selected-provider isolation. These are synthetic
checks, not evidence of a configured Resend account or real inbox delivery.

The approved production sender is `otp@mindblisspower.com`; do not assume a
local operator environment has the same sender or variable names. The public
receiver is configured separately; see the portal's
`docs/resend-webhook.md`. Its `RESEND_WEBHOOK_SECRET` belongs only to that
receiver and must never be confused with the sending API key or inbox ID.
The receiver's intended URL is `https://mindblisspower.com/api/webhooks/resend`.
Its current deployment and credentials must be checked independently against
the portal's release evidence. A missing Signing secret keeps POST closed with
503. The dated evidence below distinguishes configuration, synthetic requests,
real sends and human receipt.

## What stays unchanged

Better Auth remains self-hosted and generates/verifies the OTP. Resend only
delivers the existing verification, sign-in and password-recovery email.
No account migration or schema change is needed. Preserve code expiry,
attempt limits, recipient budgets, purpose isolation, secure sessions,
identity linking and every financial restriction. Never mark an address
verified because a provider accepted its message.

## Operator prerequisites

1. Access or create the organization's [Resend account](https://resend.com/).
   Resend [does not require production approval](https://resend.com/docs/knowledge-base/does-resend-require-production-approval),
   including for free accounts. Account access and any billing choice belong
   to the account owner; domain verification and quota still apply.
2. The owner selected the root domain `mindblisspower.com` and approved the
   sender `otp@mindblisspower.com`. Verify that domain under
   [Domains](https://resend.com/domains). Copy exactly the DNS records issued by Resend; keep existing MX,
   SPF, DKIM and Cloudflare sending records intact. Do not add conflicting SPF
   records at the same DNS name. Receiving email in Resend is not required.
3. Wait until the selected sender domain is verified. Disable open/click
   tracking for authentication email. Domain verification does not itself
   confirm available quota or inbox placement.
4. In [API Keys](https://resend.com/api-keys), create a production key with
   **Sending access**, restricted to the verified sending domain. Full account
   access is not needed by the application. Store `RESEND_API_KEY` in the
   ignored `backend/.env.local`; never send the key in chat or commit it.
   Set `AUTH_EMAIL_FROM=otp@mindblisspower.com` (no display
   name in this application's current validator). Do not enable the selector
   in a shared runtime until its replacement image is ready.
5. Confirm the actual account quota and plan in the dashboard. Production
   approval is not a prerequisite; sending volume and billing limits are.
   Check capacity against the required daily/monthly volume. A peak capacity
   request is not permission to buy a plan or enable overage billing. Obtain
   the owner's explicit plan approval before any paid change.
6. Confirm all three existing aliases below are published, accept the string
   variable `OTP` and do not require additional unsupplied variables. Do not
   clone or overwrite remote templates automatically to make a test pass.

Official references, checked 2026-11-02:
[domain verification](https://resend.com/docs/dashboard/domains/introduction),
[API key permissions](https://resend.com/docs/api-reference/api-keys/create-api-key),
[production access](https://resend.com/docs/knowledge-base/does-resend-require-production-approval),
[quotas](https://resend.com/docs/knowledge-base/account-quotas-and-limits),
[pricing](https://resend.com/pricing).

## Configuration and release

The fixed, server-owned native OTP mapping is:

| Better Auth purpose | Published Resend alias |
| --- | --- |
| `sign-in` | `login-verification-code` |
| `email-verification` | `account-verification` |
| `forget-password` | `password-reset` |

When Resend is selected, the OTP payload provides `from`, `to`, the reviewed
`subject` and `template: { id: alias, variables: { OTP: nativeCode } }`. The
[official API](https://resend.com/docs/api-reference/emails/send-email) accepts
the alias of a published template, not an unpublished draft. It forbids
`html`, `text` or `react` alongside `template`; the OTP transport omits them.
Unknown aliases or malformed variables fail closed before a request. A
template failure never triggers an alternate HTML send or another provider.

Cloudflare continues sending the reviewed local HTML/text and ignores the
hosted-template metadata. Generic non-OTP action messages without that metadata
retain HTML/text in Resend. Local exports under `docs/email-templates/` are
reference assets; tests do not certify a remote version or publish it.

| Target | Required settings |
| --- | --- |
| API process | `AUTH_EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `AUTH_EMAIL_FROM` |
| Private Core Worker | Same selected sender settings, plus existing auth/JWT prerequisites |
| Public portal/admin sending | No Resend API key or sender/provider configuration |
| Portal webhook receiver | Separate `RESEND_WEBHOOK_ENABLED` and `RESEND_WEBHOOK_SECRET`; no sending API key |
| Go Containers | No email provider settings or credential |

The selector accepts exactly `cloudflare` or `resend`. Only absence retains
Cloudflare; empty or malformed values do not silently select another provider.
Resend never falls back to Cloudflare, and inactive sender credentials are not
read or forwarded. Core keeps phone authentication disabled.

Before publication, run the auth tests/typecheck and Core tests without
production env files. All delivery tests must use intercepted requests only.
Build the API image without local secrets, pin the actual published images
for all other Containers, preserve all current feature flags, and record the
new API image digest. Upload only the selected secret to private Core through
its approved secret mechanism. Coordinate the replacement API image and Core
selector/sender change; do not point the old Cloudflare-only image at Resend.
Worker/secret publication and Container rollout are separate operations, even
when requested by one deploy command. For future incompatible changes, first
roll out a compatible image retaining the current sender, confirm every API
instance, then switch secrets and restart only API. A new image or application
version alone does not prove that every running instance has been replaced.
Do not rebuild or replace Payments, Engine, Withdrawals, portal or admin for
this transport-only change. No SQL migrations or mass-message task belongs
to this release.

With fresh authorization for named recipients, make one production OTP
request per recipient. Do not reuse an already-consumed test authorization,
read/redeem their codes, clear budgets or retry automatically. Confirm both
Resend acceptance and human inbox/spam receipt; the human completes login.
Check registration, sign-in and password recovery retain their existing
response privacy, purpose checks, cooldowns and session policy.

## Delivery safety and rollback

The only Resend destination is HTTPS `POST https://api.resend.com/emails`,
with an 8-second deadline and no redirect, automatic retry or alternate
provider. A valid accepted message identifier means provider acceptance,
not inbox delivery. No recipient, code, action URL, credential, message body
or raw provider error is logged.

Confirmed provider rejection retains the existing exact-generation cleanup
semantics. Timeout, 5xx or ambiguous/malformed responses must not discard a
possibly delivered challenge. Keep generic recovery responses; changing
them only for existing addresses would expose account existence.

If rollback is needed, first verify that Cloudflare sending is available and
has quota. Restore the prior reviewed API/Core release and sender configuration
without touching users, verification records or financial data. Rollback is
an explicit operator action, never a second send within the same request.

## Release evidence — 2026-11-02, Bogotá

Private Core version `ed986d1d-86b1-4709-901d-0199eff602f3`, deployment
`ee433fe6-8c4a-4b0f-bcea-73bf6b3c973c`, published with 100% traffic. API
application version 10 pins
`mindbliss/api-resend-templates-20261102@sha256:26b43dfe9b26b8d48d5ba114f7c9c77c73c2122a989f157134796e40e85ef90d`.
Wrangler reported no application changes for Payments (15), Engine (1) or
Withdrawals (3). Auth/business flags and database records were not changed.

Only `RESEND_API_KEY`, `AUTH_EMAIL_PROVIDER=resend` and the approved sender
were uploaded to private Core. The owner stored the sending key locally as
`RESEND_API`; the operator explicitly mapped it to the runtime variable
`RESEND_API_KEY`, without adding a runtime alias or uploading the environment
file. A random local Windows named pipe supplied the three-secret allowlist
in memory to Wrangler; no secret was committed or included in an image.

Three bounded live template tests used the verified runtime image and approved
recipient `guardcolombia@gmail.com`: all aliases were accepted and the owner
confirmed receipt. Test subjects clearly said their codes were not valid for
production. These messages did not create accounts, sessions or production
challenges, reset passwords or verify identities. Sending-only API permission
correctly refused domain/template metadata reads; it was not expanded.

A separately authorized native production login request returned HTTP 200
with private/no-store and no session cookie. The owner confirmed receipt but
reported missing visual styling; delivery is confirmed, visual/template and
running-instance attribution remain under investigation. Do not present this
receipt alone as proof that a particular running process has changed provider.
A live webhook tail observed a signed `email.sent` notification; delayed
provider retries mean temporal coincidence alone does not identify its send.

Post-release portal/admin login, public JWKS and `/api/auth/session` checks
returned HTTP 200 with no session cookie. Browser `/api/auth/get-session` is
intentionally not exposed (404); use the BFF `/api/auth/session` route.
No code was read or redeemed. No recipient cooldown or auth restriction was
cleared, no bulk mailing was created and no paid plan/overage was enabled.
