-- PREPARED ONLY. Reviewed schema change; never run at application startup.
-- Permit auditable on-demand legacy linking AFTER canonical email verification.
-- No backfill, email verification, admin grants, tree movement or financial write.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SELECT pg_advisory_xact_lock(hashtextextended('verified-email-identity-binding-v1',0));
DO $$ DECLARE methods text[]; BEGIN
  IF current_database() <> 'REPLACE_WITH_CURATED_DATABASE' THEN
    RAISE EXCEPTION 'verified_email_binding_database_requires_review';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint
    WHERE conrelid='identity.auth_binding'::regclass AND conname='auth_binding_link_method_check'
      AND contype='c' AND convalidated
      AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='identity.auth_binding'::regclass AND attname='link_method')]::smallint[]) THEN
    RAISE EXCEPTION 'verified_email_binding_constraint_requires_review';
  END IF;
  SELECT array_agg(captures.value[1] ORDER BY captures.value[1]) INTO methods
    FROM pg_constraint c CROSS JOIN LATERAL regexp_matches(pg_get_constraintdef(c.oid),'''([^'']*)''','g') AS captures(value)
    WHERE c.conrelid='identity.auth_binding'::regclass AND c.conname='auth_binding_link_method_check';
  IF methods IS DISTINCT FROM ARRAY['approved_claim','legacy_user_id','new_registration','single_use_invite']
    AND methods IS DISTINCT FROM ARRAY['approved_claim','legacy_user_id','new_registration','single_use_invite','verified_email'] THEN
    RAISE EXCEPTION 'verified_email_binding_methods_require_review';
  END IF;
END $$;
ALTER TABLE identity.auth_binding DROP CONSTRAINT auth_binding_link_method_check;
ALTER TABLE identity.auth_binding ADD CONSTRAINT auth_binding_link_method_check
  CHECK (link_method IN ('new_registration','legacy_user_id','approved_claim','single_use_invite','verified_email'));

-- Non-unique by design: trim/case collisions stay visible and require review.
-- Matches the provisioning predicate instead of scanning the full legacy table.
CREATE INDEX IF NOT EXISTS person_email_normalized_identity_idx ON mlm.person(lower(btrim(email::text)));
COMMENT ON CONSTRAINT auth_binding_link_method_check ON identity.auth_binding IS
  'verified_email: on-demand canonical verified email matched exactly one eligible non-admin unbound legacy person; existing bindings stay immutable.';
COMMIT;
