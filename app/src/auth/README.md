# Authentication composition

Current product decision (2026-10-26): **email only**, using Better Auth and
Cloudflare email delivery. The portal exposes no SMS controls or phone-auth
routes; Cloudflare also blocks those private routes and forces phone/schema
flags off without forwarding sent.dm credentials. Do not configure sent.dm or
apply migration 75 for this release. The optional SMS implementation documented
below is retained as inactive reference; it is not a registration dependency.

Public registration now accepts optional customer `contactPhone` and
`contactWhatsapp` fields, with country-code-aware E.164 validation. These are
self-declared contact details only: never phone verification, message consent
or legacy identity-link authority. Migration 76 must be reviewed and applied
before deploying the matching runtime; it adds nullable, non-unique private
auth columns without updating legacy people, network positions or ranks.
See [email registration and customer contacts](../../docs/registration-contacts.md).

`auth.ts` wires the PostgreSQL adapter and identity module. `options.ts` is the
testable Better Auth 1.6.22 configuration; `delivery.ts` contains bounded HTTP
transports, `phone-otp.ts` hardens OTP storage/consumption, and
`phone-opt-in.ts` implements the authenticated optional SMS permission flow.
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

Email and SMS OTP use a secret-keyed hash, 5-minute expiry and 3 attempts. The
SMS challenge is hashed before adapter creation and bound to the initiating
authenticated user, phone and random generation. Its custom verifier consumes
the database verification row atomically, persists
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

Delivery failure handling (2026-10-27): Better Auth's background-await helper
swallows sender exceptions, even when no background task handler is configured.
The transport therefore emits only a safe `auth_email_delivery` classification
with HTTP status and numeric provider code: never destinations, recipient
hashes, OTPs, action URLs, tokens, provider messages or response bodies.
Login/reset retain generic responses to avoid account enumeration. Registration
returns `503/AUTH_EMAIL_DELIVERY_UNAVAILABLE` after a confirmed provider rejection;
the created account remains unverified and can request verification later.
Only an explicit rejection removes the matching purpose/address/HMAC challenge
generation. Timeouts, 5xx and malformed acknowledgements may follow acceptance,
so their codes remain usable if received. None of these paths automatically
resend, weaken attempt limits, reset cooldowns or grant a session. Recipient
cooldown rejections include `Retry-After` from the persistent deadline.

SMS is optional, after email verification **and actual email login**. It cannot
replace email proof, create a session, issue a JWT, approve a historical account
claim, place a network node or authorize marketing. Every endpoint below requires
a verified-email session, including limited `claim_required` sessions. POST also
requires an explicitly trusted Origin. No user ID is accepted from the caller.

- `GET /api/auth/phone-number/opt-in` returns exactly `{ available,
  consentVersion: "sms-auth-v1", optedIn, phoneNumber: string|null,
  phoneNumberVerified }`.
- `POST /api/auth/phone-number/send-otp` requires `{ phoneNumber: E.164,
  consent: true, consentVersion: "sms-auth-v1" }`, with no additional fields.
  Success is `{ ok: true, resendAfter: 60 }`, meaning queued acceptance, not
  possession proof. Both destination and authenticated-user cooldowns apply.
- `POST /api/auth/phone-number/verify` requires `{ phoneNumber, code: sixDigits,
  updatePhoneNumber: true, disableSession: true }`; success is
  `{ ok: true, phoneNumberVerified: true, optedIn: true }`. It cannot create or
  replace the existing session cookie. A compare-and-swap on the current consent
  generation prevents a verifier in flight from restoring revoked consent.
- `POST /api/auth/phone-number/revoke-consent` requires `{}`; success is
  `{ ok: true, optedIn: false }`. It invalidates pending challenges and persists
  revocation separately from evidence that the user once proved the phone.

Migration 75 creates `auth.sms_opt_in` separately; no auth.user columns or
existing contacts are backfilled. The record stores current consent version,
explicit request time, proof time and revocation time; it is not a marketing
subscription or an immutable event-history ledger. The operator must review the
database guard and effective grants, permitting only the existing auth runtime
role SELECT/INSERT/UPDATE on this relation. Check default/inherited grants too.
Do not execute the migration at app startup. Only after that review set
`BETTER_AUTH_SMS_OPT_IN_SCHEMA_READY=true`. Before readiness, status returns
`available:false` without querying the new table; existing email login continues.
If readiness is mistakenly enabled without the table, SMS returns a redacted
503, not successful opt-in. No schema change is applied automatically.

Actual sending additionally requires `BETTER_AUTH_PHONE_OTP_ENABLED=true`, an
approved SMS template and valid sent.dm configuration with channel `sms`.
Missing configuration and WhatsApp-only setup keep SMS unavailable; there is no
silent fallback, automatic resend, provider activation or paid managed component.
When unavailable, authenticated send/verify return 404. Phone-number sign-in,
anonymous phone signup and phone password reset are disabled; use email login
and email reset instead. Removing consent does not disable email access.

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
Public email signup first requires an injected, read-only registration decision.
The production composition uses the business reader, never the auth writer, and
queries the canonical database with the same normalization and ban predicates as
Go's `BanDecisionFor`: email/phone/name blacklist, optional exact birth date,
person blacklisted/status, and affiliate suspension. No decision is cached.
An absent checker, unavailable database or malformed result fails closed before
creating an auth user or delivering email; rejection reasons stay private.
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
