-- Reviewed additive contact storage. Apply BEFORE the matching auth runtime.
-- No OTP/SMS/WhatsApp delivery, consent, identity claims or existing business
-- data are changed. Never run on application startup. Review database and the
-- already-restricted auth role, then replace ONLY the explicit database guard.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('mindbliss-registration-contacts-v1', 0));
DO $$ BEGIN
  IF current_database() <> 'REPLACE_WITH_CURATED_DATABASE' THEN
    RAISE EXCEPTION 'registration_contacts_explicit_database_review_required';
  END IF;
  IF to_regclass('auth.user') IS NULL THEN RAISE EXCEPTION 'registration_contacts_auth_user_required'; END IF;
  IF (SELECT relkind FROM pg_class WHERE oid='auth.user'::regclass) <> 'r' THEN
    RAISE EXCEPTION 'registration_contacts_user_relation_requires_review';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='auth.user'::regclass AND NOT attisdropped
    AND attname IN ('contact_phone_e164','contact_whatsapp_e164')) THEN
    RAISE EXCEPTION 'registration_contacts_existing_shape_requires_review';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mindbliss_auth_core_v1' AND NOT rolcanlogin
    AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'registration_contacts_restricted_auth_role_required';
  END IF;
END $$;

-- No default, unique index or data backfill: unrelated applicants can share a
-- contact number and cannot reserve another person's authentication phone.
-- Possible country-specific lengths are checked with libphonenumber in the
-- application; SQL enforces the E.164 syntax/15-digit upper bound only.
ALTER TABLE auth.user
  ADD COLUMN contact_phone_e164 text,
  ADD COLUMN contact_whatsapp_e164 text,
  ADD CONSTRAINT auth_user_contact_phone_e164_format CHECK (contact_phone_e164 IS NULL OR contact_phone_e164 ~ '^\+[1-9][0-9]{1,14}$'),
  ADD CONSTRAINT auth_user_contact_whatsapp_e164_format CHECK (contact_whatsapp_e164 IS NULL OR contact_whatsapp_e164 ~ '^\+[1-9][0-9]{1,14}$');

COMMENT ON COLUMN auth.user.contact_phone_e164 IS 'Self-declared contact only: not phone possession, identity authority or communication consent';
COMMENT ON COLUMN auth.user.contact_whatsapp_e164 IS 'Self-declared WhatsApp contact only: not verified or subscribed to messages';
GRANT SELECT(contact_phone_e164,contact_whatsapp_e164),
  INSERT(contact_phone_e164,contact_whatsapp_e164),
  UPDATE(contact_phone_e164,contact_whatsapp_e164) ON auth.user TO mindbliss_auth_core_v1;

DO $$ DECLARE role_name text; BEGIN
  -- Adding columns must not silently grant these private contact values to the
  -- member/Go reader. Abort and roll back instead of editing shared role ACLs.
  FOREACH role_name IN ARRAY ARRAY['mindbliss_member_reader_bootstrap_v1','mindbliss_reader_20261025'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      IF has_column_privilege(role_name,'auth.user','contact_phone_e164','SELECT,INSERT,UPDATE,REFERENCES')
        OR has_column_privilege(role_name,'auth.user','contact_whatsapp_e164','SELECT,INSERT,UPDATE,REFERENCES') THEN
        RAISE EXCEPTION 'registration_contacts_reader_private_contact_access';
      END IF;
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid='auth.user'::regclass AND a.grantee=0 AND a.privilege_type IN('SELECT','INSERT','UPDATE','REFERENCES')) THEN
    RAISE EXCEPTION 'registration_contacts_public_access_requires_review';
  END IF;
END $$;
COMMIT;
