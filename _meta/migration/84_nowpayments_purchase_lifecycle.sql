-- Reviewed NOW-only purchase lifecycle. Never run automatically on startup.
-- Financial snapshots, payment evidence and activated memberships are retained.
-- A local cancellation DOES NOT revoke a NOWPayments invoice or refund money.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_advisory_xact_lock(hashtextextended('nowpayments-purchase-lifecycle-v1',0));

ALTER TABLE payments.nowpayments_membership_attempt
 ADD COLUMN checkout_open boolean NOT NULL DEFAULT true;
CREATE TABLE payments.nowpayments_purchase_request (
 auth_subject text NOT NULL REFERENCES auth.user(id) ON DELETE RESTRICT,
 environment text NOT NULL CHECK(environment IN('production','sandbox')),
 purchase_request_id uuid NOT NULL CHECK(purchase_request_id<>'00000000-0000-0000-0000-000000000000'::uuid),
 attempt_id uuid NOT NULL REFERENCES payments.nowpayments_membership_attempt(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(auth_subject,environment,purchase_request_id)
);
CREATE INDEX nowpayments_purchase_request_attempt_idx ON payments.nowpayments_purchase_request(attempt_id);
CREATE TABLE payments.nowpayments_purchase_cancellation (
 attempt_id uuid PRIMARY KEY REFERENCES payments.nowpayments_membership_attempt(id) ON DELETE RESTRICT,
 auth_subject text NOT NULL REFERENCES auth.user(id) ON DELETE RESTRICT,
 environment text NOT NULL CHECK(environment IN('production','sandbox')),
 cancelled_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION payments.check_nowpayments_purchase_request() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM payments.nowpayments_membership_attempt a
   WHERE a.id=NEW.attempt_id AND a.auth_subject=NEW.auth_subject AND a.environment=NEW.environment) THEN
  RAISE EXCEPTION 'nowpayments_purchase_request_owner_mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER nowpayments_purchase_request_owner BEFORE INSERT ON payments.nowpayments_purchase_request
 FOR EACH ROW EXECUTE FUNCTION payments.check_nowpayments_purchase_request();
CREATE TRIGGER nowpayments_purchase_request_append_only BEFORE UPDATE OR DELETE ON payments.nowpayments_purchase_request
 FOR EACH ROW EXECUTE FUNCTION payments.reject_nowpayments_evidence_mutation();
CREATE TRIGGER nowpayments_purchase_cancellation_append_only BEFORE UPDATE OR DELETE ON payments.nowpayments_purchase_cancellation
 FOR EACH ROW EXECUTE FUNCTION payments.reject_nowpayments_evidence_mutation();

-- Application takes the same attempt -> operational order lock order. A capture
-- may arrive concurrently without that lock; the sticky blocked order below
-- still prevents any later receipt/job from activating an abandoned invoice.
CREATE FUNCTION payments.check_nowpayments_purchase_cancellation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE a payments.nowpayments_membership_attempt%ROWTYPE; order_state text;
BEGIN
 SELECT * INTO a FROM payments.nowpayments_membership_attempt WHERE id=NEW.attempt_id FOR UPDATE;
 SELECT state INTO order_state FROM payments.nowpayments_operational_order WHERE attempt_id=NEW.attempt_id FOR UPDATE;
 IF a.id IS NULL OR a.auth_subject<>NEW.auth_subject OR a.environment<>NEW.environment
  OR NOT a.checkout_open OR a.state<>'invoice_created' OR a.invoice_id IS NULL OR a.payment_id IS NOT NULL
  OR order_state IS DISTINCT FROM 'awaiting_payment'
  OR EXISTS(SELECT 1 FROM payments.nowpayments_membership_receipt r WHERE r.attempt_id=a.id)
  OR EXISTS(SELECT 1 FROM payments.nowpayments_payment_binding b WHERE b.attempt_id=a.id)
  OR EXISTS(SELECT 1 FROM payments.nowpayments_webhook_capture c WHERE c.environment=a.environment
      AND (c.matched_attempt_id=a.id OR c.order_id=a.id::text)) THEN
  RAISE EXCEPTION 'nowpayments_purchase_not_cancellable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER nowpayments_purchase_cancellation_safe BEFORE INSERT ON payments.nowpayments_purchase_cancellation
 FOR EACH ROW EXECUTE FUNCTION payments.check_nowpayments_purchase_cancellation();
-- Audit insertion and terminal blocking must commit together, even for a caller
-- using the restricted runtime SQL role outside the HTTP handler.
CREATE FUNCTION payments.require_nowpayments_cancelled_order() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM payments.nowpayments_membership_attempt a
   JOIN payments.nowpayments_operational_order o ON o.attempt_id=a.id
   WHERE a.id=NEW.attempt_id AND NOT a.checkout_open AND o.state='security_blocked') THEN
  RAISE EXCEPTION 'nowpayments_cancellation_requires_blocked_order' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER nowpayments_purchase_cancellation_atomic AFTER INSERT ON payments.nowpayments_purchase_cancellation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payments.require_nowpayments_cancelled_order();
