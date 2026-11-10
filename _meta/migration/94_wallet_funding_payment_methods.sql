-- Prepared, request metadata only. This does not confirm payments, credit any
-- wallet, change personal ownership proofs, or grant direct financial access.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallet-funding-payment-methods-v1',0));

DO $preflight$
BEGIN
  IF pg_catalog.current_database()<>'mindbliss_curated_20261025' OR pg_catalog.pg_is_in_recovery()
    OR pg_catalog.to_regclass('payments.reown_funding_intent') IS NULL
    OR pg_catalog.to_regprocedure('payments.create_reown_funding_intent(text,text,text,numeric,uuid)') IS NULL THEN
    RAISE EXCEPTION 'wallet_funding_method_prerequisites_required';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid='payments.reown_funding_intent'::regclass
    AND attname='payment_method' AND NOT attisdropped)
    OR pg_catalog.to_regprocedure('payments.create_reown_funding_intent(text,text,text,numeric,uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'wallet_funding_method_requires_fresh_review';
  END IF;
END $preflight$;

-- NULL preserves the fact that historical requests did not capture a method.
-- New requests can only be made through the required-method function below.
ALTER TABLE payments.reown_funding_intent ADD COLUMN payment_method text
  CONSTRAINT reown_funding_payment_method CHECK(payment_method IS NULL OR payment_method ~ '^[A-Z0-9_]{2,40}$');

CREATE FUNCTION payments.create_reown_funding_intent(
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
    OR p_amount IS NULL OR NOT(p_amount BETWEEN 50 AND 25000) OR p_amount<>round(p_amount,2) THEN
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

-- The old overload cannot bypass the new required-method contract.
REVOKE ALL ON FUNCTION payments.create_reown_funding_intent(text,text,text,numeric,uuid) FROM PUBLIC,mindbliss_auth_core_v1;
REVOKE ALL ON FUNCTION payments.create_reown_funding_intent(text,text,text,numeric,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION payments.create_reown_funding_intent(text,text,text,numeric,uuid,text) TO mindbliss_auth_core_v1;

DO $verify$
BEGIN
  IF pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.create_reown_funding_intent(text,text,text,numeric,uuid)','EXECUTE')
    OR NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.create_reown_funding_intent(text,text,text,numeric,uuid,text)','EXECUTE')
    OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.reown_funding_intent','SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'wallet_funding_method_grants_invalid';
  END IF;
END $verify$;
COMMIT;
