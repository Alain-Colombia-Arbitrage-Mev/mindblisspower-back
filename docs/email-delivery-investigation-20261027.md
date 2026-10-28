# Email delivery investigation — 2026-10-27 (Bogotá)

## Confirmed findings

- Better Auth 1.6.22 catches sender exceptions. The old anonymous login response
  could be HTTP 200 after provider rejection, with no useful safe diagnostics.
  Keep login anti-enumeration; do not mistake the generic response for delivery.
- The administrative resend timer was 30 seconds, but the persistent recipient
  budget is five minutes. The updated UI prevents duplicate requests and honors
  the server deadline. Contacts and registration remain email-only for identity.
- A real administrative code request took about 7.1 seconds, close to the old
  eight-second BFF deadline. Bounded delivery deadlines now allow provider,
  database and Container startup; token exchange remains short. No retries.
- Cloudflare account, active zone, custom domains, enabled sending domain and
  required secret names were checked. The local email token verified active.
  Neither of the two explicitly authorized test addresses was suppressed.
- One authorized address has a verified access account; the other has no access
  account and cannot receive a login OTP by design. No account was auto-created.
- One plain diagnostic email was accepted into Cloudflare's queue. A real admin
  OTP request returned HTTP 200 and created one challenge in the canonical DB.
  No OTP/hash was read, copied, redeemed or exposed. One earlier client attempt
  failed before any observable challenge; a single manual recovery request was
  made after a read-only no-challenge guard. No automatic sends or retries.
- A subsequent metadata-only provider query filtered exactly the authorized
  administrative recipient and confirmed `delivered` at 23:06:42 Bogotá on
  October 27, with no technical error. This means acceptance by Gmail's mail
  server, not visibility in the inbox. The control message was accepted/queued,
  but a delivered event for it was not yet available. User inbox confirmation
  remains pending. No message preview, body, headers or OTP was inspected.

## Implementation

Auth transport classifies explicit rejections separately from ambiguous failures.
Confirmed rejections retire the exact challenge using parameterized predicates;
signup reports a recoverable pending-registration failure. Login remains generic
for privacy. The request-scoped state is isolated across concurrent requests.
Existing email proof, CAS attempt limits, financial gates and contacts survive.

Portal and admin have coordinated delivery deadlines, explicit manual recovery
and cooldown feedback without changing the design or private cache policies.
No SQL migration, role change, financial write, tree/rank update or Chatwoot work.

Verification: portal 390 tests plus typecheck and scoped ESLint passed. Admin
280 tests passed; the final exact-429 Retry-After adjustment separately passed
six focused helper tests and ESLint. Backend full suite passed 124 tests with
14 PostgreSQL-environment skips; the added exact-DELETE SQL regression also
passed, along with typecheck, toolchain generation and 24 isolated HTTP probes.
Docker/pinned-Linux and isolated PostgreSQL verification remain pending.

## Publication status

Source changes and automated verification are prepared. Publication of this fix
is **pending**, not claimed complete: Docker Desktop's Linux engine is unavailable
and reports an October 22 `com.docker.build.exe` process preventing startup.
No Docker data was deleted or reset, no database Container was removed, and no
old artifact was deployed as if it contained the fixes. The owner was asked to
restore Docker Desktop before the immutable API and portal builds are published.

When the engine is available: run the pinned Bun 1.4.4 Docker tests and isolated
PostgreSQL fixtures, build both portals, run offline Worker smoke and dry-runs,
then publish only the API image and portal Workers. Preserve the three Go image
digests and readiness gates; no full financial rollout. Confirm deployed versions
and perform read-only smoke checks. Do not send additional real email tests
without checking the owner's existing authorization and pending challenge state.

References checked: [Cloudflare REST send contract](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/),
[activity states](https://developers.cloudflare.com/email-service/observability/logs/),
[analytics](https://developers.cloudflare.com/email-service/observability/metrics-analytics/),
[Better Auth email OTP](https://better-auth.com/docs/plugins/email-otp).
