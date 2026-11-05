-- Reviewed operator migration only. No startup DDL, credentials or automatic grants.
-- CSV reporting supersedes visible Stripe sales, never canonical provider evidence,
-- membership activation, tree/PV, principal, ROI, commissions or ledger history.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_advisory_xact_lock(hashtextextended('admin-sales-reporting-v1',0));

CREATE TABLE payments.sales_import_batch (
 id uuid PRIMARY KEY,
 file_sha256 text NOT NULL UNIQUE CHECK(file_sha256 ~ '^[0-9a-f]{64}$'),
 source_name text NOT NULL CHECK(length(source_name) BETWEEN 1 AND 200),
 source_extracted_at timestamptz,
 imported_at timestamptz NOT NULL DEFAULT now(),
 row_count bigint NOT NULL CHECK(row_count>0),
 gross_minor bigint NOT NULL CHECK(gross_minor>0),
 refunded_minor bigint NOT NULL CHECK(refunded_minor BETWEEN 0 AND gross_minor),
 fee_minor bigint NOT NULL CHECK(fee_minor BETWEEN 0 AND gross_minor-refunded_minor),
 statement jsonb NOT NULL CHECK(jsonb_typeof(statement)='object'),
 controls jsonb NOT NULL CHECK(jsonb_typeof(controls)='object'),
 status text NOT NULL CHECK(status IN('reviewed','rejected'))
);
CREATE TABLE payments.sales_import_row (
 batch_id uuid NOT NULL REFERENCES payments.sales_import_batch(id) ON DELETE RESTRICT,
 source_row integer NOT NULL CHECK(source_row>0),
 external_id text NOT NULL CHECK(external_id ~ '^pi_[A-Za-z0-9]{8,128}$'),
 provider_reference text NOT NULL CHECK(provider_reference ~ '^(ch|py)_[A-Za-z0-9]{8,128}$'),
 created_at timestamptz NOT NULL,
 paid_at timestamptz,
 currency text NOT NULL CHECK(currency='usd'),
 person_id bigint REFERENCES mlm.person(id) ON DELETE RESTRICT,
 affiliate_id bigint REFERENCES mlm.affiliate(id) ON DELETE RESTRICT,
 buyer_email text NOT NULL DEFAULT '',
 buyer_name text NOT NULL DEFAULT '',
 package_id bigint,
 package_name text NOT NULL,
 base_minor bigint CHECK(base_minor>=0),
 gross_minor bigint NOT NULL CHECK(gross_minor>0),
 refunded_minor bigint NOT NULL CHECK(refunded_minor BETWEEN 0 AND gross_minor),
 fee_minor bigint NOT NULL CHECK(fee_minor BETWEEN 0 AND gross_minor-refunded_minor),
 net_minor bigint NOT NULL CHECK(net_minor=gross_minor-refunded_minor-fee_minor),
 verified_fee_minor bigint CHECK(verified_fee_minor>=0),
 display_status text NOT NULL CHECK(display_status IN('paid','under_review')),
 source_status text NOT NULL CHECK(source_status IN('Paid','En Revisión')),
 activation_status text NOT NULL CHECK(activation_status='not_inferred_from_import'),
 risk_status text NOT NULL CHECK(risk_status IN('none','disputed','refunded','source_review')),
 product_scope text NOT NULL CHECK(product_scope IN('mindbliss_membership','unattributed')),
 provider_verified boolean NOT NULL CHECK(NOT provider_verified),
 commission_eligible boolean NOT NULL CHECK(NOT commission_eligible),
 fee_reconciliation_status text NOT NULL CHECK(fee_reconciliation_status IN('matched','discrepancy','unavailable')),
 canonical_payment_intent_id text REFERENCES payments.stripe_sale(payment_intent_id) ON DELETE RESTRICT,
 canonical_refunded_minor bigint CHECK(canonical_refunded_minor>=0),
 canonical_dispute_count integer CHECK(canonical_dispute_count>=0),
 canonical_source_eligible boolean,
 record_sha256 text NOT NULL CHECK(record_sha256 ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(batch_id,external_id), UNIQUE(batch_id,provider_reference), UNIQUE(batch_id,source_row),
 CHECK((product_scope='mindbliss_membership')=(canonical_payment_intent_id IS NOT NULL)),
 CHECK(canonical_payment_intent_id IS NULL OR canonical_payment_intent_id=external_id),
 CHECK(product_scope<>'unattributed' OR(person_id IS NULL AND affiliate_id IS NULL AND package_id IS NULL AND base_minor IS NULL AND buyer_email='' AND buyer_name='')),
 CHECK((fee_reconciliation_status='unavailable')=(verified_fee_minor IS NULL)),
 CHECK(fee_reconciliation_status<>'matched' OR fee_minor=verified_fee_minor),
 CHECK(fee_reconciliation_status<>'discrepancy' OR fee_minor<>verified_fee_minor),
 CHECK((display_status='paid')=(source_status='Paid'))
);
CREATE INDEX sales_import_row_created_idx ON payments.sales_import_row(batch_id,created_at DESC,external_id);
CREATE INDEX sales_import_row_person_idx ON payments.sales_import_row(person_id) WHERE person_id IS NOT NULL;
CREATE TABLE payments.admin_sales_source (
 provider text PRIMARY KEY CHECK(provider='stripe'),
 active_batch_id uuid NOT NULL REFERENCES payments.sales_import_batch(id) ON DELETE RESTRICT,
 activated_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION payments.reject_sales_import_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'sales_import_evidence_is_append_only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER sales_import_batch_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON payments.sales_import_batch
 FOR EACH STATEMENT EXECUTE FUNCTION payments.reject_sales_import_mutation();
CREATE TRIGGER sales_import_row_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON payments.sales_import_row
 FOR EACH STATEMENT EXECUTE FUNCTION payments.reject_sales_import_mutation();

-- The view owner must be a reviewed, non-login reporting owner. Runtime readers
-- receive SELECT on these three narrow views only, NOT underlying NOW evidence
-- JSON, auth identity, write permissions or a general SECURITY DEFINER function.
CREATE VIEW payments.v_admin_sales WITH(security_barrier=true) AS
 SELECT 'stripe'::text AS provider,r.external_id,r.provider_reference,r.created_at,r.paid_at,r.currency,
  r.person_id,r.affiliate_id,r.buyer_email,r.buyer_name,r.package_id,r.package_name,r.base_minor,
  r.gross_minor,r.refunded_minor,r.fee_minor,r.net_minor,r.display_status,r.source_status,
  r.activation_status,r.risk_status,r.batch_id::text AS source_batch_id,r.product_scope,
  r.provider_verified,r.commission_eligible,r.verified_fee_minor,r.fee_reconciliation_status
 FROM payments.sales_import_row r JOIN payments.admin_sales_source a ON a.provider='stripe' AND a.active_batch_id=r.batch_id
 JOIN payments.sales_import_batch b ON b.id=r.batch_id AND b.status='reviewed'
 WHERE r.product_scope='mindbliss_membership'
 UNION ALL
 SELECT 'nowpayments'::text,a.id::text,coalesce(a.payment_id,a.invoice_id,''),a.created_at,
  proof.received_at,a.currency,a.person_id,coalesce(o.affiliate_id,a.affiliate_id),
  p.email::text,trim(p.first_name||' '||p.last_name),a.package_id::bigint,a.package_name,(a.amount_usd*100)::bigint,
  (f.gross_usd*100)::bigint,0::bigint,(f.provider_cost_usd*100)::bigint,(f.net_usd*100)::bigint,
  CASE WHEN o.state='risk_review' OR proof.multiple_payments OR capture_risk.held THEN 'under_review' ELSE 'activated' END,
  'finished'::text,o.state,CASE WHEN o.state='risk_review' OR proof.multiple_payments OR capture_risk.held THEN 'source_review' ELSE 'none' END,
  NULL::text,'mindbliss_membership'::text,true,o.state='activated' AND NOT proof.multiple_payments AND NOT capture_risk.held,
  -- NOW inflow cost is the approved 1% business policy, not an independently
  -- returned processor settlement fee. Keep that evidence unknown here.
  NULL::bigint,'unavailable'::text
 FROM payments.nowpayments_membership_attempt a JOIN payments.nowpayments_operational_order o ON o.attempt_id=a.id
 JOIN mlm.person p ON p.id=a.person_id
 JOIN payments.nowpayments_operational_inflow f ON f.id=o.inflow_id AND f.attempt_id=a.id
 CROSS JOIN LATERAL(SELECT min(r.received_at) FILTER(WHERE r.payment_id=a.payment_id AND r.finished_verified AND NOT r.multiple_payments) AS received_at,
   coalesce(bool_or(r.multiple_payments),false) AS multiple_payments
   FROM payments.nowpayments_membership_receipt r WHERE r.attempt_id=a.id AND r.environment=a.environment) proof
 -- Captures exist only after authenticated IPN + fixed-provider verification.
 -- Quarantine has matched_attempt_id=NULL by schema, so it needs the exact
 -- order/payment/invoice/environment tuple instead of an email/price guess.
 CROSS JOIN LATERAL(SELECT EXISTS(SELECT 1 FROM payments.nowpayments_webhook_capture cap
   WHERE cap.environment=a.environment AND cap.payment_id=a.payment_id
    AND((cap.disposition='matched' AND cap.matched_attempt_id=a.id)
     OR(cap.disposition='quarantined' AND cap.order_id=a.id::text AND cap.invoice_id=a.invoice_id))
    AND(cap.risk_detected OR cap.disposition='quarantined')) AS held) capture_risk
 WHERE a.provider='nowpayments' AND a.purpose='membership' AND a.environment='production' AND a.currency='usd'
  AND o.state IN('activated','risk_review') AND o.activated_at IS NOT NULL AND proof.received_at IS NOT NULL
  AND f.payment_ref='nowpayments:'||a.environment||':'||a.payment_id
  AND (f.gross_usd*100)::bigint=a.total_cents AND f.provider_cost_usd=f.gross_usd*.01 AND f.net_usd=f.gross_usd*.99;

CREATE VIEW payments.v_admin_sales_import_batch WITH(security_barrier=true) AS
 SELECT id,file_sha256,source_name,source_extracted_at,imported_at,row_count,gross_minor,refunded_minor,fee_minor,statement,controls,status
 FROM payments.sales_import_batch;
CREATE VIEW payments.v_admin_sales_source WITH(security_barrier=true) AS
 SELECT provider,active_batch_id,activated_at FROM payments.admin_sales_source;

REVOKE ALL ON payments.sales_import_batch,payments.sales_import_row,payments.admin_sales_source,
 payments.v_admin_sales,payments.v_admin_sales_import_batch,payments.v_admin_sales_source FROM PUBLIC;
REVOKE ALL ON FUNCTION payments.reject_sales_import_mutation() FROM PUBLIC;
COMMIT;
