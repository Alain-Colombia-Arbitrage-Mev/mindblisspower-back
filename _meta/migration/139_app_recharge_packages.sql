-- Determine the App member's recharge package from verified production settlements.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app-recharge-packages-139',0));

CREATE FUNCTION payments.read_app_recharge_package_v1(p_subject text,p_native_session text)
RETURNS TABLE(level integer,ceiling_usd_minor text,gross_usd_minor text,confirmed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
BEGIN
  PERFORM identity.require_administrative_native_session(p_subject,p_native_session);
  RETURN QUERY
    WITH totals AS (
      SELECT sum(s.gross_usd_minor) AS gross,max(s.provider_settled_at) AS latest
      FROM payments.app_meld_funding_attempt a
      JOIN payments.app_meld_settlement s ON s.attempt_id=a.id
      WHERE a.subject=p_subject AND s.gross_usd_minor IS NOT NULL
    ), tiers(tier,ceiling) AS (
      VALUES (1,5000),(2,10000),(3,25000),(4,50000),(5,100000),(6,250000),(7,1000000),(8,2500000)
    )
    SELECT t.tier,t.ceiling::text,b.gross::text,b.latest
    FROM totals b JOIN tiers t
      ON t.tier=coalesce((SELECT min(x.tier) FROM tiers x WHERE b.gross<=x.ceiling),8)
    WHERE b.gross>0;
END $function$;

DO $permissions$
DECLARE v_owner name; v_role text;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(proowner) INTO v_owner FROM pg_catalog.pg_proc
    WHERE oid='payments.read_app_meld_settlement_v1(text,text,uuid)'::regprocedure;
  EXECUTE pg_catalog.format('ALTER FUNCTION payments.read_app_recharge_package_v1(text,text) OWNER TO %I',v_owner);
  FOR v_role IN
    SELECT DISTINCT CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(acl.grantee)) END
    FROM pg_catalog.pg_proc p,LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
    WHERE p.oid='payments.read_app_recharge_package_v1(text,text)'::regprocedure AND acl.grantee<>p.proowner
  LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION payments.read_app_recharge_package_v1(text,text) FROM '||v_role;
  END LOOP;
  GRANT EXECUTE ON FUNCTION payments.read_app_recharge_package_v1(text,text) TO mindbliss_auth_core_v1;
END $permissions$;
COMMIT;
