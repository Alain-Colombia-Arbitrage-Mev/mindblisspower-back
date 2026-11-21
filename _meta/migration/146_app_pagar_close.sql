-- Fund the Pagar bonus close exclusively from confirmed Polygon treasury receipts.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app-pagar-economy-v1',0));

DO $preflight$
BEGIN
  IF pg_catalog.current_database()<>'mindbliss_curated_20261025'
    OR pg_catalog.pg_is_in_recovery()
    OR pg_catalog.to_regclass('payments.app_pagar_investment') IS NULL
    OR pg_catalog.to_regclass('payments.app_pagar_rank_entitlement') IS NULL
    OR pg_catalog.to_regclass('payments.app_pagar_bonus_period') IS NOT NULL THEN
    RAISE EXCEPTION 'app_pagar_close_requires_review';
  END IF;
END $preflight$;

CREATE TABLE payments.app_pagar_bonus_obligation (
  kind text NOT NULL CHECK(kind IN ('direct','binary','royalty','rank')),
  reference text NOT NULL CHECK(length(reference) BETWEEN 1 AND 160),
  recipient_affiliate_id bigint NOT NULL REFERENCES mlm.affiliate(id) ON DELETE RESTRICT,
  gross_usd_minor numeric(38,0) NOT NULL CHECK(gross_usd_minor>0),
  cap_payment_id uuid REFERENCES payments.app_pagar_investment(payment_id) ON DELETE RESTRICT,
  matched_pv numeric(24,0) NOT NULL DEFAULT 0 CHECK(matched_pv>=0),
  source_payment_id uuid REFERENCES payments.app_pagar_investment(payment_id) ON DELETE RESTRICT,
  identified_week date NOT NULL CHECK(pg_catalog.isfinite(identified_week) AND extract(isodow FROM identified_week)=1),
  PRIMARY KEY(kind,reference),
  CHECK((kind='binary' AND cap_payment_id IS NOT NULL AND matched_pv>0)
    OR (kind<>'binary' AND source_payment_id IS NOT NULL AND matched_pv=0))
);
CREATE INDEX app_pagar_binary_obligation_idx ON payments.app_pagar_bonus_obligation(recipient_affiliate_id,identified_week) WHERE kind='binary';
CREATE INDEX app_pagar_bonus_cap_payment_idx ON payments.app_pagar_bonus_obligation(cap_payment_id) WHERE cap_payment_id IS NOT NULL;

CREATE TABLE payments.app_pagar_bonus_period (
  week_end date PRIMARY KEY CHECK(pg_catalog.isfinite(week_end) AND extract(isodow FROM week_end)=1),
  closed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  treasury_token_atomic numeric(78,0) NOT NULL CHECK(treasury_token_atomic>=0),
  treasury_cap_usd_minor numeric(38,0) NOT NULL CHECK(treasury_cap_usd_minor>=0),
  roi_reserved_usd_minor numeric(38,0) NOT NULL CHECK(roi_reserved_usd_minor>=0),
  previous_bonus_usd_minor numeric(38,0) NOT NULL CHECK(previous_bonus_usd_minor>=0),
  eligible_usd_minor numeric(38,0) NOT NULL CHECK(eligible_usd_minor>=0),
  credited_usd_minor numeric(38,0) NOT NULL CHECK(credited_usd_minor>=0 AND credited_usd_minor<=eligible_usd_minor),
  CHECK(treasury_cap_usd_minor<=pg_catalog.div(treasury_token_atomic,10000::numeric)),
  CHECK(credited_usd_minor<=greatest(0,treasury_cap_usd_minor-roi_reserved_usd_minor-previous_bonus_usd_minor))
);

CREATE TABLE payments.app_pagar_bonus_credit (
  week_end date NOT NULL REFERENCES payments.app_pagar_bonus_period(week_end) ON DELETE RESTRICT,
  kind text NOT NULL,
  reference text NOT NULL,
  credited_usd_minor numeric(38,0) NOT NULL CHECK(credited_usd_minor>0),
  PRIMARY KEY(week_end,kind,reference),
  FOREIGN KEY(kind,reference) REFERENCES payments.app_pagar_bonus_obligation(kind,reference) ON DELETE RESTRICT
);
CREATE INDEX app_pagar_bonus_credit_obligation_idx ON payments.app_pagar_bonus_credit(kind,reference);

