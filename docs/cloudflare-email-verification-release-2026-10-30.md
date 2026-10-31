# Email verification release — 2026-10-30 (America/Bogota)

Scope: first valid email-OTP response and persistent verification feedback in the member portal. No changes to permissions, legacy-account approval, network positions, ranks, financial rules, or provider enablement.

## Sources and production

- Backend source: `a5c76d3` (`fix(auth): verify canonical first-OTP response before confirming login`).
- Portal source: `1c2778a` (`fix(auth): confirm verified email before continuing to portal`).
- Core Worker: `b744b950-faab-42d6-bdb0-2aeca7907765`, active 100%.
- Portal Worker: `ec49743d-ce9c-4674-bf95-d05bf480f3ba`, active 100% on `mindblisspower.com`.
- API container: version 6, active 100%, image `registry.cloudflare.com/ed805ed2b05218b41fc1d4d2440e658e/mindbliss/api-first-otp-verified-20261030@sha256:97cceca907fa223b34a63d777491d305072582cfa9ccdd43cd019308d223ffd9`.
- API rollout `24fd5ed0-a0c1-4bef-b530-be43cbdc08c9`: completed, 1/1 healthy, zero errors; checked at `2026-10-31T02:49:10Z`.

Engine v1 (`d3519b1c…`), Payments v5 (`aa4f8df7…`), and Withdrawals v3 (`9e85980b…`) were not redeployed. Stripe remains disabled. NOWPayments IPN remains disabled; its private secret stays in Core only. Existing read-only policies and authentication/approval gates remain unchanged.

## Fix and proof

Better Auth 1.6.22 can return its original `emailVerified:false` user snapshot after persisting the first successful OTP verification. The portal correctly rejected that inconsistent response and discarded its cookies. The backend now corrects only this native success case after checking the new session, matching subject/token/recipient, and a fresh canonical verified user. An unavailable or inconsistent proof fails closed without delivering a session cookie. No verification or approval is fabricated.

The portal projects only `user.emailVerified:true` from a validated sign-in response. It displays “Correo verificado correctamente” without an immediate redirect, then separately checks the canonical session and matching email before offering continuation. Pending account linking remains a separate review state. Registration uses the same confirmation wording. Sending a message, URL flags, and failed/ambiguous responses never display verification success.

Validation:

- Backend isolated test image: 152 passed, 14 PostgreSQL-integration skips, zero failures; typecheck, migration-generation toolchain, and synthetic HTTP pentest passed. No production migration was applied.
- Real Better Auth detached-adapter → real portal BFF synthetic fixture: 105 assertions across 12 requests passed, including first OTP, wrong/replayed OTP, pending identity, and canonical-read failure. No real messages or provider calls.
- Portal: 419 tests passed, typecheck passed, changed-file lint passed with zero warnings/errors, independent security review passed.
- Built portal artifact: 54 workerd smoke probes passed with external networking disabled and zero database queries/messages. The exact tested image was exported for deployment; the previous local bundle was retained.
- Public production GET checks: portal login/registration and both portals' session/JWKS endpoints responded 200 with private/no-store authentication responses. Anonymous requests did not gain access. Published chunks contain the confirmation/actions and initial pages do not claim verification. Versioned assets remain immutable/public-cacheable.
- Disabled Stripe resume route still returns 303 to the packages page.

No production OTP was requested or redeemed during this release. Final mailbox/code entry must be performed by the user with a fresh code; never share codes or session cookies.

## Next release caution

Pin the current image digests before a scoped rollout. An older private API-only config may contain an obsolete Payments image and must not be reused as-is. Cloudflare application base metadata can lag completed rollouts: inspect weighted application versions plus the explicit rollout ID, not only the base version or a now-empty active-rollout pointer.
