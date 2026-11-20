-- Only the App Pagar source funds and activates this independent investment ledger.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app-pagar-roi-143',0));

DO $preflight$
BEGIN
  IF pg_catalog.current_database()<>'mindbliss_curated_20261025'
    OR pg_catalog.pg_is_in_recovery()
    OR pg_catalog.to_regclass('payments.app_pagar_accounting_receipt') IS NULL
    OR pg_catalog.to_regprocedure('identity.member_referral_person_eligible(bigint)') IS NULL THEN
    RAISE EXCEPTION 'app_pagar_roi_requires_review';
  END IF;
END $preflight$;

CREATE TABLE payments.app_pagar_investment (
  payment_id uuid PRIMARY KEY REFERENCES payments.app_pagar_accounting_receipt(payment_id) ON DELETE RESTRICT,
  subject text NOT NULL,
  person_id bigint NOT NULL REFERENCES mlm.person(id) ON DELETE RESTRICT,
  affiliate_id bigint REFERENCES mlm.affiliate(id) ON DELETE RESTRICT,
  gross_usd_minor numeric(24,0) NOT NULL CHECK(gross_usd_minor>0),
  treasury_net_atomic numeric(78,0) NOT NULL CHECK(treasury_net_atomic>0),
  pv_delta numeric(24,0) NOT NULL CHECK(pv_delta>=0),
  package_level smallint NOT NULL CHECK(package_level BETWEEN 1 AND 8),
  plan_config_id bigint NOT NULL REFERENCES mlm.plan_config(id) ON DELETE RESTRICT,
  plan_snapshot jsonb NOT NULL CHECK(pg_catalog.jsonb_typeof(plan_snapshot)='object'),
  roi_tier_id smallint NOT NULL REFERENCES mlm.cd_roi_tier(id) ON DELETE RESTRICT,
  base_annual_rate numeric(8,4) NOT NULL CHECK(base_annual_rate BETWEEN 0 AND 1),
  qualified_annual_rate numeric(8,4) NOT NULL CHECK(qualified_annual_rate BETWEEN base_annual_rate AND 1),
  lifetime_cap_minor numeric(24,0) NOT NULL CHECK(lifetime_cap_minor>0),
  starts_at timestamptz NOT NULL CHECK(pg_catalog.isfinite(starts_at)),
  matures_at timestamptz NOT NULL CHECK(pg_catalog.isfinite(matures_at) AND matures_at>starts_at),
  activated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE INDEX app_pagar_investment_subject_idx ON payments.app_pagar_investment(subject,starts_at);
CREATE INDEX app_pagar_investment_affiliate_idx ON payments.app_pagar_investment(affiliate_id,starts_at);
CREATE INDEX app_pagar_accounting_receipt_posted_idx ON payments.app_pagar_accounting_receipt(posted_at,payment_id);

CREATE TABLE payments.app_pagar_economic_hold (
  payment_id uuid PRIMARY KEY REFERENCES payments.app_pagar_accounting_receipt(payment_id) ON DELETE RESTRICT,
  held_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE payments.app_pagar_roi_cursor (
  payment_id uuid PRIMARY KEY REFERENCES payments.app_pagar_investment(payment_id) ON DELETE RESTRICT,
  next_day date,
  cumulative_rate_days numeric(38,4) NOT NULL DEFAULT 0 CHECK(cumulative_rate_days>=0),
  accrued_usd_minor numeric(24,0) NOT NULL DEFAULT 0 CHECK(accrued_usd_minor>=0)
);
CREATE INDEX app_pagar_roi_due_idx ON payments.app_pagar_roi_cursor(next_day,payment_id) WHERE next_day IS NOT NULL;

CREATE TABLE payments.app_pagar_roi_day (
  payment_id uuid NOT NULL REFERENCES payments.app_pagar_investment(payment_id) ON DELETE RESTRICT,
  cutoff_day date NOT NULL,
  annual_rate numeric(8,4) NOT NULL CHECK(annual_rate BETWEEN 0 AND 1),
  qualifying_directs boolean NOT NULL,
  accrued_usd_minor numeric(24,0) NOT NULL CHECK(accrued_usd_minor>=0),
  available_at timestamptz NOT NULL,
  PRIMARY KEY(payment_id,cutoff_day)
);

-- Call only after an authenticated provider reread reports a terminal failure
-- for a matched lot. Once held, the same receipt remains held on retries.
CREATE FUNCTION payments.hold_app_pagar_economic_receipt_v1(p_subject text,p_payment uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app-pagar-economy-v1',0));
  INSERT INTO payments.app_pagar_economic_hold(payment_id)
    SELECT r.payment_id FROM payments.app_pagar_accounting_receipt r
    WHERE r.payment_id=p_payment AND r.subject=p_subject
    ON CONFLICT DO NOTHING;
  RETURN EXISTS(
    SELECT 1 FROM payments.app_pagar_economic_hold h JOIN payments.app_pagar_accounting_receipt r USING(payment_id)
    WHERE h.payment_id=p_payment AND r.subject=p_subject
  );
END $function$;

CREATE FUNCTION payments.run_app_pagar_roi_v1()
RETURNS TABLE(activated integer,accrued_days integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
DECLARE
  v_now timestamptz:=pg_catalog.clock_timestamp();
  v_cutoff date:=((v_now AT TIME ZONE 'America/Bogota')-interval '30 minutes')::date;
  v_due record;
  v_through date;
  v_cutoff_at timestamptz;
  v_qualified boolean;
  v_rate numeric;
  v_rate_days numeric;
  v_total numeric;
BEGIN
  activated:=0;
  accrued_days:=0;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('app-pagar-economy-v1',0)) THEN
    RETURN NEXT;
    RETURN;
  END IF;

  WITH eligible AS (
    SELECT r.*,p.id AS person_id,a.id AS affiliate_id,pl.id AS plan_id,pl.snapshot,
      pl.cd_lock_days,pl.lifetime_cap_factor,rt.id AS tier_id,rt.base_annual_rate,rt.qualified_annual_rate
    FROM payments.app_pagar_accounting_receipt r
    JOIN auth."user" u ON u.id=r.subject AND u.email_verified
    JOIN identity.auth_binding b ON b.subject=u.id AND b.provider='better_auth'
    JOIN mlm.person p ON p.id=b.person_id AND p.user_id=u.id
      AND lower(btrim(u.email))=lower(btrim(p.email::text)) AND p.public_id IS NOT NULL
    LEFT JOIN mlm.affiliate a ON a.person_id=p.id AND a.status::text='active'
    JOIN LATERAL (
      SELECT c.id,c.cd_lock_days,c.lifetime_cap_factor,pg_catalog.to_jsonb(c) AS snapshot,count(*) OVER() AS matches
      FROM mlm.plan_config c WHERE c.effective_from<=r.confirmed_at
        AND (c.effective_to IS NULL OR c.effective_to>r.confirmed_at)
    ) pl ON pl.matches=1 AND pl.cd_lock_days BETWEEN 1 AND 36500
      AND pg_catalog.floor(r.gross_usd_minor*pl.lifetime_cap_factor)>0
    JOIN LATERAL (
      SELECT t.id,t.base_annual_rate,t.qualified_annual_rate,count(*) OVER() AS matches
      FROM mlm.cd_roi_tier t WHERE t.active AND t.min_amount_usd<=r.gross_usd_minor/100
        AND (t.max_amount_usd IS NULL OR t.max_amount_usd>r.gross_usd_minor/100)
    ) rt ON rt.matches=1 AND rt.base_annual_rate BETWEEN 0 AND 1
      AND rt.qualified_annual_rate BETWEEN rt.base_annual_rate AND 1
    WHERE r.confirmed_at<=v_now AND identity.member_referral_person_eligible(p.id)
      AND NOT EXISTS(SELECT 1 FROM payments.app_pagar_investment i WHERE i.payment_id=r.payment_id)
      AND NOT EXISTS(SELECT 1 FROM payments.app_pagar_economic_hold h WHERE h.payment_id=r.payment_id)
    ORDER BY r.posted_at,r.payment_id LIMIT 20
  ), created AS (
    INSERT INTO payments.app_pagar_investment(payment_id,subject,person_id,affiliate_id,gross_usd_minor,
      treasury_net_atomic,pv_delta,package_level,plan_config_id,plan_snapshot,roi_tier_id,base_annual_rate,
      qualified_annual_rate,lifetime_cap_minor,starts_at,matures_at)
    SELECT e.payment_id,e.subject,e.person_id,e.affiliate_id,e.gross_usd_minor,e.allocated_received_atomic,e.pv_delta,
      CASE WHEN e.cumulative_gross_usd_minor<=5000 THEN 1 WHEN e.cumulative_gross_usd_minor<=10000 THEN 2
        WHEN e.cumulative_gross_usd_minor<=25000 THEN 3 WHEN e.cumulative_gross_usd_minor<=50000 THEN 4
        WHEN e.cumulative_gross_usd_minor<=100000 THEN 5 WHEN e.cumulative_gross_usd_minor<=250000 THEN 6
        WHEN e.cumulative_gross_usd_minor<=1000000 THEN 7 ELSE 8 END,
      e.plan_id,e.snapshot,e.tier_id,e.base_annual_rate,e.qualified_annual_rate,
      pg_catalog.floor(e.gross_usd_minor*e.lifetime_cap_factor),e.confirmed_at,
      ((e.confirmed_at AT TIME ZONE 'America/Bogota')+pg_catalog.make_interval(days=>e.cd_lock_days)) AT TIME ZONE 'America/Bogota'
    FROM eligible e
    ON CONFLICT DO NOTHING RETURNING payment_id,starts_at
  )
  INSERT INTO payments.app_pagar_roi_cursor(payment_id,next_day)
    SELECT c.payment_id,(c.starts_at AT TIME ZONE 'America/Bogota')::date+1 FROM created c;
  GET DIAGNOSTICS activated=ROW_COUNT;

  FOR v_due IN
    SELECT i.*,c.next_day,c.cumulative_rate_days,c.accrued_usd_minor
    FROM payments.app_pagar_roi_cursor c JOIN payments.app_pagar_investment i USING(payment_id)
    WHERE c.next_day<=v_cutoff
      AND NOT EXISTS(SELECT 1 FROM payments.app_pagar_economic_hold h WHERE h.payment_id=c.payment_id)
    ORDER BY c.next_day,c.payment_id LIMIT 20
  LOOP
    v_through:=(v_due.matures_at AT TIME ZONE 'America/Bogota')::date;
    v_cutoff_at:=(v_due.next_day::timestamp+interval '30 minutes') AT TIME ZONE 'America/Bogota';
    SELECT count(DISTINCT a.id) FILTER(WHERE leg.position::text='L')>0
      AND count(DISTINCT a.id) FILTER(WHERE leg.position::text='R')>0
      AND count(DISTINCT a.id)>=(v_due.plan_snapshot->>'cd_qualified_directs')::integer
    INTO v_qualified
    FROM mlm.affiliate a
    JOIN mlm.affiliate leg ON leg.parent_id=v_due.affiliate_id
    JOIN mlm.affiliate_closure ac ON ac.ancestor_id=leg.id AND ac.descendant_id=a.id
    JOIN payments.app_pagar_investment d ON d.affiliate_id=a.id
    WHERE a.sponsor_id=v_due.affiliate_id AND a.status::text='active'
      AND d.starts_at<v_cutoff_at AND d.matures_at>v_cutoff_at
      AND ((v_due.plan_snapshot->>'cd_same_tier_required')::boolean=false OR d.roi_tier_id>=v_due.roi_tier_id)
      AND NOT EXISTS(SELECT 1 FROM payments.app_pagar_economic_hold h WHERE h.payment_id=d.payment_id);
    v_qualified:=coalesce(v_qualified,false);
    v_rate:=CASE WHEN v_qualified THEN v_due.qualified_annual_rate ELSE v_due.base_annual_rate END;
    v_rate_days:=v_due.cumulative_rate_days+v_due.gross_usd_minor*v_rate;
    v_total:=least(v_due.lifetime_cap_minor,pg_catalog.div(v_rate_days,365::numeric));
    INSERT INTO payments.app_pagar_roi_day(payment_id,cutoff_day,annual_rate,qualifying_directs,accrued_usd_minor,available_at)
      VALUES(v_due.payment_id,v_due.next_day,v_rate,v_qualified,v_total-v_due.accrued_usd_minor,v_due.matures_at);
    UPDATE payments.app_pagar_roi_cursor c
      SET next_day=CASE WHEN v_due.next_day<v_through THEN v_due.next_day+1 END,
        cumulative_rate_days=v_rate_days,accrued_usd_minor=v_total
      WHERE c.payment_id=v_due.payment_id;
    accrued_days:=accrued_days+1;
  END LOOP;
  RETURN NEXT;
END $function$;

DO $permissions$
DECLARE v_owner name; v_role text; v_signature text; v_relation text;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(c.relowner) INTO STRICT v_owner
    FROM pg_catalog.pg_class c WHERE c.oid='payments.app_pagar_accounting_receipt'::regclass;
  EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA auth,identity,mlm TO %I',v_owner);
  EXECUTE pg_catalog.format('GRANT SELECT(id,email,email_verified) ON auth."user" TO %I',v_owner);
  EXECUTE pg_catalog.format('GRANT SELECT(subject,provider,person_id) ON identity.auth_binding TO %I',v_owner);
  EXECUTE pg_catalog.format('GRANT SELECT(id,user_id,email,public_id) ON mlm.person TO %I',v_owner);
  EXECUTE pg_catalog.format('GRANT SELECT(id,person_id,status,parent_id,sponsor_id,position) ON mlm.affiliate TO %I',v_owner);
  EXECUTE pg_catalog.format('GRANT SELECT(ancestor_id,descendant_id) ON mlm.affiliate_closure TO %I',v_owner);
  EXECUTE pg_catalog.format('GRANT SELECT ON mlm.plan_config,mlm.cd_roi_tier TO %I',v_owner);
  EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION identity.member_referral_person_eligible(bigint) TO %I',v_owner);
  FOREACH v_relation IN ARRAY ARRAY['app_pagar_investment','app_pagar_economic_hold','app_pagar_roi_cursor','app_pagar_roi_day'] LOOP
    EXECUTE pg_catalog.format('ALTER TABLE payments.%I ENABLE ROW LEVEL SECURITY',v_relation);
    IF v_relation<>'app_pagar_roi_cursor' THEN
      EXECUTE pg_catalog.format('CREATE TRIGGER app_pagar_roi_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON payments.%I FOR EACH STATEMENT EXECUTE FUNCTION payments.reject_app_pagar_accounting_mutation()',v_relation);
    END IF;
    EXECUTE pg_catalog.format('ALTER TABLE payments.%I OWNER TO %I',v_relation,v_owner);
    FOR v_role IN
      SELECT DISTINCT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END
      FROM pg_catalog.pg_class c,LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE c.relnamespace='payments'::regnamespace AND c.relname=v_relation AND a.grantee<>c.relowner
    LOOP
      EXECUTE pg_catalog.format('REVOKE ALL ON TABLE payments.%I FROM %s',v_relation,v_role);
    END LOOP;
    IF pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.'||v_relation,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION 'app_pagar_roi_permissions_changed';
    END IF;
  END LOOP;
  FOREACH v_signature IN ARRAY ARRAY['payments.run_app_pagar_roi_v1()','payments.hold_app_pagar_economic_receipt_v1(text,uuid)'] LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO %I',v_signature,v_owner);
    FOR v_role IN
      SELECT DISTINCT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END
      FROM pg_catalog.pg_proc p,LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      WHERE p.oid=v_signature::regprocedure AND a.grantee<>p.proowner
    LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION '||v_signature||' FROM '||v_role;
    END LOOP;
    EXECUTE 'GRANT EXECUTE ON FUNCTION '||v_signature||' TO mindbliss_auth_core_v1';
  END LOOP;
END $permissions$;
COMMIT;
