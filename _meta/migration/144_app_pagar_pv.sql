-- Pagar-only volume attributed once from the activated payment and its tree path.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app-pagar-economy-v1',0));

DO $preflight$
BEGIN
  IF pg_catalog.current_database()<>'mindbliss_curated_20261025'
    OR pg_catalog.pg_is_in_recovery()
    OR pg_catalog.to_regclass('payments.app_pagar_investment') IS NULL
    OR pg_catalog.to_regclass('payments.app_pagar_economic_hold') IS NULL
    OR pg_catalog.to_regclass('payments.app_pagar_pv_source') IS NOT NULL
    OR pg_catalog.to_regclass('mlm.affiliate_closure') IS NULL THEN
    RAISE EXCEPTION 'app_pagar_pv_requires_review';
  END IF;
  LOCK TABLE payments.app_pagar_investment IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS(SELECT 1 FROM payments.app_pagar_investment) THEN
    RAISE EXCEPTION 'app_pagar_pv_requires_review';
  END IF;
END $preflight$;

CREATE TABLE payments.app_pagar_pv_source (
  payment_id uuid PRIMARY KEY REFERENCES payments.app_pagar_investment(payment_id) ON DELETE RESTRICT,
  subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 255),
  affiliate_id bigint CHECK(affiliate_id>0),
  pv_delta numeric(24,0) NOT NULL CHECK(pv_delta>=0),
  depth_cap integer NOT NULL CHECK(depth_cap BETWEEN 1 AND 30),
  confirmed_at timestamptz NOT NULL CHECK(pg_catalog.isfinite(confirmed_at))
);
CREATE INDEX app_pagar_pv_source_subject_idx ON payments.app_pagar_pv_source(subject);

CREATE TABLE payments.app_pagar_pv_leg (
  payment_id uuid NOT NULL REFERENCES payments.app_pagar_pv_source(payment_id) ON DELETE RESTRICT,
  affiliate_id bigint NOT NULL CHECK(affiliate_id>0),
  leg text NOT NULL CHECK(leg IN ('L','R')),
  distance integer NOT NULL CHECK(distance BETWEEN 1 AND 30),
  PRIMARY KEY(payment_id,affiliate_id),
  UNIQUE(payment_id,distance)
);
CREATE INDEX app_pagar_pv_leg_affiliate_idx ON payments.app_pagar_pv_leg(affiliate_id,leg);

ALTER TABLE payments.app_pagar_pv_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments.app_pagar_pv_leg ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER app_pagar_pv_source_retained BEFORE UPDATE OR DELETE OR TRUNCATE ON payments.app_pagar_pv_source
  FOR EACH STATEMENT EXECUTE FUNCTION payments.reject_app_pagar_accounting_mutation();
CREATE TRIGGER app_pagar_pv_leg_retained BEFORE UPDATE OR DELETE OR TRUNCATE ON payments.app_pagar_pv_leg
  FOR EACH STATEMENT EXECUTE FUNCTION payments.reject_app_pagar_accounting_mutation();

CREATE FUNCTION payments.attribute_app_pagar_pv_v1()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
DECLARE v_depth integer; v_valid boolean;
BEGIN
  IF NEW.plan_snapshot->>'depth_cap' IS NULL OR NEW.plan_snapshot->>'depth_cap' !~ '^([1-9]|[12][0-9]|30)$' THEN
    RAISE EXCEPTION 'app_pagar_pv_invalid_depth' USING ERRCODE='23514';
  END IF;
  v_depth:=(NEW.plan_snapshot->>'depth_cap')::integer;
  INSERT INTO payments.app_pagar_pv_source(payment_id,subject,affiliate_id,pv_delta,depth_cap,confirmed_at)
  VALUES(NEW.payment_id,NEW.subject,NEW.affiliate_id,NEW.pv_delta,v_depth,NEW.starts_at);
  -- Unplaced members earn personal Pagar PV only. They have no binary leg.
  IF NEW.affiliate_id IS NULL OR NEW.pv_delta=0 THEN RETURN NEW; END IF;

  -- Materialize the path and check the placement/closure relationship in one
  -- snapshot. Each leg belongs to the child immediately below its ancestor,
  -- not to the buyer's orientation at every level.
  WITH RECURSIVE path(affiliate_id,parent_id,position,active,distance,leg,visited,cycle) AS (
    SELECT a.id,a.parent_id,a.position::text,a.status::text='active',0,NULL::text,ARRAY[a.id],false
      FROM mlm.affiliate a WHERE a.id=NEW.affiliate_id
    UNION ALL
    SELECT a.id,a.parent_id,a.position::text,a.status::text='active',p.distance+1,p.position,
      pg_catalog.array_append(p.visited,a.id),a.id=ANY(p.visited)
      FROM path p JOIN mlm.affiliate a ON a.id=p.parent_id
      WHERE p.distance<v_depth AND NOT p.cycle
  ), integrity AS (
    SELECT coalesce(bool_and(
      NOT p.cycle
      AND CASE WHEN p.parent_id IS NULL THEN p.position IS NULL
        ELSE coalesce(p.position IN ('L','R'),false)
          AND (p.distance=v_depth OR EXISTS(SELECT 1 FROM path n WHERE n.distance=p.distance+1 AND n.affiliate_id=p.parent_id))
        END
      AND CASE WHEN p.distance=0 THEN p.active ELSE p.leg IN ('L','R') AND EXISTS(
        SELECT 1 FROM mlm.affiliate_closure c WHERE c.ancestor_id=p.affiliate_id
          AND c.descendant_id=NEW.affiliate_id AND c.distance=p.distance
      ) END
    ),false) AS valid
    FROM path p
  ), attributed AS (
    INSERT INTO payments.app_pagar_pv_leg(payment_id,affiliate_id,leg,distance)
    SELECT NEW.payment_id,p.affiliate_id,p.leg,p.distance
      FROM path p CROSS JOIN integrity i
      WHERE i.valid AND p.distance>0 AND p.active
    RETURNING 1
  )
  SELECT i.valid INTO v_valid FROM integrity i CROSS JOIN(SELECT count(*) FROM attributed) a;
  IF v_valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'app_pagar_pv_invalid_tree' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $function$;

