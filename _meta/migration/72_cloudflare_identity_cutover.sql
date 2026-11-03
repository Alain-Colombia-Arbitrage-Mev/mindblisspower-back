-- PREPARED ONLY: identity upgrade AFTER migration 71 and reviewed role bootstrap.
-- No account enrollment, email verification, admin bootstrap, claim approvals,
-- tree placement, financial mutation, Stripe request, or login activation here.
-- Existing legacy roles are NOT granted or altered. Runtime role names below
-- refer only to the new isolated reader/auth logins and their reviewed groups.
-- This one-time UUID backfill must happen on the CANONICAL source, then clone.
-- auth.user must still be empty: enroll the first explicitly approved operator
-- only AFTER this migration. Verified legacy members still require claim approval.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='5min';
SELECT pg_advisory_xact_lock(hashtextextended('mindbliss-cloudflare-identity-v1',0));
DO $$ DECLARE role_name text; expected_login boolean; expected_group text;
BEGIN
  IF current_database() <> 'REPLACE_WITH_CURATED_DATABASE' THEN RAISE EXCEPTION 'identity_cutover_explicit_database_review_required'; END IF;
  IF to_regnamespace('identity') IS NOT NULL OR EXISTS(SELECT 1 FROM pg_attribute
    WHERE attrelid='mlm.person'::regclass AND attname='public_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'identity_cutover_existing_identity_state_requires_review';
  END IF;
  IF (SELECT relkind FROM pg_class WHERE oid='mlm.person'::regclass) <> 'r'
    OR EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class='mlm.person'::regclass AND rulename <> '_RETURN')
    OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='mlm.person'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'identity_cutover_person_rules_or_triggers_require_review';
  END IF;
  FOREACH role_name IN ARRAY ARRAY['auth.user','auth.session','auth.account','auth.verification','auth.jwks','auth.rate_limit'] LOOP
    IF to_regclass(role_name) IS NULL THEN RAISE EXCEPTION 'identity_cutover_auth_core_71_required'; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid='auth.user'::regclass AND attnum>0 AND NOT attisdropped) <> 9
    OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='mlm.person'::regclass AND attname='email'
      AND atttypid IN (SELECT oid FROM pg_type WHERE typname='citext') AND NOT attisdropped) THEN
    RAISE EXCEPTION 'identity_cutover_existing_schema_shape_requires_review';
  END IF;
  IF EXISTS(SELECT 1 FROM auth.user) OR EXISTS(SELECT 1 FROM mlm.person WHERE user_id IS NOT NULL) THEN
    RAISE EXCEPTION 'identity_cutover_enrollment_already_started_requires_review';
  END IF;
  FOR role_name,expected_login IN SELECT * FROM (VALUES
    ('mindbliss_member_reader_bootstrap_v1',false),('mindbliss_auth_core_v1',false),
    ('mindbliss_reader_20261025',true),('mindbliss_auth_20261025',true)) AS expected(name,login)
  LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name AND rolcanlogin=expected_login AND rolinherit
      AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls) THEN
      RAISE EXCEPTION 'identity_cutover_runtime_role_attributes_require_review';
    END IF;
    IF has_database_privilege(role_name,current_database(),'CREATE') OR EXISTS(SELECT 1 FROM pg_namespace n
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' AND has_schema_privilege(role_name,n.oid,'CREATE')) THEN
      RAISE EXCEPTION 'identity_cutover_runtime_create_access';
    END IF;
    IF NOT expected_login AND EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=role_name)) THEN
      RAISE EXCEPTION 'identity_cutover_policy_group_inherits_another_role';
    END IF;
    IF expected_login THEN
      expected_group=CASE WHEN role_name='mindbliss_reader_20261025' THEN 'mindbliss_member_reader_bootstrap_v1' ELSE 'mindbliss_auth_core_v1' END;
      IF (SELECT count(*) FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=role_name)) <> 1
        OR NOT EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid JOIN pg_roles u ON u.oid=m.member
          WHERE u.rolname=role_name AND g.rolname=expected_group AND m.inherit_option AND NOT m.set_option AND NOT m.admin_option) THEN
        RAISE EXCEPTION 'identity_cutover_login_membership_requires_review';
      END IF;
    END IF;
    IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE p.prosecdef AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
        AND has_schema_privilege(role_name,n.oid,'USAGE') AND has_function_privilege(role_name,p.oid,'EXECUTE')) THEN
      RAISE EXCEPTION 'identity_cutover_accessible_definer_requires_review';
    END IF;
  END LOOP;
  IF has_any_column_privilege('mindbliss_auth_20261025','mlm.person','SELECT,INSERT,UPDATE,REFERENCES')
    OR has_table_privilege('mindbliss_auth_20261025','mlm.person','DELETE,TRUNCATE,TRIGGER') THEN
    RAISE EXCEPTION 'identity_cutover_auth_role_not_at_reviewed_core_baseline';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    WHERE d.defaclnamespace=0 AND d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=current_user)
      AND d.defaclobjtype IN ('r','S') AND a.grantee<>d.defaclrole) THEN
    RAISE EXCEPTION 'identity_cutover_global_default_data_grants_require_review';
  END IF;
