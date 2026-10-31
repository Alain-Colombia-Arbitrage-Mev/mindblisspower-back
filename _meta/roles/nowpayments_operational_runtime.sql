-- Explicit, additive runtime ACL manifest for reviewed migrations 79 + 80.
-- Operator ONLY: create a fresh LOGIN NOINHERIT NOSUPERUSER NOCREATEDB
-- NOCREATEROLE NOREPLICATION NOBYPASSRLS role separately. In the SAME transaction
-- set_config('mindbliss.nowpayments_operations_role','reviewed-role-name',true),
-- then execute this file. Missing GUC/schema or unsafe role aborts atomically.
-- No credentials, roles, existing ACL revocations, RLS or financial flags here.
DO $now_acl$
DECLARE target name:=current_setting('mindbliss.nowpayments_operations_role',true)::name;
 r record; relation text;
BEGIN
 IF target IS NULL OR target::text='' THEN RAISE EXCEPTION 'explicit NOW runtime role is required'; END IF;
 SELECT * INTO r FROM pg_roles WHERE rolname=target;
 IF NOT FOUND OR NOT r.rolcanlogin OR r.rolinherit OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
 OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) THEN
  RAISE EXCEPTION 'NOW runtime role must be a fresh, nonprivileged NOINHERIT login without memberships';
 END IF;
 FOREACH relation IN ARRAY ARRAY['auth.user','identity.auth_binding','payments.stripe_sale','payments.purchase_intent','mlm.binary_period','mlm.rank','mlm.withdrawal_request','mlm.plan_config','mlm.cd_roi_tier','mlm.tree_event'] LOOP
  IF to_regclass(relation) IS NOT NULL AND has_table_privilege(target,relation,'INSERT,UPDATE,DELETE,TRUNCATE') THEN
   RAISE EXCEPTION 'NOW runtime role has unrelated or inherited/PUBLIC financial/identity writes';
  END IF;
 END LOOP;
 IF has_column_privilege(target,'mlm.affiliate','left_pv_lifetime','UPDATE') OR has_column_privilege(target,'mlm.affiliate','right_pv_lifetime','UPDATE')
 OR has_column_privilege(target,'mlm.affiliate','left_pv_current','UPDATE') OR has_column_privilege(target,'mlm.affiliate','right_pv_current','UPDATE') THEN
  RAISE EXCEPTION 'NOW runtime role has unrelated global PV writes';
 END IF;
 EXECUTE format('GRANT USAGE ON SCHEMA auth,identity,mlm,payments TO %I',target);
 EXECUTE format('GRANT SELECT ON auth.user,identity.auth_binding,mlm.person,mlm.affiliate,mlm.affiliate_closure,mlm.package,mlm.plan_config,
  mlm.cd_roi_tier,mlm.asset,mlm.concept,mlm.package_cap_state,mlm.blacklist,mlm.wallet,mlm.affiliate_package,mlm.investment_cd,
  mlm.tree_event,mlm.rank,mlm.retirement_plan,mlm.retirement_mode_routing,payments.purchase_intent,
  payments.nowpayments_membership_attempt,payments.nowpayments_membership_receipt,payments.nowpayments_payment_binding,
  payments.nowpayments_operational_order,payments.nowpayments_operational_pv_source,payments.nowpayments_operational_inflow,
  payments.nowpayments_operational_job,payments.nowpayments_webhook_capture,payments.nowpayments_engine_control,
  payments.nowpayments_engine_period,payments.nowpayments_engine_binary_state,payments.nowpayments_engine_roi_state,
  payments.nowpayments_engine_roi_rate_day,payments.nowpayments_engine_obligation,payments.nowpayments_engine_payment TO %I',target);
 EXECUTE format('GRANT SELECT(id,external_ref) ON mlm.transaction TO %I',target);
 EXECUTE format('GRANT INSERT ON payments.nowpayments_membership_attempt,payments.nowpayments_membership_receipt,
  payments.nowpayments_payment_binding,payments.nowpayments_operational_order,payments.nowpayments_operational_pv_source,
  payments.nowpayments_operational_inflow,payments.nowpayments_operational_job,payments.nowpayments_engine_period,
  payments.nowpayments_engine_binary_state,payments.nowpayments_engine_roi_state,payments.nowpayments_engine_roi_rate_day,
  payments.nowpayments_engine_obligation,payments.nowpayments_engine_payment,mlm.affiliate,mlm.affiliate_closure,
  mlm.affiliate_package,mlm.package_cap_state,mlm.investment_cd,mlm.wallet,mlm.transaction,
  mlm.wallet_movement,mlm.retirement_plan TO %I',target);
 EXECUTE format('GRANT UPDATE(updated_at) ON mlm.person TO %I',target);
 EXECUTE format('GRANT UPDATE(state,invoice_id,payment_id,review_reason,updated_at) ON payments.nowpayments_membership_attempt TO %I',target);
 EXECUTE format('GRANT UPDATE(state,affiliate_id,affiliate_package_id,investment_cd_id,pv_source_id,inflow_id,activated_at,updated_at) ON payments.nowpayments_operational_order TO %I',target);
 EXECUTE format('GRANT UPDATE(capture_id,state,attempts,available_at,lease_token,lease_until,last_error_code,updated_at) ON payments.nowpayments_operational_job TO %I',target);
 EXECUTE format('GRANT UPDATE(left_count,right_count,updated_at) ON mlm.affiliate TO %I',target);
 EXECUTE format('GRANT UPDATE(last_run_at) ON payments.nowpayments_engine_control TO %I',target);
 EXECUTE format('GRANT UPDATE ON payments.nowpayments_engine_period,payments.nowpayments_engine_binary_state,payments.nowpayments_engine_roi_state TO %I',target);
 EXECUTE format('GRANT UPDATE(paid_usd,cap_excluded_usd) ON payments.nowpayments_engine_obligation TO %I',target);
 EXECUTE format('GRANT UPDATE(paid_total) ON mlm.package_cap_state TO %I',target);
 EXECUTE format('GRANT UPDATE(balance) ON mlm.wallet TO %I',target);
 EXECUTE format('GRANT UPDATE(roi_accrued_usd,last_accrual_date,qualified_since,status,closed_at) ON mlm.investment_cd TO %I',target);
 EXECUTE format('GRANT UPDATE(balance_usd,updated_at) ON mlm.retirement_plan TO %I',target);
 EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE mlm.affiliate_id_seq,mlm.affiliate_package_id_seq,mlm.investment_cd_id_seq,
  mlm.wallet_id_seq,mlm.wallet_movement_id_seq,payments.nowpayments_membership_receipt_id_seq,
  payments.nowpayments_operational_pv_source_id_seq,payments.nowpayments_operational_inflow_id_seq,
  payments.nowpayments_engine_period_id_seq,payments.nowpayments_engine_obligation_id_seq,payments.nowpayments_engine_payment_id_seq TO %I',target);
END $now_acl$;
