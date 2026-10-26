# Private Cloudflare core

Production exposes no public URL, `workers.dev`, previews or direct Go ports.
The two public portal Workers reach this Worker using `CORE_API` service bindings.
Chatwoot is not deployed or connected here.

The production release enables email authentication and read-only Go reports. `AUTH_SERVICES_ENABLED`,
`AUTH_CUTOVER_VERIFIED` and `CORE_DATA_ACCESS_VERIFIED` allow an exact route list for
OTP, session, token, public keys and internal API health. This does not assert Go
network readiness or financial correctness. Staging remains closed.

`CORE_REPORTS_ENABLED=true` permits only HTTP reads to payments/withdrawals after
three restricted database logins and real private Cloudflare health/JWKS startup
checks passed. `SERVICE_READ_ONLY=true` adds an exact handler allowlist, disables
providers and all jobs, and does not forward Stripe/BMP credentials. Superadmin
allowlists are explicit private configuration, never legacy hardcoded defaults.

`CORE_SERVICES_ENABLED=false` and `CORE_NETWORK_VERIFIED=false` keep full Bun/Go
business transport closed; gRPC has passed local real-Go mTLS tests, not remote
production RPC certification. A named status-only readiness RPC can be enabled
temporarily for an owner-authenticated local caller; its gate stays off normally.
Financial mutations and jobs have additional guards. Publishing a Container is
not confirmation that checkout, payouts, compensation or historical settlements work.
Do not remove the canonical Stripe evidence to bypass an operational guard.

Database authentication has a dedicated restricted writer; business reads use a
different restricted role. Canonical public identifiers preserve existing network
positions. Legacy accounts require approved identity linking after email verification;
an email match alone never claims an existing person or tree node.

Secrets are provisioned outside Git and are mapped explicitly per Container.
Never deploy an administrative/shared database credential. Production mTLS uses
separate server/client leaves, with its CA private key kept outside application
services. Rotate the90-day leaves before their expiry.

## Optional SMS verification

Email stays the registration/login authority. SMS is a separately consented,
authenticated profile opt-in, not SMS login, marketing permission, signup,
identity linking, or permission to move a network node. No automatic WhatsApp
fallback or message retry is configured.

Both `AUTH_SMS_OPT_IN_ENABLED` and `AUTH_SMS_OPT_IN_SCHEMA_READY` default to the
literal string `false` in staging and production. Nothing here applies a schema
migration, provisions provider secrets, enables SMS, or changes a financial gate.
An operator must first review and apply additive auth migration 75, verify its
restricted auth-role grants and backups, then assert schema readiness. Until
readiness is `true`, the API status handler never queries `auth.sms_opt_in`.

The API Container receives `BETTER_AUTH_SMS_OPT_IN_SCHEMA_READY=true` only when
both `AUTH_CUTOVER_VERIFIED` and `AUTH_SMS_OPT_IN_SCHEMA_READY` are exactly `true`.
This permits current-consent status/revocation even with SMS sending disabled or
provider configuration missing. Auth status does not require a financial JWT.
Only these additional exact routes are accepted by the existing private auth
release: `GET /api/auth/phone-number/opt-in` and `POST` to
`/api/auth/phone-number/send-otp`, `/api/auth/phone-number/verify`, and
`/api/auth/phone-number/revoke-consent`. Better Auth requires a verified email
session and explicit consent before sending; schema/provider gates remain in
the backend. Other phone login/reset routes remain closed.

Sending additionally requires `AUTH_SMS_OPT_IN_ENABLED=true` and validated
private `SENTDM_API_KEY` (nonblank, no whitespace), an operator-approved
`SENTDM_OTP_TEMPLATE_ID` (nonzero UUID), and `SENTDM_OTP_CHANNEL=sms`. Optional
`SENTDM_PROFILE_ID` must be a nonzero UUID; `SENTDM_OTP_PARAMETER` defaults to
`code` and permits only 1–64 letters, digits or underscores. Approval of the
template and sender must be checked with Sent.dm separately: valid UUID syntax
is not evidence of approval or delivery. Only this explicit allowlist reaches
the API Container; Go services receive no SMS credentials. Missing/malformed SMS
configuration sets `BETTER_AUTH_PHONE_OTP_ENABLED=false` without disabling email.
Revoking consent is still allowed after the provider has been switched off.

`worker-configuration.d.ts` is an ignored, generated local artifact, not a test
fixture. Regenerate it with `npm run types:staging` after changing Worker vars;
the two SMS flags are derived from `wrangler.jsonc`. If local secret typing is
needed, use a separate local `Cloudflare.Env` interface augmentation with optional
string fields for `SENTDM_API_KEY`, `SENTDM_OTP_TEMPLATE_ID`, `SENTDM_OTP_CHANNEL`,
`SENTDM_PROFILE_ID` and `SENTDM_OTP_PARAMETER`. Never put secret values into that
stub or version the generated platform declarations. Unit tests require neither
generated types nor provider credentials and run from a fresh checkout.

```sh
npm ci --ignore-scripts
npm test
npm run check:production
# Worker-only changes must not rebuild or replace the published Container images:
npx --no-install wrangler deploy --env production --containers-rollout none
```

Schema/policy scripts are explicit operator artifacts, not startup migrations.
Apply only reviewed target-specific scripts with verified encrypted backups and
post-checks. No global/default database grants or automatic financial backfills.
