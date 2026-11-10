-- Explicit user request: personal wallet minimum USD20 and a new USD20 membership.
-- Administrative funding stays at USD50. No historical purchase, settlement,
-- balance, ROI rate, scheduler, provider configuration or grant is changed.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('personal-usd20-membership-catalog-v1',0));

DO $preflight$
BEGIN
  IF pg_catalog.current_database()<>'mindbliss_curated_20261025' OR pg_catalog.pg_is_in_recovery()
    OR pg_catalog.to_regclass('payments.reown_funding_intent') IS NULL
    OR pg_catalog.to_regclass('payments.meld_sandbox_funding_attempt') IS NULL
    OR pg_catalog.to_regclass('mlm.package') IS NULL
    OR pg_catalog.to_regclass('mlm.plan_config') IS NULL
    OR pg_catalog.to_regclass('mlm.cd_roi_tier') IS NULL
    OR pg_catalog.to_regprocedure('payments.create_reown_funding_intent(text,text,text,numeric,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'personal_usd20_prerequisites_required';
  END IF;
  IF pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.create_reown_funding_intent(text,text,text,numeric,uuid,text)'::regprocedure))
      <>'c8a003ee5488b84030c69224c4cd2aa5'
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='payments.reown_funding_intent'::regclass
      AND conname='reown_funding_intent_requested_amount_check' AND convalidated
      AND pg_catalog.pg_get_constraintdef(oid)='CHECK (((requested_amount >= (50)::numeric) AND (requested_amount <= (25000)::numeric)))')
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='payments.meld_sandbox_funding_attempt'::regclass
      AND conname='meld_sandbox_funding_attempt_requested_amount_check' AND convalidated
      AND pg_catalog.pg_get_constraintdef(oid)='CHECK (((requested_amount >= (50)::numeric) AND (requested_amount <= (25000)::numeric)))') THEN
    RAISE EXCEPTION 'personal_usd20_requires_fresh_review';
  END IF;
  IF EXISTS(SELECT 1 FROM mlm.package WHERE id=17 OR amount_usd=20.00)
    OR NOT EXISTS(SELECT 1 FROM mlm.package WHERE id=3 AND name='Pack 3' AND amount_usd=50.00
      AND pv=50 AND type='11001' AND is_active) THEN
    RAISE EXCEPTION 'usd20_existing_catalog_requires_review';
  END IF;
  IF (SELECT count(*) FROM mlm.plan_config WHERE effective_from<=now()
      AND (effective_to IS NULL OR effective_to>now()))<>1
    OR NOT EXISTS(SELECT 1 FROM mlm.plan_config WHERE effective_from<=now()
      AND (effective_to IS NULL OR effective_to>now()) AND cd_lock_days=365)
    OR (SELECT count(*) FROM mlm.cd_roi_tier WHERE active AND min_amount_usd<=20
      AND (max_amount_usd IS NULL OR max_amount_usd>20))<>1
    OR NOT EXISTS(SELECT 1 FROM mlm.cd_roi_tier WHERE active AND min_amount_usd<=20
      AND (max_amount_usd IS NULL OR max_amount_usd>20) AND base_annual_rate=0.25 AND qualified_annual_rate=0.30) THEN
    RAISE EXCEPTION 'usd20_existing_compensation_requires_review';
  END IF;
  IF pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.reown_funding_intent','SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.meld_sandbox_funding_attempt','SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.create_reown_funding_intent(text,text,text,numeric,uuid)','EXECUTE')
    OR NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.create_reown_funding_intent(text,text,text,numeric,uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'personal_usd20_runtime_isolation_required';
  END IF;
END $preflight$;

ALTER TABLE payments.reown_funding_intent DROP CONSTRAINT reown_funding_intent_requested_amount_check;
ALTER TABLE payments.reown_funding_intent ADD CONSTRAINT reown_funding_intent_requested_amount_check
  CHECK (requested_amount BETWEEN 20 AND 25000);

CREATE OR REPLACE FUNCTION payments.create_reown_funding_intent(
  p_subject text,p_address text,p_country text,p_amount numeric,p_request_id uuid,p_payment_method text)
RETURNS TABLE(id uuid,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_existing payments.reown_funding_intent%ROWTYPE;
BEGIN
  BEGIN
    PERFORM identity.administrative_wallet_person(p_subject);
  EXCEPTION WHEN SQLSTATE '28000' THEN
    RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000';
  END;
  IF p_address IS NULL OR p_address !~ '^0x[0-9a-f]{40}$'
    OR p_country IS NULL OR p_country !~ '^[A-Z]{2}$' OR p_request_id IS NULL
    OR p_payment_method IS NULL OR p_payment_method !~ '^[A-Z0-9_]{2,40}$'
    OR p_amount IS NULL OR NOT(p_amount BETWEEN 20 AND 25000) OR p_amount<>round(p_amount,2) THEN
    RAISE EXCEPTION 'wallet_funding_invalid_request' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM identity.wallet_binding b WHERE b.subject=p_subject AND b.address=p_address) THEN
    RAISE EXCEPTION 'wallet_funding_wallet_not_linked' USING ERRCODE='28000';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('reown-funding:'||p_subject,0));
  SELECT r.* INTO v_existing FROM payments.reown_funding_intent r WHERE r.id=p_request_id;
  IF FOUND THEN
    IF v_existing.subject<>p_subject OR v_existing.wallet_address<>p_address
      OR v_existing.country_code<>p_country OR v_existing.requested_amount<>p_amount
      OR v_existing.payment_method IS DISTINCT FROM p_payment_method THEN
      RAISE EXCEPTION 'wallet_funding_request_already_used' USING ERRCODE='22023';
    END IF;
    RETURN QUERY SELECT v_existing.id,v_existing.created_at;
    RETURN;
  END IF;
  IF (SELECT count(*) FROM payments.reown_funding_intent r
    WHERE r.subject=p_subject AND r.created_at>now()-interval '10 minutes')>=10 THEN
    RAISE EXCEPTION 'wallet_funding_rate_limited' USING ERRCODE='54000';
  END IF;
  RETURN QUERY INSERT INTO payments.reown_funding_intent(id,subject,wallet_address,country_code,requested_amount,payment_method)
    VALUES(p_request_id,p_subject,p_address,p_country,p_amount,p_payment_method)
    RETURNING reown_funding_intent.id,reown_funding_intent.created_at;
