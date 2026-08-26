-- 60_support_graph_rerank.sql
-- Estado de sincronización del índice derivado FalkorDB para la KB de soporte.

BEGIN;

ALTER TABLE support.kb_chunks
  ADD COLUMN IF NOT EXISTS graph_synced_at timestamptz;

CREATE INDEX IF NOT EXISTS kb_chunks_graph_pending_idx
  ON support.kb_chunks (updated_at)
  WHERE graph_synced_at IS NULL;

COMMENT ON COLUMN support.kb_chunks.graph_synced_at IS
  'Última sincronización exitosa del chunk al grafo derivado FalkorDB.';

DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['vp_engine','engine_write','app_write','app_admin','vp_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('GRANT USAGE ON SCHEMA support TO %I', role_name);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON support.kb_documents TO %I', role_name);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON support.kb_chunks TO %I', role_name);
    END IF;
  END LOOP;

  FOREACH role_name IN ARRAY ARRAY['engine_read','app_read'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('GRANT USAGE ON SCHEMA support TO %I', role_name);
      EXECUTE format('GRANT SELECT ON support.kb_documents TO %I', role_name);
      EXECUTE format('GRANT SELECT ON support.kb_chunks TO %I', role_name);
    END IF;
  END LOOP;
END $$;

COMMIT;
