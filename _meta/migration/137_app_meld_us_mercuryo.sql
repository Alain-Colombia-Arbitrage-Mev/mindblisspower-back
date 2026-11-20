-- Add the verified US Mercuryo card routes to the App journal.
-- Preserve historical RampNow attempts while retiring their creation in every writer.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app-meld-funding-137',0));

DO $preflight$
DECLARE v_policy regprocedure;
BEGIN
 v_policy:=pg_catalog.to_regprocedure('payments.app_meld_funding_wallet_route_allowed(text,text,numeric,text,text,text)');
 IF pg_catalog.current_database()<>'mindbliss_curated_20261025'
  OR pg_catalog.pg_is_in_recovery()
  OR pg_catalog.to_regclass('payments.app_meld_funding_attempt') IS NULL
  OR v_policy IS NULL
  OR pg_catalog.to_regprocedure('payments.reserve_app_meld_funding_v3(text,text,uuid,text,text,text,numeric,text,text,text,text)') IS NULL
  OR pg_catalog.to_regprocedure('payments.read_app_meld_funding_v3(text,uuid)') IS NULL
  OR pg_catalog.to_regprocedure('payments.app_meld_funding_us_mercuryo_route_allowed(text,text,numeric,text,text,text)') IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c
   WHERE c.conrelid='payments.app_meld_funding_attempt'::regclass AND c.conname='app_meld_funding_approved_market_check'
    AND c.convalidated AND EXISTS(SELECT 1 FROM pg_catalog.pg_depend d
     WHERE d.classid='pg_catalog.pg_constraint'::regclass AND d.objid=c.oid
      AND d.refclassid='pg_catalog.pg_proc'::regclass AND d.refobjid=v_policy))
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c
   WHERE c.conrelid='payments.app_meld_funding_attempt'::regclass AND c.conname='app_meld_funding_attempt_chain_id_check'
    AND c.convalidated AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%42161%137%') THEN
  RAISE EXCEPTION 'app_meld_us_mercuryo_requires_135'; END IF;
END $preflight$;

