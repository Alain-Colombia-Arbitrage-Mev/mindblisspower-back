-- REVIEWED PROPOSAL ONLY. Never execute automatically during deploy/startup.
-- 1. Back up/rehearse migration 70 and review this exact database first.
-- 2. Replace REPLACE_WITH_CURATED_DATABASE with its explicit logical DB name.
-- 3. Run as the schema owner/operator; all changes below are transactional.
-- These NEW NOLOGIN policy groups do not change existing shared login roles.
-- Create NEW managed PlanetScale login credentials with inherited_roles: []
-- separately, then grant exactly ONE corresponding group to each new login.
-- Never add postgres, app_read/app_write, pg_read_all_data or pg_write_all_data.
-- Go services need their OWN policies; this reader is only portal + Bun.
-- This file does not create passwords, attach real logins, or rotate secrets.
-- Roles themselves add no database instance or paid authentication component.
-- DB CONNECT inherited through PUBLIC on OTHER databases is outside this policy;
-- do not claim cross-database isolation without a separate cluster-wide review.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtextextended('mindbliss-auth-role-policy-v1', 0));

DO $$
DECLARE relation_name text;
BEGIN
  IF current_database() <> 'REPLACE_WITH_CURATED_DATABASE' THEN
    RAISE EXCEPTION 'role_policy_explicit_database_review_required';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('mindbliss_member_reader_v1', 'mindbliss_auth_writer_v1')) THEN
    RAISE EXCEPTION 'role_policy_new_names_required_existing_roles_are_never_modified';
  END IF;
  FOREACH relation_name IN ARRAY ARRAY[
    'mlm.person','mlm.affiliate','mlm.affiliate_package','mlm.blacklist',
    'mlm.package','mlm.rank','mlm.v_rank_progress',
    'mlm.wallet_movement','mlm.concept','mlm.bonus_run','mlm.alert_event','mlm.plan_config',
    'auth.user','auth.session','auth.account','auth.verification','auth.jwks','auth.rate_limit',
    'identity.auth_binding','identity.link_conflict','identity.legacy_claim_grant'
  ] LOOP
    IF to_regclass(relation_name) IS NULL THEN
      RAISE EXCEPTION 'role_policy_required_schema_or_migration_70_missing';
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='mlm.person'::regclass
                 AND attname='public_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'role_policy_migration_70_public_id_missing';
  END IF;
END $$;

CREATE ROLE mindbliss_member_reader_v1 NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE mindbliss_auth_writer_v1 NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO mindbliss_member_reader_v1, mindbliss_auth_writer_v1', current_database());
END $$;
GRANT USAGE ON SCHEMA mlm, auth, identity TO mindbliss_member_reader_v1, mindbliss_auth_writer_v1;

-- Explicit existing relations, NOT ALL TABLES and NOT future default grants.
-- Application authorization still enforces which member/admin may see a row.
GRANT SELECT ON mlm.person, mlm.affiliate, mlm.affiliate_package, mlm.blacklist,
  mlm.package, mlm.rank, mlm.v_rank_progress,
  mlm.wallet_movement, mlm.concept, mlm.bonus_run, mlm.alert_event, mlm.plan_config
  TO mindbliss_member_reader_v1;
-- Bun identity/model.ts also projects name; Go's own role needs only the first 3.
-- Never grant table-level SELECT here: new auth.user columns stay private.
GRANT SELECT(id, email, email_verified, name) ON auth.user TO mindbliss_member_reader_v1;
GRANT SELECT(subject, provider, person_id) ON identity.auth_binding TO mindbliss_member_reader_v1;
GRANT SELECT(subject, resolved_at, reason) ON identity.link_conflict TO mindbliss_member_reader_v1;

-- Existing safe normalization functions used by legacy portal lookups, if present.
-- No blanket function grants. Public invoker functions do NOT bypass table ACLs.
DO $$ DECLARE function_name text; extension_schema text;
BEGIN
  FOREACH function_name IN ARRAY ARRAY['mlm.norm_email(text)','mlm.norm_phone10(text)','mlm.norm_name(text)'] LOOP
    IF to_regprocedure(function_name) IS NOT NULL THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO mindbliss_member_reader_v1', to_regprocedure(function_name));
    END IF;
  END LOOP;
  SELECT n.nspname INTO extension_schema FROM pg_extension e
    JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='unaccent';
  IF extension_schema IS NOT NULL AND to_regprocedure('mlm.norm_name(text)') IS NOT NULL THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO mindbliss_member_reader_v1', extension_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.unaccent(text) TO mindbliss_member_reader_v1', extension_schema);
  END IF;
END $$;

-- Better Auth / Drizzle use full model projections on this writer ONLY.
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.user, auth.session, auth.account,
  auth.verification, auth.jwks, auth.rate_limit TO mindbliss_auth_writer_v1;
-- Current provisioning uses explicit pending/not_started literals. It cannot
-- insert is_admin, blacklisted, public_id, legacy IDs or arbitrary KYC fields.
GRANT SELECT(id, public_id, user_id, email, status, blacklisted, is_admin)
  ON mlm.person TO mindbliss_auth_writer_v1;
