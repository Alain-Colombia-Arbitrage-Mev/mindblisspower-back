-- Keep an approved historical right until explicit revocation or actual
-- evidence/identity/risk drift. Reporting-pointer changes and unrelated later
-- purchases are grant-only gates, not revocations. No existing rows are written.
BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('historical-membership-rights-validity-v1',0));
DO $preflight$
BEGIN
 IF pg_catalog.current_database()<>'mindbliss_curated_20261025' OR pg_catalog.pg_is_in_recovery()
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.stripe_membership_rights_source_snapshot(text)'::regprocedure))<>'fc136ab209e97454d1899d1044021dde'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.read_member_package_rights(text,text)'::regprocedure))<>'8ea5e613374652654e95eae55add3e9a'
  OR pg_catalog.to_regprocedure('payments.stripe_membership_rights_evidence_snapshot(text)') IS NOT NULL THEN
  RAISE EXCEPTION 'member_package_rights_validity_requires_fresh_review'; END IF;
 PERFORM set_config('mindbliss.rights119_previous_permissions',(SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'owner',p.proowner,'acl',p.proacl,'settings',p.proconfig,'definer',p.prosecdef,'volatility',p.provolatile)ORDER BY p.oid)::text
  FROM pg_proc p WHERE p.oid IN('payments.stripe_membership_rights_source_snapshot(text)'::regprocedure,'payments.read_member_package_rights(text,text)'::regprocedure)),true);
END $preflight$;

CREATE FUNCTION payments.stripe_membership_rights_evidence_snapshot(p_pi text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION payments.stripe_membership_rights_source_snapshot(p_pi text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
 WITH evidence AS MATERIALIZED(SELECT payments.stripe_membership_rights_evidence_snapshot(p_pi) AS snapshot)
 SELECT snapshot FROM evidence WHERE snapshot IS NOT NULL
  AND EXISTS(SELECT FROM payments.admin_sales_source a WHERE a.provider='stripe' AND a.active_batch_id=(snapshot->>'sourceBatchId')::uuid)
  AND NOT EXISTS(SELECT FROM mlm.affiliate_package ap WHERE ap.transaction_hash IN(p_pi,'stripe:'||p_pi))
  AND NOT EXISTS(SELECT FROM payments.purchase_intent pi WHERE pi.stripe_payment_intent_id=p_pi)
  AND NOT EXISTS(SELECT FROM payments.manual_membership_order mo WHERE mo.person_id=(snapshot->>'personId')::bigint)
$function$;

CREATE OR REPLACE FUNCTION payments.read_member_package_rights(p_subject text,p_session text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' AS $function$
DECLARE v_until timestamptz;v_person bigint;v_rows jsonb;v_total bigint;v_active bigint;
BEGIN
 BEGIN v_until:=identity.require_administrative_native_session(p_subject,p_session);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'member_package_rights_forbidden' USING ERRCODE='28000';END;
 BEGIN SELECT p.id INTO STRICT v_person FROM identity.auth_binding b JOIN mlm.person p ON p.id=b.person_id AND p.user_id=b.subject
  WHERE b.subject=p_subject AND b.provider='better_auth' FOR SHARE OF b,p;
 EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN RAISE EXCEPTION 'member_package_rights_forbidden' USING ERRCODE='28000';END;
 WITH owned AS(
  SELECT e.*,CASE WHEN v.state='active' AND (payments.stripe_membership_rights_evidence_snapshot(e.payment_intent_id) IS DISTINCT FROM e.source_snapshot)
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
DECLARE v_owner oid;item record;
BEGIN
 SELECT proowner INTO v_owner FROM pg_proc WHERE oid='payments.stripe_membership_rights_source_snapshot(text)'::regprocedure;
 EXECUTE format('ALTER FUNCTION payments.stripe_membership_rights_evidence_snapshot(text) OWNER TO %I',pg_get_userbyid(v_owner));
 REVOKE ALL ON FUNCTION payments.stripe_membership_rights_evidence_snapshot(text) FROM PUBLIC;
 FOR item IN SELECT a.grantee FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl)a
  WHERE p.oid='payments.stripe_membership_rights_evidence_snapshot(text)'::regprocedure AND a.grantee<>p.proowner AND a.grantee<>0 LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION payments.stripe_membership_rights_evidence_snapshot(text) FROM %I',pg_get_userbyid(item.grantee));END LOOP;
 IF current_setting('mindbliss.rights119_previous_permissions')::jsonb IS DISTINCT FROM(SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'owner',p.proowner,'acl',p.proacl,'settings',p.proconfig,'definer',p.prosecdef,'volatility',p.provolatile)ORDER BY p.oid)
  FROM pg_proc p WHERE p.oid IN('payments.stripe_membership_rights_source_snapshot(text)'::regprocedure,'payments.read_member_package_rights(text,text)'::regprocedure)) THEN
  RAISE EXCEPTION 'member_package_rights_validity_permission_drift';END IF;
END $ownership$;
COMMIT;
