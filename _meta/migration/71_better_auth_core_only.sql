-- Operator-reviewed, additive Better Auth 1.6.22 / Drizzle auth.ts schema.
-- Core auth only. Does NOT apply migration 70, backfill identities, alter mlm,
-- link users by email, generate keys/codes, send messages, or enable login.
-- Stop on an unexpected existing shape instead of silently accepting drift.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('mindbliss-better-auth-core-v1', 0));
DO $$
DECLARE relation_name text;
BEGIN
  IF current_database() <> 'REPLACE_WITH_CURATED_DATABASE' THEN
    RAISE EXCEPTION 'auth_core_explicit_database_review_required';
  END IF;
  IF to_regclass('auth.user') IS NULL THEN RAISE EXCEPTION 'auth_core_existing_user_required'; END IF;
  IF (SELECT relkind FROM pg_class WHERE oid='auth.user'::regclass) <> 'r'
      OR EXISTS (SELECT 1 FROM pg_rewrite WHERE ev_class='auth.user'::regclass AND rulename <> '_RETURN') THEN
    RAISE EXCEPTION 'auth_core_existing_user_rules_or_kind_require_review';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='auth.user'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'auth_core_existing_user_trigger_requires_review';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE c.contype='f' AND c.confrelid='auth.user'::regclass AND n.nspname <> 'auth'
        AND (c.confdeltype NOT IN ('a','r') OR c.confupdtype NOT IN ('a','r'))) THEN
    RAISE EXCEPTION 'auth_core_business_cascade_requires_review';
  END IF;
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid='auth.user'::regclass
      AND attnum>0 AND NOT attisdropped) <> 6 THEN
    RAISE EXCEPTION 'auth_core_existing_user_shape_requires_review';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='auth.user'::regclass
      AND attnum>0 AND NOT attisdropped AND attname IN ('image','phone_number','phone_number_verified')) THEN
    RAISE EXCEPTION 'auth_core_existing_plugin_columns_require_review';
  END IF;
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid='auth.user'::regclass AND attnum>0 AND NOT attisdropped
      AND ((attname IN ('id','email','name') AND atttypid='text'::regtype)
        OR (attname='email_verified' AND atttypid='boolean'::regtype)
        OR (attname IN ('created_at','updated_at') AND atttypid='timestamptz'::regtype))) <> 6 THEN
    RAISE EXCEPTION 'auth_core_existing_user_shape_requires_review';
  END IF;
  FOREACH relation_name IN ARRAY ARRAY['auth.session','auth.account','auth.verification','auth.jwks','auth.rate_limit'] LOOP
    IF to_regclass(relation_name) IS NOT NULL THEN RAISE EXCEPTION 'auth_core_existing_table_requires_review'; END IF;
  END LOOP;
END $$;

ALTER TABLE auth.user ADD COLUMN image text;
ALTER TABLE auth.user ADD COLUMN phone_number text;
ALTER TABLE auth.user ADD COLUMN phone_number_verified boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX auth_user_phone_unique ON auth.user(phone_number);

CREATE TABLE auth.session (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth.user(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_session_user_idx ON auth.session(user_id);
CREATE INDEX auth_session_expiry_idx ON auth.session(expires_at);

CREATE TABLE auth.account (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth.user(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX auth_account_provider_subject_unique ON auth.account(provider_id, account_id);
CREATE INDEX auth_account_user_idx ON auth.account(user_id);

CREATE TABLE auth.verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_verification_identifier_idx ON auth.verification(identifier);
CREATE INDEX auth_verification_expiry_idx ON auth.verification(expires_at);

CREATE TABLE auth.jwks (
  id text PRIMARY KEY,
  public_key text NOT NULL,
  private_key text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz
);
CREATE TABLE auth.rate_limit (
  id text PRIMARY KEY,
  key text NOT NULL UNIQUE,
  count integer NOT NULL CHECK(count >= 0),
  last_request bigint NOT NULL CHECK(last_request >= 0)
);
COMMIT;
