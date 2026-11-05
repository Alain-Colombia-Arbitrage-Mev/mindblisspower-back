# Email opt-in and optional customer contacts

The public signup flow verifies email ownership only. Email verification is
mandatory before email login; signup and verification do not create a session.
Registration SMS send/verify and telephone login are unavailable even if a
stale `BETTER_AUTH_REGISTRATION_SMS_REQUIRED` environment variable remains set.
No sent.dm configuration or migration 75 is required for this release.

`POST /api/auth/sign-up/email` accepts optional `contactPhone` and
`contactWhatsapp`, each a canonical E.164 string. The UI collects country code
and a friendly national number, then normalizes them. The backend independently
checks `libphonenumber-js/min` metadata, possible length, canonical form and the
absence of extensions. Omit empty fields. Contacts are not verified and are not
SMS/WhatsApp authentication or marketing consent.

Migration 76 adds nullable, non-unique text columns `auth.user.contact_phone_e164`
and `auth.user.contact_whatsapp_e164`. Apply the reviewed migration before the
runtime release: Drizzle reads the user schema during email login. The migration
has an explicit database guard and bounded locks, does not create roles, and
only grants these columns to the existing restricted auth group. It aborts if
the known member readers inherit access to the new private values. No existing
phone, user, network node, rank, sale or commission is backfilled or overwritten.

Both fields belong to the authenticated subject and are excluded from Better
Auth signup/user/session response bodies. They do not use the unique verified
authentication `phone_number` field. Unverified contacts cannot reserve a phone
number or automatically claim a legacy account. After verified email, only a
newly created `mlm.person` receives that subject's contact phone. Existing and
legacy people keep their stored phone; WhatsApp remains on the subject's customer
record and is reachable by an authorized user-id relationship, not phone matching.

Run `bun --no-env-file test` and
`node src/auth/test-email-contact-postgres.mjs --synthetic-docker` from `app`.
The PostgreSQL fixture is isolated, uses synthetic data and no external network,
and is removed after the test. No real email/SMS/WhatsApp is sent.
