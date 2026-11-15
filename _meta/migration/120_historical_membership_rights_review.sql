-- Explicit, individually evidenced rights-only review decisions. Never edit
-- original imported statuses, canonical financial identity, tree or economics.
BEGIN;
SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='2min';
SELECT pg_advisory_xact_lock(hashtextextended('historical-membership-rights-review-v1',0));
DO $preflight$
DECLARE v_owner oid;
BEGIN
 IF current_database()<>'mindbliss_curated_20261025' OR pg_is_in_recovery()
  OR md5(pg_get_functiondef('payments.stripe_membership_rights_evidence_snapshot(text)'::regprocedure))<>'52197b96008830cfdeae841ea378ef3d'
  OR to_regclass('payments.stripe_membership_rights_review_decision') IS NOT NULL
  OR to_regprocedure('payments.stripe_membership_rights_review_source_context(text,text)') IS NOT NULL
  OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname='mindbliss_stripe_rights_operator_v1' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls)THEN
  RAISE EXCEPTION 'member_package_rights_review_requires_fresh_review';END IF;
 SELECT proowner INTO v_owner FROM pg_proc WHERE oid='payments.stripe_membership_rights_evidence_snapshot(text)'::regprocedure;
 IF NOT has_column_privilege(v_owner,'auth.user','id','SELECT') OR NOT has_column_privilege(v_owner,'auth.user','email','SELECT')
  OR NOT has_column_privilege(v_owner,'auth.user','email_verified','SELECT') OR NOT has_table_privilege(v_owner,'identity.auth_binding','SELECT')THEN
  RAISE EXCEPTION 'member_package_rights_review_existing_identity_policy_required';END IF;
 PERFORM set_config('mindbliss.rights120_previous_permissions',(SELECT jsonb_build_object('owner',p.proowner,'acl',p.proacl,'config',p.proconfig,'definer',p.prosecdef,'volatility',p.provolatile)::text
  FROM pg_proc p WHERE p.oid='payments.stripe_membership_rights_evidence_snapshot(text)'::regprocedure),true);
END $preflight$;

CREATE TABLE payments.stripe_membership_rights_review_decision(
 id uuid PRIMARY KEY,payment_intent_id text NOT NULL UNIQUE REFERENCES payments.stripe_sale(payment_intent_id),
 mode text NOT NULL CHECK(mode IN('csv_review','identity_correction')),
 original_snapshot jsonb NOT NULL CHECK(jsonb_typeof(original_snapshot)='object'),original_snapshot_sha256 text NOT NULL CHECK(original_snapshot_sha256~'^[0-9a-f]{64}$'),
 approved_snapshot jsonb NOT NULL CHECK(jsonb_typeof(approved_snapshot)='object'),approved_snapshot_sha256 text NOT NULL CHECK(approved_snapshot_sha256~'^[0-9a-f]{64}$'),
 provider_readback jsonb NOT NULL CHECK(jsonb_typeof(provider_readback)='object'),
 provider_identity jsonb NOT NULL CHECK(jsonb_typeof(provider_identity)='object'),radar_review jsonb NOT NULL CHECK(jsonb_typeof(radar_review)='object'),
 actor text NOT NULL CHECK(length(actor)BETWEEN 1 AND 128 AND actor!~'[[:cntrl:]]'),reason text NOT NULL CHECK(length(reason)BETWEEN 1 AND 480 AND reason!~'[[:cntrl:]]'),
 approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(original_snapshot_sha256=encode(sha256(convert_to(original_snapshot::text,'UTF8')),'hex')),
 CHECK(approved_snapshot_sha256=encode(sha256(convert_to(approved_snapshot::text,'UTF8')),'hex'))
);
ALTER TABLE payments.stripe_membership_rights_review_decision ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER stripe_membership_rights_review_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON payments.stripe_membership_rights_review_decision
 FOR EACH STATEMENT EXECUTE FUNCTION payments.reject_stripe_membership_rights_mutation();

