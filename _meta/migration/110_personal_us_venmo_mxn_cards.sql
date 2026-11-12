-- Personal US/USD Venmo/PayPal and Mexico/MXN card/mobile-pay request metadata.
-- New MXN requests retain the fixed 931 floor plus live provider limits.
-- COP, old functions, request history, ledgers and sandbox rows stay unchanged.
-- New COP checkouts are temporarily disabled; historical COP readers stay intact.
BEGIN;
SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('personal-us-venmo-mxn-cards-v1',0));
DO $preflight$
BEGIN
 IF pg_catalog.current_database()<>'mindbliss_curated_20261025' OR pg_catalog.pg_is_in_recovery()
  OR pg_catalog.to_regclass('payments.reown_funding_intent') IS NULL
  OR pg_catalog.to_regprocedure('payments.create_reown_funding_intent_v6(text,text,text,numeric,uuid,text,text)') IS NULL THEN
  RAISE EXCEPTION 'personal_us_mxn_prerequisites_required'; END IF;
 IF pg_catalog.to_regprocedure('payments.create_reown_funding_intent_v7(text,text,text,numeric,uuid,text,text)') IS NOT NULL
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.create_reown_funding_intent_v6(text,text,text,numeric,uuid,text,text)'::regprocedure))<>'f41bd3b29c834c41c1f8ee7d967c4fba'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.create_reown_funding_intent_v4(text,text,text,numeric,uuid,text,text)'::regprocedure))<>'c3bb68c1cc00f5ba1c017ef3f4d3936c'
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='payments.reown_funding_intent'::regclass
    AND conname='reown_funding_intent_requested_amount_check' AND convalidated
    AND pg_catalog.md5(pg_catalog.pg_get_constraintdef(oid,true))='0665657796161e6de48bf31356c0b237')
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='payments.reown_funding_intent'::regclass
    AND conname='reown_funding_intent_source_currency_check' AND convalidated
    AND pg_catalog.md5(pg_catalog.pg_get_constraintdef(oid,true))='6a64ef1e58db9ca4aa84ddd6b27c4a2d') THEN
  RAISE EXCEPTION 'personal_us_mxn_requires_fresh_review'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid='payments.reown_funding_intent'::regclass
    AND (NOT relrowsecurity OR NOT pg_catalog.pg_has_role(relowner,'USAGE')))
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.reown_funding_intent','SELECT,INSERT,UPDATE,DELETE')
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid='payments.create_reown_funding_intent_v6(text,text,text,numeric,uuid,text,text)'::regprocedure
    AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog']::text[] AND pg_catalog.pg_has_role(proowner,'USAGE'))
  OR NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.create_reown_funding_intent_v6(text,text,text,numeric,uuid,text,text)','EXECUTE') THEN
  RAISE EXCEPTION 'personal_us_mxn_runtime_isolation_required'; END IF;
END $preflight$;

-- Keep historical SPEI requests in their original fiat/network. Newly supported
-- MXN methods are Polygon-only; the v7 writer also enforces the current 931 floor.
ALTER TABLE payments.reown_funding_intent DROP CONSTRAINT reown_funding_intent_requested_amount_check;
ALTER TABLE payments.reown_funding_intent ADD CONSTRAINT reown_funding_intent_requested_amount_check
 CHECK((source_currency='USD' AND requested_amount BETWEEN 20 AND 25000)
  OR (source_currency='MXN' AND country_code='MX' AND payment_method IS NOT NULL
    AND payment_method IN('SPEI','CREDIT_DEBIT_CARD','APPLE_PAY','GOOGLE_PAY')
    AND (payment_method='SPEI' OR destination_currency='USDT_POLYGON')
    AND requested_amount BETWEEN 0.01 AND 1000000000)
  OR (source_currency='COP' AND country_code='CO' AND payment_method IS NOT NULL AND payment_method IN('PSE','LOCAL_BANK_TRANSFER')
    AND destination_currency='USDT_POLYGON' AND requested_amount BETWEEN 0.01 AND 1000000000));

CREATE FUNCTION payments.create_reown_funding_intent_v7(
 p_subject text,p_address text,p_country text,p_amount numeric,p_request_id uuid,p_payment_method text,p_source_currency text)
