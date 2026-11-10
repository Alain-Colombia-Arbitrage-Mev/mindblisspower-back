-- Owned request-status reads only. No payment confirmation, wallet credit,
-- commission update, webhook activation, data writes or direct table grants.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallet-funding-status-reads-v1',0));

DO $preflight$
BEGIN
  IF pg_catalog.current_database()<>'mindbliss_curated_20261025' OR pg_catalog.pg_is_in_recovery()
    OR pg_catalog.to_regclass('payments.reown_funding_intent') IS NULL
    OR pg_catalog.to_regclass('payments.meld_sandbox_funding_attempt') IS NULL
    OR pg_catalog.to_regprocedure('identity.administrative_wallet_person(text)') IS NULL THEN
    RAISE EXCEPTION 'wallet_funding_status_prerequisites_required';
  END IF;
  IF pg_catalog.to_regprocedure('payments.read_wallet_funding_status(text,text,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'wallet_funding_status_requires_fresh_review';
  END IF;
END $preflight$;

CREATE FUNCTION payments.read_wallet_funding_status(p_subject text,p_kind text,p_reference uuid)
RETURNS TABLE(id uuid,wallet_kind text,environment text,provider text,status text,wallet_address text,
  country_code text,requested_amount numeric,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  BEGIN
    PERFORM identity.administrative_wallet_person(p_subject);
  EXCEPTION WHEN SQLSTATE '28000' THEN
    RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000';
  END;
  IF p_reference IS NULL THEN
    RAISE EXCEPTION 'wallet_funding_invalid_reference' USING ERRCODE='22023';
  END IF;
  IF p_kind='personal' THEN
    RETURN QUERY SELECT r.id,r.wallet_kind,r.environment,r.provider,r.status,r.wallet_address,
      r.country_code,r.requested_amount,r.created_at FROM payments.reown_funding_intent r
      WHERE r.subject=p_subject AND r.id=p_reference;
  ELSIF p_kind='administrative' THEN
    RETURN QUERY SELECT r.id,r.wallet_kind,r.environment,r.provider,r.status,r.wallet_address,
      r.country_code,r.requested_amount,r.created_at FROM payments.meld_sandbox_funding_attempt r
      WHERE r.subject=p_subject AND r.id=p_reference;
  ELSE
    RAISE EXCEPTION 'wallet_funding_invalid_kind' USING ERRCODE='22023';
  END IF;
END $function$;

REVOKE ALL ON FUNCTION payments.read_wallet_funding_status(text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION payments.read_wallet_funding_status(text,text,uuid) TO mindbliss_auth_core_v1;

DO $verify$
BEGIN
  IF NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.read_wallet_funding_status(text,text,uuid)','EXECUTE')
    OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.reown_funding_intent','SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.meld_sandbox_funding_attempt','SELECT,INSERT,UPDATE,DELETE')
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
      WHERE p.oid='payments.read_wallet_funding_status(text,text,uuid)'::regprocedure AND a.grantee=0) THEN
    RAISE EXCEPTION 'wallet_funding_status_grants_invalid';
  END IF;
END $verify$;
COMMIT;
