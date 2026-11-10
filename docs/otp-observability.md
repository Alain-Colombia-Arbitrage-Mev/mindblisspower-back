# OTP diagnostics and delivery telemetry

The administrator's **Salud de acceso (OTP)** screen uses Better Auth, not the
legacy Cognito directory. Its manual, same-origin POST is a privileged read:
the BFF and API independently check the administrator's current identity.
The SQL snapshot is parameterized, read-only and bounded. It does not read
password hashes, session tokens or OTP values and cannot change an account.

## Separate capabilities

- `CORE_AUTH_TRACE_ENABLED` enables bounded pseudonymous authentication and
  signed delivery-event history in the existing API Durable Object. The API
  receives `AUTH_OTP_TRACE_ENABLED`. The portal uses `RESEND_TRACE_ENABLED` and
  a write-only `PrivateEmailTelemetry` service binding for verified webhooks.
- `CORE_OBSERVABILITY_ENABLED` enables reads of official provider quota and
  capacity metrics. This remains independent: missing credentials are unknown,
  not healthy. Do not substitute send credentials or the application DB role.
- `CORE_HTTP_EGRESS_STRICT_ENABLED` remains false. Trace transport uses only the
  fixed private HTTPS observation host, signed envelopes and the injected CA;
  it does not enable a catch-all egress handler or relax TLS verification.

Use the private, zero-argument `authTraceTransportReadiness()` probe to verify
the real Bun-to-Durable-Object HTTPS path after the API rollout. The probe sends
no email, touches no customer table and persists no synthetic delivery. Do not
claim a successful production trace transport based only on a local unit test.
The fixed private readiness check allows up to fifteen seconds for a cold API
container, without extending OTP request deadlines or retrying an email.

## Data and guarantees

Recipient and provider-message references are domain-separated HMAC-SHA256
values derived server-side; they are pseudonymous references, not encryption.
No recipient, subject, OTP, password, cookie, provider response or raw provider
identifier is stored in this history or emitted in diagnostic logs. Reference
values never cross the administrative BFF into the browser.

History is retained for **up to 14 days**, with a global bound of 10,000 events
and a maximum of 20 events returned per manual lookup. Capacity truncation is
explicitly marked as limited; absent events are not proof of no prior send.
Expired metadata is excluded from reads, with bounded housekeeping on writes
and the existing five-minute schedule. No PlanetScale telemetry table is added.

Resend callbacks are verified against the exact raw bytes and Svix signature
before any durable operation. Event IDs deduplicate callback retries; provider
message references correlate callbacks even when delivery precedes the API ACK.
A failed durable write returns 503, not a false success. Authentic callbacks
outside retention are acknowledged as ignored, not counted as new deliveries.
Authentication observation failure never retries an email, changes provider,
revokes an accepted code or alters native status/cookies. Local failure alerts
are in-app only, not email/SMS/push notifications.

`email.sent` means accepted for sending; `email.delivered` means accepted by the
recipient's mail server, not inbox placement, reading or identity verification.
Only the native OTP redemption flow establishes email possession. A verified
email alone does not replace network binding or administrator authorization.

## Official quota/capacity access still required

Configure these separately without pasting values into chat or committing them:

- `RESEND_MONITOR_API_KEY`: permission to read Usage; not the send-only key.
- `CLOUDFLARE_MONITOR_API_TOKEN`: read-only analytics for the selected account.
- `PLANETSCALE_MONITOR_SERVICE_TOKEN_ID`, `PLANETSCALE_MONITOR_SERVICE_TOKEN`,
  `PLANETSCALE_MONITOR_ORGANIZATION`, `PLANETSCALE_MONITOR_DATABASE`,
  `PLANETSCALE_MONITOR_BRANCH`: read_branch access to the intended branch.

Run the existing read-only `operational-check.mjs` before enabling provider
monitoring. Cloudflare Email's administrator-declared budget is 200/day;
Resend's declared budget is 50,000/month. Provider Usage, when available, takes
precedence. Local observations are neither account-wide usage nor billing data.

References: [Resend event types](https://resend.com/docs/webhooks/event-types),
[Better Auth hooks](https://better-auth.com/docs/concepts/hooks),
[Durable Object storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/).
