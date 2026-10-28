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
  server, not visibility in the inbox. The owner subsequently confirmed that the
  control message to the other authorized address arrived in the inbox, not spam.
  No message preview, body, headers or OTP was inspected. No further real email
  tests were sent during publication.

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
281 tests passed, including the exact-429 Retry-After adjustment. The pinned
Linux Bun 1.4.4 image passed 125 tests, with 14 environment-dependent skips,
typecheck, toolchain generation and 24 isolated HTTP probes. Separate isolated
PostgreSQL fixtures passed: contacts 46 assertions, identity 12 tests / 114
assertions, and registration/blacklist 14 assertions. These used synthetic data,
no production credentials or real provider calls; all fixture Containers were
removed. Portal and admin workerd smoke passed 50 and 31 probes respectively,
with network disabled; the exported portal artifact also passed all 50 probes.

## Publication status

Published after the owner restored Docker Desktop. Its Linux engine 29.1.3 was
verified without resetting or deleting Docker data. All three production dry-runs
passed before publication; previous local portal artifacts were preserved under
each repository's ignored `.wrangler/artifacts-before-email-delivery-20261027`.

- Core Worker: `5eb1f63e-0d43-4583-87a4-97c189079a4b`.
- API application: version **4**, healthy, no rollout pending; source `c4345b2`.
- API image: `registry.cloudflare.com/ed805ed2b05218b41fc1d4d2440e658e/mindbliss/api-email-delivery-fix@sha256:5d7efe50df0b1d49bea63285b3e6be3d3e651dc82a515400321d5659c0b32934`.
- Portal Worker: `49d6c274-825d-4421-b6c5-2b2661214f68`, source `5195b4c`.
- Admin Worker: `df107b2a-2769-4cca-9f37-c9fd8fe86f3e`, source `960e8ca`.

The API-only rollout reported no changes to the three Go applications. Their
image digests, versions and update timestamps were compared before/after and are
identical; financial/readiness gates remain unchanged. Chatwoot was not touched.
Read-only production smoke passed 13 portal and 9 admin probes: login/register,
anonymous session/authorization, JWKS, CSRF, disabled phone auth, exact static
cache headers, ETag 304 and uncached missing assets. The four new JS chunks were
also retrieved successfully. No live account was created, no OTP redeemed, no
payment made and no additional email sent. These public probes do not substitute
for a human completing a fresh real registration.

References checked: [Cloudflare REST send contract](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/),
[activity states](https://developers.cloudflare.com/email-service/observability/logs/),
[analytics](https://developers.cloudflare.com/email-service/observability/metrics-analytics/),
[Better Auth email OTP](https://better-auth.com/docs/plugins/email-otp).
