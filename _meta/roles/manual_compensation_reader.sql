-- Operator-reviewed additive READ ONLY manifest for migration 91. No login,
-- secret, role creation, DML, provider permission or authentication credential
-- access is introduced. In the SAME transaction set_config(
-- 'mindbliss.manual_compensation_reader_role','reviewed-payments-reader',true).
-- The invoker view requires column access to BOTH UNION branches, even when
-- filtering source_kind='manual'; do not silently fall back to a zero balance.
-- The explicit target may be a NOINHERIT LOGIN or an INHERIT NOLOGIN read
-- group. Granting to the latter never changes any existing login/membership.
DO $manual_reader_acl$
DECLARE
 target name:=current_setting('mindbliss.manual_compensation_reader_role',true)::name;
 r record; relation text;
BEGIN
 IF target IS NULL OR target::text='' THEN RAISE EXCEPTION 'explicit manual compensation reader role is required'; END IF;
 SELECT * INTO r FROM pg_roles WHERE rolname=target;
 IF NOT FOUND OR NOT ((r.rolcanlogin AND NOT r.rolinherit) OR (NOT r.rolcanlogin AND r.rolinherit))
 OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
 OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) THEN
  RAISE EXCEPTION 'manual compensation reader must be a nonprivileged NOINHERIT login or INHERIT NOLOGIN group without parent memberships';
 END IF;
 FOREACH relation IN ARRAY ARRAY['payments.manual_membership_order','payments.compensation_source','payments.v_compensation_source','payments.v_compensation_obligation_origin',
  'payments.nowpayments_engine_obligation','payments.nowpayments_engine_payment','auth.user','identity.auth_binding'] LOOP
  IF to_regclass(relation) IS NULL THEN RAISE EXCEPTION 'manual compensation reader schema is incomplete'; END IF;
  IF has_table_privilege(target,relation,'INSERT,UPDATE,DELETE,TRUNCATE') THEN
   RAISE EXCEPTION 'manual compensation reader has write privileges';
  END IF;
 END LOOP;
 -- Never add rights to password hashes, sessions, OTP/challenges or tokens.
 EXECUTE format('GRANT USAGE ON SCHEMA auth,identity,mlm,payments TO %I',target);
 EXECUTE format('GRANT SELECT(id,email,email_verified) ON auth.user TO %I',target);
 EXECUTE format('GRANT SELECT(subject,person_id,provider) ON identity.auth_binding TO %I',target);
 EXECUTE format('GRANT SELECT(id,user_id,email,status,blacklisted) ON mlm.person TO %I',target);
 EXECUTE format('GRANT SELECT(id,person_id,status) ON mlm.affiliate TO %I',target);
 EXECUTE format('GRANT SELECT(email_norm) ON mlm.blacklist TO %I',target);
 EXECUTE format('GRANT SELECT ON payments.v_compensation_source,payments.v_compensation_obligation_origin TO %I',target);
 EXECUTE format('GRANT SELECT(obligation_id,source_id) ON payments.compensation_binary_allocation TO %I',target);
 EXECUTE format('GRANT SELECT(id,source_kind,nowpayments_attempt_id,manual_order_id) ON payments.compensation_source TO %I',target);
 EXECUTE format('GRANT SELECT(id,source_kind,person_id,affiliate_id,package_id,affiliate_package_id,investment_cd_id,
  plan_snapshot,roi_base_annual_rate,roi_qualified_annual_rate,gross_usd,fee_rate,fee_usd,net_usd,pv,effective_at,
  approved_at,roi_tier_id,state,cd_lock_days,lifetime_cap_factor) ON payments.manual_membership_order TO %I',target);
 EXECUTE format('GRANT SELECT(attempt_id,affiliate_id,affiliate_package_id,investment_cd_id,pv_source_id,inflow_id,
  roi_base_annual_rate,roi_qualified_annual_rate,activated_at,plan_snapshot,roi_tier_id,state)
  ON payments.nowpayments_operational_order TO %I',target);
 EXECUTE format('GRANT SELECT(id,auth_subject,person_id,environment,amount_usd,pricing_policy,invoice_id,payment_id,commission_base_usd,pv)
  ON payments.nowpayments_membership_attempt TO %I',target);
 EXECUTE format('GRANT SELECT(id,pv,attempt_id,affiliate_id) ON payments.nowpayments_operational_pv_source TO %I',target);
 EXECUTE format('GRANT SELECT(id,net_usd,gross_usd,attempt_id,payment_ref) ON payments.nowpayments_operational_inflow TO %I',target);
 EXECUTE format('GRANT SELECT(id,affiliate_id,package_id,payment_method,transaction_hash,status,activated_at,expired_at)
  ON mlm.affiliate_package TO %I',target);
 EXECUTE format('GRANT SELECT(affiliate_package_id,closed_at,cap_total) ON mlm.package_cap_state TO %I',target);
 EXECUTE format('GRANT SELECT(id,affiliate_id,affiliate_package_id,principal_usd,roi_tier_id,start_at,matures_at,status,closed_at)
  ON mlm.investment_cd TO %I',target);
 EXECUTE format('GRANT SELECT(attempt_id,payment_id,finished_verified,multiple_payments,api_evidence)
  ON payments.nowpayments_membership_receipt TO %I',target);
 EXECUTE format('GRANT SELECT(matched_attempt_id,payment_id,environment,finished_verified,risk_detected,disposition)
  ON payments.nowpayments_webhook_capture TO %I',target);
 EXECUTE format('GRANT SELECT(id,source_attempt_id,earning_source_id,affiliate_id,affiliate_package_id,kind,entitlement_usd,
  paid_usd,cap_excluded_usd,created_at,available_at) ON payments.nowpayments_engine_obligation TO %I',target);
 EXECUTE format('GRANT SELECT(obligation_id,transaction_ref,amount_usd) ON payments.nowpayments_engine_payment TO %I',target);
 EXECUTE format('GRANT SELECT(id,external_ref) ON mlm.transaction TO %I',target);
 EXECUTE format('GRANT SELECT(wallet_id,transaction_id,affiliate_id,amount,is_frozen) ON mlm.wallet_movement TO %I',target);
 EXECUTE format('GRANT SELECT(id,affiliate_id,asset_id) ON mlm.wallet TO %I',target);
 EXECUTE format('GRANT SELECT(id,symbol) ON mlm.asset TO %I',target);
 EXECUTE format('GRANT SELECT(affiliate_id,status) ON mlm.withdrawal_request TO %I',target);
END
$manual_reader_acl$;
