# Email registration and contact storage — 2026-10-26

Implementation: `e6df13d`; portal implementation: `5e010c2`.

## Production state

- Reviewed migration 76 applied to `mindbliss_curated_20261025` before publishing
  the runtime. Explicit target fingerprint:
  `75af2c5f4cf0b89c36b5d55460f26ad136055ecf81c8330f3f8d28abc92cd1c9`.
- Migration source SHA-256 at execution:
  `62b941d17c6be47f5c3615ccd1b533b6b421d24938e5ed4e4db40f97256cbed3`.
- Added only `auth.user.contact_phone_e164` and `contact_whatsapp_e164`: nullable
  text, no defaults, no uniqueness, no backfill. Verified auth group SELECT,
  INSERT and UPDATE; both known member reader roles have no access. No role
  creation, business-row inspection or existing customer updates.
- Core Worker: `14ee2477-ee3e-4942-9ad7-d4c51422fbbc`.
- API application version 3; image digest
  `sha256:eb645562fb8a4bcfb510ae97c3a010b95afe5e7c7bb6701b81f0eec359f9bacc`.
  Authoritative `containers info` confirms the new image and no active rollout.
- Portal Worker: `e6bea468-302c-4d2b-8452-b67b30cb4c75`.
- Only the API image changed. Engine version 1, Payments version 4 and Withdrawals
  version 3 retained their application IDs, image digests and modification times;
  deploy output confirmed no changes to each. Existing financial readiness gates
  were preserved. Chatwoot and the administrative application were not deployed.

The operator credential is separate from application credentials. Its configured
default database is `postgres`; metadata confirmed ownership and CONNECT for the
explicit curated target on the same TLS-verified host and port. The one-time
runner selected only that reviewed target in memory, without editing any `.env`
file. No credentials are recorded here.

## Verification

- Bun 1.4.4 Docker: 118 passing tests, 994 assertions; 14 existing environment-
  gated omissions. Typecheck, schema generation and HTTP security checks passed.
- Isolated PostgreSQL contact fixture: 46 assertions. Isolated identity fixture:
  12 tests / 114 assertions. Reader-denial and transactional migration guards,
  email verification, canonical contact persistence, shared contact numbers,
  legacy-account non-linking, OTP concurrency and unchanged network data passed.
- Core: 35 tests, types, deployment dry-runs and both PostgreSQL role/identity
  rehearsals passed. No SMS credentials are forwarded; removed telephone auth
  namespaces return 404 before Container resolution, even with obsolete flags.
- Portal: 381 tests and typecheck passed; offline built-Worker smoke passed 50
  probes with external networking disabled and zero database/provider calls.
- Production: 19 public probes passed for the email/contact UI, disabled SMS,
  anonymous access denial, origin checks, private no-store, public static TTLs,
  conditional ETags and admin login availability. A further JWKS read returned
  200 with one public key. No real registration or email/SMS/WhatsApp was sent.

Email verification activates access, not marketing consent. Contact fields are
unverified, excluded from auth responses and cannot reserve an auth phone, link
a legacy identity, change network positions or authorize money movements.

## Recovery

If rollback is needed, restore the prior portal before the prior API image so no
new form submits contacts to an older runtime that ignores them. The additive
nullable columns can remain; do not drop contact data as part of a code rollback.
Keep the restricted reader ACLs. Previous images and Worker versions are retained.
