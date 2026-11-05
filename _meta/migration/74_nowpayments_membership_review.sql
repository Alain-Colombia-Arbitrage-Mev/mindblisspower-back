-- PREPARED ONLY. Never applied by application startup and never grants a role.
-- NOWPayments membership evidence is NOT a Stripe sale, affiliate balance,
-- commission, tree event or membership activation. A separate reviewed workflow
-- must decide fulfillment; no such mutation is authorized by this migration.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SELECT pg_advisory_xact_lock(hashtextextended('nowpayments-membership-review-v1', 0));

CREATE TABLE payments.nowpayments_membership_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'nowpayments' CHECK (provider = 'nowpayments'),
  purpose text NOT NULL DEFAULT 'membership' CHECK (purpose = 'membership'),
  environment text NOT NULL CHECK (environment IN ('production','sandbox')),
  auth_subject text NOT NULL REFERENCES auth.user(id) ON DELETE RESTRICT,
  person_id bigint NOT NULL REFERENCES mlm.person(id) ON DELETE RESTRICT,
  person_public_id uuid NOT NULL REFERENCES mlm.person(public_id) ON DELETE RESTRICT,
  affiliate_id bigint REFERENCES mlm.affiliate(id) ON DELETE RESTRICT,
  sponsor_affiliate_id bigint REFERENCES mlm.affiliate(id) ON DELETE RESTRICT,
  preferred_side text CHECK (preferred_side IS NULL OR preferred_side IN ('L','R')),
  package_id integer NOT NULL REFERENCES mlm.package(id) ON DELETE RESTRICT,
  package_name text NOT NULL CHECK (length(package_name) BETWEEN 1 AND 256),
  pv integer NOT NULL CHECK (pv >= 0),
  amount_usd numeric(14,2) NOT NULL CHECK (amount_usd > 0),
  fee_usd numeric(14,2) NOT NULL CHECK (fee_usd >= 0),
  total_cents bigint NOT NULL CHECK (total_cents > 0),
  currency text NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  state text NOT NULL DEFAULT 'creating_invoice'
    CHECK (state IN ('creating_invoice','invoice_created','invoice_unknown','pending_review','closed_reviewed')),
  fulfillment_status text NOT NULL DEFAULT 'review_required' CHECK (fulfillment_status = 'review_required'),
  review_reason text CHECK (review_reason IN ('create_unconfirmed','provider_nonfinal','provider_risk','finished_membership_review','multiple_payments')),
  invoice_id text CHECK (invoice_id ~ '^[1-9][0-9]{0,63}$'),
  payment_id text CHECK (payment_id ~ '^[1-9][0-9]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (total_cents = (amount_usd + fee_usd) * 100),
  CHECK (state <> 'invoice_created' OR invoice_id IS NOT NULL),
  UNIQUE (environment, invoice_id),
  UNIQUE (environment, payment_id)
);
-- Keep even timed-out/unknown invoices outstanding: automatically retrying the
-- provider could create a second payable invoice and double-charge the buyer.
CREATE UNIQUE INDEX nowpayments_membership_outstanding_unique
  ON payments.nowpayments_membership_attempt(person_id,package_id,environment)
  WHERE state <> 'closed_reviewed';
CREATE INDEX nowpayments_membership_subject_idx ON payments.nowpayments_membership_attempt(auth_subject);
CREATE INDEX nowpayments_membership_public_id_idx ON payments.nowpayments_membership_attempt(person_public_id);
CREATE INDEX nowpayments_membership_package_idx ON payments.nowpayments_membership_attempt(package_id);
CREATE INDEX nowpayments_membership_affiliate_idx ON payments.nowpayments_membership_attempt(affiliate_id) WHERE affiliate_id IS NOT NULL;
CREATE INDEX nowpayments_membership_sponsor_idx ON payments.nowpayments_membership_attempt(sponsor_affiliate_id) WHERE sponsor_affiliate_id IS NOT NULL;

