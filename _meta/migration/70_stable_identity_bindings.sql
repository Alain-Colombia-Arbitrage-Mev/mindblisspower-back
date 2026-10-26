-- PREPARED ONLY: additive identity migration. Never runs on application startup.
-- Review privileges, existing Better Auth table shapes and a backup before use.
-- The bounded transaction deliberately fails on duplicate OAuth identities;
-- operators must resolve/quarantine those records, never delete them here.
-- Adding a nullable UUID first avoids an ADD COLUMN volatile-default rewrite.
-- Existing person IDs, affiliate IDs, ranks, sponsor/parent, path and PV are untouched.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SELECT pg_advisory_xact_lock(hashtextextended('stable-identity-v1', 0));

ALTER TABLE mlm.person ADD COLUMN IF NOT EXISTS public_id uuid;
ALTER TABLE mlm.person ALTER COLUMN public_id SET DEFAULT gen_random_uuid();
UPDATE mlm.person SET public_id = gen_random_uuid() WHERE public_id IS NULL;
ALTER TABLE mlm.person ALTER COLUMN public_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS person_public_id_unique ON mlm.person(public_id);

-- Existing snake_case Better Auth adapter mappings remain authoritative.
ALTER TABLE auth.user ADD COLUMN IF NOT EXISTS image text;
ALTER TABLE auth.user ADD COLUMN IF NOT EXISTS phone_number text;
ALTER TABLE auth.user ADD COLUMN IF NOT EXISTS phone_number_verified boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS auth_user_phone_unique ON auth.user(phone_number);

