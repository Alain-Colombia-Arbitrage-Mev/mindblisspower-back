\set ON_ERROR_STOP on
-- Synthetic QA only. This role must never be created on the recovered database.
DO $$
BEGIN
  IF current_database() <> 'mindbliss_qa' THEN
    RAISE EXCEPTION 'Refusing a non-QA database';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qa_member_read') THEN
    CREATE ROLE qa_member_read LOGIN PASSWORD 'synthetic-qa-read-only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qa_member_read'
    AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolinherit OR NOT rolcanlogin)) THEN
    RAISE EXCEPTION 'Unexpected privileges on qa_member_read';
  END IF;
END $$;
ALTER ROLE qa_member_read SET default_transaction_read_only = on;
ALTER ROLE qa_member_read SET statement_timeout = '8s';
GRANT CONNECT ON DATABASE mindbliss_qa TO qa_member_read;
GRANT USAGE ON SCHEMA mlm TO qa_member_read;
GRANT SELECT ON mlm.person, mlm.affiliate, mlm.affiliate_package,
  mlm.rank, mlm.blacklist, mlm.v_rank_progress TO qa_member_read;
