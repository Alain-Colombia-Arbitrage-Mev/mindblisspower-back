# Edge security release

## Authentication burst rule — active in the zone

On 2026-11-04 the user authorized production publication and activation. The
Cloudflare dashboard confirmed `Mindbliss auth burst v1` as **Active**, occupying
the one included rate limiting slot. No plan upgrade or managed-rule bypass was
made. The previous state was zero configured rate limiting rules.

`src/edge-auth-rate-limit.mjs` keeps the matching policy as a pure deployment
draft; importing it does not deploy anything. The dashboard generates its own
rule identity (the draft's `ref` is not asserted as the remote rule's identifier).
Future changes must inspect existing rules and update only this named rule;
never replace the entire ruleset.

- Thirty requests per source IP per Cloudflare data center in ten seconds.
- Block for ten seconds; no interactive challenge for API clients.
- Exact listed authentication paths only. Sessions, logout, payment endpoints,
  NOWPayments/Resend webhooks and public pages do not match.
- This is burst protection, not an exact quota or a replacement for the durable
  per-account limits (including recovery's five sends/ten validations per day).
- Shared-IP traffic can still reach the limit. Review legitimate traffic and
  rate-limit events; adjust conservatively, without disabling origin controls.
- The zone's Free plan only supports limited match fields. The draft uses Path,
  not Host/Method or response-based counting. Do not accept an upgrade prompt.
- Confirm the provider's response is HTTP 429 and the portal/admin display their
  retry message. Do not load-test production or send real OTP to trigger it.

Roll back by disabling only `Mindbliss auth burst v1`, not the managed protection.
Save the previous rule state before further edits. Local tests prove policy
scope only, not production enforcement or HTTP 429 delivery. No production
burst test, real OTP request or webhook mutation was performed to trigger it.

Official references:

- https://developers.cloudflare.com/waf/rate-limiting-rules/
- https://developers.cloudflare.com/waf/rate-limiting-rules/best-practices/

## Response headers

Portal/admin source now centralizes headers in `src/lib/security-headers.mjs`:

- Enforced framing/object/base restrictions, `nosniff`, referrer and feature policy.
- The stricter script/connect candidate is **report-only**; it does not claim
  complete XSS prevention and is not a nonce-based CSP. No external report endpoint
  receives private URLs or user data. Validate hydration before enforcing it.
- HSTS is staged at one day on the two exact production HTTPS hosts, without
  `includeSubDomains` or `preload`. It does not disable certificate validation.
- Static assets retain exact-file cache rules; dynamic/auth/API/error responses
  remain private and no-store. No credentials or user data may enter public cache.

Publishing the source is a separate release step. Verify 200 pages, redirects,
401/403/405/429/503 errors, static responses, cookies and mobile flows afterwards.
