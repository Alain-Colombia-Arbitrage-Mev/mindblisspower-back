-- PREPARED ONLY. Apply after reviewing the exact primary database and runtime
-- roles. Metadata inspection on 2026-11-03 found these specific SELECT columns
-- missing from mindbliss_auth_core_v1 and its existing auth login member.
-- No new roles, membership, functions, writer grants, backfill or business DML.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('mindbliss-auth-identity-eligibility-90',0));

DO $$ DECLARE role_name text; relation_name text; function_name text; BEGIN
  IF current_database()<>'REPLACE_WITH_CURATED_DATABASE' OR pg_is_in_recovery() THEN
    RAISE EXCEPTION 'auth_eligibility_explicit_primary_review_required';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mindbliss_auth_core_v1'
    AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolreplication AND NOT rolbypassrls)
    OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mindbliss_auth_20261025'
      AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'auth_eligibility_scoped_roles_required';
  END IF;
  IF NOT pg_has_role('mindbliss_auth_20261025','mindbliss_auth_core_v1','USAGE') THEN
    RAISE EXCEPTION 'auth_eligibility_existing_role_membership_required';
  END IF;
  FOREACH role_name IN ARRAY ARRAY['mindbliss_auth_core_v1','mindbliss_auth_20261025'] LOOP
    IF NOT has_schema_privilege(role_name,'mlm','USAGE')
      OR NOT has_column_privilege(role_name,'mlm.person','id','SELECT') THEN
      RAISE EXCEPTION 'auth_eligibility_existing_person_reader_required';
    END IF;
    FOREACH relation_name IN ARRAY ARRAY['mlm.affiliate','mlm.blacklist'] LOOP
      IF has_table_privilege(role_name,relation_name,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(role_name,relation_name,'INSERT,UPDATE,REFERENCES') THEN
        RAISE EXCEPTION 'auth_eligibility_business_write_access_forbidden';
      END IF;
    END LOOP;
    FOREACH function_name IN ARRAY ARRAY['mlm.norm_email(text)','mlm.norm_phone10(text)','mlm.norm_name(text)'] LOOP
      IF to_regprocedure(function_name) IS NULL
        OR NOT has_function_privilege(role_name,function_name,'EXECUTE')
        OR (SELECT prosecdef FROM pg_proc WHERE oid=to_regprocedure(function_name)) THEN
        RAISE EXCEPTION 'auth_eligibility_existing_safe_normalizers_required';
      END IF;
    END LOOP;
  END LOOP;
END $$;

GRANT SELECT(first_name,last_name,phone_number,birthday) ON mlm.person TO mindbliss_auth_core_v1;
GRANT SELECT(person_id,status) ON mlm.affiliate TO mindbliss_auth_core_v1;
GRANT SELECT(email_norm,phone_last10,name_norm,birthdate) ON mlm.blacklist TO mindbliss_auth_core_v1;

DO $$ DECLARE role_name text; item record; BEGIN
  FOREACH role_name IN ARRAY ARRAY['mindbliss_auth_core_v1','mindbliss_auth_20261025'] LOOP
    FOR item IN SELECT * FROM (VALUES
      ('mlm.person','first_name'),('mlm.person','last_name'),('mlm.person','phone_number'),('mlm.person','birthday'),
      ('mlm.affiliate','person_id'),('mlm.affiliate','status'),
      ('mlm.blacklist','email_norm'),('mlm.blacklist','phone_last10'),('mlm.blacklist','name_norm'),('mlm.blacklist','birthdate')
    ) AS required(relation_name,column_name) LOOP
      IF NOT has_column_privilege(role_name,item.relation_name,item.column_name,'SELECT') THEN
        RAISE EXCEPTION 'auth_eligibility_exact_read_grants_required';
      END IF;
    END LOOP;
  END LOOP;
END $$;
COMMIT;
