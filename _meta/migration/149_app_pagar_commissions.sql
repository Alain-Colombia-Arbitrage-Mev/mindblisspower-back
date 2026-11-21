-- Project posted Pagar commissions for their native-session owner.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';

DO $preflight$
BEGIN
  IF pg_catalog.current_database()<>'mindbliss_curated_20261025'
    OR pg_catalog.pg_is_in_recovery()
    OR pg_catalog.to_regprocedure('payments.read_app_pagar_benefits_v1(text,text)') IS NULL
    OR pg_catalog.to_regclass('payments.app_pagar_bonus_credit') IS NULL THEN
    RAISE EXCEPTION 'app_pagar_commissions_requires_review';
  END IF;
END $preflight$;

CREATE INDEX app_pagar_bonus_obligation_recipient_idx
  ON payments.app_pagar_bonus_obligation(recipient_affiliate_id) INCLUDE(kind,reference);

CREATE FUNCTION payments.read_app_pagar_commissions_v1(p_subject text,p_native_session text,p_before date)
RETURNS TABLE(virtual_balance_usd_minor text,periods jsonb,next_before text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
DECLARE v_person bigint;
BEGIN
  PERFORM identity.require_administrative_native_session(p_subject,p_native_session);
  v_person:=identity.administrative_wallet_person(p_subject);
  IF p_before IS NOT NULL AND (NOT pg_catalog.isfinite(p_before) OR extract(isodow FROM p_before)<>1) THEN
    RAISE EXCEPTION 'app_pagar_commissions_invalid_cursor' USING ERRCODE='22023';
  END IF;

  RETURN QUERY
    WITH owned_periods AS MATERIALIZED (
      SELECT c.week_end,sum(c.credited_usd_minor) AS total,
        coalesce(sum(c.credited_usd_minor) FILTER(WHERE c.kind='binary'),0) AS binary_total,
        coalesce(sum(c.credited_usd_minor) FILTER(WHERE c.kind='rank'),0) AS rank_total
      FROM mlm.affiliate a
      JOIN payments.app_pagar_bonus_obligation o ON o.recipient_affiliate_id=a.id
      JOIN payments.app_pagar_bonus_credit c USING(kind,reference)
      WHERE a.person_id=v_person
      GROUP BY c.week_end
    ), page AS (
      SELECT *,row_number() OVER(ORDER BY week_end DESC) AS row_number
      FROM owned_periods
      WHERE (p_before IS NULL OR week_end<p_before) AND (binary_total>0 OR rank_total>0)
      ORDER BY week_end DESC LIMIT 13
    )
    SELECT (SELECT coalesce(sum(owned_periods.total),0)::text FROM owned_periods),
      coalesce(jsonb_agg(jsonb_build_object('week_end',to_char(page.week_end,'YYYY-MM-DD'),
        'binary_usd_minor',page.binary_total::text,'rank_usd_minor',page.rank_total::text)
        ORDER BY page.week_end DESC) FILTER (WHERE page.row_number<=12),'[]'::jsonb),
      CASE WHEN count(*)=13 THEN to_char(min(page.week_end) FILTER(WHERE page.row_number<=12),'YYYY-MM-DD') END
    FROM page;
END $function$;

DO $permissions$
DECLARE v_owner name; v_grantee text;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(relowner) INTO STRICT v_owner
    FROM pg_catalog.pg_class WHERE oid='payments.app_pagar_bonus_obligation'::regclass;
  EXECUTE pg_catalog.format('ALTER FUNCTION payments.read_app_pagar_commissions_v1(text,text,date) OWNER TO %I',v_owner);
  FOR v_grantee IN
    SELECT DISTINCT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END
    FROM pg_catalog.pg_proc p,LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
    WHERE p.oid='payments.read_app_pagar_commissions_v1(text,text,date)'::regprocedure AND a.grantee<>p.proowner
  LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION payments.read_app_pagar_commissions_v1(text,text,date) FROM '||v_grantee;
  END LOOP;
  GRANT EXECUTE ON FUNCTION payments.read_app_pagar_commissions_v1(text,text,date) TO mindbliss_auth_core_v1;
END $permissions$;
COMMIT;