GRANT INSERT(user_id, first_name, last_name, email, phone_number, status, kyc_status), UPDATE(user_id)
  ON mlm.person TO mindbliss_auth_writer_v1;
GRANT SELECT, INSERT ON identity.auth_binding TO mindbliss_auth_writer_v1;
GRANT SELECT ON identity.link_conflict TO mindbliss_auth_writer_v1;
GRANT INSERT(subject, candidate_person_id, reason), UPDATE(last_seen_at, resolved_at)
  ON identity.link_conflict TO mindbliss_auth_writer_v1;
-- Claim consumption is distinct from approval; approval remains operator-only.
GRANT SELECT, UPDATE(consumed_at) ON identity.legacy_claim_grant TO mindbliss_auth_writer_v1;
DO $$ DECLARE sequence_name text;
BEGIN
  FOREACH sequence_name IN ARRAY ARRAY[
    pg_get_serial_sequence('mlm.person','id'), pg_get_serial_sequence('identity.link_conflict','id')
  ] LOOP
    IF sequence_name IS NULL THEN RAISE EXCEPTION 'role_policy_required_identity_sequence_missing'; END IF;
    EXECUTE format('GRANT USAGE ON SEQUENCE %s TO mindbliss_auth_writer_v1', sequence_name::regclass);
  END LOOP;
END $$;

-- Fail closed on inherited PUBLIC access. Never repair that by changing PUBLIC
-- or a shared role here: investigate with the operator, then rerun a new review.
DO $$ DECLARE role_name text; relation_oid oid; column_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['mindbliss_member_reader_v1','mindbliss_auth_writer_v1'] LOOP
    IF EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%'
      AND n.nspname <> 'information_schema' AND has_schema_privilege(role_name,n.oid,'CREATE'))
      OR has_database_privilege(role_name,current_database(),'CREATE') THEN
      RAISE EXCEPTION 'role_policy_public_create_privilege_requires_separate_review';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE p.prosecdef AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
        AND has_schema_privilege(role_name,n.oid,'USAGE') AND has_function_privilege(role_name,p.oid,'EXECUTE')) THEN
      RAISE EXCEPTION 'role_policy_accessible_security_definer_requires_separate_review';
    END IF;
  END LOOP;
  -- Any existing effective reader write, even through PUBLIC, aborts everything.
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('mlm','auth','identity','payments','support','audit','comms','recovery')
      AND c.relkind IN ('r','p','v','m','f')
      AND (has_table_privilege('mindbliss_member_reader_v1',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege('mindbliss_member_reader_v1',c.oid,'INSERT,UPDATE,REFERENCES'))) THEN
    RAISE EXCEPTION 'role_policy_reader_inherited_write_access';
  END IF;
  -- No reader access to OTPs, sessions, passwords/OAuth or private signing keys.
  FOR relation_oid IN SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='auth' AND c.relkind IN ('r','p','v','m','f') AND c.relname <> 'user'
  LOOP
    IF has_any_column_privilege('mindbliss_member_reader_v1',relation_oid,'SELECT') THEN
      RAISE EXCEPTION 'role_policy_reader_inherited_auth_secrets_access';
    END IF;
  END LOOP;
  FOR column_name IN SELECT attname FROM pg_attribute WHERE attrelid='auth.user'::regclass
    AND attnum>0 AND NOT attisdropped AND attname NOT IN ('id','email','email_verified','name')
  LOOP
    IF has_column_privilege('mindbliss_member_reader_v1','auth.user',column_name,'SELECT') THEN
      RAISE EXCEPTION 'role_policy_reader_inherited_extra_auth_user_columns';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('mlm','payments','support','audit','comms','recovery')
      AND c.relkind IN ('r','p','v','m','f') AND c.oid <> 'mlm.person'::regclass
      AND (has_table_privilege('mindbliss_auth_writer_v1',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege('mindbliss_auth_writer_v1',c.oid,'INSERT,UPDATE,REFERENCES'))) THEN
    RAISE EXCEPTION 'role_policy_auth_writer_inherited_business_writes';
  END IF;
  -- Future PUBLIC table/sequence grants would bypass new-role isolation too.
  IF EXISTS (SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
    WHERE a.grantee=0 AND d.defaclobjtype IN ('r','S')
      AND (d.defaclnamespace=0 OR n.nspname IN ('mlm','auth','identity','payments','support','audit','comms','recovery'))) THEN
    RAISE EXCEPTION 'role_policy_public_future_data_defaults_require_separate_review';
  END IF;
END $$;

-- Intentionally NO ALTER DEFAULT PRIVILEGES ... GRANT. Future tables, columns,
-- schemas/plugins/functions need explicit migration review. Recheck PUBLIC ACLs,
-- SECURITY DEFINER functions and new login memberships before EVERY rollout.
-- Do not grant legacy_claim_grant INSERT/DELETE or stripe_customer writes to
-- auth runtime. Business invariants/legacy approval still live in reviewed code;
-- column ACLs alone do not restrict possible status values or approve a claim.
COMMIT;
