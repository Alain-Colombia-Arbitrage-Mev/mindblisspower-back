-- PREPARED ONLY. No production startup migration or automatic role grants.
-- Depends on 74, 77 and the approved existing MLM payout schema/configuration.
-- This sidecar identifies ONLY new NOW operational orders. Nothing in Stripe
-- recovery, legacy NOW review invoices, positions or ranks is rewritten.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_advisory_xact_lock(hashtextextended('nowpayments-operational-orders-v1',0));

CREATE TABLE payments.nowpayments_operational_pv_source (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attempt_id uuid NOT NULL UNIQUE REFERENCES payments.nowpayments_membership_attempt(id) ON DELETE RESTRICT,
  affiliate_id bigint NOT NULL REFERENCES mlm.affiliate(id) ON DELETE RESTRICT,
  pv integer NOT NULL CHECK(pv>=0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER nowpayments_operational_pv_append_only BEFORE UPDATE OR DELETE ON payments.nowpayments_operational_pv_source
 FOR EACH ROW EXECUTE FUNCTION payments.reject_nowpayments_evidence_mutation();
CREATE TABLE payments.nowpayments_operational_inflow (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 attempt_id uuid NOT NULL UNIQUE REFERENCES payments.nowpayments_membership_attempt(id) ON DELETE RESTRICT,
 gross_usd numeric(14,2) NOT NULL CHECK(gross_usd>0),
 provider_cost_usd numeric(16,4) NOT NULL,
 net_usd numeric(16,4) NOT NULL,
 payment_ref text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(provider_cost_usd=gross_usd*0.01 AND net_usd=gross_usd*0.99 AND gross_usd=provider_cost_usd+net_usd)
);
CREATE TRIGGER nowpayments_operational_inflow_append_only BEFORE UPDATE OR DELETE ON payments.nowpayments_operational_inflow
 FOR EACH ROW EXECUTE FUNCTION payments.reject_nowpayments_evidence_mutation();
CREATE TABLE payments.nowpayments_operational_order (
  attempt_id uuid PRIMARY KEY REFERENCES payments.nowpayments_membership_attempt(id) ON DELETE RESTRICT,
  capacity_slot smallint NOT NULL UNIQUE CHECK(capacity_slot BETWEEN 1 AND 5000),
  plan_config_id bigint NOT NULL REFERENCES mlm.plan_config(id) ON DELETE RESTRICT,
  roi_tier_id smallint NOT NULL REFERENCES mlm.cd_roi_tier(id) ON DELETE RESTRICT,
  cd_lock_days integer NOT NULL CHECK(cd_lock_days BETWEEN 1 AND 36500),
  lifetime_cap_factor numeric(8,4) NOT NULL CHECK(lifetime_cap_factor>0),
  plan_snapshot jsonb NOT NULL CHECK(jsonb_typeof(plan_snapshot)='object'),
  roi_base_annual_rate numeric(8,4) NOT NULL CHECK(roi_base_annual_rate>=0),
  roi_qualified_annual_rate numeric(8,4) NOT NULL CHECK(roi_qualified_annual_rate>=roi_base_annual_rate),
  state text NOT NULL DEFAULT 'awaiting_payment' CHECK(state IN('awaiting_payment','activated','risk_review','security_blocked')),
  affiliate_id bigint REFERENCES mlm.affiliate(id) ON DELETE RESTRICT,
  affiliate_package_id bigint UNIQUE REFERENCES mlm.affiliate_package(id) ON DELETE RESTRICT,
  investment_cd_id bigint UNIQUE REFERENCES mlm.investment_cd(id) ON DELETE RESTRICT,
  pv_source_id bigint UNIQUE REFERENCES payments.nowpayments_operational_pv_source(id) ON DELETE RESTRICT,
  inflow_id bigint UNIQUE REFERENCES payments.nowpayments_operational_inflow(id) ON DELETE RESTRICT,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(state<>'activated' OR(affiliate_id IS NOT NULL AND affiliate_package_id IS NOT NULL AND investment_cd_id IS NOT NULL AND pv_source_id IS NOT NULL AND inflow_id IS NOT NULL AND activated_at IS NOT NULL))
);
CREATE INDEX nowpayments_operational_affiliate_idx ON payments.nowpayments_operational_order(affiliate_id) WHERE affiliate_id IS NOT NULL;
CREATE INDEX nowpayments_operational_state_idx ON payments.nowpayments_operational_order(state,created_at);
CREATE TABLE payments.nowpayments_operational_job (
 attempt_id uuid PRIMARY KEY REFERENCES payments.nowpayments_operational_order(attempt_id) ON DELETE RESTRICT,
 capture_id bigint NOT NULL REFERENCES payments.nowpayments_webhook_capture(id) ON DELETE RESTRICT,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN('queued','running','completed','held')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 available_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid,
 lease_until timestamptz,
 last_error_code text CHECK(last_error_code IS NULL OR last_error_code IN('processing_unavailable','identity_review_required','payment_evidence_review_required')),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX nowpayments_operational_job_due_idx ON payments.nowpayments_operational_job(available_at) WHERE state IN('queued','running');
CREATE FUNCTION payments.protect_nowpayments_operational_order() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'awaiting_payment' OR NEW.affiliate_id IS NOT NULL OR NEW.affiliate_package_id IS NOT NULL OR NEW.investment_cd_id IS NOT NULL OR NEW.pv_source_id IS NOT NULL OR NEW.inflow_id IS NOT NULL OR NEW.activated_at IS NOT NULL
       OR NOT EXISTS(SELECT 1 FROM payments.nowpayments_membership_attempt a WHERE a.id=NEW.attempt_id
          AND a.pricing_policy='catalog_includes_provider_1pct_v1' AND a.state='creating_invoice' AND a.invoice_id IS NULL AND a.payment_id IS NULL) THEN
      RAISE EXCEPTION 'nowpayments_operational_order_requires_new_order' USING ERRCODE='23514';
    END IF;
  ELSE
    IF ROW(OLD.attempt_id,OLD.capacity_slot,OLD.plan_config_id,OLD.roi_tier_id,OLD.cd_lock_days,OLD.lifetime_cap_factor,OLD.plan_snapshot,OLD.roi_base_annual_rate,OLD.roi_qualified_annual_rate,OLD.created_at)
       IS DISTINCT FROM ROW(NEW.attempt_id,NEW.capacity_slot,NEW.plan_config_id,NEW.roi_tier_id,NEW.cd_lock_days,NEW.lifetime_cap_factor,NEW.plan_snapshot,NEW.roi_base_annual_rate,NEW.roi_qualified_annual_rate,NEW.created_at)
       OR(OLD.activated_at IS NOT NULL AND ROW(OLD.affiliate_id,OLD.affiliate_package_id,OLD.investment_cd_id,OLD.pv_source_id,OLD.inflow_id,OLD.activated_at)
          IS DISTINCT FROM ROW(NEW.affiliate_id,NEW.affiliate_package_id,NEW.investment_cd_id,NEW.pv_source_id,NEW.inflow_id,NEW.activated_at))
       OR(OLD.state IN('risk_review','security_blocked') AND NEW.state<>OLD.state)
       OR(OLD.state='activated' AND NEW.state NOT IN('activated','risk_review')) THEN
      RAISE EXCEPTION 'nowpayments_operational_order_is_immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER nowpayments_operational_order_immutable BEFORE INSERT OR UPDATE ON payments.nowpayments_operational_order
 FOR EACH ROW EXECUTE FUNCTION payments.protect_nowpayments_operational_order();
REVOKE ALL ON payments.nowpayments_operational_order FROM PUBLIC;
REVOKE ALL ON payments.nowpayments_operational_job FROM PUBLIC;
REVOKE ALL ON payments.nowpayments_operational_inflow FROM PUBLIC;
REVOKE ALL ON SEQUENCE payments.nowpayments_operational_inflow_id_seq FROM PUBLIC;
REVOKE ALL ON payments.nowpayments_operational_pv_source FROM PUBLIC;
REVOKE ALL ON SEQUENCE payments.nowpayments_operational_pv_source_id_seq FROM PUBLIC;

-- Dedicated writer permission inventory (operator must review/grant explicitly):
-- USAGE schemas auth,identity,mlm,payments; SELECT auth.user,identity.auth_binding,
-- mlm.person,mlm.affiliate,mlm.affiliate_closure,mlm.package,mlm.plan_config,
-- mlm.cd_roi_tier,mlm.asset,mlm.concept,mlm.package_cap_state,mlm.blacklist,
-- mlm.registration_referral,payments.purchase_intent (SELECT ONLY),
-- payments.nowpayments_membership_attempt,payments.nowpayments_membership_receipt,
-- payments.nowpayments_payment_binding,payments.nowpayments_operational_order,
-- payments.nowpayments_operational_pv_source,payments.nowpayments_operational_inflow,
-- payments.nowpayments_operational_job,payments.nowpayments_webhook_capture.
-- INSERT payments.nowpayments_membership_attempt,nowpayments_membership_receipt,
-- nowpayments_payment_binding,nowpayments_operational_order,nowpayments_operational_pv_source,
-- nowpayments_operational_inflow,nowpayments_operational_job; narrowly UPDATE
-- membership_attempt(state,invoice_id,payment_id,review_reason,updated_at),
-- operational_order(state,affiliate_id,affiliate_package_id,investment_cd_id,pv_source_id,inflow_id,activated_at,updated_at),
-- operational_job(capture_id,state,attempts,available_at,lease_token,lease_until,last_error_code,updated_at).
-- INSERT mlm.affiliate,mlm.affiliate_closure,mlm.affiliate_package,mlm.package_cap_state,
-- mlm.investment_cd,mlm.wallet,mlm.tree_event; NO wallet movement for a purchase.
-- Engine-80 legitimately needs its separately reviewed accrual ledger writes.
-- UPDATE mlm.person(updated_at) permits row locking but not identity changes.
-- UPDATE only affiliate counters/PV as required by existing placement/PV
-- triggers; SELECT/USAGE only the identity sequences of those inserted tables.
-- NO Stripe INSERT/UPDATE/DELETE; NO auth/identity writes; NO withdrawals;
-- NO general engine/scheduler permission or financialguard bypass.
COMMIT;
