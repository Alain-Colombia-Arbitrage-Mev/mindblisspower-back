-- Reviewed operator operation, never an application migration/startup task.
-- Run in a fresh psql connection with ON_ERROR_STOP; all parameters are required:
-- phase=quarantine|complete, expected_database, source_person_id, target_person_id, case_email,
-- quarantine_email, new_subject, operation_key, actor_subject,
-- evidence_confirmed=legacy_username_and_phone_reviewed.
-- The caller must privately preserve the reviewed before-state and establish
-- legacy usernames, original source email and phone ownership. A phone match
-- alone is NOT authentication or authorization. No case-specific PII lives here.
--
-- Phase quarantine changes ONLY the old auth principal and revokes its access.
-- Both business-person emails remain unchanged while old in-flight JWT reads
-- drain. Phase complete has a FIXED six-minute DB-timestamp barrier; there is
-- no operator-supplied override. It transfers the business-person emails only
-- after that barrier and after exact phase-one fingerprints are rechecked.
-- Preserve the old principal/binding and both business people. The correct
-- person receives the real email only in phase complete. A DIFFERENT
-- pending principal must complete a fresh native OTP before normal provisioning
-- can link that person. No password/hash, session, grant, sale or balance moves.
-- No trigger, public UUID, role, permission, tree or financial row is modified.
\set ON_ERROR_STOP on
\set VERBOSITY terse
\pset pager off

BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
SET LOCAL idle_in_transaction_session_timeout = '30s';

CREATE TEMP TABLE _identity_access_case ON COMMIT DROP AS
SELECT :'phase'::text AS phase,
       :'expected_database'::text AS expected_database,
       :'source_person_id'::bigint AS source_person_id,
       :'target_person_id'::bigint AS target_person_id,
       :'case_email'::text AS case_email,
       :'quarantine_email'::text AS quarantine_email,
       :'new_subject'::text AS new_subject,
       :'operation_key'::text AS operation_key,
       :'actor_subject'::text AS actor_subject,
       :'evidence_confirmed'::text AS evidence_confirmed;

CREATE TEMP TABLE _identity_access_before(kind text PRIMARY KEY, value jsonb NOT NULL) ON COMMIT DROP;

DO $correction$
DECLARE
  c record;
  old_subject text;
  old_auth jsonb;
  source_person jsonb;
  target_person jsonb;
  old_binding jsonb;
  affiliates_before jsonb;
  triggers_before jsonb;
  triggers_after jsonb;
  revoked_sessions bigint;
  revoked_challenges bigint;
  affected bigint;
  phase1 jsonb;
  phase1_at timestamptz;
  plan jsonb;