-- Promoted by the authenticated MELD risk-review migration. Unreviewed funds
-- cannot be credited when migrations are applied or rolled back separately.
CREATE FUNCTION payments.app_pagar_close_sources_ready_v1(p_before timestamptz)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $function$ SELECT false $function$;

CREATE FUNCTION payments.app_pagar_binary_available_caps_v1()
RETURNS TABLE(payment_id uuid,cap_remaining numeric,roi_reserved_usd_minor numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
  WITH paid AS (
    SELECT o.cap_payment_id,sum(c.credited_usd_minor) AS amount
    FROM payments.app_pagar_bonus_obligation o
    JOIN payments.app_pagar_bonus_credit c USING(kind,reference)
    WHERE o.kind='binary' GROUP BY o.cap_payment_id
  ), reserves AS (
    -- Reserve maximum lifetime ROI, including the remaining qualified days.
    SELECT i.payment_id,i.lifetime_cap_minor,least(i.lifetime_cap_minor,
      pg_catalog.div(c.cumulative_rate_days+i.gross_usd_minor*i.qualified_annual_rate
        *greatest(0,(i.matures_at AT TIME ZONE 'America/Bogota')::date-c.next_day+1),365::numeric)) AS roi_reserved
    FROM payments.app_pagar_investment i JOIN payments.app_pagar_roi_cursor c USING(payment_id)
  )
  SELECT r.payment_id,greatest(0,r.lifetime_cap_minor-coalesce(p.amount,0)-r.roi_reserved),r.roi_reserved
  FROM reserves r LEFT JOIN paid p ON p.cap_payment_id=r.payment_id;
$function$;

CREATE FUNCTION payments.run_app_pagar_close_v1()
RETURNS TABLE(closed_weeks integer,credited_rows integer,credited_usd_minor text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='15s' AS $function$
DECLARE
  v_horizon date:=date_trunc('week',(pg_catalog.clock_timestamp() AT TIME ZONE 'America/Bogota')-interval '30 minutes')::date;
  v_week date;
  v_before timestamptz;
  v_treasury numeric;
  v_cap numeric;
  v_invalid_policy boolean;
  v_roi numeric;
  v_previous numeric;
  v_awarded numeric;
BEGIN
  closed_weeks:=0;
  credited_rows:=0;
  credited_usd_minor:='0';
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('app-pagar-economy-v1',0)) THEN
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT max(w.week_end)+7 INTO v_week FROM payments.app_pagar_bonus_period w;
  IF v_week IS NULL THEN
    SELECT date_trunc('week',min(i.activated_at) AT TIME ZONE 'America/Bogota')::date+7
    INTO v_week FROM payments.app_pagar_investment i;
  END IF;
  IF v_week IS NULL OR v_week>v_horizon THEN
    RETURN NEXT;
    RETURN;
  END IF;

  v_before:=v_week::timestamp AT TIME ZONE 'America/Bogota';
  IF payments.app_pagar_close_sources_ready_v1(v_before) IS DISTINCT FROM true OR EXISTS (
    SELECT 1 FROM payments.app_pagar_investment i
    LEFT JOIN payments.app_pagar_roi_cursor c USING(payment_id)
    WHERE i.activated_at<v_before AND (c.payment_id IS NULL OR c.next_day<=v_week)
      AND NOT EXISTS(SELECT 1 FROM payments.app_pagar_economic_hold h WHERE h.payment_id=i.payment_id)
  ) THEN
    RETURN NEXT;
    RETURN;
  END IF;

  -- 6 token decimals, 2 USD decimals. No floats and no assumed MELD fee.
  -- Credit the actual Pagar receipt once, with the alpha from its own plan.
  WITH cash AS (
    SELECT r.treasury_received_atomic AS atoms,
      CASE WHEN pg_catalog.jsonb_typeof(i.plan_snapshot->'treasury_alpha')='number'
        THEN (i.plan_snapshot->>'treasury_alpha')::numeric END AS alpha
    FROM payments.app_pagar_investment i JOIN payments.app_pagar_accounting_receipt r USING(payment_id)
    WHERE i.activated_at<v_before AND r.confirmed_at<v_before
      AND NOT EXISTS(SELECT 1 FROM payments.app_pagar_economic_hold h WHERE h.payment_id=i.payment_id)
  )
  SELECT coalesce(sum(atoms),0),coalesce(pg_catalog.div(sum(atoms*alpha),10000::numeric),0),
    coalesce(bool_or(alpha IS NULL OR alpha NOT BETWEEN 0 AND 1),false)
  INTO v_treasury,v_cap,v_invalid_policy FROM cash;
  IF v_invalid_policy THEN RAISE EXCEPTION 'app_pagar_close_invalid_treasury_policy'; END IF;

  -- Bonuses can only use cash left after both posted and maximum future ROI.
  SELECT coalesce(sum(c.roi_reserved_usd_minor),0) INTO v_roi
  FROM payments.app_pagar_binary_available_caps_v1() c JOIN payments.app_pagar_investment i USING(payment_id)
  WHERE i.activated_at<v_before
    AND NOT EXISTS(SELECT 1 FROM payments.app_pagar_economic_hold h WHERE h.payment_id=i.payment_id);
  SELECT coalesce(sum(c.credited_usd_minor),0) INTO v_previous FROM payments.app_pagar_bonus_credit c;

  -- The producer is private and fills the independent direct/binary/royalty/rank snapshot.
  -- Persist the immutable claims and credits together, including first-seen claims.
  WITH supplied AS MATERIALIZED (
    SELECT c.*, count(*) OVER(PARTITION BY c.kind,c.reference) AS duplicates
    FROM payments.app_pagar_bonus_candidates_v1(v_week) c
  ), eligible AS MATERIALIZED (
    SELECT c.kind,c.reference,c.recipient_affiliate_id,c.gross_usd_minor,c.cap_payment_id,
      coalesce(c.matched_pv,0) AS matched_pv,c.source_payment_id
    FROM supplied c
    JOIN mlm.affiliate a ON a.id=c.recipient_affiliate_id AND a.status::text='active' AND a.parent_id IS NOT NULL
    WHERE c.duplicates=1 AND c.gross_usd_minor>0 AND c.gross_usd_minor=trunc(c.gross_usd_minor)
      AND (c.source_payment_id IS NULL OR EXISTS(
        SELECT 1 FROM payments.app_pagar_investment i WHERE i.payment_id=c.source_payment_id AND i.activated_at<v_before
          AND NOT EXISTS(SELECT 1 FROM payments.app_pagar_economic_hold h WHERE h.payment_id=i.payment_id)
      ))
      AND (c.cap_payment_id IS NULL OR EXISTS(
        SELECT 1 FROM payments.app_pagar_investment i WHERE i.payment_id=c.cap_payment_id
          AND i.affiliate_id=c.recipient_affiliate_id AND i.activated_at<v_before
          AND NOT EXISTS(SELECT 1 FROM payments.app_pagar_economic_hold h WHERE h.payment_id=i.payment_id)
      ))
  ), admitted AS (
    INSERT INTO payments.app_pagar_bonus_obligation(kind,reference,recipient_affiliate_id,gross_usd_minor,
      cap_payment_id,matched_pv,source_payment_id,identified_week)
    SELECT c.kind,c.reference,c.recipient_affiliate_id,c.gross_usd_minor,c.cap_payment_id,c.matched_pv,c.source_payment_id,v_week
    FROM eligible c ORDER BY c.kind,c.reference
    ON CONFLICT(kind,reference) DO NOTHING
    RETURNING *
  ), open AS (
    SELECT * FROM admitted
    UNION ALL
    SELECT o.* FROM payments.app_pagar_bonus_obligation o JOIN eligible c USING(kind,reference)
    WHERE ROW(o.recipient_affiliate_id,o.gross_usd_minor,o.cap_payment_id,o.matched_pv,o.source_payment_id)
      IS NOT DISTINCT FROM ROW(c.recipient_affiliate_id,c.gross_usd_minor,c.cap_payment_id,c.matched_pv,c.source_payment_id)
  ), prior AS (
    SELECT c.kind,c.reference,sum(c.credited_usd_minor) AS amount
    FROM payments.app_pagar_bonus_credit c GROUP BY c.kind,c.reference
  ), uncapped AS (
    SELECT o.*, greatest(0,o.gross_usd_minor-coalesce(p.amount,0)) AS outstanding,
      coalesce(a.cap_remaining,0) AS cap_remaining
    FROM open o LEFT JOIN prior p USING(kind,reference)
    LEFT JOIN payments.app_pagar_binary_available_caps_v1() a ON a.payment_id=o.cap_payment_id
  ), bounded AS (
    SELECT u.kind,u.reference, CASE WHEN u.kind='binary' THEN
      least(u.outstanding,greatest(0,u.cap_remaining-coalesce(
        sum(u.outstanding) FILTER(WHERE u.kind='binary') OVER(
          PARTITION BY u.cap_payment_id ORDER BY u.identified_week,u.reference,u.kind
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)))
      ELSE u.outstanding END AS permitted
    FROM uncapped u
  ), totals AS (
    SELECT coalesce(sum(b.permitted),0) AS due,
      least(greatest(0,v_cap-v_roi-v_previous),coalesce(sum(b.permitted),0)) AS budget
    FROM bounded b
  ), shares AS (
    -- Exact integer-cent theta. A stable largest remainder order preserves
    -- leftover cents, total funding and lifetime caps for small budgets.
    SELECT b.kind,b.reference,t.budget,
      pg_catalog.div(b.permitted*t.budget,nullif(t.due,0)) AS portion,
      mod(b.permitted*t.budget,nullif(t.due,0)) AS remainder
    FROM bounded b CROSS JOIN totals t
    WHERE b.permitted>0 AND t.due>0 AND t.budget>0
  ), awards AS MATERIALIZED (
    SELECT p.kind,p.reference,p.portion+CASE WHEN
      row_number() OVER(ORDER BY p.remainder DESC,p.kind,p.reference)<=p.budget-sum(p.portion) OVER()
      THEN 1 ELSE 0 END AS amount
    FROM shares p
  ), period AS (
    INSERT INTO payments.app_pagar_bonus_period(week_end,treasury_token_atomic,treasury_cap_usd_minor,
      roi_reserved_usd_minor,previous_bonus_usd_minor,eligible_usd_minor,credited_usd_minor)
    SELECT v_week,v_treasury,v_cap,v_roi,v_previous,t.due,coalesce((SELECT sum(a.amount) FROM awards a),0)
    FROM totals t RETURNING week_end
  ), credited AS (
    INSERT INTO payments.app_pagar_bonus_credit AS inserted(week_end,kind,reference,credited_usd_minor)
    SELECT p.week_end,a.kind,a.reference,a.amount FROM awards a CROSS JOIN period p WHERE a.amount>0
    RETURNING inserted.credited_usd_minor
  )
  SELECT count(*)::integer,coalesce(sum(c.credited_usd_minor),0) INTO credited_rows,v_awarded FROM credited c;
  closed_weeks:=1;
  credited_usd_minor:=v_awarded::text;
  RETURN NEXT;
END $function$;

DO $permissions$
DECLARE v_owner name; v_role text; v_signature text; v_relation text;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(c.relowner) INTO STRICT v_owner
    FROM pg_catalog.pg_class c WHERE c.oid='payments.app_pagar_accounting_receipt'::regclass;
  FOREACH v_relation IN ARRAY ARRAY['app_pagar_bonus_obligation','app_pagar_bonus_period','app_pagar_bonus_credit'] LOOP
    EXECUTE pg_catalog.format('ALTER TABLE payments.%I ENABLE ROW LEVEL SECURITY',v_relation);
    EXECUTE pg_catalog.format('CREATE TRIGGER app_pagar_close_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON payments.%I FOR EACH STATEMENT EXECUTE FUNCTION payments.reject_app_pagar_accounting_mutation()',v_relation);
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
      RAISE EXCEPTION 'app_pagar_close_permissions_changed';
    END IF;
  END LOOP;
  FOREACH v_signature IN ARRAY ARRAY['payments.app_pagar_close_sources_ready_v1(timestamptz)',
    'payments.app_pagar_binary_available_caps_v1()','payments.run_app_pagar_close_v1()'] LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO %I',v_signature,v_owner);
    FOR v_role IN
      SELECT DISTINCT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END
      FROM pg_catalog.pg_proc p,LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      WHERE p.oid=v_signature::regprocedure AND a.grantee<>p.proowner
    LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION '||v_signature||' FROM '||v_role;
    END LOOP;
  END LOOP;
  GRANT EXECUTE ON FUNCTION payments.run_app_pagar_close_v1() TO mindbliss_auth_core_v1;
  IF pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.app_pagar_binary_available_caps_v1()','EXECUTE') THEN
    RAISE EXCEPTION 'app_pagar_close_permissions_changed';
  END IF;
END $permissions$;
COMMIT;
