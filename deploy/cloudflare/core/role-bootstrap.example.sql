-- AUTH-CORE BOOTSTRAP ONLY: does not apply full migration 70 or enable login.
-- Replace REPLACE_WITH_CURATED_DATABASE after reviewing the exact logical DB.
-- Run as an authorized schema operator. No passwords or LOGIN roles are created.
-- Attach each NEW empty login to exactly one group separately; never reuse a
-- login inheriting postgres/app_read/app_write/pg_read_all_data/pg_write_all_data.
-- Existing shared roles, PUBLIC privileges, business rows and runtime env stay
-- untouched. This bootstrap intentionally fails instead of repairing PUBLIC.
-- Requires the separately reviewed AUTH-ONLY DDL (six auth tables/adapter fields).
-- Auth core can write auth only, NOT mlm.person or identity provision commands.
-- Keep OTP/JWT flags and runtime URLs unchanged until business binding is ready.
-- Full role-policy.example.sql still requires migration 70; a future upgrade
-- must explicitly review these existing bootstrap groups, not skip its guards.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('mindbliss-role-bootstrap-v1',0));
DO $$ DECLARE relation_name text; function_name text;
BEGIN
  IF current_database() <> 'REPLACE_WITH_CURATED_DATABASE' THEN
    RAISE EXCEPTION 'bootstrap_explicit_database_review_required';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('mindbliss_member_reader_bootstrap_v1','mindbliss_auth_core_v1')) THEN
    RAISE EXCEPTION 'bootstrap_new_names_required_existing_roles_are_never_modified';
  END IF;
  FOREACH relation_name IN ARRAY ARRAY[
    'mlm.person','mlm.affiliate','mlm.affiliate_package','mlm.blacklist','mlm.package','mlm.rank',
    'mlm.v_rank_progress','mlm.wallet_movement','mlm.concept','mlm.bonus_run','mlm.alert_event','mlm.plan_config',
    'auth.user','auth.session','auth.account','auth.verification','auth.jwks','auth.rate_limit'
  ] LOOP
    IF to_regclass(relation_name) IS NULL THEN RAISE EXCEPTION 'bootstrap_existing_reader_relation_missing'; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid='auth.user'::regclass AND NOT attisdropped
      AND attname IN ('id','email','email_verified','name','created_at','updated_at','image','phone_number','phone_number_verified')) <> 9 THEN
    RAISE EXCEPTION 'bootstrap_auth_only_adapter_fields_missing';
  END IF;
  FOREACH function_name IN ARRAY ARRAY['mlm.norm_email(text)','mlm.norm_phone10(text)','mlm.norm_name(text)'] LOOP
    IF to_regprocedure(function_name) IS NULL THEN RAISE EXCEPTION 'bootstrap_existing_normalization_function_missing'; END IF;
  END LOOP;
END $$;
CREATE ROLE mindbliss_member_reader_bootstrap_v1 NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE mindbliss_auth_core_v1 NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO mindbliss_member_reader_bootstrap_v1,mindbliss_auth_core_v1',current_database());
END $$;
GRANT USAGE ON SCHEMA mlm,auth TO mindbliss_member_reader_bootstrap_v1;
GRANT SELECT ON mlm.person,mlm.affiliate,mlm.affiliate_package,mlm.blacklist,mlm.package,mlm.rank,
  mlm.v_rank_progress,mlm.wallet_movement,mlm.concept,mlm.bonus_run,mlm.alert_event,mlm.plan_config
  TO mindbliss_member_reader_bootstrap_v1;
GRANT SELECT(id,email,email_verified,name) ON auth.user TO mindbliss_member_reader_bootstrap_v1;
GRANT USAGE ON SCHEMA auth TO mindbliss_auth_core_v1;
GRANT SELECT,INSERT,UPDATE,DELETE ON auth.user,auth.session,auth.account,
  auth.verification,auth.jwks,auth.rate_limit TO mindbliss_auth_core_v1;
