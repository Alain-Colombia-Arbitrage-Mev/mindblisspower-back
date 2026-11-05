-- Review-only additive migration. No contacts, OTPs, grants, business data or
-- existing identities are changed. Do NOT run via application startup.
-- Replace the explicit database guard only after reviewing target and roles.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('mindbliss-sms-auth-opt-in-v1', 0));
DO $$ BEGIN
  IF current_database() <> 'REPLACE_WITH_CURATED_DATABASE' THEN
    RAISE EXCEPTION 'sms_opt_in_explicit_database_review_required';
  END IF;
  IF to_regclass('auth.user') IS NULL THEN RAISE EXCEPTION 'sms_opt_in_auth_user_required'; END IF;
  IF to_regclass('auth.sms_opt_in') IS NOT NULL THEN RAISE EXCEPTION 'sms_opt_in_existing_shape_requires_review'; END IF;
END $$;

CREATE TABLE auth.sms_opt_in (
  id text PRIMARY KEY,
  user_id text NOT NULL UNIQUE REFERENCES auth.user(id) ON DELETE CASCADE,
  phone_number text NOT NULL CHECK (phone_number ~ '^\+[1-9][0-9]{7,14}$'),
  consent_version text NOT NULL CHECK (consent_version = 'sms-auth-v1'),
  consented_at timestamptz NOT NULL,
  verified_at timestamptz,
  revoked_at timestamptz,
  challenge_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (verified_at IS NULL OR (verified_at >= consented_at AND revoked_at IS NULL AND challenge_id IS NULL)),
  CHECK (challenge_id IS NULL OR verified_at IS NULL)
);
REVOKE ALL ON auth.sms_opt_in FROM PUBLIC;
-- Operator must grant only SELECT/INSERT/UPDATE on this relation to the
-- separately verified existing auth runtime role. No role names are guessed.
-- Then verify effective grants and only then set
-- BETTER_AUTH_SMS_OPT_IN_SCHEMA_READY=true. SMS delivery still additionally
-- requires BETTER_AUTH_PHONE_OTP_ENABLED=true and approved sent.dm SMS setup.
-- No existing customer is opted in or backfilled by this migration.
COMMIT;
