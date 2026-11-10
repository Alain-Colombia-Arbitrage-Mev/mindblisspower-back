# Private OTP support telemetry

`CORE_AUTH_TRACE_ENABLED` is enabled in production and disabled in staging. It is independent of
`CORE_OBSERVABILITY_ENABLED`; enabling traces never enables Usage, Workers or
PlanetScale provider collection. No new Cloudflare resource or SQL relation is
created. Existing API Durable Object storage contains pseudonymous telemetry.

## Envelope and strict contracts

Only API-container egress may POST `/v1/trace` or `/v1/probe` to
`https://observability.core.internal`. It uses the existing observation HMAC:
`HMAC-SHA256(API_BFF_SHARED_SECRET, method + "\n" + path + "\n" + timestamp +
"\n" + SHA256(rawBody))`, with `x-vp-observation-timestamp` and
`x-vp-observation-signature`. A signed envelope is valid for sixty seconds.
No cookie, query, redirect, alternative host or compressed body is accepted.

Trace fields: `version:1`, UUIDv4 `id` and `request_id`, canonical ISO
`occurred_at`, lowercase HMAC64 `recipient_ref`, `purpose` (`sign-in`,
`email-verification`, `password-reset`), and `stage` (`requested`, `blocked`,
`throttled`, `registration_required`, `send_accepted`, `send_rejected`,
`send_unknown`, `validation_succeeded`, `validation_failed`, `request_failed`).
Optional fields are HMAC64 `message_ref` and integer `http_status` 100–599.
Trace event time must be within ten minutes of receipt.

The portal-only `PrivateEmailTelemetry.recordDelivery(event)` RPC accepts only
`version:1`, HMAC64 `id` derived from Svix ID, canonical ISO `occurred_at`,
HMAC64 `message_ref` derived from the provider message ID, and `event_type`:
`email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`,
`email.complained`, `email.failed`, `email.suppressed`. The portal must first
verify the webhook signature and project/hash fields. Core independently
validates and signs the private storage request. `{recorded:true}` is returned
only after the storage transaction commits. A storage/transport/configuration
failure throws, so the portal must not acknowledge durable recording.

Raw recipients, OTPs, provider IDs, session tokens, passwords, free-text errors,
message contents and arbitrary fields are never accepted or returned.

## Retention, ordering and coverage

Primary event retention is **up to fourteen days**, globally capped at 10,000
events. Reads exclude expired entries immediately. Bounded pruning removes
expired primary records and their indexes during writes, reads and the existing
five-minute cron; inactive/large backlogs are removed in bounded batches, not
with an unbounded scan. Aggregate counters have separate bounded housekeeping.

IDs deduplicate concurrent/retried delivery events. Message-to-request mappings
associate callbacks arriving before or after the send observation. One provider
message cannot be reassigned to another recipient/request. A repeated callback
type for the same message increments its delivery-state counter only once.

Capacity eviction sets `coverage.limited`; delivery counters become unknown
instead of claiming completeness after deduplication history was truncated.
Accepted sends, delivery observations and actual provider Usage remain separate.
No zero delivery count is returned before callback tracking begins.

`PrivateCoreProbe.authTrace({recipient_ref})` is available only through the
existing admin binding (the admin BFF must independently verify its live role).
It returns at most twenty newest entries, without any recipient/message/request
references: `{version:1, enabled, coverage:{started_at, retained_since,
retention_days:14, limited}, events:[{kind:'auth',occurred_at,purpose,stage,
http_status?}|{kind:'delivery',occurred_at,event_type}]}`. Disabled traces return
`enabled:false` with unknown dates and no events; failures are not empty success.

## Local alerts and activation

With only tracing enabled, the operational snapshot exposes local delivery
counts and in-app failure alerts, while quotas and capacity remain unknown and
`monitor.enabled:false` continues to describe provider monitoring. Three failed
requests in recent five-minute buckets, any throttled/429 observation, or a
delivery bounce/failure/suppression/complaint can alert. Multiple failure stages
of the same request do not become several failed requests. Configuration errors
also participate in the original observer's failure alert. Alerts are **in app
only**; no email, SMS, push, provider request or financial mutation is generated.

Before activation, use the zero-argument private
`authTraceTransportReadiness()` RPC. It sends one fixed full-path-HMAC POST `{}`
to Bun `/internal/otp-trace-readiness` with fixed loopback client context, no
cookie or user, and checks the Bun-to-DO TLS probe ACK. `/v1/probe` never reads or
writes durable storage. This path is not in generic Core gateway allowlists.
The real TLS/CA probe must pass before publishing portal webhook recording or
claiming telemetry active. Never weaken CA validation to make the probe pass.
The fixed Bun probe permits up to fifteen seconds for container startup; the
Bun-to-DO call remains bounded to two seconds and storage calls to three.
No OTP request deadline, email retry or provider fallback is changed.

The new admin diagnostic transport permits only signed native-session JSON
`{email}` POSTs to `https://auth.core.internal/api/admin/auth/otp-diagnostic`,
bounded to 2 KiB. Bun independently validates the full-path HMAC, trusted origin,
native cookie and current canonical administrator role. No broader admin,
identity, provider, payment or withdrawal write is opened.
