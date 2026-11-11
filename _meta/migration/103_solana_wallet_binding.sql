-- Independent, non-financial Solana ownership binding. The authenticated API
-- verifies a domain-bound, one-time Ed25519 proof before inserting a binding.
-- This never creates a Better Auth session or changes an EVM/admin wallet.
BEGIN;
SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('solana-wallet-binding-v1',0));
DO $preflight$
BEGIN
 IF pg_catalog.current_database()<>'mindbliss_curated_20261025' OR pg_catalog.pg_is_in_recovery()
  OR pg_catalog.to_regclass('auth.user') IS NULL OR pg_catalog.to_regclass('mlm.person') IS NULL
  OR pg_catalog.to_regclass('identity.wallet_binding') IS NULL THEN
  RAISE EXCEPTION 'solana_wallet_binding_primary_review_required'; END IF;
 IF pg_catalog.to_regclass('identity.solana_wallet_link_challenge') IS NOT NULL
  OR pg_catalog.to_regclass('identity.solana_wallet_binding') IS NOT NULL
  OR pg_catalog.to_regprocedure('identity.guard_solana_wallet_link_challenge()') IS NOT NULL
  OR pg_catalog.to_regprocedure('identity.guard_solana_wallet_binding()') IS NOT NULL THEN
  RAISE EXCEPTION 'solana_wallet_binding_requires_fresh_review'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='mindbliss_auth_core_v1'
   AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
  OR NOT pg_catalog.pg_has_role((SELECT relowner FROM pg_catalog.pg_class WHERE oid='identity.wallet_binding'::regclass),'USAGE')
  OR NOT pg_catalog.has_table_privilege('mindbliss_auth_core_v1','identity.wallet_binding','SELECT,INSERT')
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','identity.wallet_binding','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
  RAISE EXCEPTION 'solana_wallet_binding_scoped_role_required'; END IF;
END $preflight$;

CREATE TABLE identity.solana_wallet_link_challenge (
 id uuid PRIMARY KEY CHECK(id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 subject text NOT NULL REFERENCES auth."user"(id) ON DELETE RESTRICT,
 person_id bigint NOT NULL REFERENCES mlm.person(id) ON DELETE RESTRICT,
 cluster text NOT NULL CHECK(cluster='mainnet-beta'),
 genesis_hash text NOT NULL CHECK(genesis_hash='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'),
 address text COLLATE "C" NOT NULL CHECK(address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
 nonce_hash text NOT NULL UNIQUE CHECK(nonce_hash ~ '^[0-9a-f]{64}$'),
 message text NOT NULL CHECK(length(message) BETWEEN 100 AND 2048),
 issued_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '5 minutes'),
 CHECK(consumed_at IS NULL OR consumed_at>=issued_at)
);
CREATE INDEX solana_wallet_challenge_subject_issued_idx ON identity.solana_wallet_link_challenge(subject,issued_at DESC);
CREATE INDEX solana_wallet_challenge_person_idx ON identity.solana_wallet_link_challenge(person_id);
CREATE INDEX solana_wallet_challenge_open_expiry_idx ON identity.solana_wallet_link_challenge(expires_at) WHERE consumed_at IS NULL;
CREATE TABLE identity.solana_wallet_binding (
 subject text PRIMARY KEY REFERENCES auth."user"(id) ON DELETE RESTRICT,
 person_id bigint NOT NULL UNIQUE REFERENCES mlm.person(id) ON DELETE RESTRICT,
 cluster text NOT NULL CHECK(cluster='mainnet-beta'),
 genesis_hash text NOT NULL CHECK(genesis_hash='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'),
 address text COLLATE "C" NOT NULL UNIQUE CHECK(address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
 verified_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION identity.guard_solana_wallet_link_challenge() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'solana_wallet_challenge_immutable' USING ERRCODE='22023'; END IF;
 IF ROW(NEW.id,NEW.subject,NEW.person_id,NEW.cluster,NEW.genesis_hash,NEW.address,NEW.nonce_hash,NEW.message,NEW.issued_at,NEW.expires_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.subject,OLD.person_id,OLD.cluster,OLD.genesis_hash,OLD.address,OLD.nonce_hash,OLD.message,OLD.issued_at,OLD.expires_at)
  OR NEW.consumed_at IS NULL OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at) THEN
  RAISE EXCEPTION 'solana_wallet_challenge_immutable' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END $function$;
CREATE FUNCTION identity.guard_solana_wallet_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN RAISE EXCEPTION 'solana_wallet_binding_immutable' USING ERRCODE='22023'; END $function$;
CREATE TRIGGER solana_wallet_challenge_immutable BEFORE UPDATE OR DELETE ON identity.solana_wallet_link_challenge
 FOR EACH ROW EXECUTE FUNCTION identity.guard_solana_wallet_link_challenge();
CREATE TRIGGER solana_wallet_challenge_no_truncate BEFORE TRUNCATE ON identity.solana_wallet_link_challenge
 FOR EACH STATEMENT EXECUTE FUNCTION identity.guard_solana_wallet_link_challenge();
CREATE TRIGGER solana_wallet_binding_immutable BEFORE UPDATE OR DELETE ON identity.solana_wallet_binding
 FOR EACH ROW EXECUTE FUNCTION identity.guard_solana_wallet_binding();
CREATE TRIGGER solana_wallet_binding_no_truncate BEFORE TRUNCATE ON identity.solana_wallet_binding
 FOR EACH STATEMENT EXECUTE FUNCTION identity.guard_solana_wallet_binding();

-- Remove inherited reporting/schema defaults before granting precisely the
-- same private API operations used by the existing EVM identity capability.
REVOKE ALL ON identity.solana_wallet_link_challenge,identity.solana_wallet_binding FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.guard_solana_wallet_link_challenge(),identity.guard_solana_wallet_binding() FROM PUBLIC;
DO $revoke_defaults$
DECLARE item record;
BEGIN
 FOR item IN SELECT c.oid,a.grantee FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
  WHERE c.oid IN('identity.solana_wallet_link_challenge'::regclass,'identity.solana_wallet_binding'::regclass) AND a.grantee<>c.relowner LOOP
  EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %s FROM %s',item.oid::regclass,
   CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(item.grantee)) END);
 END LOOP;
 FOR item IN SELECT p.oid,a.grantee FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
  WHERE p.oid IN('identity.guard_solana_wallet_link_challenge()'::regprocedure,'identity.guard_solana_wallet_binding()'::regprocedure)
   AND a.grantee<>p.proowner LOOP
  EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %s',item.oid::regprocedure,
   CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(item.grantee)) END);
 END LOOP;
