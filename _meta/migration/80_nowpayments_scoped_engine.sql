-- Reviewed operator migration only. No automatic startup execution or grants.
-- NOW-only accounting state; no Stripe/recovery/global PV/period rewrites.
-- Depends on 79; the application role must be an explicit restricted login.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_advisory_xact_lock(hashtextextended('nowpayments-scoped-engine-v1',0));

CREATE TABLE payments.nowpayments_engine_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  schema_version integer NOT NULL CHECK(schema_version=1),
  last_run_at timestamptz
);
INSERT INTO payments.nowpayments_engine_control(singleton,schema_version) VALUES(true,1);

CREATE TABLE payments.nowpayments_engine_period (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL CHECK(period_end>period_start),
  state text NOT NULL DEFAULT 'open' CHECK(state IN('open','closed')),
  inflows_usd numeric(24,4) NOT NULL DEFAULT 0 CHECK(inflows_usd>=0),
  roi_usd numeric(20,2) NOT NULL DEFAULT 0 CHECK(roi_usd>=0),
  projected_usd numeric(20,2) NOT NULL DEFAULT 0 CHECK(projected_usd>=0),
  paid_usd numeric(20,2) NOT NULL DEFAULT 0 CHECK(paid_usd>=0),
  held_usd numeric(20,2) NOT NULL DEFAULT 0 CHECK(held_usd>=0),
  theta numeric(8,6) NOT NULL DEFAULT 0 CHECK(theta BETWEEN 0 AND 1),
  closed_at timestamptz,
  UNIQUE(period_start,period_end),
  CHECK((state='closed')=(closed_at IS NOT NULL))
);

