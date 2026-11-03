-- Reviewed, one-shot repair for deployed GET /api/member/profile,
-- GET /api/admin/users/export and GET /api/member/news.
-- Metadata only: no backfill, business-row UPDATE, financial activation,
-- credential changes, publication content or additional writer privileges.
-- Replace the single database placeholder only after reviewing the target.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('mindbliss-runtime-read-schema-88',0));

DO $$ BEGIN
  IF current_database()<>'REPLACE_WITH_CURATED_DATABASE' OR pg_is_in_recovery() THEN
    RAISE EXCEPTION 'runtime_read_schema_explicit_primary_review_required';
  END IF;
  IF to_regnamespace('support') IS NULL OR to_regclass('mlm.person') IS NULL
    OR (SELECT relkind FROM pg_class WHERE oid=to_regclass('mlm.person')) IS DISTINCT FROM 'r' THEN
    RAISE EXCEPTION 'runtime_read_schema_existing_base_required';
  END IF;
  IF to_regclass('support.news') IS NOT NULL OR EXISTS(
    SELECT 1 FROM pg_attribute WHERE attrelid='mlm.person'::regclass AND attnum>0
      AND NOT attisdropped AND attname IN ('country','payout_wallet_usdc')) THEN
    RAISE EXCEPTION 'runtime_read_schema_existing_objects_require_review';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mindbliss_go_payments_reader_v1'
    AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolreplication AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'runtime_read_schema_scoped_reader_required';
  END IF;
  -- The existing payments reader already has table SELECT on person. Adding
  -- nullable fields needs no new access to that existing private relation.
  IF NOT has_table_privilege('mindbliss_go_payments_reader_v1','mlm.person','SELECT') THEN
    RAISE EXCEPTION 'runtime_read_schema_existing_reader_policy_requires_review';
  END IF;
  -- Never inherit unknown grants on a new table or its identity sequence.
  IF EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=current_user)
      AND d.defaclnamespace IN (0,'support'::regnamespace)
      AND d.defaclobjtype IN ('r','S') AND a.grantee<>d.defaclrole) THEN
    RAISE EXCEPTION 'runtime_read_schema_default_grants_require_review';
  END IF;
END $$;

-- No default and no backfill: existing country/wallet values remain unknown.
-- This is a short catalog change, not a rewrite of the person table.
ALTER TABLE mlm.person ADD COLUMN country text, ADD COLUMN payout_wallet_usdc text;

CREATE TABLE support.news (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title text NOT NULL,
  body text NOT NULL,
  published boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX news_published_idx ON support.news(created_at DESC,id DESC) WHERE published=true;
COMMENT ON TABLE support.news IS 'Official member announcements; initially empty. No automatic publication or writer activation.';
REVOKE ALL ON support.news FROM PUBLIC;
REVOKE ALL ON SEQUENCE support.news_id_seq FROM PUBLIC;
GRANT USAGE ON SCHEMA support TO mindbliss_go_payments_reader_v1;
GRANT SELECT(id,title,body,published,created_at) ON support.news TO mindbliss_go_payments_reader_v1;

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM support.news) THEN
    RAISE EXCEPTION 'runtime_read_schema_news_must_start_empty';
  END IF;
  IF has_table_privilege('mindbliss_go_payments_reader_v1','support.news','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
    OR has_any_column_privilege('mindbliss_go_payments_reader_v1','support.news','INSERT,UPDATE')
    OR has_sequence_privilege('mindbliss_go_payments_reader_v1','support.news_id_seq','USAGE,SELECT,UPDATE') THEN
    RAISE EXCEPTION 'runtime_read_schema_reader_write_access_forbidden';
  END IF;
END $$;
COMMIT;