END $revoke_defaults$;
GRANT SELECT,INSERT,UPDATE(consumed_at) ON identity.solana_wallet_link_challenge TO mindbliss_auth_core_v1;
GRANT SELECT,INSERT ON identity.solana_wallet_binding TO mindbliss_auth_core_v1;
DO $verify$
BEGIN
 IF NOT pg_catalog.has_table_privilege('mindbliss_auth_core_v1','identity.solana_wallet_link_challenge','SELECT')
  OR NOT pg_catalog.has_table_privilege('mindbliss_auth_core_v1','identity.solana_wallet_link_challenge','INSERT')
  OR NOT pg_catalog.has_column_privilege('mindbliss_auth_core_v1','identity.solana_wallet_link_challenge','consumed_at','UPDATE')
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','identity.solana_wallet_link_challenge','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='identity.solana_wallet_link_challenge'::regclass
    AND a.attnum>0 AND NOT a.attisdropped AND a.attname<>'consumed_at'
    AND pg_catalog.has_column_privilege('mindbliss_auth_core_v1',a.attrelid,a.attnum,'UPDATE'))
  OR NOT pg_catalog.has_table_privilege('mindbliss_auth_core_v1','identity.solana_wallet_binding','SELECT')
  OR NOT pg_catalog.has_table_privilege('mindbliss_auth_core_v1','identity.solana_wallet_binding','INSERT')
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','identity.solana_wallet_binding','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
    WHERE c.oid IN('identity.solana_wallet_link_challenge'::regclass,'identity.solana_wallet_binding'::regclass)
    AND a.grantee<>c.relowner AND (a.grantee<>'mindbliss_auth_core_v1'::regrole OR a.privilege_type NOT IN('SELECT','INSERT') OR a.is_grantable))
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
    WHERE p.oid IN('identity.guard_solana_wallet_link_challenge()'::regprocedure,'identity.guard_solana_wallet_binding()'::regprocedure) AND a.grantee<>p.proowner) THEN
  RAISE EXCEPTION 'solana_wallet_binding_exact_grants_required'; END IF;
END $verify$;
COMMIT;