CREATE TABLE IF NOT EXISTS auth.session (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth.user(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_session_user_idx ON auth.session(user_id);
CREATE INDEX IF NOT EXISTS auth_session_expiry_idx ON auth.session(expires_at);

CREATE TABLE IF NOT EXISTS auth.account (
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
CREATE UNIQUE INDEX IF NOT EXISTS auth_account_provider_subject_unique ON auth.account(provider_id, account_id);
CREATE INDEX IF NOT EXISTS auth_account_user_idx ON auth.account(user_id);

CREATE TABLE IF NOT EXISTS auth.verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_verification_identifier_idx ON auth.verification(identifier);
CREATE INDEX IF NOT EXISTS auth_verification_expiry_idx ON auth.verification(expires_at);

-- Better Auth 1.6 JWT/database-rate-limit plugin shapes, inactive unless enabled.
CREATE TABLE IF NOT EXISTS auth.jwks (
  id text PRIMARY KEY,
  public_key text NOT NULL,
  private_key text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz
);
CREATE TABLE IF NOT EXISTS auth.rate_limit (
  id text PRIMARY KEY,
  key text NOT NULL UNIQUE,
  count integer NOT NULL CHECK (count >= 0),
  last_request bigint NOT NULL CHECK (last_request >= 0)
);

CREATE SCHEMA IF NOT EXISTS identity;
REVOKE ALL ON SCHEMA identity FROM PUBLIC;

-- One Better Auth principal per business person. OAuth providers are linked to
-- that principal by auth.account, not additional person rows or email matches.
CREATE TABLE IF NOT EXISTS identity.auth_binding (
  subject text PRIMARY KEY REFERENCES auth.user(id) ON DELETE RESTRICT,
  provider text NOT NULL DEFAULT 'better_auth' CHECK (provider = 'better_auth'),
  person_id bigint NOT NULL UNIQUE REFERENCES mlm.person(id) ON DELETE RESTRICT,
  link_method text NOT NULL CHECK (link_method IN ('new_registration', 'legacy_user_id', 'approved_claim', 'single_use_invite')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Approval records are the minimal identity history. Only a token hash is kept;
-- no email copy, token plaintext, provider payload or tree snapshot is stored.
CREATE TABLE IF NOT EXISTS identity.legacy_claim_grant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id bigint NOT NULL REFERENCES mlm.person(id) ON DELETE RESTRICT,
  subject text NOT NULL REFERENCES auth.user(id) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE CONSTRAINT legacy_claim_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CONSTRAINT legacy_claim_kind CHECK (kind IN ('approved_claim', 'single_use_invite')),
  approved_by_subject text NOT NULL REFERENCES auth.user(id) ON DELETE RESTRICT,
  approved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CONSTRAINT legacy_claim_expiry CHECK (expires_at > approved_at),
  consumed_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT legacy_claim_two_party CHECK (approved_by_subject <> subject),
  CONSTRAINT legacy_claim_consumption_time CHECK (consumed_at IS NULL OR consumed_at >= approved_at),
  CONSTRAINT legacy_claim_not_consumed_and_revoked CHECK (revoked_at IS NULL OR consumed_at IS NULL)
);
CREATE INDEX IF NOT EXISTS legacy_claim_person_idx ON identity.legacy_claim_grant(person_id);
CREATE INDEX IF NOT EXISTS legacy_claim_subject_idx ON identity.legacy_claim_grant(subject);
CREATE INDEX IF NOT EXISTS legacy_claim_approver_idx ON identity.legacy_claim_grant(approved_by_subject);
CREATE INDEX IF NOT EXISTS legacy_claim_open_expiry_idx ON identity.legacy_claim_grant(expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS identity.link_conflict (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject text NOT NULL REFERENCES auth.user(id) ON DELETE RESTRICT,
  candidate_person_id bigint REFERENCES mlm.person(id) ON DELETE RESTRICT,
  reason text NOT NULL CONSTRAINT identity_link_conflict_reason CHECK (reason IN ('legacy_claim_required', 'identity_collision', 'person_unavailable', 'invalid_claim', 'stripe_customer_collision')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE NULLS NOT DISTINCT (subject, candidate_person_id, reason)
);
CREATE INDEX IF NOT EXISTS identity_conflict_person_idx ON identity.link_conflict(candidate_person_id);

-- Customer IDs are scoped to the Stripe account AND test/live mode. Nothing is
-- linked by an email in a webhook, and this migration never contacts Stripe.
CREATE TABLE IF NOT EXISTS identity.stripe_customer (
  account_id text NOT NULL CONSTRAINT stripe_account_id_format CHECK (account_id ~ '^acct_[A-Za-z0-9]+$'),
  livemode boolean NOT NULL,
  customer_id text NOT NULL CONSTRAINT stripe_customer_id_format CHECK (customer_id ~ '^cus_[A-Za-z0-9]+$'),
  person_id bigint NOT NULL REFERENCES mlm.person(id) ON DELETE RESTRICT,
  linked_by_subject text NOT NULL REFERENCES auth.user(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, livemode, customer_id),
  UNIQUE (account_id, livemode, person_id)
);
CREATE INDEX IF NOT EXISTS stripe_customer_person_idx ON identity.stripe_customer(person_id);
CREATE INDEX IF NOT EXISTS stripe_customer_actor_idx ON identity.stripe_customer(linked_by_subject);

-- Preserve only already-explicit user_id relations; NEVER backfill from email.
INSERT INTO identity.auth_binding(subject, person_id, link_method)
SELECT p.user_id, p.id, 'legacy_user_id' FROM mlm.person p
JOIN auth.user u ON u.id = p.user_id
WHERE p.user_id IS NOT NULL
ON CONFLICT (subject) DO NOTHING;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM identity.auth_binding b JOIN mlm.person p ON p.id = b.person_id
             WHERE p.user_id IS DISTINCT FROM b.subject) THEN
    RAISE EXCEPTION 'identity_binding_conflict_requires_review';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION identity.protect_public_id() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.public_id IS DISTINCT FROM NEW.public_id THEN
    RAISE EXCEPTION 'person_public_id_is_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS person_public_id_immutable ON mlm.person;
CREATE TRIGGER person_public_id_immutable BEFORE UPDATE OF public_id ON mlm.person
  FOR EACH ROW EXECUTE FUNCTION identity.protect_public_id();

CREATE OR REPLACE FUNCTION identity.protect_auth_binding() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.subject IS DISTINCT FROM NEW.subject OR OLD.provider IS DISTINCT FROM NEW.provider
     OR OLD.person_id IS DISTINCT FROM NEW.person_id OR OLD.link_method IS DISTINCT FROM NEW.link_method THEN
    RAISE EXCEPTION 'auth_binding_is_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS auth_binding_immutable ON identity.auth_binding;
CREATE TRIGGER auth_binding_immutable BEFORE UPDATE ON identity.auth_binding
  FOR EACH ROW EXECUTE FUNCTION identity.protect_auth_binding();

-- Do not broaden default PUBLIC access. The auth runtime needs its own writer
-- role; operators approve claims using app_admin, not a browser or an email match.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_read') THEN
    REVOKE ALL ON auth.jwks FROM app_read;
    GRANT USAGE ON SCHEMA identity TO app_read;
    GRANT SELECT ON identity.auth_binding, identity.stripe_customer TO app_read;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_write') THEN
    GRANT USAGE ON SCHEMA identity TO app_write;
    GRANT SELECT, INSERT ON identity.auth_binding, identity.stripe_customer TO app_write;
    GRANT SELECT, INSERT, UPDATE ON identity.link_conflict TO app_write;
    GRANT SELECT ON identity.legacy_claim_grant TO app_write;
    GRANT UPDATE(consumed_at) ON identity.legacy_claim_grant TO app_write;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA identity TO app_write;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN
    GRANT USAGE ON SCHEMA identity TO app_admin;
    GRANT ALL ON ALL TABLES IN SCHEMA identity TO app_admin;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA identity TO app_admin;
  END IF;
END $$;
COMMIT;
