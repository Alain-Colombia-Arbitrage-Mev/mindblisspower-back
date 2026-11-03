-- Operator-reviewed read-model ACL only. The existing verified Payments report
-- login retains its current identity/MLM reads, without a new credential or DML.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('nowpayments-member-reader-v1',0));

GRANT SELECT(id,auth_subject,person_id,environment)
 ON payments.nowpayments_membership_attempt TO mindbliss_payments_20261025;
GRANT SELECT(attempt_id,state,activated_at,affiliate_id,affiliate_package_id,investment_cd_id)
 ON payments.nowpayments_operational_order TO mindbliss_payments_20261025;
GRANT SELECT(id,source_attempt_id,affiliate_id,affiliate_package_id,kind,entitlement_usd,
 paid_usd,cap_excluded_usd,created_at,available_at)
 ON payments.nowpayments_engine_obligation TO mindbliss_payments_20261025;
GRANT SELECT(obligation_id,transaction_ref,amount_usd)
 ON payments.nowpayments_engine_payment TO mindbliss_payments_20261025;
GRANT SELECT(matched_attempt_id,risk_detected,disposition)
 ON payments.nowpayments_webhook_capture TO mindbliss_payments_20261025;
GRANT SELECT(attempt_id,multiple_payments,api_evidence)
 ON payments.nowpayments_membership_receipt TO mindbliss_payments_20261025;
COMMIT;
