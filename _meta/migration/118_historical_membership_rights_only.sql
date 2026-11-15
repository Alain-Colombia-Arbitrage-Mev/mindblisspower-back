-- Approved access only, active until an append-only revocation. This migration
-- writes no existing rows and never creates an economic package, PV, ROI,
-- investment, capacity, commission, tree placement or financial movement.
BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('historical-membership-rights-v1',0));
DO $preflight$
DECLARE v_owner oid;t text;
BEGIN
 IF pg_catalog.current_database()<>'mindbliss_curated_20261025' OR pg_catalog.pg_is_in_recovery()
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('identity.require_administrative_native_session(text,text)'::regprocedure))<>'01bb63725c11ae353cb768a42ffa9485'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('identity.member_referral_person_eligible(bigint)'::regprocedure))<>'208e0d9256bd17aea609f92f73ab8def'
  OR pg_catalog.to_regclass('payments.stripe_membership_rights_run') IS NOT NULL
  OR pg_catalog.to_regclass('payments.stripe_membership_entitlement') IS NOT NULL
  OR pg_catalog.to_regclass('payments.stripe_membership_rights_event') IS NOT NULL
  OR EXISTS(SELECT FROM pg_catalog.pg_roles WHERE rolname='mindbliss_stripe_rights_operator_v1') THEN
  RAISE EXCEPTION 'member_package_rights_requires_fresh_review'; END IF;
 SELECT proowner INTO v_owner FROM pg_catalog.pg_proc WHERE oid='identity.require_administrative_native_session(text,text)'::regprocedure;
 FOREACH t IN ARRAY ARRAY['payments.sales_import_batch','payments.sales_import_row','payments.admin_sales_source','payments.stripe_sale',
  'recovery.stripe_sale_identity','recovery.package_catalog_snapshot','payments.purchase_intent','payments.manual_membership_order',
  'mlm.person','mlm.affiliate','mlm.affiliate_package','identity.auth_binding'] LOOP
  IF NOT pg_catalog.has_table_privilege(v_owner,t,'SELECT') THEN RAISE EXCEPTION 'member_package_rights_existing_read_policy_required';END IF;
 END LOOP;
 IF NOT pg_catalog.pg_has_role(v_owner,'USAGE') OR NOT pg_catalog.has_schema_privilege('mindbliss_auth_core_v1','payments','USAGE') THEN
  RAISE EXCEPTION 'member_package_rights_existing_owner_policy_required'; END IF;
END $preflight$;

CREATE ROLE mindbliss_stripe_rights_operator_v1 NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
GRANT USAGE ON SCHEMA payments TO mindbliss_stripe_rights_operator_v1;

CREATE TABLE payments.stripe_membership_rights_run(
 id uuid PRIMARY KEY,manifest_sha256 text NOT NULL CHECK(manifest_sha256~'^[0-9a-f]{64}$'),
 manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'),
 policy text NOT NULL CHECK(policy='historical_membership_access_until_revoked_v1'),
 source_batch_id uuid NOT NULL REFERENCES payments.sales_import_batch(id),
 source_file_sha256 text NOT NULL CHECK(source_file_sha256='e8d27b0af998f8a290a478d8f4e8b907e1f361e30b2ba0e350395a0405c38e20'),
 actor text NOT NULL CHECK(length(actor) BETWEEN 1 AND 128 AND actor!~'[[:cntrl:]]'),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 480 AND reason!~'[[:cntrl:]]'),
 approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(manifest_sha256=encode(sha256(convert_to(manifest::text,'UTF8')),'hex'))
);
CREATE INDEX stripe_membership_rights_run_manifest_idx ON payments.stripe_membership_rights_run(manifest_sha256);
ALTER TABLE payments.stripe_membership_rights_run ENABLE ROW LEVEL SECURITY;