END $$;

ALTER TABLE mlm.person ADD COLUMN public_id uuid;
ALTER TABLE mlm.person ALTER COLUMN public_id SET DEFAULT pg_catalog.gen_random_uuid();
UPDATE mlm.person SET public_id=pg_catalog.gen_random_uuid() WHERE public_id IS NULL;
ALTER TABLE mlm.person ALTER COLUMN public_id SET NOT NULL;
CREATE UNIQUE INDEX person_public_id_unique ON mlm.person(public_id);

CREATE SCHEMA IF NOT EXISTS identity;
REVOKE ALL ON SCHEMA identity FROM PUBLIC;

-- One Better Auth principal per business person. OAuth providers are linked to
-- that principal by auth.account, not additional person rows or email matches.
CREATE TABLE IF NOT EXISTS identity.auth_binding (
  subject text PRIMARY KEY REFERENCES auth.user(id) ON DELETE RESTRICT,
  provider text NOT NULL DEFAULT 'better_auth' CHECK (provider = 'better_auth'),
  person_id bigint NOT NULL UNIQUE REFERENCES mlm.person(id) ON DELETE RESTRICT,
  link_method text NOT NULL CHECK (link_method IN ('new_registration', 'legacy_user_id', 'approved_claim', 'single_use_invite')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Approval records are the minimal identity history. Only a token hash is kept;
-- no email copy, token plaintext, provider payload or tree snapshot is stored.
CREATE TABLE IF NOT EXISTS identity.legacy_claim_grant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id bigint NOT NULL REFERENCES mlm.person(id) ON DELETE RESTRICT,
  subject text NOT NULL REFERENCES auth.user(id) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE CONSTRAINT legacy_claim_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CONSTRAINT legacy_claim_kind CHECK (kind IN ('approved_claim', 'single_use_invite')),
  approved_by_subject text NOT NULL REFERENCES auth.user(id) ON DELETE RESTRICT,
  approved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CONSTRAINT legacy_claim_expiry CHECK (expires_at > approved_at),
  consumed_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT legacy_claim_two_party CHECK (approved_by_subject <> subject),
  CONSTRAINT legacy_claim_consumption_time CHECK (consumed_at IS NULL OR consumed_at >= approved_at),
  CONSTRAINT legacy_claim_not_consumed_and_revoked CHECK (revoked_at IS NULL OR consumed_at IS NULL)
);
CREATE INDEX IF NOT EXISTS legacy_claim_person_idx ON identity.legacy_claim_grant(person_id);
CREATE INDEX IF NOT EXISTS legacy_claim_subject_idx ON identity.legacy_claim_grant(subject);
CREATE INDEX IF NOT EXISTS legacy_claim_approver_idx ON identity.legacy_claim_grant(approved_by_subject);
CREATE INDEX IF NOT EXISTS legacy_claim_open_expiry_idx ON identity.legacy_claim_grant(expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS identity.link_conflict (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject text NOT NULL REFERENCES auth.user(id) ON DELETE RESTRICT,
  candidate_person_id bigint REFERENCES mlm.person(id) ON DELETE RESTRICT,
  reason text NOT NULL CONSTRAINT identity_link_conflict_reason CHECK (reason IN ('legacy_claim_required', 'identity_collision', 'person_unavailable', 'invalid_claim', 'stripe_customer_collision')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE NULLS NOT DISTINCT (subject, candidate_person_id, reason)
);
CREATE INDEX IF NOT EXISTS identity_conflict_person_idx ON identity.link_conflict(candidate_person_id);

-- Customer IDs are scoped to the Stripe account AND test/live mode. Nothing is
-- linked by an email in a webhook, and this migration never contacts Stripe.
CREATE TABLE IF NOT EXISTS identity.stripe_customer (
  account_id text NOT NULL CONSTRAINT stripe_account_id_format CHECK (account_id ~ '^acct_[A-Za-z0-9]+$'),
  livemode boolean NOT NULL,
  customer_id text NOT NULL CONSTRAINT stripe_customer_id_format CHECK (customer_id ~ '^cus_[A-Za-z0-9]+$'),
  person_id bigint NOT NULL REFERENCES mlm.person(id) ON DELETE RESTRICT,
  linked_by_subject text NOT NULL REFERENCES auth.user(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, livemode, customer_id),
  UNIQUE (account_id, livemode, person_id)
);
CREATE INDEX IF NOT EXISTS stripe_customer_person_idx ON identity.stripe_customer(person_id);
CREATE INDEX IF NOT EXISTS stripe_customer_actor_idx ON identity.stripe_customer(linked_by_subject);

-- Preserve only already-explicit user_id relations; NEVER backfill from email.
INSERT INTO identity.auth_binding(subject, person_id, link_method)
SELECT p.user_id, p.id, 'legacy_user_id' FROM mlm.person p
JOIN auth.user u ON u.id = p.user_id
WHERE p.user_id IS NOT NULL
ON CONFLICT (subject) DO NOTHING;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM identity.auth_binding b JOIN mlm.person p ON p.id = b.person_id
             WHERE p.user_id IS DISTINCT FROM b.subject) THEN
    RAISE EXCEPTION 'identity_binding_conflict_requires_review';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION identity.protect_public_id() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.public_id IS DISTINCT FROM NEW.public_id THEN
    RAISE EXCEPTION 'person_public_id_is_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS person_public_id_immutable ON mlm.person;
CREATE TRIGGER person_public_id_immutable BEFORE UPDATE OF public_id ON mlm.person
  FOR EACH ROW EXECUTE FUNCTION identity.protect_public_id();

CREATE OR REPLACE FUNCTION identity.protect_auth_binding() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.subject IS DISTINCT FROM NEW.subject OR OLD.provider IS DISTINCT FROM NEW.provider
     OR OLD.person_id IS DISTINCT FROM NEW.person_id OR OLD.link_method IS DISTINCT FROM NEW.link_method THEN
    RAISE EXCEPTION 'auth_binding_is_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS auth_binding_immutable ON identity.auth_binding;
CREATE TRIGGER auth_binding_immutable BEFORE UPDATE ON identity.auth_binding
  FOR EACH ROW EXECUTE FUNCTION identity.protect_auth_binding();


-- New functions only: no blanket function/default grants or shared-role edits.
REVOKE ALL ON FUNCTION identity.protect_public_id(),identity.protect_auth_binding() FROM PUBLIC;
GRANT USAGE ON SCHEMA identity TO mindbliss_member_reader_bootstrap_v1,mindbliss_auth_core_v1;
GRANT USAGE ON SCHEMA mlm TO mindbliss_auth_core_v1;
GRANT SELECT(subject,provider,person_id) ON identity.auth_binding TO mindbliss_member_reader_bootstrap_v1;
GRANT SELECT(subject,resolved_at,reason) ON identity.link_conflict TO mindbliss_member_reader_bootstrap_v1;
GRANT SELECT(id,public_id,user_id,email,status,blacklisted,is_admin) ON mlm.person TO mindbliss_auth_core_v1;
GRANT INSERT(user_id,first_name,last_name,email,phone_number,status,kyc_status),UPDATE(user_id) ON mlm.person TO mindbliss_auth_core_v1;
GRANT SELECT,INSERT ON identity.auth_binding TO mindbliss_auth_core_v1;
GRANT SELECT ON identity.link_conflict TO mindbliss_auth_core_v1;
GRANT INSERT(subject,candidate_person_id,reason),UPDATE(last_seen_at,resolved_at) ON identity.link_conflict TO mindbliss_auth_core_v1;
GRANT SELECT,UPDATE(consumed_at) ON identity.legacy_claim_grant TO mindbliss_auth_core_v1;
DO $$ DECLARE sequence_name text; BEGIN
  FOREACH sequence_name IN ARRAY ARRAY[pg_get_serial_sequence('mlm.person','id'),pg_get_serial_sequence('identity.link_conflict','id')] LOOP
    IF sequence_name IS NULL THEN RAISE EXCEPTION 'identity_cutover_identity_sequence_missing'; END IF;
    EXECUTE format('GRANT USAGE ON SEQUENCE %s TO mindbliss_auth_core_v1',sequence_name::regclass);
  END LOOP;
END $$;
-- Stripe Customer evidence is provisioned by its own reviewed payment role.
-- Auth runtime cannot insert Customer links or approve/revoke legacy claims.
DO $$ DECLARE role_name text; column_name text; object_oid oid;
BEGIN
  -- USAGE on mlm/identity was added above. Recheck effective executable
  -- definers now: a previously unreachable function must not become an
  -- indirect writer merely because this identity upgrade made it reachable.
  FOREACH role_name IN ARRAY ARRAY['mindbliss_member_reader_bootstrap_v1','mindbliss_reader_20261025',
    'mindbliss_auth_core_v1','mindbliss_auth_20261025'] LOOP
    IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE p.prosecdef AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
        AND has_schema_privilege(role_name,n.oid,'USAGE') AND has_function_privilege(role_name,p.oid,'EXECUTE')) THEN
      RAISE EXCEPTION 'identity_cutover_newly_accessible_definer_requires_review';
    END IF;
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['mindbliss_member_reader_bootstrap_v1','mindbliss_reader_20261025'] LOOP
    IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f')
        AND (has_table_privilege(role_name,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR has_any_column_privilege(role_name,c.oid,'INSERT,UPDATE,REFERENCES'))) THEN
      RAISE EXCEPTION 'identity_cutover_reader_write_access';
    END IF;
    FOR object_oid IN SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='auth' AND c.relname<>'user' AND c.relkind IN ('r','p','v','m','f')
    LOOP
      IF has_any_column_privilege(role_name,object_oid,'SELECT') THEN RAISE EXCEPTION 'identity_cutover_reader_auth_secrets_access'; END IF;
    END LOOP;
    FOR column_name IN SELECT attname FROM pg_attribute WHERE attrelid='auth.user'::regclass AND attnum>0 AND NOT attisdropped
      AND attname NOT IN ('id','email','email_verified','name')
    LOOP
      IF has_column_privilege(role_name,'auth.user',column_name,'SELECT') THEN RAISE EXCEPTION 'identity_cutover_reader_extra_auth_user_column'; END IF;
    END LOOP;
    IF has_any_column_privilege(role_name,'identity.legacy_claim_grant','SELECT')
      OR has_any_column_privilege(role_name,'identity.stripe_customer','SELECT') THEN
      RAISE EXCEPTION 'identity_cutover_reader_private_identity_access';
    END IF;
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['mindbliss_auth_core_v1','mindbliss_auth_20261025'] LOOP
    IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname NOT IN ('information_schema','auth','identity')
        AND c.relkind IN ('r','p','v','m','f') AND c.oid<>'mlm.person'::regclass
        AND (has_table_privilege(role_name,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR has_any_column_privilege(role_name,c.oid,'INSERT,UPDATE,REFERENCES'))) THEN
      RAISE EXCEPTION 'identity_cutover_auth_financial_write_access';
    END IF;
    IF has_table_privilege(role_name,'mlm.person','UPDATE,INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='mlm.person'::regclass AND a.attnum>0 AND NOT a.attisdropped
        AND ((a.attname NOT IN ('user_id','first_name','last_name','email','phone_number','status','kyc_status')
            AND has_column_privilege(role_name,'mlm.person',a.attname,'INSERT'))
          OR (a.attname<>'user_id' AND has_column_privilege(role_name,'mlm.person',a.attname,'UPDATE')))) THEN
      RAISE EXCEPTION 'identity_cutover_auth_person_privilege_too_broad';
    END IF;
    IF has_table_privilege(role_name,'identity.auth_binding','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_table_privilege(role_name,'identity.stripe_customer','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege(role_name,'identity.stripe_customer','INSERT,UPDATE,REFERENCES')
      OR has_table_privilege(role_name,'identity.legacy_claim_grant','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='identity.legacy_claim_grant'::regclass AND a.attnum>0 AND NOT a.attisdropped
        AND a.attname<>'consumed_at' AND has_column_privilege(role_name,'identity.legacy_claim_grant',a.attname,'UPDATE')) THEN
      RAISE EXCEPTION 'identity_cutover_auth_identity_privilege_too_broad';
    END IF;
  END LOOP;
  -- Fail instead of implicitly granting new identity objects to shared legacy
  -- roles through owner defaults. Existing shared role ACLs are never edited.
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault((CASE WHEN c.relkind='S' THEN 'S' ELSE 'r' END)::"char",c.relowner))) a
    WHERE n.nspname='identity' AND a.grantee NOT IN(c.relowner,
      (SELECT oid FROM pg_roles WHERE rolname='mindbliss_member_reader_bootstrap_v1'),
      (SELECT oid FROM pg_roles WHERE rolname='mindbliss_auth_core_v1'))) THEN
    RAISE EXCEPTION 'identity_cutover_unreviewed_identity_object_grant';
  END IF;
END $$;
COMMIT;

