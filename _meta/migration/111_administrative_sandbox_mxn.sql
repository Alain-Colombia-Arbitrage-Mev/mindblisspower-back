-- Administrative MELD sandbox fiat only. No production purchase, wallet credit or commission.
BEGIN;
SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('administrative-sandbox-mxn-v1',0));
DO $preflight$
BEGIN
 IF pg_catalog.current_database()<>'mindbliss_curated_20261025' OR pg_catalog.pg_is_in_recovery()
  OR pg_catalog.to_regclass('payments.meld_sandbox_funding_attempt') IS NULL
  OR pg_catalog.to_regprocedure('payments.create_reown_funding_intent_v7(text,text,text,numeric,uuid,text,text)') IS NULL THEN
  RAISE EXCEPTION 'administrative_mxn_prerequisites_required'; END IF;
 IF pg_catalog.to_regprocedure('payments.create_meld_sandbox_funding_attempt_v2(text,text,text,numeric,uuid,text,text,text)') IS NOT NULL
  OR pg_catalog.to_regprocedure('payments.read_wallet_funding_history_v4(text,text)') IS NOT NULL
  OR pg_catalog.to_regprocedure('payments.read_wallet_funding_status_v4(text,text,uuid)') IS NOT NULL
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.create_meld_sandbox_funding_attempt(text,text,text,numeric,uuid,text,text)'::regprocedure))<>'00f7d47a742dea6c7c94be7cfe5e664f'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.read_wallet_funding_history_v3(text,text)'::regprocedure))<>'0302bda008fbb6b6007e17879d447981'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.read_wallet_funding_status_v3(text,text,uuid)'::regprocedure))<>'c78f17016d1d77a3b804218dc3253503'
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='payments.meld_sandbox_funding_attempt'::regclass
    AND conname='meld_sandbox_funding_attempt_requested_amount_check' AND convalidated
    AND pg_catalog.md5(pg_catalog.pg_get_constraintdef(oid,true))='f8805ea2e74fd3bd753ed79b372ca772')
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='payments.meld_sandbox_funding_attempt'::regclass
    AND conname='meld_sandbox_funding_attempt_source_currency_check' AND convalidated
    AND pg_catalog.md5(pg_catalog.pg_get_constraintdef(oid,true))='5b39dd7cfb7082f9f884b5c4f30ba754') THEN
  RAISE EXCEPTION 'administrative_mxn_requires_fresh_review'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid='payments.meld_sandbox_funding_attempt'::regclass
    AND(NOT relrowsecurity OR NOT pg_catalog.pg_has_role(relowner,'USAGE')))
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.meld_sandbox_funding_attempt','SELECT,INSERT,UPDATE,DELETE')
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid='payments.create_meld_sandbox_funding_attempt(text,text,text,numeric,uuid,text,text)'::regprocedure
    AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog']::text[] AND pg_catalog.pg_has_role(proowner,'USAGE'))
  OR NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.create_meld_sandbox_funding_attempt(text,text,text,numeric,uuid,text,text)','EXECUTE') THEN
  RAISE EXCEPTION 'administrative_mxn_runtime_isolation_required'; END IF;
END $preflight$;
ALTER TABLE payments.meld_sandbox_funding_attempt DROP CONSTRAINT meld_sandbox_funding_attempt_source_currency_check;
ALTER TABLE payments.meld_sandbox_funding_attempt ADD CONSTRAINT meld_sandbox_funding_attempt_source_currency_check CHECK(source_currency IN('USD','MXN'));
ALTER TABLE payments.meld_sandbox_funding_attempt DROP CONSTRAINT meld_sandbox_funding_attempt_requested_amount_check;
ALTER TABLE payments.meld_sandbox_funding_attempt ADD CONSTRAINT meld_sandbox_funding_attempt_requested_amount_check CHECK(
 (source_currency='USD' AND requested_amount BETWEEN 50 AND 25000)
 OR(source_currency='MXN' AND country_code='MX' AND destination_currency='USDT_POLYGON'
   AND((service_provider='TRANSAK' AND payment_method IN('CREDIT_DEBIT_CARD','APPLE_PAY','GOOGLE_PAY'))
     OR(service_provider='BANXA' AND payment_method='CREDIT_DEBIT_CARD'))
   AND requested_amount BETWEEN 0.01 AND 1000000000));