CREATE TABLE payments.stripe_membership_entitlement(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),payment_intent_id text NOT NULL UNIQUE REFERENCES payments.stripe_sale(payment_intent_id),
 run_id uuid NOT NULL REFERENCES payments.stripe_membership_rights_run(id),
 source_batch_id uuid NOT NULL,source_record_sha256 text NOT NULL CHECK(source_record_sha256~'^[0-9a-f]{64}$'),
 source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'),
 source_snapshot_sha256 text NOT NULL CHECK(source_snapshot_sha256~'^[0-9a-f]{64}$'),
 person_id bigint NOT NULL REFERENCES mlm.person(id),affiliate_id bigint REFERENCES mlm.affiliate(id),
 source_package_id bigint NOT NULL REFERENCES recovery.package_catalog_snapshot(source_package_id),
 package_name text NOT NULL CHECK(length(package_name) BETWEEN 1 AND 240 AND package_name!~'[[:cntrl:]]'),
 catalog_sha256 text NOT NULL CHECK(catalog_sha256~'^[0-9a-f]{64}$'),
 currency text NOT NULL CHECK(currency='usd'),base_minor bigint NOT NULL CHECK(base_minor>0),fee_minor bigint NOT NULL CHECK(fee_minor>=0),
 bought_at timestamptz NOT NULL CHECK(isfinite(bought_at)),recognized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 access_from timestamptz NOT NULL DEFAULT clock_timestamp(),
 term_policy text NOT NULL CHECK(term_policy='historical_membership_access_until_revoked_v1'),
 provider_verified_at timestamptz NOT NULL CHECK(isfinite(provider_verified_at)),provider_proof_sha256 text NOT NULL CHECK(provider_proof_sha256~'^[0-9a-f]{64}$'),
 economic_activation boolean NOT NULL DEFAULT false CHECK(NOT economic_activation),
 roi_enabled boolean NOT NULL DEFAULT false CHECK(NOT roi_enabled),commissions_enabled boolean NOT NULL DEFAULT false CHECK(NOT commissions_enabled),
 FOREIGN KEY(source_batch_id,payment_intent_id) REFERENCES payments.sales_import_row(batch_id,external_id),
 CHECK(access_from=recognized_at AND bought_at<=recognized_at),
 CHECK(source_snapshot_sha256=encode(sha256(convert_to(source_snapshot::text,'UTF8')),'hex'))
);
CREATE INDEX stripe_membership_entitlement_person_idx ON payments.stripe_membership_entitlement(person_id,recognized_at DESC,id);
ALTER TABLE payments.stripe_membership_entitlement ENABLE ROW LEVEL SECURITY;

CREATE TABLE payments.stripe_membership_rights_event(
 id uuid PRIMARY KEY,entitlement_id uuid NOT NULL REFERENCES payments.stripe_membership_entitlement(id),
 sequence_no bigint NOT NULL CHECK(sequence_no>0),state text NOT NULL CHECK(state IN('active','suspended','revoked','review_required')),
 actor text NOT NULL CHECK(length(actor) BETWEEN 1 AND 128 AND actor!~'[[:cntrl:]]'),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 480 AND reason!~'[[:cntrl:]]'),
 evidence_sha256 text NOT NULL CHECK(evidence_sha256~'^[0-9a-f]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(entitlement_id,sequence_no),CHECK((sequence_no=1)=(state='active'))
);
ALTER TABLE payments.stripe_membership_rights_event ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION payments.reject_stripe_membership_rights_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN RAISE EXCEPTION 'member_package_rights_append_only' USING ERRCODE='23514';END $function$;
CREATE TRIGGER stripe_membership_rights_run_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON payments.stripe_membership_rights_run
 FOR EACH STATEMENT EXECUTE FUNCTION payments.reject_stripe_membership_rights_mutation();
CREATE TRIGGER stripe_membership_entitlement_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON payments.stripe_membership_entitlement
 FOR EACH STATEMENT EXECUTE FUNCTION payments.reject_stripe_membership_rights_mutation();