CREATE FUNCTION payments.stripe_membership_rights_review_source_context(p_pi text,p_mode text)RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT jsonb_build_object('original',jsonb_build_object('paymentIntentId',r.external_id,'recordSha256',r.record_sha256,'canonicalRecordSha256',s.source_record_sha256,
  'sourceBatchId',r.batch_id::text,'sourceStatus',r.source_status,'displayStatus',r.display_status,'riskStatus',r.risk_status,
  'originalPersonId',r.person_id::text,'originalAffiliateId',r.affiliate_id::text,
  'canonicalPersonId',i.person_id::text,'canonicalAffiliateId',i.affiliate_id::text,'identityVerified',i.identity_verified,
  'identityMatchStatus',i.match_status,'identityReviewReasons',i.review_reasons,'catalogVerified',i.catalog_verified,
  'canonicalEmailSha256',encode(sha256(convert_to(lower(btrim(s.metadata->>'email')),'UTF8')),'hex'),
  'metadataPersonId',s.metadata->>'person_id','metadataPackageId',s.metadata->>'package_id'),'approved',jsonb_build_object('paymentIntentId',r.external_id,'chargeReference',r.provider_reference,
  'sourceBatchId',r.batch_id::text,'sourceFileSha256',b.file_sha256,'sourceRow',r.source_row,
  'recordSha256',r.record_sha256,'canonicalRecordSha256',s.source_record_sha256,
  'personId',p.id::text,'affiliateId',af.id::text,'sourcePackageId',c.source_package_id::text,
  'packageName',r.package_name,'catalogSha256',c.source_sha256,'currency',r.currency,
  'baseMinor',c.base_minor::text,'feeMinor',c.fee_minor::text,'capturedMinor',s.captured_minor::text,
  'boughtAt',to_char(s.charged_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
 FROM payments.sales_import_batch b
 JOIN payments.sales_import_row r ON r.batch_id=b.id JOIN payments.stripe_sale s ON s.payment_intent_id=r.canonical_payment_intent_id
 JOIN recovery.stripe_sale_identity i ON i.payment_intent_id=s.payment_intent_id
 JOIN recovery.package_catalog_snapshot c ON c.source_package_id=r.package_id AND c.source_package_id::text=s.metadata->>'package_id'
 JOIN mlm.person p ON p.id=CASE WHEN p_mode='identity_correction' THEN 15451 ELSE r.person_id END
 LEFT JOIN mlm.affiliate af ON af.id=CASE WHEN p_mode='identity_correction' THEN 115533 ELSE r.affiliate_id END
 WHERE b.id='9f488abd-f4fd-421e-8bb7-3d92ca4ca199'::uuid
  AND b.file_sha256='e8d27b0af998f8a290a478d8f4e8b907e1f361e30b2ba0e350395a0405c38e20' AND b.status='reviewed'
  AND b.row_count=737 AND (SELECT count(*) FROM payments.sales_import_row all_rows WHERE all_rows.batch_id=b.id)=737
  AND (SELECT count(*) FROM payments.sales_import_row all_rows WHERE all_rows.batch_id=b.id AND all_rows.product_scope='mindbliss_membership')=733
  AND r.external_id=p_pi AND r.product_scope='mindbliss_membership' AND r.risk_status='none'
  AND ((p_mode='csv_review' AND r.display_status='under_review' AND r.source_status='En Revisión' AND i.identity_verified
    AND i.person_id=r.person_id AND i.affiliate_id IS NOT DISTINCT FROM r.affiliate_id)
   OR(p_mode='identity_correction' AND encode(sha256(convert_to(p_pi,'UTF8')),'hex')='d418b4ac8574307fbad5c9ae52bd9157259e4055eb723d2703c0b2b25b9bd72a'
    AND r.display_status='paid' AND r.source_status='Paid' AND r.person_id IS NULL AND r.affiliate_id IS NULL
    AND i.identity_verified IS FALSE AND i.person_id=15450 AND i.affiliate_id=88610 AND s.metadata->>'person_id'='15451'))
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
  AND i.catalog_verified AND ((p_mode='csv_review'AND(r.affiliate_id IS NULL OR af.person_id=p.id))
   OR(p_mode='identity_correction'AND af.id=115533 AND af.person_id=p.id)) AND identity.member_referral_person_eligible(p.id)
  AND nullif(btrim(s.metadata->>'email'),'') IS NOT NULL AND length(btrim(s.metadata->>'email'))<=254
  AND btrim(s.metadata->>'email')!~'[[:space:][:cntrl:]]'
$function$;

CREATE FUNCTION payments.stripe_membership_rights_review_evidence_snapshot(p_pi text)RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT d.approved_snapshot FROM payments.stripe_membership_rights_review_decision d
 WHERE d.payment_intent_id=p_pi AND payments.stripe_membership_rights_review_source_context(p_pi,d.mode)
  =jsonb_build_object('original',d.original_snapshot,'approved',d.approved_snapshot)
$function$;

CREATE OR REPLACE FUNCTION payments.stripe_membership_rights_evidence_snapshot(p_pi text)RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT coalesce((
SELECT jsonb_build_object('paymentIntentId',r.external_id,'chargeReference',r.provider_reference,
  'sourceBatchId',r.batch_id::text,'sourceFileSha256',b.file_sha256,'sourceRow',r.source_row,
  'recordSha256',r.record_sha256,'canonicalRecordSha256',s.source_record_sha256,
  'personId',r.person_id::text,'affiliateId',r.affiliate_id::text,'sourcePackageId',c.source_package_id::text,
  'packageName',r.package_name,'catalogSha256',c.source_sha256,'currency',r.currency,
  'baseMinor',c.base_minor::text,'feeMinor',c.fee_minor::text,'capturedMinor',s.captured_minor::text,
  'boughtAt',to_char(s.charged_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
 FROM payments.sales_import_batch b
 JOIN payments.sales_import_row r ON r.batch_id=b.id JOIN payments.stripe_sale s ON s.payment_intent_id=r.canonical_payment_intent_id
 JOIN recovery.stripe_sale_identity i ON i.payment_intent_id=s.payment_intent_id
 JOIN recovery.package_catalog_snapshot c ON c.source_package_id=r.package_id AND c.source_package_id::text=s.metadata->>'package_id'
 JOIN mlm.person p ON p.id=r.person_id LEFT JOIN mlm.affiliate af ON af.id=r.affiliate_id
 WHERE b.id='9f488abd-f4fd-421e-8bb7-3d92ca4ca199'::uuid
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
 ),payments.stripe_membership_rights_review_evidence_snapshot(p_pi))
$function$;

CREATE FUNCTION payments.approve_stripe_membership_rights_review(p_id uuid,p_pi text,p_mode text,p_original_sha text,p_approved_sha text,
 p_provider_readback jsonb,p_provider_identity jsonb,p_radar_review jsonb,p_actor text,p_reason text)
RETURNS TABLE(id uuid,created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' AS $function$
DECLARE d payments.stripe_membership_rights_review_decision%ROWTYPE;context jsonb;approved jsonb;original jsonb;proof jsonb;v_verified timestamptz;
BEGIN
 IF p_id IS NULL OR p_pi IS NULL OR p_pi!~'^pi_[A-Za-z0-9]{8,128}$' OR p_mode IS NULL OR p_mode NOT IN('csv_review','identity_correction')
  OR p_original_sha IS NULL OR p_original_sha!~'^[0-9a-f]{64}$' OR p_approved_sha IS NULL OR p_approved_sha!~'^[0-9a-f]{64}$'
  OR p_actor IS NULL OR length(p_actor)NOT BETWEEN 1 AND 128 OR p_actor~'[[:cntrl:]]'
  OR p_reason IS NULL OR length(p_reason)NOT BETWEEN 1 AND 480 OR p_reason~'[[:cntrl:]]'
  OR jsonb_typeof(p_provider_readback)IS DISTINCT FROM 'object' OR jsonb_typeof(p_provider_identity)IS DISTINCT FROM 'object'
  OR jsonb_typeof(p_radar_review)IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'member_package_rights_review_invalid' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('stripe-rights-pi:'||p_pi,0));
 SELECT x.* INTO d FROM payments.stripe_membership_rights_review_decision x WHERE x.payment_intent_id=p_pi;
 IF FOUND THEN
  IF d.id<>p_id OR d.mode<>p_mode OR d.original_snapshot_sha256<>p_original_sha OR d.approved_snapshot_sha256<>p_approved_sha
   OR d.provider_readback<>p_provider_readback OR d.provider_identity<>p_provider_identity OR d.radar_review<>p_radar_review OR d.actor<>p_actor OR d.reason<>p_reason THEN
   RAISE EXCEPTION 'member_package_rights_review_conflict' USING ERRCODE='23505';END IF;
  RETURN QUERY SELECT d.id,false;RETURN;
 END IF;
 IF EXISTS(SELECT FROM payments.stripe_membership_rights_review_decision x WHERE x.id=p_id)
  OR EXISTS(SELECT FROM payments.stripe_membership_entitlement e WHERE e.payment_intent_id=p_pi) THEN
  RAISE EXCEPTION 'member_package_rights_review_conflict' USING ERRCODE='23505';END IF;
 context:=payments.stripe_membership_rights_review_source_context(p_pi,p_mode);original:=context->'original';approved:=context->'approved';
 IF context IS NULL OR p_original_sha IS DISTINCT FROM encode(sha256(convert_to(original::text,'UTF8')),'hex')
  OR p_approved_sha IS DISTINCT FROM encode(sha256(convert_to(approved::text,'UTF8')),'hex') THEN
  RAISE EXCEPTION 'member_package_rights_review_source_changed' USING ERRCODE='22023';END IF;
 proof:=p_provider_readback;
 IF (SELECT array_agg(key ORDER BY key)FROM jsonb_object_keys(proof)key)IS DISTINCT FROM
  ARRAY['captured','capturedMinor','chargeReference','currency','disputeCount','livemode','packmindbliss','paid','paymentIntentId','proofSha256','refundedMinor','sourceMetadataMatches','status','verifiedAt']::text[]
  OR EXISTS(SELECT FROM jsonb_each(proof)x WHERE x.key IN('paymentIntentId','chargeReference','currency','status','capturedMinor','refundedMinor','verifiedAt','proofSha256')AND jsonb_typeof(x.value)<>'string')
  OR proof->>'paymentIntentId'IS DISTINCT FROM p_pi OR proof->>'chargeReference'IS DISTINCT FROM approved->>'chargeReference'
  OR proof->>'currency'IS DISTINCT FROM 'usd' OR proof->>'status'IS DISTINCT FROM 'succeeded'
  OR proof->'livemode'IS DISTINCT FROM 'true'::jsonb OR proof->'packmindbliss'IS DISTINCT FROM 'true'::jsonb OR proof->'paid'IS DISTINCT FROM 'true'::jsonb
  OR proof->'captured'IS DISTINCT FROM 'true'::jsonb OR proof->'sourceMetadataMatches'IS DISTINCT FROM 'true'::jsonb OR proof->'disputeCount'IS DISTINCT FROM '0'::jsonb
  OR proof->>'refundedMinor'IS DISTINCT FROM '0' OR proof->>'capturedMinor'IS DISTINCT FROM approved->>'capturedMinor'
  OR coalesce(proof->>'proofSha256','')!~'^[0-9a-f]{64}$' OR coalesce(proof->>'verifiedAt','')!~'^20[0-9]{2}-[0-9]{2}-[0-9]{2}T' OR length(proof->>'verifiedAt')>64 THEN
  RAISE EXCEPTION 'member_package_rights_review_provider_proof_required' USING ERRCODE='22023';END IF;
 BEGIN v_verified:=(proof->>'verifiedAt')::timestamptz;
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'member_package_rights_review_provider_proof_required' USING ERRCODE='22023';END;
 IF NOT isfinite(v_verified) OR v_verified>clock_timestamp()+interval '30 seconds' OR v_verified<clock_timestamp()-interval '24 hours' THEN
  RAISE EXCEPTION 'member_package_rights_review_provider_proof_required' USING ERRCODE='22023';END IF;
 IF (SELECT array_agg(key ORDER BY key)FROM jsonb_object_keys(p_provider_identity)key)IS DISTINCT FROM
  ARRAY['emailNormalizedSha256','metadataPackageId','metadataPersonId']::text[]
  OR EXISTS(SELECT FROM jsonb_each(p_provider_identity)x WHERE jsonb_typeof(x.value)<>'string')
  OR coalesce(p_provider_identity->>'emailNormalizedSha256','')!~'^[0-9a-f]{64}$'
  OR p_provider_identity->>'emailNormalizedSha256'IS DISTINCT FROM original->>'canonicalEmailSha256'
  OR p_provider_identity->>'metadataPersonId'IS DISTINCT FROM original->>'metadataPersonId'
  OR p_provider_identity->>'metadataPackageId'IS DISTINCT FROM original->>'metadataPackageId' THEN
  RAISE EXCEPTION 'member_package_rights_review_identity_proof_required' USING ERRCODE='22023';END IF;
 -- Only the actually reviewed no-Radar-reference cohort is admitted. A review
 -- ID needs a future, linked Review->PI/charge proof; an 'approved' label alone
 -- is deliberately insufficient. No Radar approval POST is ever performed.
 IF (SELECT array_agg(key ORDER BY key)FROM jsonb_object_keys(p_radar_review)key)IS DISTINCT FROM
  ARRAY['closedReason','open','proofSha256','reviewReference','state']::text[]
  OR p_radar_review->>'state'IS DISTINCT FROM 'none' OR p_radar_review->'open'IS DISTINCT FROM 'false'::jsonb
  OR p_radar_review->'reviewReference'IS DISTINCT FROM 'null'::jsonb OR p_radar_review->'closedReason'IS DISTINCT FROM 'null'::jsonb
  OR p_radar_review->'proofSha256'IS DISTINCT FROM 'null'::jsonb THEN
  RAISE EXCEPTION 'member_package_rights_review_radar_hold' USING ERRCODE='22023';END IF;
 IF p_mode='identity_correction' AND NOT EXISTS(
  SELECT FROM mlm.person p JOIN identity.auth_binding b ON b.person_id=p.id AND b.provider='better_auth' AND b.subject=p.user_id
  JOIN auth."user" u ON u.id=b.subject JOIN payments.stripe_sale s ON s.payment_intent_id=p_pi
  WHERE p.id=15451 AND u.email_verified
   AND lower(btrim(p.email))=lower(btrim(s.metadata->>'email')) AND lower(btrim(u.email))=lower(btrim(s.metadata->>'email'))
   AND(SELECT count(*)FROM mlm.person other WHERE lower(btrim(other.email))=lower(btrim(s.metadata->>'email')))=1
   AND(SELECT count(*)FROM auth."user" other WHERE lower(btrim(other.email))=lower(btrim(s.metadata->>'email')))=1
   AND(SELECT count(*)FROM identity.auth_binding other WHERE other.person_id=p.id AND other.provider='better_auth')=1
   AND(SELECT count(*)FROM identity.auth_binding other JOIN auth."user" ou ON ou.id=other.subject WHERE lower(btrim(ou.email))=lower(btrim(s.metadata->>'email')))=1
 )THEN RAISE EXCEPTION 'member_package_rights_review_identity_proof_required' USING ERRCODE='28000';END IF;
 INSERT INTO payments.stripe_membership_rights_review_decision(id,payment_intent_id,mode,original_snapshot,original_snapshot_sha256,
  approved_snapshot,approved_snapshot_sha256,provider_readback,provider_identity,radar_review,actor,reason)
 VALUES(p_id,p_pi,p_mode,original,p_original_sha,approved,p_approved_sha,p_provider_readback,p_provider_identity,p_radar_review,p_actor,p_reason);
 RETURN QUERY SELECT p_id,true;
END $function$;

DO $ownership$
DECLARE v_owner oid;item record;signature text;
BEGIN
 SELECT proowner INTO v_owner FROM pg_proc WHERE oid='payments.stripe_membership_rights_evidence_snapshot(text)'::regprocedure;
 EXECUTE format('ALTER TABLE payments.stripe_membership_rights_review_decision OWNER TO %I',pg_get_userbyid(v_owner));
 FOREACH signature IN ARRAY ARRAY['payments.stripe_membership_rights_review_source_context(text,text)',
  'payments.stripe_membership_rights_review_evidence_snapshot(text)',
  'payments.approve_stripe_membership_rights_review(uuid,text,text,text,text,jsonb,jsonb,jsonb,text,text)']LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO %I',signature,pg_get_userbyid(v_owner));
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
 END LOOP;
 FOR item IN SELECT a.grantee FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl)a WHERE c.oid='payments.stripe_membership_rights_review_decision'::regclass AND a.grantee<>c.relowner LOOP
  EXECUTE format('REVOKE ALL ON payments.stripe_membership_rights_review_decision FROM %s',CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(item.grantee))END);END LOOP;
 FOR item IN SELECT p.oid::regprocedure signature,a.grantee FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl)a WHERE p.oid IN(
  'payments.stripe_membership_rights_review_source_context(text,text)'::regprocedure,'payments.stripe_membership_rights_review_evidence_snapshot(text)'::regprocedure,
  'payments.approve_stripe_membership_rights_review(uuid,text,text,text,text,jsonb,jsonb,jsonb,text,text)'::regprocedure)AND a.grantee<>p.proowner AND a.grantee<>0 LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',item.signature,pg_get_userbyid(item.grantee));END LOOP;
 IF current_setting('mindbliss.rights120_previous_permissions')::jsonb IS DISTINCT FROM(SELECT jsonb_build_object('owner',p.proowner,'acl',p.proacl,'config',p.proconfig,'definer',p.prosecdef,'volatility',p.provolatile)
  FROM pg_proc p WHERE p.oid='payments.stripe_membership_rights_evidence_snapshot(text)'::regprocedure)THEN
  RAISE EXCEPTION 'member_package_rights_review_permission_drift';END IF;
END $ownership$;
GRANT EXECUTE ON FUNCTION payments.approve_stripe_membership_rights_review(uuid,text,text,text,text,jsonb,jsonb,jsonb,text,text) TO mindbliss_stripe_rights_operator_v1;
COMMIT;