CREATE FUNCTION payments.app_meld_funding_us_mercuryo_route_allowed(
 p_country text,p_currency text,p_amount numeric,p_method text,p_provider text,p_asset text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $function$
 SELECT coalesce(
  p_country='US' AND p_currency='USD' AND p_provider='MERCURYO'
  AND p_method IN('CREDIT_DEBIT_CARD','APPLE_PAY','GOOGLE_PAY')
  AND p_asset IN('USDC_POLYGON','USDC_ARBITRUM','USDC')
  AND p_amount BETWEEN 50.00 AND CASE WHEN p_method='CREDIT_DEBIT_CARD' THEN 16000.00 ELSE 2000.00 END
  AND p_amount=pg_catalog.round(p_amount,2),false);
$function$;

CREATE FUNCTION payments.reject_retired_app_meld_funding() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
 RAISE EXCEPTION 'wallet_funding_invalid_request' USING ERRCODE='22023';
END $function$;

CREATE TRIGGER app_meld_funding_retired_us_rampnow BEFORE INSERT ON payments.app_meld_funding_attempt
 FOR EACH ROW WHEN (NEW.country_code='US' AND NEW.source_currency='USD' AND NEW.service_provider='RAMPNOW')
 EXECUTE FUNCTION payments.reject_retired_app_meld_funding();

ALTER TABLE payments.app_meld_funding_attempt
 DROP CONSTRAINT app_meld_funding_approved_market_check,
 ADD CONSTRAINT app_meld_funding_approved_market_check CHECK(
  payments.app_meld_funding_route_allowed(country_code,source_currency,requested_amount,payment_method,service_provider,destination_currency)
  OR payments.app_meld_funding_wallet_route_allowed(country_code,source_currency,requested_amount,payment_method,service_provider,destination_currency)
  OR payments.app_meld_funding_us_mercuryo_route_allowed(country_code,source_currency,requested_amount,payment_method,service_provider,destination_currency));

CREATE OR REPLACE FUNCTION payments.reserve_app_meld_funding_v3(
 p_subject text,p_native_session text,p_id uuid,p_wallet text,p_country text,p_currency text,p_amount numeric,
 p_method text,p_provider text,p_account text,p_asset text)
RETURNS TABLE(id uuid,created_at timestamptz,wallet_address text,customer_reference uuid,created boolean,status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
DECLARE r payments.app_meld_funding_attempt%ROWTYPE; v_customer uuid; v_digest text;
BEGIN
 BEGIN PERFORM identity.require_administrative_native_session(p_subject,p_native_session);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000'; END;
 IF p_id IS NULL OR p_wallet IS NULL OR p_wallet!~'^0x[0-9a-f]{40}$'
  OR p_wallet='0x0000000000000000000000000000000000000000'
  OR p_account IS NULL OR p_account!~'^[A-Za-z0-9_-]{1,128}$'
  OR p_amount IS NULL OR p_amount::text IN('NaN','Infinity','-Infinity') OR p_amount<>pg_catalog.round(p_amount,2)
  OR NOT (payments.app_meld_funding_wallet_route_allowed(p_country,p_currency,p_amount,p_method,p_provider,p_asset)
      OR payments.app_meld_funding_us_mercuryo_route_allowed(p_country,p_currency,p_amount,p_method,p_provider,p_asset)) THEN
  RAISE EXCEPTION 'wallet_funding_invalid_request' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM identity.wallet_binding b WHERE b.subject=p_subject AND b.address=p_wallet) THEN
  RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000'; END IF;
 v_digest:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
  'mindbliss-app-meld-customer-v1:'||p_subject||':'||p_wallet,'UTF8')),'hex');
 v_customer:=(substr(v_digest,1,8)||'-'||substr(v_digest,9,4)||'-8'||substr(v_digest,14,3)||
  '-a'||substr(v_digest,18,3)||'-'||substr(v_digest,21,12))::uuid;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app-meld-funding-owner:'||p_subject,0));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app-meld-funding-attempt:'||p_id::text,0));
 SELECT a.* INTO r FROM payments.app_meld_funding_attempt a WHERE a.id=p_id;
 IF FOUND THEN
  IF (r.subject,r.native_session_id,r.wallet_address,r.customer_reference,r.country_code,r.source_currency,
    r.requested_amount,r.payment_method,r.service_provider,r.account_id,r.destination_currency)
   IS DISTINCT FROM (p_subject,p_native_session,p_wallet,v_customer,p_country,p_currency,p_amount,p_method,p_provider,p_account,p_asset) THEN
   RAISE EXCEPTION 'wallet_funding_request_already_used' USING ERRCODE='23505'; END IF;
  RETURN QUERY SELECT r.id,r.created_at,r.wallet_address,r.customer_reference,false,r.status;
  RETURN;
 END IF;
 IF (SELECT count(*) FROM payments.app_meld_funding_attempt a
  WHERE a.subject=p_subject AND a.created_at>clock_timestamp()-interval '10 minutes')>=10 THEN
  RAISE EXCEPTION 'wallet_funding_rate_limited' USING ERRCODE='54000'; END IF;
 RETURN QUERY INSERT INTO payments.app_meld_funding_attempt AS a
  (id,subject,native_session_id,wallet_address,customer_reference,country_code,source_currency,requested_amount,payment_method,
   service_provider,account_id,destination_currency,chain_id)
 VALUES(p_id,p_subject,p_native_session,p_wallet,v_customer,p_country,p_currency,p_amount,p_method,p_provider,p_account,p_asset,
  CASE p_asset WHEN 'USDC_ARBITRUM' THEN 42161 WHEN 'USDC' THEN 1 ELSE 137 END)
 RETURNING a.id,a.created_at,a.wallet_address,a.customer_reference,true,a.status;
END $function$;

DO $permissions$
DECLARE v_signature text; v_owner name; v_role text;
BEGIN
 SELECT pg_catalog.pg_get_userbyid(proowner) INTO v_owner FROM pg_catalog.pg_proc
  WHERE oid='payments.reserve_app_meld_funding_v3(text,text,uuid,text,text,text,numeric,text,text,text,text)'::regprocedure;
 FOREACH v_signature IN ARRAY ARRAY[
  'payments.app_meld_funding_us_mercuryo_route_allowed(text,text,numeric,text,text,text)',
  'payments.reject_retired_app_meld_funding()'
 ] LOOP
  EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO %I',v_signature,v_owner);
  FOR v_role IN
   SELECT DISTINCT CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(acl.grantee)) END
   FROM pg_catalog.pg_proc p, LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
   WHERE p.oid=v_signature::regprocedure AND acl.grantee<>p.proowner
  LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||v_signature||' FROM '||v_role; END LOOP;
  IF pg_catalog.has_function_privilege('mindbliss_auth_core_v1',v_signature,'EXECUTE') THEN
   RAISE EXCEPTION 'app_meld_us_mercuryo_permissions_changed'; END IF;
 END LOOP;
 IF NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1',
   'payments.reserve_app_meld_funding_v3(text,text,uuid,text,text,text,numeric,text,text,text,text)','EXECUTE')
  OR NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.read_app_meld_funding_v3(text,uuid)','EXECUTE')
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.app_meld_funding_attempt','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  OR NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid='payments.app_meld_funding_attempt'::regclass) THEN
  RAISE EXCEPTION 'app_meld_us_mercuryo_permissions_changed'; END IF;
END $permissions$;
COMMIT;