CREATE TRIGGER app_pagar_investment_attribute_pv AFTER INSERT ON payments.app_pagar_investment
  FOR EACH ROW EXECUTE FUNCTION payments.attribute_app_pagar_pv_v1();

CREATE FUNCTION payments.read_app_pagar_points_v1(p_subject text,p_native_session text)
RETURNS TABLE(own_pv text,left_pv text,right_pv text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
DECLARE v_person bigint;
BEGIN
  PERFORM identity.require_administrative_native_session(p_subject,p_native_session);
  v_person:=identity.administrative_wallet_person(p_subject);
  RETURN QUERY
    SELECT (
      SELECT coalesce(sum(s.pv_delta),0)::text FROM payments.app_pagar_pv_source s WHERE s.subject=p_subject
        AND NOT EXISTS(SELECT 1 FROM payments.app_pagar_economic_hold h WHERE h.payment_id=s.payment_id)
    ),coalesce(sum(s.pv_delta) FILTER (WHERE l.leg='L'),0)::text,
      coalesce(sum(s.pv_delta) FILTER (WHERE l.leg='R'),0)::text
    FROM mlm.affiliate a
    JOIN payments.app_pagar_pv_leg l ON l.affiliate_id=a.id
    JOIN payments.app_pagar_pv_source s ON s.payment_id=l.payment_id
    WHERE a.person_id=v_person AND a.status::text='active'
      AND NOT EXISTS(SELECT 1 FROM payments.app_pagar_economic_hold h WHERE h.payment_id=s.payment_id);
END $function$;

DO $permissions$
DECLARE v_owner name; v_role text; v_name text; v_signature text;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(c.relowner) INTO STRICT v_owner
  FROM pg_catalog.pg_class c WHERE c.oid='payments.app_pagar_investment'::regclass;
  EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA mlm,identity TO %I',v_owner);
  EXECUTE pg_catalog.format('GRANT SELECT(id,person_id,parent_id,position,status) ON mlm.affiliate TO %I',v_owner);
  EXECUTE pg_catalog.format('GRANT SELECT(ancestor_id,descendant_id,distance) ON mlm.affiliate_closure TO %I',v_owner);
  EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION identity.administrative_wallet_person(text),identity.require_administrative_native_session(text,text) TO %I',v_owner);

  FOREACH v_name IN ARRAY ARRAY['app_pagar_pv_source','app_pagar_pv_leg'] LOOP
    EXECUTE pg_catalog.format('ALTER TABLE payments.%I OWNER TO %I',v_name,v_owner);
    FOR v_role IN
      SELECT DISTINCT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END
      FROM pg_catalog.pg_class c,LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE c.relnamespace='payments'::regnamespace AND c.relname=v_name AND a.grantee<>c.relowner
    LOOP
      EXECUTE pg_catalog.format('REVOKE ALL ON TABLE payments.%I FROM %s',v_name,v_role);
    END LOOP;
  END LOOP;

  FOREACH v_signature IN ARRAY ARRAY['payments.attribute_app_pagar_pv_v1()','payments.read_app_pagar_points_v1(text,text)'] LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO %I',v_signature,v_owner);
    FOR v_role IN
      SELECT DISTINCT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END
      FROM pg_catalog.pg_proc p,LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      WHERE p.oid=v_signature::regprocedure AND a.grantee<>p.proowner
    LOOP
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %s',v_signature,v_role);
    END LOOP;
  END LOOP;

  GRANT EXECUTE ON FUNCTION payments.read_app_pagar_points_v1(text,text) TO mindbliss_auth_core_v1;
  IF pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.app_pagar_pv_source','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.app_pagar_pv_leg','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.attribute_app_pagar_pv_v1()','EXECUTE') THEN
    RAISE EXCEPTION 'app_pagar_pv_permissions_changed';
  END IF;
END $permissions$;
COMMIT;