CREATE FUNCTION payments.create_meld_sandbox_funding_attempt_v2(
  p_subject text,p_address text,p_country text,p_amount numeric,p_request_id uuid,p_service_provider text,p_payment_method text,p_source_currency text)
RETURNS TABLE(id uuid,created_at timestamptz,created boolean,status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_existing payments.meld_sandbox_funding_attempt%ROWTYPE;
BEGIN
  BEGIN
    PERFORM identity.administrative_wallet_person(p_subject);
  EXCEPTION WHEN SQLSTATE '28000' THEN
    RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000';
  END;
  IF p_address IS NULL OR p_address !~ '^0x[0-9a-f]{40}$'
    OR p_country IS NULL OR p_country !~ '^[A-Z]{2}$' OR p_request_id IS NULL
    OR p_amount IS NULL OR p_amount<>round(p_amount,2) OR p_source_currency IS NULL OR p_source_currency NOT IN('USD','MXN')
    OR(p_source_currency='USD' AND NOT(p_amount BETWEEN 50 AND 25000))
    OR(p_source_currency='MXN' AND(p_country<>'MX' OR NOT(p_amount BETWEEN 0.01 AND 1000000000)
      OR p_payment_method IS NULL OR p_service_provider IS NULL
      OR NOT((p_service_provider='TRANSAK' AND p_payment_method IN('CREDIT_DEBIT_CARD','APPLE_PAY','GOOGLE_PAY'))
        OR(p_service_provider='BANXA' AND p_payment_method='CREDIT_DEBIT_CARD'))))
    OR p_service_provider IS NULL OR p_service_provider NOT IN ('TRANSAK','BANXA')
    OR p_payment_method IS NULL OR p_payment_method !~ '^[A-Z0-9_]{2,40}$' THEN
    RAISE EXCEPTION 'wallet_funding_invalid_request' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM identity.administrative_wallet_assignment a JOIN identity.administrative_wallet_pool p ON p.ordinal=a.pool_ordinal
    WHERE a.subject=p_subject AND p.address=p_address AND p.status='available' FOR SHARE OF a,p;
  IF NOT FOUND THEN RAISE EXCEPTION 'wallet_funding_wallet_not_assigned' USING ERRCODE='28000'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('meld-sandbox-funding:'||p_subject,0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('meld-sandbox-funding-request:'||p_request_id::text,0));
  SELECT r.* INTO v_existing FROM payments.meld_sandbox_funding_attempt r WHERE r.id=p_request_id;
  IF FOUND THEN
    IF v_existing.subject<>p_subject OR v_existing.wallet_address<>p_address
      OR v_existing.country_code<>p_country OR v_existing.requested_amount<>p_amount
      OR v_existing.service_provider<>p_service_provider OR v_existing.payment_method<>p_payment_method
      OR v_existing.source_currency<>p_source_currency THEN
      RAISE EXCEPTION 'wallet_funding_request_already_used' USING ERRCODE='22023';
    END IF;
    RETURN QUERY SELECT v_existing.id,v_existing.created_at,false,v_existing.status;
    RETURN;
  END IF;
  IF (SELECT count(*) FROM payments.meld_sandbox_funding_attempt r
    WHERE r.subject=p_subject AND r.created_at>now()-interval '10 minutes')>=10 THEN
    RAISE EXCEPTION 'wallet_funding_rate_limited' USING ERRCODE='54000';
  END IF;
  RETURN QUERY INSERT INTO payments.meld_sandbox_funding_attempt(id,subject,wallet_address,country_code,requested_amount,service_provider,payment_method,source_currency)
    VALUES(p_request_id,p_subject,p_address,p_country,p_amount,p_service_provider,p_payment_method,p_source_currency)
    RETURNING meld_sandbox_funding_attempt.id,meld_sandbox_funding_attempt.created_at,true,meld_sandbox_funding_attempt.status;
END $function$;
-- A warm USD-only runtime cannot replay an MXN reference as dollars.
CREATE OR REPLACE FUNCTION payments.create_meld_sandbox_funding_attempt(
 p_subject text,p_address text,p_country text,p_amount numeric,p_request_id uuid,p_service_provider text,p_payment_method text)
RETURNS TABLE(id uuid,created_at timestamptz,created boolean,status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
 RETURN QUERY SELECT * FROM payments.create_meld_sandbox_funding_attempt_v2(p_subject,p_address,p_country,p_amount,p_request_id,p_service_provider,p_payment_method,'USD');
END $function$;

CREATE FUNCTION payments.read_wallet_funding_history_v4(p_subject text,p_kind text)
RETURNS TABLE(id uuid,wallet_kind text,environment text,provider text,status text,wallet_address text,
 country_code text,requested_amount numeric,created_at timestamptz,source_currency text,payment_method text,destination_currency text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
 BEGIN PERFORM identity.administrative_wallet_person(p_subject);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000'; END;
 IF p_kind='personal' THEN
  RETURN QUERY SELECT r.id,r.wallet_kind,r.environment,r.provider,r.status,r.wallet_address,
   r.country_code,r.requested_amount,r.created_at,r.source_currency,r.payment_method,r.destination_currency FROM payments.reown_funding_intent r
   WHERE r.subject=p_subject ORDER BY r.created_at DESC,r.id DESC LIMIT 20;
 ELSIF p_kind='administrative' THEN
  RETURN QUERY SELECT r.id,r.wallet_kind,r.environment,r.provider,r.status,r.wallet_address,
   r.country_code,r.requested_amount,r.created_at,r.source_currency,r.payment_method,r.destination_currency FROM payments.meld_sandbox_funding_attempt r
   WHERE r.subject=p_subject ORDER BY r.created_at DESC,r.id DESC LIMIT 20;
 ELSE RAISE EXCEPTION 'wallet_funding_invalid_kind' USING ERRCODE='22023'; END IF;
END $function$;
CREATE FUNCTION payments.read_wallet_funding_status_v4(p_subject text,p_kind text,p_reference uuid)
RETURNS TABLE(id uuid,wallet_kind text,environment text,provider text,status text,wallet_address text,
 country_code text,requested_amount numeric,created_at timestamptz,source_currency text,payment_method text,destination_currency text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
 BEGIN PERFORM identity.administrative_wallet_person(p_subject);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000'; END;
 IF p_reference IS NULL THEN RAISE EXCEPTION 'wallet_funding_invalid_reference' USING ERRCODE='22023'; END IF;
 IF p_kind='personal' THEN
  RETURN QUERY SELECT r.id,r.wallet_kind,r.environment,r.provider,r.status,r.wallet_address,
   r.country_code,r.requested_amount,r.created_at,r.source_currency,r.payment_method,r.destination_currency FROM payments.reown_funding_intent r
   WHERE r.subject=p_subject AND r.id=p_reference;
 ELSIF p_kind='administrative' THEN
  RETURN QUERY SELECT r.id,r.wallet_kind,r.environment,r.provider,r.status,r.wallet_address,
   r.country_code,r.requested_amount,r.created_at,r.source_currency,r.payment_method,r.destination_currency FROM payments.meld_sandbox_funding_attempt r
   WHERE r.subject=p_subject AND r.id=p_reference;
 ELSE RAISE EXCEPTION 'wallet_funding_invalid_kind' USING ERRCODE='22023'; END IF;
END $function$;
REVOKE ALL ON FUNCTION payments.create_meld_sandbox_funding_attempt_v2(text,text,text,numeric,uuid,text,text,text),payments.read_wallet_funding_history_v4(text,text),payments.read_wallet_funding_status_v4(text,text,uuid) FROM PUBLIC;
DO $owner_and_acl$
DECLARE item record;v_owner text;v_signature text;v_reference text;
BEGIN
 SELECT pg_catalog.pg_get_userbyid(proowner) INTO v_owner FROM pg_catalog.pg_proc
  WHERE oid='payments.create_meld_sandbox_funding_attempt(text,text,text,numeric,uuid,text,text)'::regprocedure;
 FOREACH v_signature IN ARRAY ARRAY['payments.create_meld_sandbox_funding_attempt_v2(text,text,text,numeric,uuid,text,text,text)','payments.read_wallet_funding_history_v4(text,text)','payments.read_wallet_funding_status_v4(text,text,uuid)'] LOOP
  v_reference:=CASE WHEN v_signature LIKE 'payments.read_wallet_funding_history_v4%' THEN 'payments.read_wallet_funding_history_v3(text,text)'
    WHEN v_signature LIKE 'payments.read_wallet_funding_status_v4%' THEN 'payments.read_wallet_funding_status_v3(text,text,uuid)'
    ELSE 'payments.create_meld_sandbox_funding_attempt(text,text,text,numeric,uuid,text,text)' END;
  SELECT pg_catalog.pg_get_userbyid(proowner) INTO v_owner FROM pg_catalog.pg_proc WHERE oid=v_reference::regprocedure;
  EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO %I',v_signature,v_owner);
  FOR item IN SELECT DISTINCT a.grantee FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
   WHERE p.oid=v_signature::regprocedure AND a.grantee<>p.proowner AND a.grantee<>0 LOOP
   EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %I',v_signature,pg_catalog.pg_get_userbyid(item.grantee)); END LOOP;
  EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO mindbliss_auth_core_v1',v_signature);
 END LOOP;
END $owner_and_acl$;
DO $verify$
DECLARE v_signature text;v_owner oid;v_reference text;
BEGIN
 SELECT proowner INTO v_owner FROM pg_catalog.pg_proc WHERE oid='payments.create_meld_sandbox_funding_attempt(text,text,text,numeric,uuid,text,text)'::regprocedure;
 FOREACH v_signature IN ARRAY ARRAY['payments.create_meld_sandbox_funding_attempt_v2(text,text,text,numeric,uuid,text,text,text)','payments.read_wallet_funding_history_v4(text,text)','payments.read_wallet_funding_status_v4(text,text,uuid)'] LOOP
  v_reference:=CASE WHEN v_signature LIKE 'payments.read_wallet_funding_history_v4%' THEN 'payments.read_wallet_funding_history_v3(text,text)'
    WHEN v_signature LIKE 'payments.read_wallet_funding_status_v4%' THEN 'payments.read_wallet_funding_status_v3(text,text,uuid)'
    ELSE 'payments.create_meld_sandbox_funding_attempt(text,text,text,numeric,uuid,text,text)' END;
  SELECT proowner INTO v_owner FROM pg_catalog.pg_proc WHERE oid=v_reference::regprocedure;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid=v_signature::regprocedure AND prosecdef
     AND proconfig=ARRAY['search_path=pg_catalog']::text[] AND proowner=v_owner)
   OR NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1',v_signature,'EXECUTE')
   OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
    WHERE p.oid=v_signature::regprocedure AND a.grantee<>p.proowner AND a.grantee<>'mindbliss_auth_core_v1'::regrole) THEN
   RAISE EXCEPTION 'administrative_mxn_runtime_isolation_failed'; END IF;
 END LOOP;
 IF pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.meld_sandbox_funding_attempt','SELECT,INSERT,UPDATE,DELETE')
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.read_wallet_funding_history_v3(text,text)'::regprocedure))<>'0302bda008fbb6b6007e17879d447981'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.read_wallet_funding_status_v3(text,text,uuid)'::regprocedure))<>'c78f17016d1d77a3b804218dc3253503' THEN
  RAISE EXCEPTION 'administrative_mxn_runtime_isolation_failed'; END IF;
END $verify$;
COMMIT;
