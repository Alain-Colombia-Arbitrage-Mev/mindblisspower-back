# Authentication composition

`auth.ts` wires the PostgreSQL adapter and identity module. `options.ts` is the
testable Better Auth 1.6.22 configuration; `delivery.ts` contains bounded HTTP
transports, and `phone-otp.ts` hardens phone OTP storage/consumption.
Nothing migrates data, sends messages or enables these capabilities on import.
The framework is MIT licensed and runs in this existing Bun process and PostgreSQL,
without Better Auth's optional paid managed infrastructure. See the
[email authentication backend contract](../../../docs/email-auth-backend.md).

All feature flags default off. Apply the reviewed auth schema before enabling
them. `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_EMAIL_API_TOKEN` + `AUTH_EMAIL_FROM`
configure Cloudflare Email Sending over its fixed HTTPS REST endpoint. The token
needs only account-scoped `Email Sending: Edit`; the sender domain must be onboarded
with SPF/DKIM/DMARC and sending enabled. Email Sending is currently Beta; arbitrary
recipients require the Workers Paid plan. Email Routing alone is not a transactional
sender. No Worker deployment is required for this backend REST transport.
Sent.dm does **not** provide email in its v3 API. `SENTDM_API_KEY`, an approved
`SENTDM_OTP_TEMPLATE_ID` and one `SENTDM_OTP_CHANNEL` (`sms` or `whatsapp`) configure
phone delivery. Optional template parameter/profile settings are in `.env.example`.
No automatic cross-channel fallback or retries can duplicate OTP deliveries.
Sent's `202/QUEUED` is acceptance, not proof of delivery or identity.
Cloudflare success also requires this one recipient in `delivered` or `queued`,
without permanent bounce, suppression or API errors. A message ID is not assumed
to exist in the REST response. There is no Resend dependency or fallback.

Email OTP uses a secret-keyed hash, 5-minute expiry and 3 attempts. Phone OTP
requires a storage hook because the installed plugin otherwise stores plaintext.
Its custom verifier consumes the database verification row atomically, persists
failed-attempt counts using row-ID/value/expiry compare-and-swap; failed codes
never delete/recreate a challenge. It never treats SMS proof as verified email.
A persistent per-recipient send cooldown and Better Auth's database-backed IP/path limiter
apply across processes. Provider errors, OTPs, destinations and signed action
URLs are never logged or returned as diagnostic details.

Temporary email OTP restriction: resend waits until the original code's full
5-minute expiry (not 60 seconds). The installed email plugin recreates a row on
a failed attempt, so a new generation is prohibited while that original row is
valid. This deliberately trades resend speed for replay safety until a native
persistent-generation verifier is available. Phone resend cooldown is 60 seconds.
The recipient budget stores an allowed-after timestamp so framework cleanup
cannot prune the longer cooldown early. New codes invalidate all older rows.
The optional non-consuming `/email-otp/check-verification-otp` HTTP route is
disabled; the actual sign-in route consumes the challenge. A generic successful
send-request response does not confirm provider acceptance or inbox delivery.

Public phone endpoints (opt-in): `POST /api/auth/phone-number/send-otp` and
`POST /api/auth/phone-number/verify`. Existing users with already-verified email
can use `disableSession:false` to sign in; use `disableSession:true` for proof
without a new session. There is no phone-only signup or temporary-email claim.
Phone password reset is deliberately disabled: the installed 1.6.22 reset path
does not use its custom `verifyOTP` callback. Use email reset instead.

JWT is opt-in, RS256/2048 with encrypted private keys in `auth.jwks`, explicit
issuer/audience and 5-minute expiry. `GET /api/auth/token` requires an authenticated
session, verified email and a current reviewed identity binding. Its allowlisted
claims are `sub` (auth user ID), `email`, `email_verified:true`,
`authVerified:true`, and `person_public_id`; the Go resolver treats the binding,
not the email or public UUID claim, as authority. `/api/auth/jwks` exposes public
keys only. JWTs are not placed on ordinary session responses. Cognito remains
unchanged until an explicit deployment cutover.

Identity provisioning never claims a legacy person by matching an email. A
`claim_required`/quarantined auth session cannot obtain a financial JWT. Legacy
linking is a separate approved, single-use claim policy.
The token email comes from that current binding, not the auth profile; a changed
or mismatched email is rejected before a JWT can reach email-based legacy reads.

Verified references, 2026-10-25 (official docs + Context7, checked against installed
1.6.22 source):

- https://better-auth.com/docs/plugins/email-otp
- https://better-auth.com/docs/plugins/phone-number
- https://better-auth.com/docs/plugins/jwt
- https://developers.cloudflare.com/email-service/api/send-emails/rest-api/
- https://developers.cloudflare.com/email-service/get-started/send-emails/
- https://developers.cloudflare.com/email-service/
- https://docs.sent.dm/start/guides/sending-messages
- https://docs.sent.dm/reference/api/authentication

Never test delivery with production credentials: tests inject senders/fetch and
exercise the real Better Auth handler with synthetic adapter data.
