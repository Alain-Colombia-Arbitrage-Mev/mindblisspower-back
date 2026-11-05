-- OPERATOR-REVIEWED DDL ONLY. Never run automatically at application startup.
-- Dependencies: 79,80,82 and the existing package/CD/cap/plan schema.
-- This migration records a separate authorized manual source; it fabricates no
-- Stripe sale, NOW attempt, provider receipt, webhook or authentication identity.
-- It inserts NO manual order, package, CD, PV event, obligation or ledger entry.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_advisory_xact_lock(hashtextextended('nowpayments-scoped-engine-v1',0));

-- The new weighted allocator cannot reinterpret already-consumed historical
-- blocks without an independently approved lot-level backfill.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM payments.nowpayments_engine_binary_state WHERE claimed_blocks>0) THEN
    RAISE EXCEPTION 'manual_source_requires_approved_binary_allocation_backfill' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM payments.nowpayments_engine_obligation WHERE kind IN('direct_bonus','royalty')) THEN
    RAISE EXCEPTION 'compensation_source_requires_approved_earning_origin_backfill' USING ERRCODE='23514';
  END IF;
END $$;
ALTER TABLE payments.nowpayments_engine_binary_state
  ADD COLUMN claimed_prefix_hash text
    CHECK(claimed_prefix_hash IS NULL OR claimed_prefix_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT compensation_binary_claimed_prefix_required
    CHECK(claimed_blocks=0 OR claimed_prefix_hash IS NOT NULL);

CREATE TABLE payments.manual_membership_order (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key text NOT NULL UNIQUE
    CHECK(operation_key ~ '^manual-membership:[a-z0-9][a-z0-9._:-]{7,111}$'),
  source_kind text NOT NULL DEFAULT 'manual' CHECK(source_kind='manual'),
  person_id bigint NOT NULL REFERENCES mlm.person(id) ON DELETE RESTRICT,
  affiliate_id bigint NOT NULL REFERENCES mlm.affiliate(id) ON DELETE RESTRICT,
  package_id integer NOT NULL REFERENCES mlm.package(id) ON DELETE RESTRICT,
  affiliate_package_id bigint NOT NULL UNIQUE REFERENCES mlm.affiliate_package(id) ON DELETE RESTRICT,
  investment_cd_id bigint NOT NULL UNIQUE REFERENCES mlm.investment_cd(id) ON DELETE RESTRICT,
  plan_config_id bigint NOT NULL REFERENCES mlm.plan_config(id) ON DELETE RESTRICT,
  roi_tier_id smallint NOT NULL REFERENCES mlm.cd_roi_tier(id) ON DELETE RESTRICT,
  cd_lock_days integer NOT NULL CHECK(cd_lock_days=365),
  lifetime_cap_factor numeric(8,4) NOT NULL CHECK(lifetime_cap_factor=2),
  plan_snapshot jsonb NOT NULL CHECK(jsonb_typeof(plan_snapshot)='object'),
  roi_base_annual_rate numeric(8,4) NOT NULL CHECK(roi_base_annual_rate=.25),
  roi_qualified_annual_rate numeric(8,4) NOT NULL CHECK(roi_qualified_annual_rate BETWEEN .30 AND .50),
  gross_usd numeric(14,2) NOT NULL CHECK(gross_usd=100),
  fee_rate numeric(8,6) NOT NULL CHECK(fee_rate=.03),
  fee_usd numeric(16,4) NOT NULL CHECK(fee_usd=gross_usd*fee_rate),
  net_usd numeric(16,4) NOT NULL CHECK(net_usd=gross_usd-fee_usd AND net_usd=gross_usd*.97),
  pv integer NOT NULL CHECK(pv=100),
  effective_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz NOT NULL DEFAULT now(),
  actor_reason text NOT NULL CHECK(length(btrim(actor_reason)) BETWEEN 10 AND 1000),
  authorization_digest text NOT NULL CHECK(authorization_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'activated' CHECK(state IN('activated','risk_review','security_blocked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(approved_at<=effective_at AND effective_at<=created_at)
);
CREATE INDEX manual_membership_order_person_idx ON payments.manual_membership_order(person_id);
CREATE INDEX manual_membership_order_affiliate_idx ON payments.manual_membership_order(affiliate_id);
CREATE INDEX manual_membership_order_package_idx ON payments.manual_membership_order(package_id);
CREATE INDEX manual_membership_order_plan_idx ON payments.manual_membership_order(plan_config_id);
CREATE INDEX manual_membership_order_tier_idx ON payments.manual_membership_order(roi_tier_id);

-- Invoker-only validation. The reviewed operator transaction must create the
-- package, its normal cap trigger result and CD before inserting this manifest.
-- Lock acquisition order is person, affiliate, catalog, plan, tier, package,
-- cap, CD. No auth.user/user_id/binding is required, inserted or modified.
CREATE FUNCTION payments.protect_manual_membership_order() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE
  person_status text; person_blocked boolean; linked_person bigint; affiliate_status text;
  catalog_amount numeric; catalog_pv integer; catalog_active boolean;
  cfg jsonb; tier_base numeric; tier_qualified numeric; tier_min numeric; tier_max numeric; tier_active boolean;
  pkg_affiliate bigint; pkg_catalog integer; pkg_status text; pkg_method text; pkg_ref text;
  pkg_activated timestamptz; pkg_expired timestamptz; cap_total numeric; cap_paid numeric; cap_closed timestamptz;
  cd_affiliate bigint; cd_package bigint; cd_principal numeric; cd_tier smallint;
  cd_start timestamptz; cd_matures timestamptz; cd_status text; cd_closed timestamptz;
BEGIN
  IF TG_OP='DELETE' OR TG_OP='TRUNCATE' THEN
    RAISE EXCEPTION 'manual_membership_order_is_append_only' USING ERRCODE='55000';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(OLD)-'state') IS DISTINCT FROM (to_jsonb(NEW)-'state')
       OR OLD.state<>'activated' OR NEW.state NOT IN('risk_review','security_blocked') THEN
      RAISE EXCEPTION 'manual_membership_order_is_immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  NEW.created_at:=now();
  IF NEW.state<>'activated' OR NEW.approved_at>NEW.effective_at OR NEW.effective_at>NEW.created_at
     OR (NEW.approved_at AT TIME ZONE 'America/Bogota')::date<>(NEW.created_at AT TIME ZONE 'America/Bogota')::date
     OR (NEW.effective_at AT TIME ZONE 'America/Bogota')::date<>(NEW.created_at AT TIME ZONE 'America/Bogota')::date THEN
    RAISE EXCEPTION 'manual_membership_requires_current_day_approval' USING ERRCODE='23514';
  END IF;
  SELECT p.status::text,COALESCE(p.blacklisted,false) INTO person_status,person_blocked
    FROM mlm.person p WHERE p.id=NEW.person_id FOR KEY SHARE;
  IF NOT FOUND OR person_status NOT IN('active','pending') OR person_blocked THEN
    RAISE EXCEPTION 'manual_membership_person_unavailable' USING ERRCODE='23514';
  END IF;
  SELECT a.person_id,a.status::text INTO linked_person,affiliate_status
    FROM mlm.affiliate a WHERE a.id=NEW.affiliate_id FOR KEY SHARE;
  IF NOT FOUND OR linked_person<>NEW.person_id OR affiliate_status<>'active' THEN
    RAISE EXCEPTION 'manual_membership_identity_mismatch' USING ERRCODE='23514';
  END IF;
  SELECT p.amount_usd,p.pv,p.is_active INTO catalog_amount,catalog_pv,catalog_active
    FROM mlm.package p WHERE p.id=NEW.package_id FOR KEY SHARE;
  IF NOT FOUND OR NOT catalog_active OR catalog_amount<>NEW.gross_usd OR catalog_pv<>NEW.pv THEN
    RAISE EXCEPTION 'manual_membership_catalog_mismatch' USING ERRCODE='23514';
  END IF;
  SELECT to_jsonb(p) INTO cfg FROM mlm.plan_config p WHERE p.id=NEW.plan_config_id
    AND p.effective_from<=NEW.effective_at AND(p.effective_to IS NULL OR p.effective_to>NEW.effective_at) FOR KEY SHARE;
  IF NOT FOUND OR cfg IS DISTINCT FROM NEW.plan_snapshot
     OR (cfg->>'cd_lock_days')::integer IS DISTINCT FROM NEW.cd_lock_days
     OR (cfg->>'lifetime_cap_factor')::numeric IS DISTINCT FROM NEW.lifetime_cap_factor THEN
    RAISE EXCEPTION 'manual_membership_plan_mismatch' USING ERRCODE='23514';
  END IF;
  SELECT t.base_annual_rate,t.qualified_annual_rate,t.min_amount_usd,t.max_amount_usd,t.active
    INTO tier_base,tier_qualified,tier_min,tier_max,tier_active
    FROM mlm.cd_roi_tier t WHERE t.id=NEW.roi_tier_id FOR KEY SHARE;
  IF NOT FOUND OR NOT tier_active OR tier_base<>NEW.roi_base_annual_rate OR tier_qualified<>NEW.roi_qualified_annual_rate
     OR NEW.gross_usd<tier_min OR(tier_max IS NOT NULL AND NEW.gross_usd>=tier_max) THEN
    RAISE EXCEPTION 'manual_membership_roi_tier_mismatch' USING ERRCODE='23514';
  END IF;
  SELECT p.affiliate_id,p.package_id,p.status::text,p.payment_method,p.transaction_hash,p.activated_at,p.expired_at
    INTO pkg_affiliate,pkg_catalog,pkg_status,pkg_method,pkg_ref,pkg_activated,pkg_expired
    FROM mlm.affiliate_package p WHERE p.id=NEW.affiliate_package_id FOR KEY SHARE;
  IF NOT FOUND OR pkg_affiliate<>NEW.affiliate_id OR pkg_catalog<>NEW.package_id OR pkg_status<>'active'
     OR pkg_method IS DISTINCT FROM 'manual' OR pkg_ref IS DISTINCT FROM 'manual:production:'||NEW.id::text
     OR pkg_activated IS DISTINCT FROM NEW.effective_at OR pkg_expired IS NOT NULL THEN
    RAISE EXCEPTION 'manual_membership_package_mismatch' USING ERRCODE='23514';
  END IF;
  SELECT c.cap_total,c.paid_total,c.closed_at INTO cap_total,cap_paid,cap_closed
    FROM mlm.package_cap_state c WHERE c.affiliate_package_id=NEW.affiliate_package_id FOR KEY SHARE;
  IF NOT FOUND OR cap_total<>NEW.gross_usd*NEW.lifetime_cap_factor OR cap_paid<>0 OR cap_closed IS NOT NULL THEN
    RAISE EXCEPTION 'manual_membership_cap_mismatch' USING ERRCODE='23514';
  END IF;
  SELECT c.affiliate_id,c.affiliate_package_id,c.principal_usd,c.roi_tier_id,c.start_at,c.matures_at,c.status::text,c.closed_at
    INTO cd_affiliate,cd_package,cd_principal,cd_tier,cd_start,cd_matures,cd_status,cd_closed
    FROM mlm.investment_cd c WHERE c.id=NEW.investment_cd_id FOR KEY SHARE;
  IF NOT FOUND OR cd_affiliate<>NEW.affiliate_id OR cd_package IS DISTINCT FROM NEW.affiliate_package_id
     OR cd_principal<>NEW.gross_usd OR cd_tier<>NEW.roi_tier_id OR cd_start IS DISTINCT FROM NEW.effective_at
     OR cd_matures IS DISTINCT FROM NEW.effective_at+interval '365 days' OR cd_status<>'active' OR cd_closed IS NOT NULL THEN
    RAISE EXCEPTION 'manual_membership_cd_mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER manual_membership_order_immutable BEFORE INSERT OR UPDATE OR DELETE ON payments.manual_membership_order
  FOR EACH ROW EXECUTE FUNCTION payments.protect_manual_membership_order();
CREATE TRIGGER manual_membership_order_no_truncate BEFORE TRUNCATE ON payments.manual_membership_order
  FOR EACH STATEMENT EXECUTE FUNCTION payments.protect_manual_membership_order();

CREATE TABLE payments.compensation_source (
  id uuid PRIMARY KEY,
  source_kind text NOT NULL CHECK(source_kind IN('nowpayments','manual')),
  nowpayments_attempt_id uuid UNIQUE REFERENCES payments.nowpayments_operational_order(attempt_id) ON DELETE RESTRICT,
  manual_order_id uuid UNIQUE REFERENCES payments.manual_membership_order(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((source_kind='nowpayments' AND nowpayments_attempt_id IS NOT NULL AND manual_order_id IS NULL AND id=nowpayments_attempt_id)
     OR (source_kind='manual' AND manual_order_id IS NOT NULL AND nowpayments_attempt_id IS NULL AND id=manual_order_id))
);
CREATE FUNCTION payments.reject_compensation_source_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN
  RAISE EXCEPTION 'compensation_source_evidence_is_append_only' USING ERRCODE='55000';
END $$;
CREATE TRIGGER compensation_source_append_only BEFORE UPDATE OR DELETE ON payments.compensation_source
  FOR EACH ROW EXECUTE FUNCTION payments.reject_compensation_source_mutation();
CREATE TRIGGER compensation_source_no_truncate BEFORE TRUNCATE ON payments.compensation_source
  FOR EACH STATEMENT EXECUTE FUNCTION payments.reject_compensation_source_mutation();

-- Classification is NOT evidence of payment or engine eligibility. The view
-- below still validates every receipt/capture and source/package/CD invariant.
CREATE FUNCTION payments.classify_compensation_source() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN
  IF TG_TABLE_NAME='nowpayments_operational_order' THEN
    INSERT INTO payments.compensation_source(id,source_kind,nowpayments_attempt_id)
      VALUES(NEW.attempt_id,'nowpayments',NEW.attempt_id);
  ELSIF TG_TABLE_NAME='manual_membership_order' THEN
    INSERT INTO payments.compensation_source(id,source_kind,manual_order_id)
      VALUES(NEW.id,'manual',NEW.id);
  ELSE
    RAISE EXCEPTION 'compensation_source_classification_unavailable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
INSERT INTO payments.compensation_source(id,source_kind,nowpayments_attempt_id,created_at)
  SELECT attempt_id,'nowpayments',attempt_id,created_at FROM payments.nowpayments_operational_order;
CREATE TRIGGER nowpayments_order_compensation_source AFTER INSERT ON payments.nowpayments_operational_order
  FOR EACH ROW EXECUTE FUNCTION payments.classify_compensation_source();
CREATE TRIGGER manual_order_compensation_source AFTER INSERT ON payments.manual_membership_order
  FOR EACH ROW EXECUTE FUNCTION payments.classify_compensation_source();

-- Preserve every existing NOW UUID and all accounting amounts. Only the FK
-- target changes; historical column names remain compatible with old code.
ALTER TABLE payments.nowpayments_engine_roi_state DROP CONSTRAINT nowpayments_engine_roi_state_attempt_id_fkey;
ALTER TABLE payments.nowpayments_engine_roi_state ADD CONSTRAINT nowpayments_engine_roi_state_attempt_id_fkey
  FOREIGN KEY(attempt_id) REFERENCES payments.compensation_source(id) ON DELETE RESTRICT;
ALTER TABLE payments.nowpayments_engine_roi_rate_day DROP CONSTRAINT nowpayments_engine_roi_rate_day_attempt_id_fkey;
ALTER TABLE payments.nowpayments_engine_roi_rate_day ADD CONSTRAINT nowpayments_engine_roi_rate_day_attempt_id_fkey
  FOREIGN KEY(attempt_id) REFERENCES payments.compensation_source(id) ON DELETE RESTRICT;
ALTER TABLE payments.nowpayments_engine_obligation DROP CONSTRAINT nowpayments_engine_obligation_source_attempt_id_fkey;
ALTER TABLE payments.nowpayments_engine_obligation ADD CONSTRAINT nowpayments_engine_obligation_source_attempt_id_fkey
  FOREIGN KEY(source_attempt_id) REFERENCES payments.compensation_source(id) ON DELETE RESTRICT;
-- source_attempt_id still identifies the beneficiary's own package/cap. The
-- causal sale is separate; never infer its provider from the own membership.
ALTER TABLE payments.nowpayments_engine_obligation ADD COLUMN earning_source_id uuid
  REFERENCES payments.compensation_source(id) ON DELETE RESTRICT;
CREATE INDEX compensation_obligation_earning_source_idx ON payments.nowpayments_engine_obligation(earning_source_id)
  WHERE earning_source_id IS NOT NULL;
CREATE TRIGGER compensation_obligation_earning_source_immutable BEFORE UPDATE OF earning_source_id
  ON payments.nowpayments_engine_obligation FOR EACH ROW EXECUTE FUNCTION payments.reject_compensation_source_mutation();
ALTER TABLE payments.nowpayments_engine_obligation DROP CONSTRAINT nowpayments_engine_obligation_external_ref_check;
ALTER TABLE payments.nowpayments_engine_obligation ADD CONSTRAINT nowpayments_engine_obligation_external_ref_check
  CHECK(external_ref LIKE 'now:%' OR external_ref LIKE 'comp:%');
ALTER TABLE payments.nowpayments_engine_payment DROP CONSTRAINT nowpayments_engine_payment_transaction_ref_check;
ALTER TABLE payments.nowpayments_engine_payment ADD CONSTRAINT nowpayments_engine_payment_transaction_ref_check
  CHECK(transaction_ref LIKE 'now:%' OR transaction_ref LIKE 'comp:%');

CREATE VIEW payments.v_compensation_source WITH(security_invoker=true,security_barrier=true) AS
SELECT s.id AS source_id,s.source_kind,o.affiliate_id,o.affiliate_package_id,o.investment_cd_id,pv.pv,
  a.amount_usd AS gross_usd,i.net_usd,o.roi_base_annual_rate,o.roi_qualified_annual_rate,o.activated_at,
  cd.start_at,cd.matures_at,cd.status::text AS cd_status,o.plan_snapshot,
  (ap.status='active' AND cs.closed_at IS NULL) AS active,ap.status::text AS package_status,
  cs.closed_at AS cap_closed_at,ap.expired_at AS package_expired_at,cd.closed_at AS cd_closed_at,
  o.roi_tier_id,o.state,af.person_id
FROM payments.compensation_source s
JOIN payments.nowpayments_operational_order o ON o.attempt_id=s.nowpayments_attempt_id AND s.source_kind='nowpayments'
JOIN payments.nowpayments_membership_attempt a ON a.id=o.attempt_id AND a.environment='production'
JOIN payments.nowpayments_operational_pv_source pv ON pv.id=o.pv_source_id AND pv.attempt_id=o.attempt_id AND pv.affiliate_id=o.affiliate_id
JOIN payments.nowpayments_operational_inflow i ON i.id=o.inflow_id AND i.attempt_id=o.attempt_id
JOIN mlm.affiliate_package ap ON ap.id=o.affiliate_package_id AND ap.affiliate_id=o.affiliate_id AND ap.payment_method='nowpayments'
JOIN mlm.package_cap_state cs ON cs.affiliate_package_id=ap.id
JOIN mlm.investment_cd cd ON cd.id=o.investment_cd_id AND cd.affiliate_package_id=ap.id AND cd.affiliate_id=o.affiliate_id
JOIN mlm.affiliate af ON af.id=o.affiliate_id
WHERE o.state='activated' AND a.pricing_policy='catalog_includes_provider_1pct_v1'
  AND a.invoice_id IS NOT NULL AND a.payment_id IS NOT NULL AND a.commission_base_usd=i.net_usd
  AND i.gross_usd=a.amount_usd AND i.net_usd=a.amount_usd*.99 AND pv.pv=a.pv AND cd.principal_usd=a.amount_usd AND cd.roi_tier_id=o.roi_tier_id
  AND i.payment_ref='nowpayments:production:'||a.payment_id AND ap.transaction_hash=i.payment_ref
  AND cd.matures_at=cd.start_at+interval '365 days'
  AND EXISTS(SELECT 1 FROM payments.nowpayments_membership_receipt r WHERE r.attempt_id=o.attempt_id AND r.payment_id=a.payment_id AND r.finished_verified AND NOT r.multiple_payments)
  AND NOT EXISTS(SELECT 1 FROM payments.nowpayments_membership_receipt r WHERE r.attempt_id=o.attempt_id AND(r.multiple_payments OR r.api_evidence->>'payment_status' NOT IN('waiting','confirming','confirmed','sending','finished')))
  AND EXISTS(SELECT 1 FROM payments.nowpayments_webhook_capture c WHERE c.matched_attempt_id=o.attempt_id AND c.payment_id=a.payment_id AND c.environment='production' AND c.finished_verified AND NOT c.risk_detected AND c.disposition<>'quarantined')
UNION ALL
SELECT s.id,s.source_kind,m.affiliate_id,m.affiliate_package_id,m.investment_cd_id,m.pv,
  m.gross_usd,m.net_usd,m.roi_base_annual_rate,m.roi_qualified_annual_rate,m.effective_at,
  cd.start_at,cd.matures_at,cd.status::text,m.plan_snapshot,
  (ap.status='active' AND cs.closed_at IS NULL),ap.status::text,cs.closed_at,ap.expired_at,cd.closed_at,
  m.roi_tier_id,m.state,m.person_id
FROM payments.compensation_source s
JOIN payments.manual_membership_order m ON m.id=s.manual_order_id AND s.source_kind='manual'
JOIN mlm.affiliate af ON af.id=m.affiliate_id AND af.person_id=m.person_id
JOIN mlm.affiliate_package ap ON ap.id=m.affiliate_package_id AND ap.affiliate_id=m.affiliate_id AND ap.package_id=m.package_id
JOIN mlm.package_cap_state cs ON cs.affiliate_package_id=ap.id
JOIN mlm.investment_cd cd ON cd.id=m.investment_cd_id AND cd.affiliate_id=m.affiliate_id AND cd.affiliate_package_id=ap.id
WHERE m.state='activated' AND m.source_kind='manual' AND m.gross_usd=100 AND m.pv=100
  AND m.fee_rate=.03 AND m.fee_usd=m.gross_usd*.03 AND m.net_usd=m.gross_usd*.97
  AND ap.payment_method='manual' AND ap.transaction_hash='manual:production:'||m.id::text
  AND ap.activated_at=m.effective_at AND cd.start_at=m.effective_at
  AND cd.principal_usd=m.gross_usd AND cd.roi_tier_id=m.roi_tier_id
  AND cd.matures_at=cd.start_at+interval '365 days' AND cs.cap_total=m.gross_usd*m.lifetime_cap_factor
  AND m.cd_lock_days=365 AND m.lifetime_cap_factor=2
  AND (m.approved_at AT TIME ZONE 'America/Bogota')::date=(m.effective_at AT TIME ZONE 'America/Bogota')::date;

CREATE FUNCTION payments.validate_compensation_obligation_earning_source() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE earning_factor numeric;
BEGIN
  IF NEW.kind IN('direct_bonus','royalty') THEN
    SELECT net_usd/gross_usd INTO earning_factor FROM payments.v_compensation_source WHERE source_id=NEW.earning_source_id;
    IF NOT FOUND OR earning_factor IS DISTINCT FROM NEW.commission_factor THEN
      RAISE EXCEPTION 'compensation_obligation_earning_source_required' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.kind='binary_bonus' AND NEW.earning_source_id IS NOT NULL THEN
    RAISE EXCEPTION 'compensation_binary_origin_requires_allocations' USING ERRCODE='23514';
  ELSIF NEW.kind='roi' AND NEW.earning_source_id IS NOT NULL AND NEW.earning_source_id<>NEW.source_attempt_id THEN
    RAISE EXCEPTION 'compensation_roi_origin_must_match_own_source' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER compensation_obligation_earning_source_validate BEFORE INSERT ON payments.nowpayments_engine_obligation
  FOR EACH ROW EXECUTE FUNCTION payments.validate_compensation_obligation_earning_source();

CREATE TABLE payments.compensation_binary_allocation (
  affiliate_id bigint NOT NULL REFERENCES mlm.affiliate(id) ON DELETE RESTRICT,
  block_no bigint NOT NULL CHECK(block_no>0),
  leg text NOT NULL CHECK(leg IN('L','R')),
  source_id uuid NOT NULL REFERENCES payments.compensation_source(id) ON DELETE RESTRICT,
  pv numeric(20,8) NOT NULL CHECK(pv>0 AND pv<=500),
  commission_factor numeric(8,6) NOT NULL CHECK(commission_factor IN(.97,.99)),
  obligation_id bigint NOT NULL REFERENCES payments.nowpayments_engine_obligation(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(affiliate_id,block_no,leg,source_id)
);
CREATE INDEX compensation_binary_allocation_source_idx ON payments.compensation_binary_allocation(source_id);
CREATE INDEX compensation_binary_allocation_obligation_idx ON payments.compensation_binary_allocation(obligation_id);
CREATE FUNCTION payments.validate_compensation_binary_allocation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE source_factor numeric; obligation_affiliate bigint; obligation_kind text;
BEGIN
  SELECT net_usd/gross_usd INTO source_factor FROM payments.v_compensation_source WHERE source_id=NEW.source_id;
  IF NOT FOUND OR source_factor IS DISTINCT FROM NEW.commission_factor THEN
    RAISE EXCEPTION 'compensation_binary_source_factor_mismatch' USING ERRCODE='23514';
  END IF;
  SELECT affiliate_id,kind INTO obligation_affiliate,obligation_kind
    FROM payments.nowpayments_engine_obligation WHERE id=NEW.obligation_id FOR KEY SHARE;
  IF NOT FOUND OR obligation_affiliate<>NEW.affiliate_id OR obligation_kind<>'binary_bonus'
     OR NOT EXISTS(SELECT 1 FROM payments.nowpayments_engine_obligation e
       JOIN payments.v_compensation_source s ON s.source_id=e.source_attempt_id
         AND s.affiliate_id=e.affiliate_id AND s.affiliate_package_id=e.affiliate_package_id
       WHERE e.id=NEW.obligation_id) THEN
    RAISE EXCEPTION 'compensation_binary_obligation_mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER compensation_binary_allocation_validate BEFORE INSERT ON payments.compensation_binary_allocation
  FOR EACH ROW EXECUTE FUNCTION payments.validate_compensation_binary_allocation();
CREATE TRIGGER compensation_binary_allocation_append_only BEFORE UPDATE OR DELETE ON payments.compensation_binary_allocation
  FOR EACH ROW EXECUTE FUNCTION payments.reject_compensation_source_mutation();
CREATE TRIGGER compensation_binary_allocation_no_truncate BEFORE TRUNCATE ON payments.compensation_binary_allocation
  FOR EACH STATEMENT EXECUTE FUNCTION payments.reject_compensation_source_mutation();
CREATE FUNCTION payments.check_compensation_binary_block() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE left_pv numeric; right_pv numeric; obligations integer;
BEGIN
  SELECT COALESCE(sum(pv) FILTER(WHERE leg='L'),0),COALESCE(sum(pv) FILTER(WHERE leg='R'),0),count(DISTINCT obligation_id)
    INTO left_pv,right_pv,obligations FROM payments.compensation_binary_allocation
    WHERE affiliate_id=NEW.affiliate_id AND block_no=NEW.block_no;
  IF left_pv<>500 OR right_pv<>500 OR obligations<>1 THEN
    RAISE EXCEPTION 'compensation_binary_block_incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER compensation_binary_block_complete AFTER INSERT ON payments.compensation_binary_allocation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payments.check_compensation_binary_block();

-- An obligation may contain several complete blocks. Its audit factor rounds
-- only the display/snapshot to six decimals; the entitlement uses the full
-- weighted PV numerator and truncates to cents once, not per source lot.
CREATE FUNCTION payments.check_compensation_binary_obligation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE target_id bigint; allocated_pv numeric; weighted_pv numeric;
  obligation_kind text; obligation_factor numeric; obligation_unit numeric; obligation_amount numeric;
BEGIN
  IF TG_TABLE_NAME='nowpayments_engine_obligation' THEN target_id:=NEW.id;
  ELSE target_id:=NEW.obligation_id;
  END IF;
  SELECT kind,commission_factor,unit_gross_usd,entitlement_usd
    INTO obligation_kind,obligation_factor,obligation_unit,obligation_amount
    FROM payments.nowpayments_engine_obligation WHERE id=target_id;
  IF obligation_kind<>'binary_bonus' THEN RETURN NULL; END IF;
  SELECT COALESCE(sum(pv),0),COALESCE(sum(pv*commission_factor),0)
    INTO allocated_pv,weighted_pv FROM payments.compensation_binary_allocation WHERE obligation_id=target_id;
  IF allocated_pv<=0 OR obligation_unit IS NULL OR obligation_unit NOT IN(10,50)
     OR obligation_factor IS DISTINCT FROM round(weighted_pv/allocated_pv,6)
     OR obligation_amount IS DISTINCT FROM trunc(obligation_unit*weighted_pv/1000,2) THEN
    RAISE EXCEPTION 'compensation_binary_weighted_entitlement_mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER compensation_binary_obligation_allocation AFTER INSERT ON payments.nowpayments_engine_obligation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payments.check_compensation_binary_obligation();
CREATE CONSTRAINT TRIGGER compensation_binary_allocation_entitlement AFTER INSERT ON payments.compensation_binary_allocation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payments.check_compensation_binary_obligation();

-- Reporting lineage uses immutable typed identities, not a source's current
-- eligibility. A later risk hold does not relabel an already recorded origin.
CREATE VIEW payments.v_compensation_obligation_origin WITH(security_invoker=true,security_barrier=true) AS
SELECT e.id AS obligation_id,
  COALESCE(CASE
    WHEN e.kind='roi' THEN own_source.source_kind
    WHEN e.kind IN('direct_bonus','royalty') THEN earning_source.source_kind
    WHEN e.kind='binary_bonus' THEN CASE
      WHEN allocation.providers=1 THEN allocation.single_provider
      WHEN allocation.providers>1 THEN 'mixed'
      ELSE 'unattributed' END
    ELSE 'unattributed' END,'unattributed') AS source_provider
FROM payments.nowpayments_engine_obligation e
LEFT JOIN payments.compensation_source own_source ON own_source.id=e.source_attempt_id
LEFT JOIN payments.compensation_source earning_source ON earning_source.id=e.earning_source_id
LEFT JOIN LATERAL(SELECT count(DISTINCT s.source_kind) AS providers,min(s.source_kind) AS single_provider
  FROM payments.compensation_binary_allocation a JOIN payments.compensation_source s ON s.id=a.source_id
  WHERE a.obligation_id=e.id) allocation ON e.kind='binary_bonus';

-- Strip per-object default ACLs as well as PUBLIC. Do not alter account-wide
-- default privileges and do not grant runtime roles implicitly. The reviewed
-- runtime manifest must add ONLY SELECT/INSERT as explicitly required later.
DO $$
DECLARE obj record; grantee record;
BEGIN
  FOR obj IN SELECT c.oid,c.relowner,n.nspname,c.relname,c.relacl
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='payments' AND c.relname IN('manual_membership_order','compensation_source','v_compensation_source','compensation_binary_allocation','v_compensation_obligation_origin')
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM PUBLIC',obj.nspname,obj.relname);
    FOR grantee IN SELECT DISTINCT a.grantee FROM aclexplode(COALESCE(obj.relacl,acldefault('r',obj.relowner))) a
      WHERE a.grantee<>0 AND a.grantee<>obj.relowner
    LOOP
      EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM %I',obj.nspname,obj.relname,pg_get_userbyid(grantee.grantee));
    END LOOP;
  END LOOP;
  FOR obj IN SELECT p.oid,p.proowner,n.nspname,p.proname,p.proacl
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='payments' AND p.proname IN('protect_manual_membership_order','reject_compensation_source_mutation','classify_compensation_source','validate_compensation_binary_allocation','check_compensation_binary_block','check_compensation_binary_obligation','validate_compensation_obligation_earning_source')
      AND p.pronargs=0
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%I() FROM PUBLIC',obj.nspname,obj.proname);
    FOR grantee IN SELECT DISTINCT a.grantee FROM aclexplode(COALESCE(obj.proacl,acldefault('f',obj.proowner))) a
      WHERE a.grantee<>0 AND a.grantee<>obj.proowner
    LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %I.%I() FROM %I',obj.nspname,obj.proname,pg_get_userbyid(grantee.grantee));
    END LOOP;
  END LOOP;
END $$;

COMMENT ON TABLE payments.manual_membership_order IS
  'Operator-authorized real manual USD100/PV100 membership source; fee3%, net97%; no provider or auth evidence. Facts immutable; only one-way risk holds permitted.';
COMMENT ON TABLE payments.compensation_source IS
  'Immutable typed source registry; classification alone is not verified payment or engine eligibility. Existing NOW UUIDs preserved.';
COMMENT ON VIEW payments.v_compensation_source IS
  'Invoker validated NOW/manual sources for the scoped engine; excludes Stripe recovery and legacy PV. Invalid activated count mismatch must fail closed.';
COMMENT ON TABLE payments.compensation_binary_allocation IS
  'Append-only consumed PV lots per ancestor/block/leg; both legs exactly500 at commit; factors follow each source, never the beneficiary membership fee.';
COMMENT ON VIEW payments.v_compensation_obligation_origin IS
  'Actual earning origin: ROI own source, direct/royalty explicit causal sale, binary actual allocated lots; mixed/unattributed are never guessed from beneficiary membership.';
COMMIT;
