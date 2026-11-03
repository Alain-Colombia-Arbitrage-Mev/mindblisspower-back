-- PREPARED ONLY: empty read-model tables from migrations50/65, not their grants.
-- No account enrollment, financial activation, legacy-role or PUBLIC changes.
-- Review the canonical destination, backup, then run atomically before Go grants.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('mindbliss-cloudflare-read-models-v1',0));
DO $$ DECLARE relation_name text; enum_oid oid;
BEGIN
  IF current_database()<>'REPLACE_WITH_CURATED_DATABASE' THEN
    RAISE EXCEPTION 'read_models_explicit_database_review_required';
  END IF;
  FOREACH relation_name IN ARRAY ARRAY['auth.user','auth.session','auth.account','auth.verification','auth.jwks','auth.rate_limit',
    'identity.auth_binding','identity.legacy_claim_grant','identity.link_conflict','identity.stripe_customer','mlm.person','mlm.affiliate'] LOOP
    IF to_regclass(relation_name) IS NULL OR (SELECT relkind FROM pg_class WHERE oid=to_regclass(relation_name))<>'r' THEN
      RAISE EXCEPTION 'read_models_identity72_required';
    END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='mlm.person'::regclass AND attname='public_id'
    AND atttypid='uuid'::regtype AND attnotnull AND NOT attisdropped) THEN
    RAISE EXCEPTION 'read_models_canonical_public_id_required';
  END IF;
  IF to_regclass('mlm.member_onboarding') IS NOT NULL OR to_regclass('mlm.bmp_account_link') IS NOT NULL THEN
    RAISE EXCEPTION 'read_models_existing_tables_require_review';
  END IF;
  -- Do not silently inherit owner defaults that expose these new private tables.
  -- Fail rather than modifying existing defaults/PUBLIC/shared-role grants.
  IF EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=current_user)
      AND d.defaclnamespace IN (0,'mlm'::regnamespace) AND d.defaclobjtype IN ('r','S') AND a.grantee<>d.defaclrole) THEN
    RAISE EXCEPTION 'read_models_owner_default_data_grants_require_review';
  END IF;
  enum_oid=to_regtype('mlm.bmp_link_status');
  IF enum_oid IS NOT NULL AND (ARRAY(SELECT enumlabel::text FROM pg_enum WHERE enumtypid=enum_oid ORDER BY enumsortorder)
    IS DISTINCT FROM ARRAY['pending_admin','approved','rejected']::text[]) THEN
    RAISE EXCEPTION 'read_models_bmp_enum_labels_require_review';
  END IF;
  IF enum_oid IS NULL THEN CREATE TYPE mlm.bmp_link_status AS ENUM('pending_admin','approved','rejected'); END IF;
END $$;

CREATE TABLE mlm.bmp_account_link (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  affiliate_id bigint NOT NULL REFERENCES mlm.affiliate(id),
  bmp_email text NOT NULL,
  status mlm.bmp_link_status NOT NULL DEFAULT 'pending_admin',
  bmp_user_id text,
  bmp_block_reason text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  requested_from_ip inet,
  reviewed_by_person_id bigint REFERENCES mlm.person(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX bmp_account_link_one_approved ON mlm.bmp_account_link(affiliate_id) WHERE status='approved';
CREATE UNIQUE INDEX bmp_account_link_one_pending ON mlm.bmp_account_link(affiliate_id) WHERE status='pending_admin';
CREATE INDEX bmp_account_link_pending_queue ON mlm.bmp_account_link(requested_at DESC) WHERE status='pending_admin';
-- Existing partial indexes cover active requests; this full FK index also covers
-- historical rejected links when validating a referenced affiliate.
CREATE INDEX bmp_account_link_affiliate_idx ON mlm.bmp_account_link(affiliate_id);
CREATE INDEX bmp_account_link_reviewer_idx ON mlm.bmp_account_link(reviewed_by_person_id) WHERE reviewed_by_person_id IS NOT NULL;
COMMENT ON TABLE mlm.bmp_account_link IS 'Approved alternate BMP identity requests; initially empty; outbound payments remain disabled.';

CREATE TABLE mlm.member_onboarding (
  person_id bigint PRIMARY KEY REFERENCES mlm.person(id) ON DELETE CASCADE,
  city text CHECK(city IS NULL OR char_length(city)<=120),
  document_type text CHECK(document_type IS NULL OR document_type IN ('cc','ce','passport','dni')),
  document_number text CHECK(document_number IS NULL OR char_length(document_number) BETWEEN 3 AND 40),
  birth_date date CHECK(birth_date IS NULL OR birth_date>=DATE '1900-01-01'),
  address text CHECK(address IS NULL OR char_length(address)<=240),
  preferred_language text NOT NULL DEFAULT 'es' CHECK(preferred_language IN ('es','en','pt')),
  communication_channel text NOT NULL DEFAULT 'whatsapp' CHECK(communication_channel IN ('whatsapp','email','phone')),
  member_interest text NOT NULL DEFAULT 'wellbeing' CHECK(member_interest IN ('wellbeing','products','community','education')),
  support_needs text CHECK(support_needs IS NULL OR char_length(support_needs)<=1000),
  accepts_privacy boolean NOT NULL DEFAULT false,
  accepts_communications boolean NOT NULL DEFAULT false,
  privacy_accepted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- person_id is already indexed by its PK; no redundant FK index is needed.
COMMENT ON TABLE mlm.member_onboarding IS 'Private onboarding profile; initially empty; no legacy enrollment or PII backfill.';

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM mlm.bmp_account_link) OR EXISTS(SELECT 1 FROM mlm.member_onboarding) THEN
    RAISE EXCEPTION 'read_models_must_start_empty';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,
      acldefault((CASE WHEN c.relkind='S' THEN 'S' ELSE 'r' END)::"char",c.relowner))) a
    WHERE c.oid IN ('mlm.bmp_account_link'::regclass,'mlm.member_onboarding'::regclass,
      pg_get_serial_sequence('mlm.bmp_account_link','id')::regclass) AND a.grantee<>c.relowner) THEN
    RAISE EXCEPTION 'read_models_unreviewed_new_object_grant';
  END IF;
END $$;
COMMIT;