CREATE FUNCTION payments.protect_nowpayments_checkout_open() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  IF NOT NEW.checkout_open THEN RAISE EXCEPTION 'nowpayments_checkout_must_start_open' USING ERRCODE='23514'; END IF;
 ELSIF OLD.checkout_open IS DISTINCT FROM NEW.checkout_open THEN
  IF NEW.checkout_open OR NOT (
    EXISTS(SELECT 1 FROM payments.nowpayments_purchase_cancellation c WHERE c.attempt_id=NEW.id)
    OR EXISTS(SELECT 1 FROM payments.nowpayments_operational_order o WHERE o.attempt_id=NEW.id AND o.state='activated')) THEN
   RAISE EXCEPTION 'nowpayments_checkout_close_requires_terminal_proof' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER nowpayments_checkout_open_protected BEFORE INSERT OR UPDATE OF checkout_open
 ON payments.nowpayments_membership_attempt FOR EACH ROW EXECUTE FUNCTION payments.protect_nowpayments_checkout_open();
CREATE FUNCTION payments.close_nowpayments_activated_checkout() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.state='activated' THEN
  UPDATE payments.nowpayments_membership_attempt SET checkout_open=false
   WHERE id=NEW.attempt_id AND checkout_open;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER nowpayments_activated_checkout_closed AFTER UPDATE OF state ON payments.nowpayments_operational_order
 FOR EACH ROW WHEN(NEW.state='activated') EXECUTE FUNCTION payments.close_nowpayments_activated_checkout();
-- Existing fulfilled orders release only the checkout slot; no principal, CD,
-- payment evidence, PV or obligations are changed. Existing unpaid rows stay open.
UPDATE payments.nowpayments_membership_attempt a SET checkout_open=false
 FROM payments.nowpayments_operational_order o WHERE o.attempt_id=a.id AND o.state='activated' AND a.checkout_open;
DROP INDEX payments.nowpayments_membership_outstanding_unique;
CREATE UNIQUE INDEX nowpayments_membership_outstanding_unique
 ON payments.nowpayments_membership_attempt(person_id,package_id,environment)
 WHERE state<>'closed_reviewed' AND checkout_open;
CREATE INDEX nowpayments_purchase_history_idx ON payments.nowpayments_membership_attempt(auth_subject,environment,created_at DESC,id DESC);
-- History also checks quarantined evidence by the merchant order reference.
-- Avoid an unindexed capture scan for every displayed purchase.
CREATE INDEX nowpayments_capture_order_reference_idx ON payments.nowpayments_webhook_capture(environment,order_id);
REVOKE ALL ON payments.nowpayments_purchase_request,payments.nowpayments_purchase_cancellation FROM PUBLIC;

-- Extend the existing dedicated writer, not the auth/global application login.
GRANT SELECT,INSERT ON payments.nowpayments_purchase_request,payments.nowpayments_purchase_cancellation
 TO mindbliss_now_ops_20261031;
GRANT UPDATE(checkout_open) ON payments.nowpayments_membership_attempt TO mindbliss_now_ops_20261031;
-- Exact read-model additions; no table-level auth/identity grants or new DML.
GRANT SELECT(person_public_id,package_id,package_name,total_cents,fee_usd,created_at,updated_at,state,invoice_id,payment_id,checkout_open)
 ON payments.nowpayments_membership_attempt TO mindbliss_payments_20261025;
GRANT SELECT(attempt_id,cancelled_at) ON payments.nowpayments_purchase_cancellation TO mindbliss_payments_20261025;
GRANT SELECT(attempt_id) ON payments.nowpayments_payment_binding TO mindbliss_payments_20261025;
GRANT SELECT(id,environment,matched_attempt_id,order_id,risk_detected,disposition,finished_verified,api_evidence)
 ON payments.nowpayments_webhook_capture TO mindbliss_payments_20261025;
COMMIT;
