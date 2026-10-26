# Registration-only SMS

`BETTER_AUTH_REGISTRATION_SMS_REQUIRED` is false unless explicitly set to `true`.
It is separate from profile SMS opt-in and never enables phone login. Approved
Sent SMS credentials, template and channel are required before activation.
Missing SMS configuration fails only these endpoints and new signup; existing
email login remains available. Production also requires the signed BFF gate.

The registration flow calls `POST /api/auth/registration/phone/send` with email,
E.164 phone and explicit `registration-phone-v1` consent, then
`POST /api/auth/registration/phone/verify` with that email, phone, opaque flow ID
and six-digit code. Neither endpoint looks up whether a customer exists or
creates a user, MLM link, JWT or session. SMS permission is not marketing consent.

Only the BFF receives the opaque verification proof. It sets an HttpOnly browser
cookie and forwards that proof exclusively to `/sign-up/email`, together with
`vp_registration_phone_expected=<submitted E.164 phone>` in its signed upstream
Cookie header. The expected-phone cookie is server-to-server only, never a
browser Set-Cookie. The proof cookie is `__Secure-vp_registration_phone` for
HTTPS, or `vp_registration_phone` for explicitly local HTTP. The existing proxy
middleware verifies the complete Cookie header, body, IP and request path.

Signup compares the proof email and expected phone before its registration
policy query. The user-create hook atomically consumes it again immediately
before INSERT and sets verified phone fields from server proof only. Direct
client phone fields cannot override that result. Email must still be separately
verified; existing legacy identity approval is unchanged and never matches on
phone. Phone login/reset routes remain disabled.

Challenges use HMAC OTPs in `auth.verification`, five-minute deadlines, three
atomic attempts and recipient/IP/flow counters in `auth.rate_limit`. The opaque
signup proof is stored only under a keyed hash, expires five minutes after
successful SMS verification and is single-use. No migration 75 or SMS consent relation is needed.
Raw codes, proof tokens and provider responses must never be logged.
The account-wide safety cap admits at most 100 SMS requests and resets only
after 24 hours without an admitted request; this deliberately conservative
rolling-day ceiling cannot be bypassed by rotating IPs, emails or phones.
Provider failures still spend that cost budget and cannot trigger auto-retries.

If delivery, proof storage or signup fails, fail closed. A consumed proof is
never restored, including after a failed user INSERT: the applicant must start
new SMS verification. Provider sends are not automatically retried. Persistent
send cooldowns still apply after failures to avoid duplicate messages and abuse.

Tests cover Better Auth with an in-memory adapter and fake transport, plus the
signed BFF path. Run
`node src/auth/test-registration-phone-postgres.mjs --synthetic-docker` from `app`
for isolated PostgreSQL fixtures: the runner checks
atomic budgets, OTP attempts, one-use redemption and signup under row-lock
contention, with no external network or provider calls. It removes its temporary
Docker resources when finished.

Before activation, review the existing auth-role grants and test delivery only
to an explicitly authorized controlled recipient using an approved SMS template.
This source change does not run a production migration, send a real message or
enable production SMS.