-- A hosted invoice does not supply its eventual payment ID. The first verified
-- API/IPN pair binds it atomically. Extra payments on an invoice remain separate
-- evidence requiring review; they never replace the first bound payment.
CREATE TABLE payments.nowpayments_payment_binding (
  environment text NOT NULL CHECK (environment IN ('production','sandbox')),
  payment_id text NOT NULL CHECK (payment_id ~ '^[1-9][0-9]{0,63}$'),
  attempt_id uuid NOT NULL REFERENCES payments.nowpayments_membership_attempt(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment,payment_id)
);
CREATE INDEX nowpayments_payment_binding_attempt_idx ON payments.nowpayments_payment_binding(attempt_id);

CREATE TABLE payments.nowpayments_membership_receipt (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES payments.nowpayments_membership_attempt(id) ON DELETE RESTRICT,
  environment text NOT NULL,
  payment_id text NOT NULL,
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  api_sha256 text NOT NULL CHECK (api_sha256 ~ '^[0-9a-f]{64}$'),
  signed_evidence jsonb NOT NULL CHECK (jsonb_typeof(signed_evidence) = 'object'),
  api_evidence jsonb NOT NULL CHECK (jsonb_typeof(api_evidence) = 'object'),
  finished_verified boolean NOT NULL,
  multiple_payments boolean NOT NULL,
  fulfillment_status text NOT NULL DEFAULT 'review_required' CHECK (fulfillment_status = 'review_required'),
  received_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (environment,payment_id) REFERENCES payments.nowpayments_payment_binding(environment,payment_id) ON DELETE RESTRICT,
  UNIQUE (environment,payment_id,body_sha256,api_sha256)
);
CREATE INDEX nowpayments_membership_receipt_attempt_idx ON payments.nowpayments_membership_receipt(attempt_id,received_at);

CREATE FUNCTION payments.protect_nowpayments_membership_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF ROW(OLD.id,OLD.provider,OLD.purpose,OLD.environment,OLD.auth_subject,OLD.person_id,OLD.person_public_id,
         OLD.affiliate_id,OLD.sponsor_affiliate_id,OLD.preferred_side,OLD.package_id,OLD.package_name,
         OLD.pv,OLD.amount_usd,OLD.fee_usd,OLD.total_cents,OLD.currency,OLD.fulfillment_status,OLD.created_at)
     IS DISTINCT FROM
     ROW(NEW.id,NEW.provider,NEW.purpose,NEW.environment,NEW.auth_subject,NEW.person_id,NEW.person_public_id,
         NEW.affiliate_id,NEW.sponsor_affiliate_id,NEW.preferred_side,NEW.package_id,NEW.package_name,
         NEW.pv,NEW.amount_usd,NEW.fee_usd,NEW.total_cents,NEW.currency,NEW.fulfillment_status,NEW.created_at)
     OR (OLD.invoice_id IS NOT NULL AND OLD.invoice_id IS DISTINCT FROM NEW.invoice_id)
     OR (OLD.payment_id IS NOT NULL AND OLD.payment_id IS DISTINCT FROM NEW.payment_id)
     OR (OLD.state='pending_review' AND NEW.state NOT IN ('pending_review','closed_reviewed'))
     OR (OLD.state='closed_reviewed' AND NEW.state <> 'closed_reviewed') THEN
    RAISE EXCEPTION 'nowpayments_membership_snapshot_is_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER nowpayments_membership_snapshot_immutable BEFORE UPDATE ON payments.nowpayments_membership_attempt
  FOR EACH ROW EXECUTE FUNCTION payments.protect_nowpayments_membership_snapshot();

CREATE FUNCTION payments.reject_nowpayments_evidence_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'nowpayments_evidence_is_append_only' USING ERRCODE='23514';
END $$;
CREATE TRIGGER nowpayments_membership_receipt_append_only BEFORE UPDATE OR DELETE ON payments.nowpayments_membership_receipt
  FOR EACH ROW EXECUTE FUNCTION payments.reject_nowpayments_evidence_mutation();
CREATE TRIGGER nowpayments_payment_binding_immutable BEFORE UPDATE OR DELETE ON payments.nowpayments_payment_binding
  FOR EACH ROW EXECUTE FUNCTION payments.reject_nowpayments_evidence_mutation();

REVOKE ALL ON payments.nowpayments_membership_attempt, payments.nowpayments_payment_binding, payments.nowpayments_membership_receipt FROM PUBLIC;
-- No GRANT: production currently uses explicit read-only roles. Operators must
-- separately review a narrow writer role and financial readiness before use.
COMMIT;