DO $$ DECLARE function_name text; extension_schema text;
BEGIN
  FOREACH function_name IN ARRAY ARRAY['mlm.norm_email(text)','mlm.norm_phone10(text)','mlm.norm_name(text)'] LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO mindbliss_member_reader_bootstrap_v1',to_regprocedure(function_name));
  END LOOP;
  SELECT n.nspname INTO extension_schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='unaccent';
  IF extension_schema IS NOT NULL THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO mindbliss_member_reader_bootstrap_v1',extension_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.unaccent(text) TO mindbliss_member_reader_bootstrap_v1',extension_schema);
  END IF;
END $$;

-- No mlm/identity privileges for auth core; its six tables are not sufficient
-- to run existing provision/binding hooks. Metadata/PUBLIC TEMP are not app data.
DO $$ DECLARE role_name text; relation_oid oid; column_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['mindbliss_member_reader_bootstrap_v1','mindbliss_auth_core_v1'] LOOP
    IF has_database_privilege(role_name,current_database(),'CREATE') OR EXISTS(
      SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
        AND has_schema_privilege(role_name,n.oid,'CREATE')) THEN
      RAISE EXCEPTION 'bootstrap_public_create_requires_separate_review';
    END IF;
    IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prosecdef
      AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
      AND has_schema_privilege(role_name,n.oid,'USAGE') AND has_function_privilege(role_name,p.oid,'EXECUTE')) THEN
      RAISE EXCEPTION 'bootstrap_accessible_security_definer_requires_separate_review';
    END IF;
    IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f')
        AND (role_name='mindbliss_member_reader_bootstrap_v1'
          OR NOT(n.nspname='auth' AND c.relname IN ('user','session','account','verification','jwks','rate_limit')))
        AND (has_table_privilege(role_name,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR has_any_column_privilege(role_name,c.oid,'INSERT,UPDATE,REFERENCES'))) THEN
      RAISE EXCEPTION 'bootstrap_effective_write_access';
    END IF;
  END LOOP;
  FOR relation_oid IN SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='auth' AND c.relname <> 'user' AND c.relkind IN ('r','p','v','m','f')
  LOOP
    IF has_any_column_privilege('mindbliss_member_reader_bootstrap_v1',relation_oid,'SELECT') THEN
      RAISE EXCEPTION 'bootstrap_reader_auth_secrets_access';
    END IF;
  END LOOP;
  FOR column_name IN SELECT attname FROM pg_attribute WHERE attrelid='auth.user'::regclass
    AND attnum>0 AND NOT attisdropped AND attname NOT IN ('id','email','email_verified','name')
  LOOP
    IF has_column_privilege('mindbliss_member_reader_bootstrap_v1','auth.user',column_name,'SELECT') THEN
      RAISE EXCEPTION 'bootstrap_reader_extra_auth_user_columns';
    END IF;
  END LOOP;
  -- Auth core must not acquire business or unreviewed auth table reads, even
  -- column-only PUBLIC ones. Extension-owned monitoring relations
  -- in public are catalog-like, not business data; application tables are not.
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f')
      AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid
        AND d.refclassid='pg_extension'::regclass AND d.deptype='e')
      AND NOT(n.nspname='auth' AND c.relname IN ('user','session','account','verification','jwks','rate_limit'))
      AND has_any_column_privilege('mindbliss_auth_core_v1',c.oid,'SELECT')) THEN
    RAISE EXCEPTION 'bootstrap_auth_core_business_read_access';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' AND c.relkind='S'
      AND (has_sequence_privilege('mindbliss_member_reader_bootstrap_v1',c.oid,'USAGE,UPDATE')
        OR has_sequence_privilege('mindbliss_auth_core_v1',c.oid,'USAGE,SELECT,UPDATE'))) THEN
    RAISE EXCEPTION 'bootstrap_public_sequence_access';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    WHERE a.grantee=0 AND d.defaclobjtype IN ('r','S')) THEN
    RAISE EXCEPTION 'bootstrap_public_future_data_defaults_require_separate_review';
  END IF;
END $$;
-- No DEFAULT PRIVILEGES grants. Future auth tables/columns remain inaccessible
-- unless PUBLIC or an operator later changes ACLs; audit those every rollout.
-- This does not isolate other logical databases with PUBLIC CONNECT/data ACLs.
COMMIT;