RETURNS TABLE(id uuid,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_existing payments.reown_funding_intent%ROWTYPE;
BEGIN
 IF p_source_currency='COP' THEN
  RAISE EXCEPTION 'wallet_funding_invalid_request' USING ERRCODE='22023'; END IF;
 IF p_payment_method IN('VENMO','PAYPAL') AND (p_country IS DISTINCT FROM 'US' OR p_source_currency IS DISTINCT FROM 'USD') THEN
  RAISE EXCEPTION 'wallet_funding_invalid_request' USING ERRCODE='22023'; END IF;
 IF p_country='CO' AND p_source_currency='USD' AND (p_payment_method IS NULL OR p_payment_method NOT IN('CREDIT_DEBIT_CARD','APPLE_PAY','GOOGLE_PAY')) THEN
  RAISE EXCEPTION 'wallet_funding_invalid_request' USING ERRCODE='22023'; END IF;
 IF p_source_currency IS DISTINCT FROM 'MXN' THEN
  RETURN QUERY SELECT * FROM payments.create_reown_funding_intent_v6(p_subject,p_address,p_country,p_amount,p_request_id,p_payment_method,p_source_currency);
  RETURN;
 END IF;
 BEGIN PERFORM identity.administrative_wallet_person(p_subject);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000'; END;
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'wallet_funding_unavailable' USING ERRCODE='40001'; END IF;
 IF p_address IS NULL OR p_address !~ '^0x[0-9a-f]{40}$'
  OR p_country IS DISTINCT FROM 'MX' OR p_request_id IS NULL OR p_payment_method IS NULL
  OR p_payment_method NOT IN('SPEI','CREDIT_DEBIT_CARD','APPLE_PAY','GOOGLE_PAY')
  OR p_amount IS NULL OR p_amount<>round(p_amount,2) OR NOT(p_amount BETWEEN 931 AND 1000000000) THEN
  RAISE EXCEPTION 'wallet_funding_invalid_request' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM identity.wallet_binding b WHERE b.subject=p_subject AND b.address=p_address) THEN
  RAISE EXCEPTION 'wallet_funding_wallet_not_linked' USING ERRCODE='28000'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('reown-funding:'||p_subject,0));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('reown-funding-request:'||p_request_id::text,0));
 SELECT r.* INTO v_existing FROM payments.reown_funding_intent r WHERE r.id=p_request_id;
 IF FOUND THEN
  IF v_existing.subject<>p_subject OR v_existing.wallet_address<>p_address
   OR v_existing.country_code<>p_country OR v_existing.requested_amount<>p_amount
   OR v_existing.payment_method IS DISTINCT FROM p_payment_method OR v_existing.source_currency IS DISTINCT FROM p_source_currency
   OR v_existing.destination_currency<>'USDT_POLYGON' THEN
   RAISE EXCEPTION 'wallet_funding_request_already_used' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT v_existing.id,v_existing.created_at; RETURN;
 END IF;
 IF (SELECT count(*) FROM payments.reown_funding_intent r WHERE r.subject=p_subject AND r.created_at>now()-interval '10 minutes')>=10 THEN
  RAISE EXCEPTION 'wallet_funding_rate_limited' USING ERRCODE='54000'; END IF;
 RETURN QUERY INSERT INTO payments.reown_funding_intent(id,subject,wallet_address,country_code,requested_amount,payment_method,source_currency,destination_currency)
  VALUES(p_request_id,p_subject,p_address,p_country,p_amount,p_payment_method,p_source_currency,'USDT_POLYGON')
  RETURNING reown_funding_intent.id,reown_funding_intent.created_at;
END $function$;
REVOKE ALL ON FUNCTION payments.create_reown_funding_intent_v7(text,text,text,numeric,uuid,text,text) FROM PUBLIC;
DO $owner_and_acl$
DECLARE item record;v_owner text;
BEGIN
 SELECT pg_catalog.pg_get_userbyid(proowner) INTO v_owner FROM pg_catalog.pg_proc
  WHERE oid='payments.create_reown_funding_intent_v6(text,text,text,numeric,uuid,text,text)'::regprocedure;
 EXECUTE pg_catalog.format('ALTER FUNCTION payments.create_reown_funding_intent_v7(text,text,text,numeric,uuid,text,text) OWNER TO %I',v_owner);
 FOR item IN SELECT DISTINCT a.grantee FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
  WHERE p.oid='payments.create_reown_funding_intent_v7(text,text,text,numeric,uuid,text,text)'::regprocedure AND a.grantee<>p.proowner AND a.grantee<>0 LOOP
  EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION payments.create_reown_funding_intent_v7(text,text,text,numeric,uuid,text,text) FROM %I',pg_catalog.pg_get_userbyid(item.grantee));
 END LOOP;
END $owner_and_acl$;
GRANT EXECUTE ON FUNCTION payments.create_reown_funding_intent_v7(text,text,text,numeric,uuid,text,text) TO mindbliss_auth_core_v1;
DO $verify$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid='payments.create_reown_funding_intent_v7(text,text,text,numeric,uuid,text,text)'::regprocedure
    AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.proowner=(SELECT proowner FROM pg_catalog.pg_proc
      WHERE oid='payments.create_reown_funding_intent_v6(text,text,text,numeric,uuid,text,text)'::regprocedure))
  OR NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.create_reown_funding_intent_v7(text,text,text,numeric,uuid,text,text)','EXECUTE')
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
    WHERE p.oid='payments.create_reown_funding_intent_v7(text,text,text,numeric,uuid,text,text)'::regprocedure
    AND a.grantee<>p.proowner AND a.grantee<>'mindbliss_auth_core_v1'::regrole)
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.reown_funding_intent','SELECT,INSERT,UPDATE,DELETE')
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.create_reown_funding_intent_v6(text,text,text,numeric,uuid,text,text)'::regprocedure))<>'f41bd3b29c834c41c1f8ee7d967c4fba'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.create_reown_funding_intent_v4(text,text,text,numeric,uuid,text,text)'::regprocedure))<>'c3bb68c1cc00f5ba1c017ef3f4d3936c' THEN
  RAISE EXCEPTION 'personal_us_mxn_runtime_isolation_failed'; END IF;
END $verify$;
COMMIT;