BEGIN
  SELECT * INTO STRICT c FROM pg_temp._identity_access_case;
  IF c.phase NOT IN('quarantine','complete') OR current_database() <> c.expected_database
     OR c.evidence_confirmed <> 'legacy_username_and_phone_reviewed'
     OR c.source_person_id <= 0 OR c.target_person_id <= 0 OR c.source_person_id = c.target_person_id
     OR c.case_email <> lower(btrim(c.case_email)) OR length(c.case_email) > 254
     OR c.case_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     OR c.quarantine_email <> lower(btrim(c.quarantine_email)) OR length(c.quarantine_email) > 254
     OR c.quarantine_email !~ '^[a-z0-9][a-z0-9._+-]*@[a-z0-9.-]+\.invalid$'
     OR c.case_email = c.quarantine_email
     OR c.new_subject !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR c.operation_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
     OR length(c.actor_subject) NOT BETWEEN 1 AND 255
     OR current_setting('session_replication_role') <> 'origin' THEN
    RAISE EXCEPTION 'identity_correction_invalid_parameters';
  END IF;

  -- Resolve then lock the old auth user BEFORE the normalized-email advisory
  -- lock, matching provisionAuthPerson's lock order. Any drift aborts below.
  SELECT p.user_id INTO STRICT old_subject FROM mlm.person p WHERE p.id=c.source_person_id;
  IF old_subject IS NULL OR old_subject IN (c.new_subject,c.actor_subject) THEN
    RAISE EXCEPTION 'identity_correction_source_principal_requires_review';
  END IF;
  PERFORM 1 FROM auth."user" u WHERE u.id=old_subject FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'identity_correction_source_principal_missing'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('person-email:' || c.case_email,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('legacy-identity-correction:' || c.operation_key,0));
  PERFORM 1 FROM mlm.person p WHERE p.id IN (c.source_person_id,c.target_person_id) ORDER BY p.id FOR UPDATE;
  PERFORM 1 FROM identity.auth_binding b
    WHERE b.subject=old_subject OR b.person_id IN(c.source_person_id,c.target_person_id) FOR UPDATE;

  IF NOT EXISTS (
    SELECT 1 FROM auth."user" u JOIN identity.auth_binding b ON b.subject=u.id AND b.provider='better_auth'
    JOIN mlm.person p ON p.id=b.person_id AND p.user_id=u.id
    WHERE u.id=c.actor_subject AND u.email_verified IS TRUE AND p.is_admin IS TRUE
      AND p.status::text='active' AND NOT coalesce(p.blacklisted,false)
      AND lower(btrim(u.email))=lower(btrim(p.email::text))
  ) THEN RAISE EXCEPTION 'identity_correction_authorized_actor_required'; END IF;
  IF EXISTS(SELECT 1 FROM audit.activity_log
    WHERE entity_type='legacy_identity_access_correction' AND entity_id=c.operation_key) THEN
    RAISE EXCEPTION 'identity_correction_already_applied';
  END IF;
  SELECT to_jsonb(a),a.occurred_at INTO phase1,phase1_at FROM audit.activity_log a
    WHERE entity_type='legacy_identity_access_correction_phase1' AND entity_id=c.operation_key FOR UPDATE;
  IF c.phase='quarantine' AND phase1 IS NOT NULL THEN
    RAISE EXCEPTION 'identity_correction_phase1_already_applied';
  END IF;
  IF c.phase='complete' THEN
    IF (SELECT count(*) FROM audit.activity_log WHERE entity_type='legacy_identity_access_correction_phase1'
      AND entity_id=c.operation_key)<>1 OR phase1 IS NULL THEN
      RAISE EXCEPTION 'identity_correction_phase1_required';
    END IF;
    IF now() < phase1_at + interval '6 minutes' THEN
      RAISE EXCEPTION 'identity_correction_token_drain_pending';
    END IF;
  END IF;

  IF (SELECT count(*) FROM mlm.person WHERE id IN(c.source_person_id,c.target_person_id)) <> 2
     OR EXISTS(SELECT 1 FROM mlm.person WHERE id IN(c.source_person_id,c.target_person_id)
       AND (status::text <> 'active' OR coalesce(blacklisted,false) OR is_admin IS DISTINCT FROM false))
     OR EXISTS(SELECT 1 FROM mlm.affiliate WHERE person_id IN(c.source_person_id,c.target_person_id)
       AND status::text <> 'active')
     OR (SELECT count(*) FROM mlm.affiliate WHERE person_id=c.source_person_id) <> 1
     OR (SELECT count(*) FROM mlm.affiliate WHERE person_id=c.target_person_id) <> 1
     OR (SELECT count(*) FROM mlm.person WHERE lower(btrim(email::text))=c.case_email) <> 1
     OR NOT EXISTS(SELECT 1 FROM mlm.person WHERE id=c.source_person_id AND user_id=old_subject
       AND lower(btrim(email::text))=c.case_email)
     OR (c.phase='quarantine' AND ((SELECT count(*) FROM auth."user" WHERE lower(btrim(email))=c.case_email) <> 1
       OR NOT EXISTS(SELECT 1 FROM auth."user" WHERE id=old_subject AND email_verified IS TRUE
         AND lower(btrim(email))=c.case_email)))
     OR (c.phase='complete' AND (EXISTS(SELECT 1 FROM auth."user" WHERE lower(btrim(email))=c.case_email)
       OR NOT EXISTS(SELECT 1 FROM auth."user" WHERE id=old_subject AND email_verified IS FALSE AND email=c.quarantine_email)
       OR EXISTS(SELECT 1 FROM auth.session WHERE user_id=old_subject)))
     OR (SELECT count(*) FROM identity.auth_binding WHERE subject=old_subject) <> 1
     OR NOT EXISTS(SELECT 1 FROM identity.auth_binding WHERE subject=old_subject
       AND provider='better_auth' AND person_id=c.source_person_id)
     OR NOT EXISTS(SELECT 1 FROM mlm.person WHERE id=c.target_person_id AND user_id IS NULL)
     OR EXISTS(SELECT 1 FROM identity.auth_binding WHERE person_id=c.target_person_id)
     OR EXISTS(SELECT 1 FROM auth."user" WHERE id=c.new_subject
       OR (lower(btrim(email))=c.quarantine_email AND (c.phase='quarantine' OR id<>old_subject)))
     OR EXISTS(SELECT 1 FROM mlm.person WHERE lower(btrim(email::text))=c.quarantine_email) THEN
    RAISE EXCEPTION 'identity_correction_identity_state_drift';
  END IF;
  IF EXISTS (
    SELECT 1 FROM mlm.person p JOIN mlm.blacklist b ON
      (mlm.norm_email(p.email) IS NOT NULL AND b.email_norm=mlm.norm_email(p.email)) OR
      (mlm.norm_phone10(p.phone_number) IS NOT NULL AND b.phone_last10=mlm.norm_phone10(p.phone_number)) OR
      (mlm.norm_name(p.first_name || ' ' || p.last_name) IS NOT NULL
       AND b.name_norm=mlm.norm_name(p.first_name || ' ' || p.last_name)
       AND (b.birthdate IS NULL OR (p.birthday IS NOT NULL AND b.birthdate=p.birthday)))
    WHERE p.id IN(c.source_person_id,c.target_person_id)
  ) THEN RAISE EXCEPTION 'identity_correction_restricted_identity'; END IF;

  -- Fail closed on unexpected write-side behavior. Do not disable it. The only
  -- reviewed non-internal triggers are the existing UUID/binding protectors.
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='mlm.person'::regclass AND NOT tgisinternal) <> 1
     OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='mlm.person'::regclass
       AND tgname='person_public_id_immutable' AND NOT tgisinternal AND tgenabled IN('O','A')
       AND (tgtype & 19)=19 AND tgfoid='identity.protect_public_id()'::regprocedure)
     OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='identity.auth_binding'::regclass AND NOT tgisinternal) <> 1
     OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.auth_binding'::regclass
       AND tgname='auth_binding_immutable' AND NOT tgisinternal AND tgenabled IN('O','A')
       AND (tgtype & 19)=19 AND tgfoid='identity.protect_auth_binding()'::regprocedure)
     OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid IN('auth.user'::regclass,'auth.session'::regclass,
       'auth.verification'::regclass) AND NOT tgisinternal)
     OR EXISTS(SELECT 1 FROM pg_constraint k JOIN pg_attribute a ON a.attrelid=k.confrelid
       AND a.attname='email' AND a.attnum=ANY(k.confkey)
       WHERE k.contype='f' AND k.confrelid IN('mlm.person'::regclass,'auth.user'::regclass)) THEN
    RAISE EXCEPTION 'identity_correction_unreviewed_trigger_or_email_fk';
  END IF;

  SELECT to_jsonb(p) INTO source_person FROM mlm.person p WHERE p.id=c.source_person_id;
  SELECT to_jsonb(p) INTO target_person FROM mlm.person p WHERE p.id=c.target_person_id;
  SELECT to_jsonb(u) INTO old_auth FROM auth."user" u WHERE u.id=old_subject;
  SELECT to_jsonb(b) INTO old_binding FROM identity.auth_binding b WHERE b.subject=old_subject;
  SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) INTO affiliates_before
    FROM mlm.affiliate a WHERE a.person_id IN(c.source_person_id,c.target_person_id);
  SELECT coalesce(jsonb_agg(jsonb_build_object('relation',t.tgrelid::regclass::text,'name',t.tgname,
    'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid),'function',pg_get_functiondef(t.tgfoid))
    ORDER BY t.tgrelid,t.tgname),'[]'::jsonb) INTO triggers_before FROM pg_trigger t
    WHERE NOT t.tgisinternal AND t.tgrelid IN('mlm.person'::regclass,'identity.auth_binding'::regclass,
      'auth.user'::regclass,'auth.session'::regclass,'auth.verification'::regclass);
  INSERT INTO pg_temp._identity_access_before VALUES
    ('source_person',source_person),('target_person',target_person),('old_auth',old_auth),
    ('old_binding',old_binding),('affiliates',affiliates_before),('triggers',triggers_before);

  plan := jsonb_build_object('database',c.expected_database,'source_person_id',c.source_person_id,
    'target_person_id',c.target_person_id,'old_subject',old_subject,'new_subject',c.new_subject,
    'actor_subject',c.actor_subject,'evidence',c.evidence_confirmed,
    'case_email_sha256',encode(sha256(convert_to(c.case_email,'UTF8')),'hex'),
    'quarantine_email_sha256',encode(sha256(convert_to(c.quarantine_email,'UTF8')),'hex'));
  IF c.phase='complete' AND (
       phase1->'before_data'->'plan' IS DISTINCT FROM plan
       OR phase1->>'actor_user_id' IS DISTINCT FROM c.actor_subject
       OR phase1->>'action' IS DISTINCT FROM 'quarantine_old_access_wait_token_drain'
       OR phase1->'after_data'->'old_access_disabled' IS DISTINCT FROM 'true'::jsonb
       OR phase1->'before_data'->>'source_person_sha256' IS DISTINCT FROM encode(sha256(convert_to(source_person::text,'UTF8')),'hex')
       OR phase1->'before_data'->>'target_person_sha256' IS DISTINCT FROM encode(sha256(convert_to(target_person::text,'UTF8')),'hex')
       OR phase1->'before_data'->>'old_auth_fixed_sha256' IS DISTINCT FROM encode(sha256(convert_to((old_auth-'email'-'email_verified'-'updated_at')::text,'UTF8')),'hex')
       OR phase1->'before_data'->>'binding_sha256' IS DISTINCT FROM encode(sha256(convert_to(old_binding::text,'UTF8')),'hex')
       OR phase1->'before_data'->>'affiliates_sha256' IS DISTINCT FROM encode(sha256(convert_to(affiliates_before::text,'UTF8')),'hex')
       OR phase1->'before_data'->>'triggers_sha256' IS DISTINCT FROM encode(sha256(convert_to(triggers_before::text,'UTF8')),'hex')) THEN
    RAISE EXCEPTION 'identity_correction_phase1_plan_or_state_drift';
  END IF;

  IF c.phase='quarantine' THEN
    UPDATE auth."user" SET email=c.quarantine_email,email_verified=false,updated_at=now() WHERE id=old_subject;
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>1 THEN RAISE EXCEPTION 'identity_correction_old_auth_update_count'; END IF;
    DELETE FROM auth.session WHERE user_id=old_subject;
    GET DIAGNOSTICS revoked_sessions=ROW_COUNT;
    -- Native challenges only; never recipient budgets or rate_limit.
    DELETE FROM auth.verification WHERE identifier IN('sign-in-otp-' || c.case_email,
      'email-verification-otp-' || c.case_email,'forget-password-otp-' || c.case_email);
    GET DIAGNOSTICS revoked_challenges=ROW_COUNT;
  ELSE
    revoked_sessions := 0;
    revoked_challenges := 0;
    UPDATE mlm.person SET email=c.quarantine_email WHERE id=c.source_person_id;
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>1 THEN RAISE EXCEPTION 'identity_correction_source_update_count'; END IF;
  UPDATE mlm.person SET email=c.case_email WHERE id=c.target_person_id AND user_id IS NULL;
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>1 THEN RAISE EXCEPTION 'identity_correction_target_update_count'; END IF;

  INSERT INTO auth."user"(id,email,email_verified,name,image,phone_number,phone_number_verified,
    contact_phone_e164,contact_whatsapp_e164,created_at,updated_at)
  VALUES(c.new_subject,c.case_email,false,'Cuenta pendiente',NULL,NULL,false,NULL,NULL,now(),now());
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>1 THEN RAISE EXCEPTION 'identity_correction_pending_insert_count'; END IF;
  END IF;

  IF (SELECT to_jsonb(p)-'email' FROM mlm.person p WHERE p.id=c.source_person_id)
       IS DISTINCT FROM source_person-'email'
     OR (SELECT to_jsonb(p)-'email' FROM mlm.person p WHERE p.id=c.target_person_id)
       IS DISTINCT FROM target_person-'email'
     OR (SELECT to_jsonb(u)-'email'-'email_verified'-'updated_at' FROM auth."user" u WHERE u.id=old_subject)
       IS DISTINCT FROM old_auth-'email'-'email_verified'-'updated_at'
     OR (SELECT to_jsonb(b) FROM identity.auth_binding b WHERE b.subject=old_subject) IS DISTINCT FROM old_binding
     OR (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM mlm.affiliate a
       WHERE a.person_id IN(c.source_person_id,c.target_person_id)) IS DISTINCT FROM affiliates_before
     OR (c.phase='quarantine' AND (
       (SELECT to_jsonb(p) FROM mlm.person p WHERE p.id=c.source_person_id) IS DISTINCT FROM source_person
       OR (SELECT to_jsonb(p) FROM mlm.person p WHERE p.id=c.target_person_id) IS DISTINCT FROM target_person
       OR EXISTS(SELECT 1 FROM auth."user" WHERE id=c.new_subject OR lower(btrim(email))=c.case_email)))
     OR (c.phase='complete' AND (
       EXISTS(SELECT 1 FROM mlm.person WHERE id=c.source_person_id AND email::text<>c.quarantine_email)
       OR NOT EXISTS(SELECT 1 FROM mlm.person WHERE id=c.target_person_id AND email::text=c.case_email AND user_id IS NULL)
       OR (SELECT count(*) FROM auth."user" WHERE lower(btrim(email))=c.case_email)<>1
       OR NOT EXISTS(SELECT 1 FROM auth."user" WHERE id=c.new_subject AND email=c.case_email
         AND email_verified IS FALSE AND name='Cuenta pendiente' AND image IS NULL AND phone_number IS NULL
         AND phone_number_verified IS FALSE AND contact_phone_e164 IS NULL AND contact_whatsapp_e164 IS NULL)))
     OR EXISTS(SELECT 1 FROM auth."user" WHERE id=old_subject AND (email<>c.quarantine_email OR email_verified IS DISTINCT FROM false))
     OR (SELECT count(*) FROM mlm.person WHERE lower(btrim(email::text))=c.case_email)<>1
     OR EXISTS(SELECT 1 FROM auth.account WHERE user_id=c.new_subject)
     OR EXISTS(SELECT 1 FROM auth.session WHERE user_id IN(old_subject,c.new_subject))
     OR EXISTS(SELECT 1 FROM identity.auth_binding WHERE subject=c.new_subject OR person_id=c.target_person_id)
     OR EXISTS(SELECT 1 FROM mlm.person WHERE user_id=c.new_subject)
     OR EXISTS(SELECT 1 FROM auth.verification WHERE identifier IN('sign-in-otp-' || c.case_email,
       'email-verification-otp-' || c.case_email,'forget-password-otp-' || c.case_email)) THEN
    RAISE EXCEPTION 'identity_correction_postcondition_drift';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('relation',t.tgrelid::regclass::text,'name',t.tgname,
    'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid),'function',pg_get_functiondef(t.tgfoid))
    ORDER BY t.tgrelid,t.tgname),'[]'::jsonb) INTO triggers_after FROM pg_trigger t
    WHERE NOT t.tgisinternal AND t.tgrelid IN('mlm.person'::regclass,'identity.auth_binding'::regclass,
      'auth.user'::regclass,'auth.session'::regclass,'auth.verification'::regclass);
  IF triggers_before IS DISTINCT FROM triggers_after THEN RAISE EXCEPTION 'identity_correction_trigger_drift'; END IF;

  -- Only allowlisted IDs, state flags and one-way row fingerprints enter audit.
  -- No passwords, OTP values, session tokens, secrets, email or phone copies.
  INSERT INTO audit.activity_log(actor_user_id,entity_type,entity_id,action,before_data,after_data)
  VALUES(c.actor_subject,CASE WHEN c.phase='quarantine' THEN 'legacy_identity_access_correction_phase1'
      ELSE 'legacy_identity_access_correction' END,c.operation_key,
    CASE WHEN c.phase='quarantine' THEN 'quarantine_old_access_wait_token_drain' ELSE 'complete_pending_access_after_token_drain' END,
    jsonb_build_object('plan',plan,'source_person_id',c.source_person_id,'target_person_id',c.target_person_id,
      'old_subject',old_subject,'source_public_id',source_person->>'public_id','target_public_id',target_person->>'public_id',
      'source_person_sha256',encode(sha256(convert_to(source_person::text,'UTF8')),'hex'),
      'target_person_sha256',encode(sha256(convert_to(target_person::text,'UTF8')),'hex'),
      'old_auth_fixed_sha256',encode(sha256(convert_to((old_auth-'email'-'email_verified'-'updated_at')::text,'UTF8')),'hex'),
      'binding_sha256',encode(sha256(convert_to(old_binding::text,'UTF8')),'hex'),
      'affiliates_sha256',encode(sha256(convert_to(affiliates_before::text,'UTF8')),'hex'),
      'triggers_sha256',encode(sha256(convert_to(triggers_before::text,'UTF8')),'hex'),
      'evidence',c.evidence_confirmed),
    jsonb_build_object('phase',c.phase,'new_subject',c.new_subject,'email_verified',false,'binding_created',false,
      'old_access_disabled',true,'pending_principal_created',c.phase='complete','minimum_drain_seconds',360,
      'credentials_copied',false,'sessions_revoked',revoked_sessions,'native_challenges_revoked',revoked_challenges,
      'old_binding_preserved',true,'public_ids_preserved',true,'affiliate_rows_preserved',true,
      'financial_writes',0,'messages_sent',0));
END
$correction$;

COMMIT;
SELECT CASE WHEN :'phase'='quarantine' THEN 'legacy_identity_access_correction_quarantined_wait_6_minutes'
  ELSE 'legacy_identity_access_correction_applied_pending_otp' END AS status;
