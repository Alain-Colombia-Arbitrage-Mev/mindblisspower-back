-- PREPARED ONLY. Additive, non-financial identity capability for a Better Auth
-- subject to prove ownership of exactly one EVM wallet. Apply explicitly to the
-- reviewed primary database before publishing the matching API container.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('reown-wallet-binding-v1',0));

DO $preflight$
BEGIN
  IF pg_catalog.current_database()<>'mindbliss_curated_20261025' OR pg_catalog.pg_is_in_recovery() THEN
    RAISE EXCEPTION 'wallet_binding_explicit_primary_review_required';
  END IF;
  IF pg_catalog.to_regclass('identity.wallet_binding') IS NOT NULL
    OR pg_catalog.to_regclass('identity.wallet_link_challenge') IS NOT NULL THEN
    RAISE EXCEPTION 'wallet_binding_requires_fresh_review';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='mindbliss_auth_core_v1'
    AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolreplication AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'wallet_binding_scoped_auth_role_required';
  END IF;
END $preflight$;

CREATE TABLE identity.wallet_link_challenge (
  id uuid PRIMARY KEY,
  subject text NOT NULL REFERENCES auth."user"(id) ON DELETE RESTRICT,
  person_id bigint NOT NULL REFERENCES mlm.person(id) ON DELETE RESTRICT,
  chain_id smallint NOT NULL CONSTRAINT wallet_link_challenge_chain CHECK (chain_id=1),
  address text NOT NULL CONSTRAINT wallet_link_challenge_address CHECK (address ~ '^0x[0-9a-f]{40}$'),
  nonce_hash text NOT NULL UNIQUE CONSTRAINT wallet_link_challenge_nonce_hash CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  message text NOT NULL CONSTRAINT wallet_link_challenge_message_length CHECK (length(message) BETWEEN 100 AND 2048),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT wallet_link_challenge_expiry CHECK (expires_at>issued_at AND expires_at<=issued_at+interval '10 minutes'),
  CONSTRAINT wallet_link_challenge_consumption CHECK (consumed_at IS NULL OR consumed_at>=issued_at)
);
CREATE INDEX wallet_link_challenge_subject_issued_idx ON identity.wallet_link_challenge(subject,issued_at DESC);
CREATE INDEX wallet_link_challenge_open_expiry_idx ON identity.wallet_link_challenge(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE identity.wallet_binding (
  subject text PRIMARY KEY REFERENCES auth."user"(id) ON DELETE RESTRICT,
  person_id bigint NOT NULL UNIQUE REFERENCES mlm.person(id) ON DELETE RESTRICT,
  chain_id smallint NOT NULL CONSTRAINT wallet_binding_chain CHECK (chain_id=1),
  address text NOT NULL CONSTRAINT wallet_binding_address CHECK (address ~ '^0x[0-9a-f]{40}$'),
  verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_binding_chain_address_key UNIQUE(chain_id,address)
);

REVOKE ALL ON identity.wallet_link_challenge,identity.wallet_binding FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE(consumed_at) ON identity.wallet_link_challenge TO mindbliss_auth_core_v1;
GRANT SELECT,INSERT ON identity.wallet_binding TO mindbliss_auth_core_v1;

DO $verify$
BEGIN
  IF NOT pg_catalog.has_table_privilege('mindbliss_auth_core_v1','identity.wallet_link_challenge','SELECT,INSERT')
    OR NOT pg_catalog.has_column_privilege('mindbliss_auth_core_v1','identity.wallet_link_challenge','consumed_at','UPDATE')
    OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','identity.wallet_link_challenge','DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR NOT pg_catalog.has_table_privilege('mindbliss_auth_core_v1','identity.wallet_binding','SELECT,INSERT')
    OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','identity.wallet_binding','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
    RAISE EXCEPTION 'wallet_binding_exact_runtime_grants_required';
  END IF;
END $verify$;
COMMIT;
