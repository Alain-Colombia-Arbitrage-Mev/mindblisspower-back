-- Pagar-only one-time rank prizes awaiting an independent funded close.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app-pagar-economy-v1',0));

DO $preflight$
BEGIN
  IF pg_catalog.current_database()<>'mindbliss_curated_20261025'
    OR pg_catalog.pg_is_in_recovery()
    OR pg_catalog.to_regclass('payments.app_pagar_pv_leg') IS NULL
    OR pg_catalog.to_regclass('payments.app_pagar_rank_entitlement') IS NOT NULL THEN
    RAISE EXCEPTION 'app_pagar_rank_requires_review';
  END IF;
  LOCK TABLE payments.app_pagar_pv_leg IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS(SELECT 1 FROM payments.app_pagar_pv_leg) THEN
    RAISE EXCEPTION 'app_pagar_rank_requires_review';
  END IF;
END $preflight$;

CREATE TABLE payments.app_pagar_rank_entitlement (
  affiliate_id bigint NOT NULL CHECK(affiliate_id>0),
  rank_id smallint NOT NULL CHECK(rank_id>0),
  rank_code text NOT NULL CHECK(length(rank_code) BETWEEN 1 AND 64),
  payment_id uuid NOT NULL,
  points_required numeric(24,2) NOT NULL CHECK(points_required>0),
  left_pv numeric(24,0) NOT NULL CHECK(left_pv>=points_required),
  right_pv numeric(24,0) NOT NULL CHECK(right_pv>=points_required),
  prize_usd_minor numeric(24,0) NOT NULL CHECK(prize_usd_minor>0),
  earned_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp() CHECK(pg_catalog.isfinite(earned_at)),
  PRIMARY KEY(affiliate_id,rank_id),
  FOREIGN KEY(payment_id,affiliate_id) REFERENCES payments.app_pagar_pv_leg(payment_id,affiliate_id) ON DELETE RESTRICT
);
CREATE INDEX app_pagar_rank_entitlement_payment_idx ON payments.app_pagar_rank_entitlement(payment_id,affiliate_id);

ALTER TABLE payments.app_pagar_rank_entitlement ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER app_pagar_rank_entitlement_retained BEFORE UPDATE OR DELETE OR TRUNCATE
  ON payments.app_pagar_rank_entitlement FOR EACH STATEMENT
  EXECUTE FUNCTION payments.reject_app_pagar_accounting_mutation();

CREATE FUNCTION payments.record_app_pagar_rank_entitlements_v1()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
BEGIN
  -- Admission, holds and rank qualification use one financial writer lock.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app-pagar-economy-v1',0));
  IF EXISTS(SELECT 1 FROM payments.app_pagar_economic_hold h WHERE h.payment_id=NEW.payment_id)
    OR NOT EXISTS(SELECT 1 FROM mlm.affiliate a WHERE a.id=NEW.affiliate_id
      AND a.status::text='active' AND a.parent_id IS NOT NULL) THEN
    RETURN NEW;
  END IF;

  WITH totals AS (
    SELECT coalesce(sum(s.pv_delta) FILTER(WHERE l.leg='L'),0) AS left_pv,
      coalesce(sum(s.pv_delta) FILTER(WHERE l.leg='R'),0) AS right_pv
    FROM payments.app_pagar_pv_leg l
    JOIN payments.app_pagar_pv_source s USING(payment_id)
    WHERE l.affiliate_id=NEW.affiliate_id
      AND NOT EXISTS(SELECT 1 FROM payments.app_pagar_economic_hold h WHERE h.payment_id=l.payment_id)
  )
  INSERT INTO payments.app_pagar_rank_entitlement(affiliate_id,rank_id,rank_code,payment_id,
    points_required,left_pv,right_pv,prize_usd_minor)
  SELECT NEW.affiliate_id,r.id,r.code,NEW.payment_id,
    r.required_points,t.left_pv,t.right_pv,r.bonus_amount_usd*100
  FROM totals t JOIN mlm.rank r ON least(t.left_pv,t.right_pv)>=r.required_points
  WHERE r.id>0 AND r.required_points>0 AND r.bonus_amount_usd>0
    AND r.bonus_amount_usd=round(r.bonus_amount_usd,2)
  ORDER BY r.required_points,r.id
  ON CONFLICT(affiliate_id,rank_id) DO NOTHING;

  RETURN NEW;
END $function$;

CREATE TRIGGER app_pagar_pv_leg_rank_entitlements AFTER INSERT ON payments.app_pagar_pv_leg
  FOR EACH ROW EXECUTE FUNCTION payments.record_app_pagar_rank_entitlements_v1();

CREATE FUNCTION payments.read_app_pagar_rank_entitlements_v1(p_subject text,p_native_session text)
RETURNS TABLE(rank_id smallint,rank_code text,prize_usd_minor text,status text,earned_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
DECLARE v_person bigint; v_left numeric; v_right numeric;
BEGIN
  SELECT p.left_pv::numeric,p.right_pv::numeric INTO v_left,v_right
    FROM payments.read_app_pagar_points_v1(p_subject,p_native_session) p;
  v_person:=identity.administrative_wallet_person(p_subject);

  RETURN QUERY
    SELECT r.rank_id,r.rank_code,r.prize_usd_minor::text,
      CASE WHEN least(v_left,v_right)>=r.points_required THEN 'pending_close'::text ELSE 'review'::text END,
      r.earned_at
    FROM mlm.affiliate a JOIN payments.app_pagar_rank_entitlement r ON r.affiliate_id=a.id
    WHERE a.person_id=v_person AND a.status::text='active' AND a.parent_id IS NOT NULL
    ORDER BY r.points_required,r.rank_id;
END $function$;

DO $permissions$
DECLARE v_owner name; v_role text; v_signature text;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(c.relowner) INTO STRICT v_owner
    FROM pg_catalog.pg_class c WHERE c.oid='payments.app_pagar_pv_source'::regclass;
  EXECUTE pg_catalog.format('GRANT SELECT(id,code,required_points,bonus_amount_usd) ON mlm.rank TO %I',v_owner);
  EXECUTE pg_catalog.format('ALTER TABLE payments.app_pagar_rank_entitlement OWNER TO %I',v_owner);
  FOR v_role IN
    SELECT DISTINCT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END
    FROM pg_catalog.pg_class c,LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
    WHERE c.oid='payments.app_pagar_rank_entitlement'::regclass AND a.grantee<>c.relowner
  LOOP
    EXECUTE 'REVOKE ALL ON TABLE payments.app_pagar_rank_entitlement FROM '||v_role;
  END LOOP;
  FOREACH v_signature IN ARRAY ARRAY['payments.record_app_pagar_rank_entitlements_v1()','payments.read_app_pagar_rank_entitlements_v1(text,text)'] LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO %I',v_signature,v_owner);
    FOR v_role IN
      SELECT DISTINCT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END
      FROM pg_catalog.pg_proc p,LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      WHERE p.oid=v_signature::regprocedure AND a.grantee<>p.proowner
    LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION '||v_signature||' FROM '||v_role;
    END LOOP;
  END LOOP;

  GRANT EXECUTE ON FUNCTION payments.read_app_pagar_rank_entitlements_v1(text,text) TO mindbliss_auth_core_v1;
  IF pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.app_pagar_rank_entitlement','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.record_app_pagar_rank_entitlements_v1()','EXECUTE') THEN
    RAISE EXCEPTION 'app_pagar_rank_permissions_changed';
  END IF;
END $permissions$;
COMMIT;
