-- Reviewed operator-only migration. Never run automatically at service startup.
-- An explicit new request may create another pending membership of the same SKU.
-- Exact request-key idempotency, ownership, capture, cancellation and financial
-- guards remain unchanged. No existing order/evidence/financial row is rewritten.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_advisory_xact_lock(hashtextextended('nowpayments-independent-purchase-requests-v1',0));

DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index i
   WHERE i.indexrelid=to_regclass('payments.nowpayments_membership_outstanding_unique')
   AND i.indrelid=to_regclass('payments.nowpayments_membership_attempt') AND i.indisunique AND i.indisvalid AND i.indisready
   AND i.indnkeyatts=3 AND i.indnatts=3 AND i.indexprs IS NULL
   AND pg_get_indexdef(i.indexrelid,1,true)='person_id' AND pg_get_indexdef(i.indexrelid,2,true)='package_id'
   AND pg_get_indexdef(i.indexrelid,3,true)='environment'
   AND pg_get_expr(i.indpred,i.indrelid)='((state <> ''closed_reviewed''::text) AND checkout_open)')
 OR NOT EXISTS(SELECT 1 FROM pg_constraint c
   WHERE c.conrelid=to_regclass('payments.nowpayments_purchase_request') AND c.contype='p'
   AND c.convalidated AND c.conkey=ARRAY[1,2,3]::smallint[]
   AND pg_get_constraintdef(c.oid)='PRIMARY KEY (auth_subject, environment, purchase_request_id)')
 OR to_regclass('payments.nowpayments_membership_open_lookup_idx') IS NOT NULL THEN
  RAISE EXCEPTION 'nowpayments_independent_purchase_schema_requires_review';
 END IF;
END $$;

DROP INDEX payments.nowpayments_membership_outstanding_unique;
CREATE INDEX nowpayments_membership_open_lookup_idx
 ON payments.nowpayments_membership_attempt(person_id,package_id,environment)
 WHERE state<>'closed_reviewed' AND checkout_open;

-- checkout_open remains an immutable lifecycle/safety signal, not a per-SKU
-- exclusivity rule. The request-map PRIMARY KEY remains the duplicate barrier.
-- No grants, authentication changes, row updates or external provider calls.
COMMIT;