CREATE TABLE payments.nowpayments_engine_binary_state (
  affiliate_id bigint PRIMARY KEY REFERENCES mlm.affiliate(id) ON DELETE RESTRICT,
  claimed_blocks bigint NOT NULL DEFAULT 0 CHECK(claimed_blocks>=0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payments.nowpayments_engine_roi_state (
  attempt_id uuid PRIMARY KEY REFERENCES payments.nowpayments_operational_order(attempt_id) ON DELETE RESTRICT,
  cutoff_date date NOT NULL,
  accrued_usd numeric(20,2) NOT NULL DEFAULT 0 CHECK(accrued_usd>=0),
  rate_day_numerator numeric(30,10) NOT NULL DEFAULT 0 CHECK(rate_day_numerator>=0),
  claimed_usd numeric(20,2) NOT NULL DEFAULT 0 CHECK(claimed_usd>=accrued_usd),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payments.nowpayments_engine_roi_rate_day (
  attempt_id uuid NOT NULL REFERENCES payments.nowpayments_operational_order(attempt_id) ON DELETE RESTRICT,
  cutoff_date date NOT NULL,
  principal_usd numeric(14,2) NOT NULL CHECK(principal_usd>0),
  annual_rate numeric(8,4) NOT NULL CHECK(annual_rate BETWEEN .25 AND .50),
  qualified boolean NOT NULL,
  rate_day_numerator numeric(30,10) NOT NULL CHECK(rate_day_numerator>=0),
  entitlement_usd numeric(20,2) NOT NULL CHECK(entitlement_usd>=0),
  credited_usd numeric(20,2) NOT NULL CHECK(credited_usd>=0 AND credited_usd<=entitlement_usd),
  PRIMARY KEY(attempt_id,cutoff_date)
);
CREATE TRIGGER nowpayments_engine_roi_day_append_only BEFORE UPDATE OR DELETE ON payments.nowpayments_engine_roi_rate_day
 FOR EACH ROW EXECUTE FUNCTION payments.reject_nowpayments_evidence_mutation();

CREATE TABLE payments.nowpayments_engine_obligation (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  external_ref text NOT NULL UNIQUE CHECK(external_ref LIKE 'now:%'),
  source_attempt_id uuid NOT NULL REFERENCES payments.nowpayments_operational_order(attempt_id) ON DELETE RESTRICT,
  period_id bigint REFERENCES payments.nowpayments_engine_period(id) ON DELETE RESTRICT,
  affiliate_id bigint NOT NULL REFERENCES mlm.affiliate(id) ON DELETE RESTRICT,
  affiliate_package_id bigint NOT NULL REFERENCES mlm.affiliate_package(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK(kind IN('roi','binary_bonus','direct_bonus','royalty')),
  entitlement_usd numeric(20,2) NOT NULL CHECK(entitlement_usd>0),
  paid_usd numeric(20,2) NOT NULL DEFAULT 0 CHECK(paid_usd>=0),
  cap_excluded_usd numeric(20,2) NOT NULL DEFAULT 0 CHECK(cap_excluded_usd>=0),
  unit_gross_usd numeric(20,2),
  commission_factor numeric(8,6) NOT NULL CHECK(commission_factor BETWEEN 0 AND 1),
  available_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(paid_usd+cap_excluded_usd<=entitlement_usd),
  CHECK((kind='roi')=(period_id IS NULL))
);
CREATE INDEX nowpayments_engine_obligation_pending_idx ON payments.nowpayments_engine_obligation(id)
 WHERE entitlement_usd>paid_usd+cap_excluded_usd;

CREATE TABLE payments.nowpayments_engine_payment (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  obligation_id bigint NOT NULL REFERENCES payments.nowpayments_engine_obligation(id) ON DELETE RESTRICT,
  installment integer NOT NULL CHECK(installment>0),
  amount_usd numeric(20,2) NOT NULL CHECK(amount_usd>0),
  theta numeric(8,6) NOT NULL CHECK(theta BETWEEN 0 AND 1),
  posted_at timestamptz NOT NULL,
  transaction_ref text NOT NULL UNIQUE CHECK(transaction_ref LIKE 'now:%'),
  UNIQUE(obligation_id,installment)
);
CREATE TRIGGER nowpayments_engine_payment_append_only BEFORE UPDATE OR DELETE ON payments.nowpayments_engine_payment
 FOR EACH ROW EXECUTE FUNCTION payments.reject_nowpayments_evidence_mutation();

-- Existing obligations are audit records: never erase a held entitlement or
-- reattribute it to another source/package. Only the paid/cap-excluded counters
-- may advance atomically with an append-only engine payment and ledger entry.
CREATE FUNCTION payments.protect_nowpayments_engine_obligation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' OR ROW(OLD.id,OLD.external_ref,OLD.source_attempt_id,OLD.period_id,
    OLD.affiliate_id,OLD.affiliate_package_id,OLD.kind,OLD.entitlement_usd,OLD.unit_gross_usd,
    OLD.commission_factor,OLD.available_at,OLD.created_at) IS DISTINCT FROM
    ROW(NEW.id,NEW.external_ref,NEW.source_attempt_id,NEW.period_id,
    NEW.affiliate_id,NEW.affiliate_package_id,NEW.kind,NEW.entitlement_usd,NEW.unit_gross_usd,
    NEW.commission_factor,NEW.available_at,NEW.created_at)
    OR NEW.paid_usd<OLD.paid_usd OR NEW.cap_excluded_usd<OLD.cap_excluded_usd THEN
    RAISE EXCEPTION 'nowpayments_engine_obligation_is_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER nowpayments_engine_obligation_immutable BEFORE UPDATE OR DELETE ON payments.nowpayments_engine_obligation
 FOR EACH ROW EXECUTE FUNCTION payments.protect_nowpayments_engine_obligation();

REVOKE ALL ON payments.nowpayments_engine_control,payments.nowpayments_engine_period,
 payments.nowpayments_engine_binary_state,payments.nowpayments_engine_roi_state,
 payments.nowpayments_engine_obligation,payments.nowpayments_engine_payment,payments.nowpayments_engine_roi_rate_day FROM PUBLIC;
REVOKE ALL ON SEQUENCE payments.nowpayments_engine_period_id_seq,
 payments.nowpayments_engine_obligation_id_seq,payments.nowpayments_engine_payment_id_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION payments.protect_nowpayments_engine_obligation() FROM PUBLIC;

-- Operator-reviewed additional runtime ACL inventory, NOT executed here:
-- SELECT/INSERT/UPDATE only on control, period, binary_state, roi_state;
-- SELECT/INSERT obligation; UPDATE obligation(paid_usd,cap_excluded_usd);
-- SELECT/INSERT engine_payment; USAGE/SELECT exactly their three sequences.
-- SELECT/INSERT roi_rate_day; never UPDATE/DELETE an audited rate-day.
-- SELECT only NOW operational order/PV/inflow/attempt/capture/receipt manifests,
-- mlm.affiliate/closure/person/package/cap_state/concept/asset/rank/blacklist,
-- retirement_plan/mode_routing. INSERT ledger transaction/wallet/movement;
-- UPDATE package_cap_state(paid_total), investment_cd(roi_accrued_usd,
-- last_accrual_date,qualified_since,status,closed_at) restricted to linked NOW CDs.
-- Retirement routing reuses the reviewed existing helpers: INSERT retirement_plan,
-- UPDATE retirement_plan(balance_usd,updated_at), USD-RET wallet/ledger creation.
-- SELECT transaction(id,external_ref) for INSERT RETURNING/conflict checks;
-- UPDATE wallet(balance) required by the existing invoker ledger trigger.
-- No DELETE, no Stripe/recovery writes, no global periods/node/rank/PV writes,
-- no withdrawals, no future-default grants and no SECURITY DEFINER functions.
COMMIT;