CREATE TRIGGER stripe_membership_rights_event_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON payments.stripe_membership_rights_event
 FOR EACH STATEMENT EXECUTE FUNCTION payments.reject_stripe_membership_rights_mutation();

-- Pure primary evidence read. NULL means review/blocked, never an inferred grant.
CREATE FUNCTION payments.stripe_membership_rights_source_snapshot(p_pi text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT jsonb_build_object('paymentIntentId',r.external_id,'chargeReference',r.provider_reference,
  'sourceBatchId',r.batch_id::text,'sourceFileSha256',b.file_sha256,'sourceRow',r.source_row,
  'recordSha256',r.record_sha256,'canonicalRecordSha256',s.source_record_sha256,
  'personId',r.person_id::text,'affiliateId',r.affiliate_id::text,'sourcePackageId',c.source_package_id::text,
  'packageName',r.package_name,'catalogSha256',c.source_sha256,'currency',r.currency,
  'baseMinor',c.base_minor::text,'feeMinor',c.fee_minor::text,'capturedMinor',s.captured_minor::text,
  'boughtAt',to_char(s.charged_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
 FROM payments.admin_sales_source a JOIN payments.sales_import_batch b ON b.id=a.active_batch_id
 JOIN payments.sales_import_row r ON r.batch_id=b.id JOIN payments.stripe_sale s ON s.payment_intent_id=r.canonical_payment_intent_id
 JOIN recovery.stripe_sale_identity i ON i.payment_intent_id=s.payment_intent_id
 JOIN recovery.package_catalog_snapshot c ON c.source_package_id=r.package_id AND c.source_package_id::text=s.metadata->>'package_id'
 JOIN mlm.person p ON p.id=r.person_id LEFT JOIN mlm.affiliate af ON af.id=r.affiliate_id
 WHERE a.provider='stripe' AND b.id='9f488abd-f4fd-421e-8bb7-3d92ca4ca199'::uuid
  AND b.file_sha256='e8d27b0af998f8a290a478d8f4e8b907e1f361e30b2ba0e350395a0405c38e20' AND b.status='reviewed'
  AND b.row_count=737 AND (SELECT count(*) FROM payments.sales_import_row all_rows WHERE all_rows.batch_id=b.id)=737
  AND (SELECT count(*) FROM payments.sales_import_row all_rows WHERE all_rows.batch_id=b.id AND all_rows.product_scope='mindbliss_membership')=733
  AND r.external_id=p_pi AND r.product_scope='mindbliss_membership' AND r.display_status='paid' AND r.source_status='Paid' AND r.risk_status='none'
  AND r.record_sha256~'^[0-9a-f]{64}$' AND s.source_record_sha256~'^[0-9a-f]{64}$'
  AND r.refunded_minor=0 AND r.canonical_refunded_minor=0 AND r.canonical_dispute_count=0 AND r.canonical_source_eligible
  AND r.activation_status='not_inferred_from_import' AND NOT r.provider_verified AND NOT r.commission_eligible
  AND s.livemode AND s.payment_status='succeeded' AND s.currency='usd' AND r.currency='usd'
  AND s.refunded_minor=0 AND s.dispute_count=0 AND s.source_eligible AND s.metadata->>'packmindbliss'='true'
  AND jsonb_typeof(s.product_evidence)='array' AND jsonb_array_length(s.product_evidence)>0
  AND jsonb_typeof(s.source_review_reasons)='array' AND jsonb_array_length(s.source_review_reasons)=0
  AND s.captured_minor=s.gross_minor AND r.gross_minor=s.captured_minor AND c.base_minor+c.fee_minor=s.captured_minor
  AND c.currency='usd' AND c.base_minor=r.base_minor AND c.base_minor>0 AND c.fee_minor>=0
  AND c.source_sha256='1a66ef14184878c0a1ece0281b5607f6b4e274e67094d1502af47ee2e9c6a2a0'
  AND isfinite(s.charged_at) AND s.charged_at<=clock_timestamp() AND r.paid_at=s.charged_at
  AND length(r.package_name) BETWEEN 1 AND 240 AND r.package_name!~'[[:cntrl:]]'
  AND i.identity_verified AND i.catalog_verified AND i.person_id=r.person_id AND i.affiliate_id IS NOT DISTINCT FROM r.affiliate_id
  AND (r.affiliate_id IS NULL OR af.person_id=p.id) AND identity.member_referral_person_eligible(p.id)
  AND NOT EXISTS(SELECT FROM mlm.affiliate_package ap WHERE ap.transaction_hash IN(p_pi,'stripe:'||p_pi))
  AND NOT EXISTS(SELECT FROM payments.purchase_intent pi WHERE pi.stripe_payment_intent_id=p_pi)
  -- Manual orders have no PaymentIntent column. Never invent a match from a
  -- free-text reason/operation key; hold overlapping people for explicit review.
  AND NOT EXISTS(SELECT FROM payments.manual_membership_order mo WHERE mo.person_id=p.id)
$function$;

CREATE FUNCTION payments.register_stripe_membership_rights_run(p_id uuid,p_manifest jsonb,p_manifest_sha256 text,p_actor text,p_reason text)
RETURNS TABLE(id uuid,manifest_sha256 text,created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' AS $function$
DECLARE r payments.stripe_membership_rights_run%ROWTYPE;m jsonb;proof jsonb;v_snapshot jsonb;v_hash text;v_verified timestamptz;
BEGIN
 IF p_id IS NULL OR p_manifest_sha256 IS NULL OR p_manifest_sha256!~'^[0-9a-f]{64}$'
  OR p_manifest_sha256<>encode(sha256(convert_to(p_manifest::text,'UTF8')),'hex')
  OR p_actor IS NULL OR length(p_actor) NOT BETWEEN 1 AND 128 OR p_actor~'[[:cntrl:]]'
  OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 1 AND 480 OR p_reason~'[[:cntrl:]]'
  OR jsonb_typeof(p_manifest)<>'object' OR (SELECT array_agg(key ORDER BY key)FROM jsonb_object_keys(p_manifest)key)
   IS DISTINCT FROM ARRAY['members','policy','sourceBatchId','sourceFileSha256','version']::text[]
  OR p_manifest->'version' IS DISTINCT FROM '1'::jsonb OR p_manifest->>'policy' IS DISTINCT FROM 'historical_membership_access_until_revoked_v1'
  OR p_manifest->>'sourceBatchId' IS DISTINCT FROM '9f488abd-f4fd-421e-8bb7-3d92ca4ca199'
  OR p_manifest->>'sourceFileSha256' IS DISTINCT FROM 'e8d27b0af998f8a290a478d8f4e8b907e1f361e30b2ba0e350395a0405c38e20'
  OR jsonb_typeof(p_manifest->'members')<>'array' OR jsonb_array_length(p_manifest->'members') NOT BETWEEN 1 AND 733 THEN
  RAISE EXCEPTION 'member_package_rights_invalid_manifest' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('stripe-rights-run:'||p_id::text,0));
 SELECT x.* INTO r FROM payments.stripe_membership_rights_run x WHERE x.id=p_id;
 IF FOUND THEN
  IF r.manifest_sha256<>p_manifest_sha256 OR r.manifest<>p_manifest OR r.actor<>p_actor OR r.reason<>p_reason THEN
   RAISE EXCEPTION 'member_package_rights_conflict' USING ERRCODE='23505'; END IF;
  RETURN QUERY SELECT r.id,r.manifest_sha256,false;RETURN;
 END IF;
 IF (SELECT count(DISTINCT x->>'paymentIntentId')FROM jsonb_array_elements(p_manifest->'members')x)<>jsonb_array_length(p_manifest->'members') THEN
  RAISE EXCEPTION 'member_package_rights_invalid_manifest' USING ERRCODE='22023'; END IF;
 FOR m IN SELECT value FROM jsonb_array_elements(p_manifest->'members') LOOP
  IF jsonb_typeof(m)<>'object' OR (SELECT array_agg(key ORDER BY key)FROM jsonb_object_keys(m)key)
    IS DISTINCT FROM ARRAY['paymentIntentId','providerReadback','recordSha256','snapshotSha256']::text[]
   OR EXISTS(SELECT FROM jsonb_each(m)x WHERE x.key IN('paymentIntentId','recordSha256','snapshotSha256')AND jsonb_typeof(x.value)<>'string')
   OR coalesce(m->>'paymentIntentId','')!~'^pi_[A-Za-z0-9]{8,128}$' OR coalesce(m->>'recordSha256','')!~'^[0-9a-f]{64}$'
   OR coalesce(m->>'snapshotSha256','')!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'member_package_rights_invalid_manifest' USING ERRCODE='22023'; END IF;
  v_snapshot:=payments.stripe_membership_rights_source_snapshot(m->>'paymentIntentId');
  v_hash:=encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex');
  IF v_snapshot IS NULL OR m->>'recordSha256'<>v_snapshot->>'recordSha256' OR m->>'snapshotSha256'<>v_hash THEN
   RAISE EXCEPTION 'member_package_rights_source_requires_review' USING ERRCODE='22023'; END IF;
  proof:=m->'providerReadback';
  IF jsonb_typeof(proof)<>'object' OR (SELECT array_agg(key ORDER BY key)FROM jsonb_object_keys(proof)key)
   IS DISTINCT FROM ARRAY['captured','capturedMinor','chargeReference','currency','disputeCount','livemode','packmindbliss',
    'paid','paymentIntentId','proofSha256','refundedMinor','sourceMetadataMatches','status','verifiedAt']::text[]
   OR EXISTS(SELECT FROM jsonb_each(proof)x WHERE x.key IN('paymentIntentId','chargeReference','currency','status','capturedMinor','refundedMinor','verifiedAt','proofSha256')AND jsonb_typeof(x.value)<>'string')
   OR proof->>'paymentIntentId' IS DISTINCT FROM m->>'paymentIntentId' OR proof->>'chargeReference' IS DISTINCT FROM v_snapshot->>'chargeReference'
   OR proof->>'currency' IS DISTINCT FROM 'usd' OR proof->>'status' IS DISTINCT FROM 'succeeded'
   OR proof->'livemode' IS DISTINCT FROM 'true'::jsonb OR proof->'packmindbliss' IS DISTINCT FROM 'true'::jsonb OR proof->'paid' IS DISTINCT FROM 'true'::jsonb
   OR proof->'captured' IS DISTINCT FROM 'true'::jsonb OR proof->'sourceMetadataMatches' IS DISTINCT FROM 'true'::jsonb OR proof->'disputeCount' IS DISTINCT FROM '0'::jsonb
   OR proof->>'refundedMinor' IS DISTINCT FROM '0' OR proof->>'capturedMinor' IS DISTINCT FROM v_snapshot->>'capturedMinor'
   OR coalesce(proof->>'proofSha256','')!~'^[0-9a-f]{64}$' OR coalesce(proof->>'verifiedAt','')!~'^20[0-9]{2}-[0-9]{2}-[0-9]{2}T'
   OR length(proof->>'verifiedAt')>64 THEN
   RAISE EXCEPTION 'member_package_rights_provider_proof_required' USING ERRCODE='22023'; END IF;
  BEGIN v_verified:=(proof->>'verifiedAt')::timestamptz;
   EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'member_package_rights_provider_proof_required' USING ERRCODE='22023'; END;
  IF NOT isfinite(v_verified) OR v_verified>clock_timestamp()+interval '30 seconds' OR v_verified<clock_timestamp()-interval '24 hours' THEN
   RAISE EXCEPTION 'member_package_rights_provider_proof_required' USING ERRCODE='22023'; END IF;
 END LOOP;
 INSERT INTO payments.stripe_membership_rights_run(id,manifest_sha256,manifest,policy,source_batch_id,source_file_sha256,actor,reason)
 VALUES(p_id,p_manifest_sha256,p_manifest,'historical_membership_access_until_revoked_v1','9f488abd-f4fd-421e-8bb7-3d92ca4ca199',
  'e8d27b0af998f8a290a478d8f4e8b907e1f361e30b2ba0e350395a0405c38e20',p_actor,p_reason);
 RETURN QUERY SELECT p_id,p_manifest_sha256,true;
END $function$;

CREATE FUNCTION payments.recognize_stripe_membership_right(p_run uuid,p_pi text)
RETURNS TABLE(id uuid,created boolean,state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' AS $function$
DECLARE run payments.stripe_membership_rights_run%ROWTYPE;e payments.stripe_membership_entitlement%ROWTYPE;m jsonb;s jsonb;v_hash text;v_now timestamptz;
BEGIN
 IF p_run IS NULL OR p_pi IS NULL OR p_pi!~'^pi_[A-Za-z0-9]{8,128}$' THEN RAISE EXCEPTION 'member_package_rights_invalid_manifest' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('stripe-rights-pi:'||p_pi,0));
 SELECT r.* INTO STRICT run FROM payments.stripe_membership_rights_run r WHERE r.id=p_run;
 SELECT x INTO m FROM jsonb_array_elements(run.manifest->'members')x WHERE x->>'paymentIntentId'=p_pi;
 IF m IS NULL THEN RAISE EXCEPTION 'member_package_rights_invalid_manifest' USING ERRCODE='22023';END IF;
 s:=payments.stripe_membership_rights_source_snapshot(p_pi);v_hash:=encode(sha256(convert_to(s::text,'UTF8')),'hex');
 IF s IS NULL OR v_hash<>m->>'snapshotSha256' OR s->>'recordSha256'<>m->>'recordSha256'
  OR (m#>>'{providerReadback,verifiedAt}')::timestamptz<clock_timestamp()-interval '24 hours' THEN
  RAISE EXCEPTION 'member_package_rights_source_requires_review' USING ERRCODE='22023';END IF;
 SELECT x.* INTO e FROM payments.stripe_membership_entitlement x WHERE x.payment_intent_id=p_pi;
 IF FOUND THEN
  IF e.source_snapshot_sha256<>v_hash OR e.source_snapshot<>s OR e.term_policy<>run.policy THEN
   RAISE EXCEPTION 'member_package_rights_conflict' USING ERRCODE='23505';END IF;
  RETURN QUERY SELECT e.id,false,(SELECT v.state FROM payments.stripe_membership_rights_event v WHERE v.entitlement_id=e.id ORDER BY v.sequence_no DESC LIMIT 1);RETURN;
 END IF;
 v_now:=clock_timestamp();
 INSERT INTO payments.stripe_membership_entitlement(payment_intent_id,run_id,source_batch_id,source_record_sha256,source_snapshot,source_snapshot_sha256,
  person_id,affiliate_id,source_package_id,package_name,catalog_sha256,currency,base_minor,fee_minor,bought_at,recognized_at,access_from,term_policy,
  provider_verified_at,provider_proof_sha256)
 VALUES(p_pi,p_run,(s->>'sourceBatchId')::uuid,s->>'recordSha256',s,v_hash,(s->>'personId')::bigint,(s->>'affiliateId')::bigint,
  (s->>'sourcePackageId')::bigint,s->>'packageName',s->>'catalogSha256','usd',(s->>'baseMinor')::bigint,(s->>'feeMinor')::bigint,
  (s->>'boughtAt')::timestamptz,v_now,v_now,run.policy,(m#>>'{providerReadback,verifiedAt}')::timestamptz,m#>>'{providerReadback,proofSha256}') RETURNING * INTO e;
 INSERT INTO payments.stripe_membership_rights_event(id,entitlement_id,sequence_no,state,actor,reason,evidence_sha256)
 VALUES(gen_random_uuid(),e.id,1,'active',run.actor,run.reason,run.manifest_sha256);
 RETURN QUERY SELECT e.id,true,'active'::text;
END $function$;

CREATE FUNCTION payments.record_stripe_membership_rights_decision(p_event uuid,p_pi text,p_state text,p_actor text,p_reason text,p_evidence text)
RETURNS TABLE(id uuid,created boolean,state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' AS $function$
DECLARE e payments.stripe_membership_entitlement%ROWTYPE;v payments.stripe_membership_rights_event%ROWTYPE;v_seq bigint;v_state text;
BEGIN
 IF p_event IS NULL OR p_pi IS NULL OR p_pi!~'^pi_[A-Za-z0-9]{8,128}$' OR p_state IS NULL OR p_state NOT IN('suspended','revoked','review_required')
  OR p_actor IS NULL OR length(p_actor) NOT BETWEEN 1 AND 128 OR p_actor~'[[:cntrl:]]'
  OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 1 AND 480 OR p_reason~'[[:cntrl:]]'
  OR p_evidence IS NULL OR p_evidence!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'member_package_rights_invalid_decision' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('stripe-rights-pi:'||p_pi,0));
 SELECT x.* INTO STRICT e FROM payments.stripe_membership_entitlement x WHERE x.payment_intent_id=p_pi;
 SELECT x.* INTO v FROM payments.stripe_membership_rights_event x WHERE x.id=p_event;
 IF FOUND THEN
  IF v.entitlement_id<>e.id OR v.state<>p_state OR v.actor<>p_actor OR v.reason<>p_reason OR v.evidence_sha256<>p_evidence THEN
   RAISE EXCEPTION 'member_package_rights_conflict' USING ERRCODE='23505';END IF;
  RETURN QUERY SELECT v.id,false,v.state;RETURN;
 END IF;
 SELECT x.sequence_no,x.state INTO STRICT v_seq,v_state FROM payments.stripe_membership_rights_event x WHERE x.entitlement_id=e.id ORDER BY x.sequence_no DESC LIMIT 1;
 IF v_state='revoked' AND p_state<>'revoked' THEN RAISE EXCEPTION 'member_package_rights_revoked' USING ERRCODE='23514';END IF;
 INSERT INTO payments.stripe_membership_rights_event(id,entitlement_id,sequence_no,state,actor,reason,evidence_sha256)
 VALUES(p_event,e.id,v_seq+1,p_state,p_actor,p_reason,p_evidence);
 RETURN QUERY SELECT p_event,true,p_state;
END $function$;

CREATE FUNCTION payments.read_member_package_rights(p_subject text,p_session text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' AS $function$
DECLARE v_until timestamptz;v_person bigint;v_rows jsonb;v_total bigint;v_active bigint;
BEGIN
 BEGIN v_until:=identity.require_administrative_native_session(p_subject,p_session);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'member_package_rights_forbidden' USING ERRCODE='28000';END;
 BEGIN SELECT p.id INTO STRICT v_person FROM identity.auth_binding b JOIN mlm.person p ON p.id=b.person_id AND p.user_id=b.subject
  WHERE b.subject=p_subject AND b.provider='better_auth' FOR SHARE OF b,p;
 EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN RAISE EXCEPTION 'member_package_rights_forbidden' USING ERRCODE='28000';END;
 WITH owned AS(
  SELECT e.*,CASE WHEN v.state='active' AND (payments.stripe_membership_rights_source_snapshot(e.payment_intent_id) IS DISTINCT FROM e.source_snapshot)
   THEN 'review_required' ELSE v.state END AS rights_state
  FROM payments.stripe_membership_entitlement e JOIN LATERAL(SELECT x.state FROM payments.stripe_membership_rights_event x
   WHERE x.entitlement_id=e.id ORDER BY x.sequence_no DESC LIMIT 1)v ON true WHERE e.person_id=v_person
 ),latest AS(SELECT * FROM owned ORDER BY recognized_at DESC,id DESC LIMIT 100)
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id::text,'packageName',package_name,'sourcePackageId',source_package_id::text,
   'packageBaseUsd',(base_minor::numeric/100)::numeric(24,2)::text,
   'boughtAt',to_char(bought_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
   'recognizedAt',to_char(recognized_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'status',rights_state,
   'term',jsonb_build_object('type','until_revoked','startsAt',to_char(access_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'endsAt',NULL),
   'source','stripe_import')ORDER BY recognized_at DESC,id DESC),'[]'::jsonb),
  (SELECT count(*) FROM owned),(SELECT count(*) FROM owned WHERE rights_state='active')INTO v_rows,v_total,v_active FROM latest;
 IF v_total>733 OR v_until<=clock_timestamp() THEN RAISE EXCEPTION 'member_package_rights_unavailable' USING ERRCODE='28000';END IF;
 RETURN jsonb_build_object('rightsOnly',true,'economicActivation',false,'roiEnabled',false,'commissionsEnabled',false,
  'policy','historical_membership_access_until_revoked_v1','totalCount',v_total,'activeCount',v_active,'items',v_rows);
END $function$;

DO $ownership$
DECLARE v_owner oid;item record;signature text;
BEGIN
 SELECT proowner INTO v_owner FROM pg_proc WHERE oid='identity.require_administrative_native_session(text,text)'::regprocedure;
 FOR item IN SELECT c.oid::regclass relation FROM pg_class c WHERE c.oid IN('payments.stripe_membership_rights_run'::regclass,
  'payments.stripe_membership_entitlement'::regclass,'payments.stripe_membership_rights_event'::regclass)LOOP
  EXECUTE format('ALTER TABLE %s OWNER TO %I',item.relation,pg_get_userbyid(v_owner));END LOOP;
 FOREACH signature IN ARRAY ARRAY['payments.reject_stripe_membership_rights_mutation()',
  'payments.stripe_membership_rights_source_snapshot(text)','payments.register_stripe_membership_rights_run(uuid,jsonb,text,text,text)',
  'payments.recognize_stripe_membership_right(uuid,text)','payments.record_stripe_membership_rights_decision(uuid,text,text,text,text,text)',
  'payments.read_member_package_rights(text,text)'] LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO %I',signature,pg_get_userbyid(v_owner));
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
 END LOOP;
 FOR item IN SELECT c.oid::regclass relation,a.grantee FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl)a WHERE c.oid IN(
  'payments.stripe_membership_rights_run'::regclass,'payments.stripe_membership_entitlement'::regclass,'payments.stripe_membership_rights_event'::regclass)AND a.grantee<>c.relowner LOOP
  EXECUTE format('REVOKE ALL ON TABLE %s FROM %s',item.relation,CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(item.grantee))END);END LOOP;
 FOR item IN SELECT p.oid::regprocedure signature,a.grantee FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl)a WHERE p.oid IN(
  'payments.reject_stripe_membership_rights_mutation()'::regprocedure,'payments.stripe_membership_rights_source_snapshot(text)'::regprocedure,
  'payments.register_stripe_membership_rights_run(uuid,jsonb,text,text,text)'::regprocedure,'payments.recognize_stripe_membership_right(uuid,text)'::regprocedure,
  'payments.record_stripe_membership_rights_decision(uuid,text,text,text,text,text)'::regprocedure,'payments.read_member_package_rights(text,text)'::regprocedure)
  AND a.grantee<>p.proowner AND a.grantee<>0 LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',item.signature,pg_get_userbyid(item.grantee));END LOOP;
END $ownership$;
GRANT EXECUTE ON FUNCTION payments.read_member_package_rights(text,text) TO mindbliss_auth_core_v1;
GRANT EXECUTE ON FUNCTION payments.register_stripe_membership_rights_run(uuid,jsonb,text,text,text),payments.recognize_stripe_membership_right(uuid,text),
 payments.record_stripe_membership_rights_decision(uuid,text,text,text,text,text) TO mindbliss_stripe_rights_operator_v1;
COMMIT;
