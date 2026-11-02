-- Operator only, same reviewed transaction as migration 87. No credentials.
-- Fixed fresh NOLOGIN view owner receives only columns projected by static views.
-- Existing runtime policy group gets SELECT on three narrow views only.
DO $sales_roles$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mindbliss_sales_report_owner_20261102') THEN
  RAISE EXCEPTION 'sales_report_owner_requires_fresh_review';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mindbliss_go_payments_reader_v1'
  AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls) THEN
  RAISE EXCEPTION 'sales_report_existing_reader_policy_required';
 END IF;
END $sales_roles$;
CREATE ROLE mindbliss_sales_report_owner_20261102 NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA payments,mlm TO mindbliss_sales_report_owner_20261102;
GRANT SELECT ON payments.sales_import_batch,payments.sales_import_row,payments.admin_sales_source TO mindbliss_sales_report_owner_20261102;
GRANT SELECT(id,provider,purpose,environment,person_id,affiliate_id,package_id,package_name,amount_usd,total_cents,currency,state,payment_id,invoice_id,created_at)
 ON payments.nowpayments_membership_attempt TO mindbliss_sales_report_owner_20261102;
GRANT SELECT(attempt_id,affiliate_id,activated_at,state,inflow_id)
 ON payments.nowpayments_operational_order TO mindbliss_sales_report_owner_20261102;
GRANT SELECT(id,attempt_id,gross_usd,provider_cost_usd,net_usd,payment_ref)
 ON payments.nowpayments_operational_inflow TO mindbliss_sales_report_owner_20261102;
GRANT SELECT(attempt_id,environment,payment_id,finished_verified,multiple_payments,received_at)
 ON payments.nowpayments_membership_receipt TO mindbliss_sales_report_owner_20261102;
GRANT SELECT(environment,payment_id,matched_attempt_id,disposition,risk_detected,order_id,invoice_id)
 ON payments.nowpayments_webhook_capture TO mindbliss_sales_report_owner_20261102;
GRANT SELECT(id,email,first_name,last_name) ON mlm.person TO mindbliss_sales_report_owner_20261102;
-- PostgreSQL requires the new owner to hold CREATE while ownership transfers.
-- This capability is removed in this same transaction before commit.
GRANT CREATE ON SCHEMA payments TO mindbliss_sales_report_owner_20261102;
-- A NOSUPERUSER CREATEROLE operator receives ADMIN, but not SET/INHERIT,
-- automatically on a newly created role (createrole_self_grant=''). Ownership
-- transfer requires SET privilege. Permit SET only for this low-privilege owner
-- for the transfer, and restore the original no-SET/no-INHERIT posture below.
GRANT mindbliss_sales_report_owner_20261102 TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
-- Grant as the current view owner before the ownership transfer. This avoids
-- SET ROLE and never grants a runtime role any ownership or base-table access.
GRANT SELECT ON payments.v_admin_sales,payments.v_admin_sales_import_batch,payments.v_admin_sales_source
 TO mindbliss_go_payments_reader_v1;
ALTER VIEW payments.v_admin_sales OWNER TO mindbliss_sales_report_owner_20261102;
ALTER VIEW payments.v_admin_sales_import_batch OWNER TO mindbliss_sales_report_owner_20261102;
ALTER VIEW payments.v_admin_sales_source OWNER TO mindbliss_sales_report_owner_20261102;
-- Ownership transfer replaces the former owner's implicit ACL. Retain only
-- explicit SELECT for the existing maintenance operator so the authorized
-- transaction and later read-only audit can validate the finished report.
-- The DO block is invoker-only, not a callable SECURITY DEFINER function.
DO $sales_operator_read$
DECLARE operator_role name:=current_user;
BEGIN
 EXECUTE 'SET LOCAL ROLE mindbliss_sales_report_owner_20261102';
 EXECUTE format('GRANT SELECT ON payments.v_admin_sales,payments.v_admin_sales_import_batch,payments.v_admin_sales_source TO %I',operator_role);
 EXECUTE format('SET LOCAL ROLE %I',operator_role);
END $sales_operator_read$;
REVOKE CREATE ON SCHEMA payments FROM mindbliss_sales_report_owner_20261102;
GRANT mindbliss_sales_report_owner_20261102 TO CURRENT_USER WITH INHERIT FALSE, SET FALSE;
-- No memberships, login, sequences, DML, function execution, auth, raw IPN/API
-- evidence JSON, base NOW runtime grants or schema-wide/future-default grants
-- are given to runtime. Operator's non-inheritable ADMIN management membership
-- remains without SET permission, as created by PostgreSQL itself.
