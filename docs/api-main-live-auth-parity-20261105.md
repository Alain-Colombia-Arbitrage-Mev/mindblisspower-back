# API MAIN: preserve already-live authentication protections

Date: 2026-11-05. Preparation only; this document does not deploy, migrate or enable a feature.

The release base is MAIN `02e8dec`, which reports login OTP delivery failures
without claiming delivery. A direct image replacement from that base would have
removed authentication protections and private OTP diagnostics already present
in the running API. The operator explicitly authorized preserving those narrow
features in MAIN before rebuilding the API.

## Provenance and exact scope

The reviewed reference is the committed API source at `f6654b9` in the existing
production-source checkout. That checkout and its branch are read-only inputs:
no branch merge, cherry-pick, Git mutation, copying of configuration, or copying
of financial code is performed. Each reference file is checked against its
committed content before the MAIN patch is generated with `apply_patch`.

Preserved runtime modules and composition:

- `app/src/server/admin-gate.ts`: live primary canonical subject/binding,
  verified email, current account restrictions and active admin status. A
  failed authority lookup returns a generic 503; a cookie role is not authority.
- `app/src/auth/otp-trace.ts`: opt-in, request-local pseudonymous OTP lifecycle
  events. It never logs or persists addresses, codes, passwords, sessions or
  provider IDs. Private observations are signed, bounded and never retried;
  failed telemetry cannot change authentication results.
- `app/src/auth/otp-diagnostic.ts` and
  `app/src/http/otp-diagnostic-routes.ts`: existing private readiness transport
  and bounded read-only diagnosis, with signed full-path context, native session,
  exact trusted Origin and live canonical admin checks. No public route or
  permission is added to Core.
- `app/src/auth.ts`, `app/src/auth/delivery.ts`,
  `app/src/auth/email-observation.ts` and `app/src/server.ts`: only the matching
  live composition and safe provider-message correlation.
- `app/src/auth/options.ts`: only trace request/error capture is composed into
  MAIN. MAIN's `AUTH_EMAIL_DELIVERY_UNAVAILABLE` behavior is retained: login
  delivery failures return 503, confirmed rejection removes only its exact
  challenge, and ambiguous outcomes retain a potentially received code.

The matching synthetic module/composition/admin-gate tests are retained with
those features. The existing HTTP pentest fixture is aligned with the canonical
primary SELECT (all writes and unrelated queries still fail), and proves that
an authority outage cannot reach mutation handlers. MAIN's current Resend and Cloudflare delivery-error tests,
email-only pending-access operator, SQL migrations, payment engine and manual
membership work are not replaced by reference-branch versions.

## Unchanged contracts and release boundaries

No dependency, Bun lock, Dockerfile, database schema, grant, customer row,
financial amount, tree position, rank, Core source, Worker binding, flag or
secret is changed by this patch. OTP requests are explicit; creating a pending
principal does not send a message or authenticate it. Recovery/ordinary email
verification retain their generic account-existence responses.

`AUTH_OTP_TRACE_ENABLED` stays opt-in and independent of provider-usage
monitoring. The trace target and HMAC protocol are identical to the already-live
Core contract. Readiness proves only transport and strict acknowledgement,
not email delivery or database capacity. Existing runtime settings and TLS
verification must be preserved by any later API-only rollout.

Build/test only from MAIN. Revalidate type checking, native OTP/recovery/race
fixtures, canonical admin-gate checks, private readiness/diagnosis and the HTTP
pentest with synthetic storage and `--network none` before publishing an image.
No production OTP or customer query is required by these tests.
