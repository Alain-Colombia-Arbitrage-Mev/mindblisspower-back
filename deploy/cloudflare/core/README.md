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

## Email-only registration and login

Registration requires email verification; login uses email. Telephone and
WhatsApp are optional, unverified customer contact data, never authentication
factors, identity-linking evidence, or permission to send marketing messages.
This Worker contains no SMS-provider forwarding path or configuration switch.

All `/api/auth/registration/*`, `/api/auth/phone-number/*` and
`/api/auth/sign-in/phone-number` requests return 404 before resolving any
Container. The namespace roots, queries, alternate methods and hosts, suffixes,
HTTP downgrades and encoded variants remain denied even with full core readiness
or obsolete SMS flags set to `true`. Old phone-proof cookies cannot reopen them.

The API Container always receives `BETTER_AUTH_PHONE_OTP_ENABLED=false`,
`BETTER_AUTH_SMS_OPT_IN_SCHEMA_READY=false` and
`BETTER_AUTH_REGISTRATION_SMS_REQUIRED=false` as defensive compatibility settings.
The Worker does not read or forward any `SENTDM_*` or `AUTH_SMS_*` values, even if
old provider secrets remain configured remotely. No SMS-consent schema or
migration 75 is required. Email/JWT gates, signed BFF context and read-only
financial restrictions are unchanged.

`worker-configuration.d.ts` is an ignored, generated local artifact, not a test
fixture. Regenerate it with `npm run types:staging` after changing Worker vars;
the email/infrastructure bindings are derived from `wrangler.jsonc`. Obsolete SMS
variables have been removed from both environments. Never put secret values into
a type stub or version the generated platform declarations. Unit tests require neither
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
