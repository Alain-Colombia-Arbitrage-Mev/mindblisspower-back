-- Resolve unaccent in its actual extension schema, independently of each
-- connection's search_path. No blacklist data or tree positions are changed.
BEGIN;

DO $migration$
DECLARE
  extension_schema text;
BEGIN
  SELECT n.nspname INTO STRICT extension_schema
    FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'unaccent';

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION mlm.norm_name(p text) RETURNS text
      LANGUAGE sql IMMUTABLE AS $body$
        SELECT NULLIF(regexp_replace(lower(%I.unaccent(btrim(coalesce(p,'')))), '\s+', ' ', 'g'), '')
      $body$
  $definition$, extension_schema);
END
$migration$;

COMMIT;