END $function$;

-- A new canonical SKU preserves every existing catalog and purchase snapshot.
-- It uses the existing regular-package PV parity/type and existing eligible tier.
INSERT INTO mlm.package(id,name,amount_usd,pv,type,is_active,created_at,updated_at)
  VALUES(17,'Pack 20 USD',20.00,20,'11001',true,now(),now());

REVOKE ALL ON FUNCTION payments.create_reown_funding_intent(text,text,text,numeric,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION payments.create_reown_funding_intent(text,text,text,numeric,uuid,text) TO mindbliss_auth_core_v1;

DO $verify$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM mlm.package WHERE id=17 AND name='Pack 20 USD' AND amount_usd=20.00
      AND pv=20 AND type='11001' AND is_active)
    OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.reown_funding_intent','SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.meld_sandbox_funding_attempt','SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.create_reown_funding_intent(text,text,text,numeric,uuid)','EXECUTE')
    OR NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.create_reown_funding_intent(text,text,text,numeric,uuid,text)','EXECUTE')
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid='payments.create_reown_funding_intent(text,text,text,numeric,uuid,text)'::regprocedure
      AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog']::text[])
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
      WHERE p.oid='payments.create_reown_funding_intent(text,text,text,numeric,uuid,text)'::regprocedure AND a.grantee=0) THEN
    RAISE EXCEPTION 'personal_usd20_postcheck_failed';
  END IF;
END $verify$;
COMMIT;
