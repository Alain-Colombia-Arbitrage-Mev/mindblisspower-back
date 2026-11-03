-- Capture-only NOWPayments evidence. No activation, wallet, PV, ROI or commissions.
-- Does not depend on membership orders existing; unmatched events stay quarantined.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE payments.nowpayments_webhook_capture (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  environment text NOT NULL CHECK (environment IN ('production','sandbox')),
  payment_id text NOT NULL CHECK (payment_id ~ '^[1-9][0-9]{0,63}$'),
  invoice_id text CHECK (invoice_id IS NULL OR invoice_id ~ '^[1-9][0-9]{0,63}$'),
  order_id text NOT NULL CHECK (length(order_id) <= 128),
  matched_attempt_id uuid,
  payment_status text NOT NULL CHECK (length(payment_status) BETWEEN 1 AND 64),
  finished_verified boolean NOT NULL,
  risk_detected boolean NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('quarantined','matched')),
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  api_sha256 text NOT NULL CHECK (api_sha256 ~ '^[0-9a-f]{64}$'),
  signed_evidence jsonb NOT NULL CHECK (jsonb_typeof(signed_evidence) = 'object'),
  api_evidence jsonb NOT NULL CHECK (jsonb_typeof(api_evidence) = 'object'),
  received_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((disposition='matched' AND matched_attempt_id IS NOT NULL) OR
         (disposition='quarantined' AND matched_attempt_id IS NULL)),
  CHECK (NOT finished_verified OR (disposition='matched' AND payment_status='finished')),
  UNIQUE (environment,payment_id,body_sha256,api_sha256)
);
CREATE INDEX nowpayments_webhook_capture_attempt_idx
  ON payments.nowpayments_webhook_capture(environment,matched_attempt_id,id DESC)
  WHERE matched_attempt_id IS NOT NULL;
CREATE FUNCTION payments.reject_nowpayments_capture_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'nowpayments_capture_is_append_only' USING ERRCODE='23514';
END $$;
CREATE TRIGGER nowpayments_webhook_capture_append_only BEFORE UPDATE OR DELETE
  ON payments.nowpayments_webhook_capture FOR EACH ROW
  EXECUTE FUNCTION payments.reject_nowpayments_capture_mutation();
REVOKE ALL ON payments.nowpayments_webhook_capture FROM PUBLIC;
REVOKE ALL ON SEQUENCE payments.nowpayments_webhook_capture_id_seq FROM PUBLIC;
-- No login or grants. A separate reviewed role receives INSERT/SELECT here,
-- USAGE on this identity sequence and only SELECT on ownership dependencies.
-- Never grant it UPDATE/DELETE, writes on orders/MLM, or financial functions.
COMMIT;
