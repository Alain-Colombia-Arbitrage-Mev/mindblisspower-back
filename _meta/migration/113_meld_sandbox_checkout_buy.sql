-- Generic Meld Checkout BUY sandbox foundation. No production, old funding, credits or commissions.
BEGIN;
SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('meld-sandbox-checkout-buy-v1',0));
DO $preflight$
BEGIN
 IF pg_catalog.current_database()<>'mindbliss_curated_20261025' OR pg_catalog.pg_is_in_recovery()
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.create_meld_sandbox_funding_attempt_v2(text,text,text,numeric,uuid,text,text,text)'::regprocedure))<>'ac59aee12c97aaed2010090dc22788af'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.record_meld_sandbox_proof(text,uuid,jsonb,text)'::regprocedure))<>'897295b28bfebb9058bc8f1643199bbc'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.read_meld_sandbox_webhook_context(uuid,uuid,text)'::regprocedure))<>'6e08a1b1755ec883fb47592a9c8c54fb'
  OR pg_catalog.to_regclass('payments.meld_checkout_intent') IS NOT NULL
  OR pg_catalog.to_regclass('payments.meld_checkout_webhook_receipt') IS NOT NULL THEN
  RAISE EXCEPTION 'meld_checkout_requires_fresh_review'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid='payments.meld_sandbox_proof'::regclass AND relrowsecurity AND pg_catalog.pg_has_role(relowner,'USAGE'))
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.meld_sandbox_proof','SELECT,INSERT,UPDATE,DELETE') THEN
  RAISE EXCEPTION 'meld_checkout_isolation_required'; END IF;
END $preflight$;
CREATE TABLE payments.meld_checkout_intent(
 id uuid PRIMARY KEY,
 subject text NOT NULL REFERENCES auth."user"(id) ON DELETE RESTRICT,
 environment text NOT NULL DEFAULT 'sandbox' CHECK(environment='sandbox'),
 wallet_kind text NOT NULL DEFAULT 'administrative' CHECK(wallet_kind='administrative'),
 provider text NOT NULL DEFAULT 'meld' CHECK(provider='meld'),
 transaction_type text NOT NULL DEFAULT 'BUY' CHECK(transaction_type='BUY'),
 account_id text NOT NULL CHECK(account_id ~ '^[A-Za-z0-9_.:-]{1,128}$' AND account_id NOT IN('.','..')),
 customer_reference uuid NOT NULL,
 wallet_address text NOT NULL CHECK(wallet_address ~ '^0x[0-9a-f]{40}$'),
 destination_currency text NOT NULL DEFAULT 'USDT_POLYGON' CHECK(destination_currency='USDT_POLYGON'),
 country_code text NOT NULL CHECK(country_code IN('US','MX','CO')),
 source_currency text NOT NULL CHECK(source_currency IN('USD','MXN')),
 requested_amount numeric(18,2) NOT NULL,
 status text NOT NULL DEFAULT 'initiated' CHECK(status IN('initiated','minted','unavailable')),
 mint_url_sha256 text CHECK(mint_url_sha256 ~ '^[0-9a-f]{64}$'),
 provider_session_id text CHECK(provider_session_id ~ '^[A-Za-z0-9_.:-]{1,128}$' AND provider_session_id NOT IN('.','..')),
 transaction_id text UNIQUE CHECK(transaction_id ~ '^[A-Za-z0-9_.:-]{1,128}$' AND transaction_id NOT IN('.','..')),
 proof jsonb CHECK(pg_catalog.jsonb_typeof(proof)='object' AND pg_catalog.pg_column_size(proof)<=16384),
 proof_sha256 text CHECK(proof_sha256 ~ '^[0-9a-f]{64}$'),
 provider_updated_at timestamptz,
 checked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(account_id,provider_session_id),
 CHECK((source_currency='USD' AND requested_amount BETWEEN 50 AND 25000)
   OR(source_currency='MXN' AND country_code='MX' AND requested_amount BETWEEN 1 AND 10000000)),
 CHECK((status='minted' AND mint_url_sha256 IS NOT NULL) OR(status<>'minted' AND mint_url_sha256 IS NULL)),
 CHECK((proof IS NULL AND provider_session_id IS NULL AND transaction_id IS NULL AND proof_sha256 IS NULL AND provider_updated_at IS NULL AND checked_at IS NULL)
  OR(proof IS NOT NULL AND status='minted' AND provider_session_id IS NOT NULL AND transaction_id IS NOT NULL AND proof_sha256 IS NOT NULL AND provider_updated_at IS NOT NULL AND checked_at IS NOT NULL))
);
CREATE TABLE payments.meld_checkout_webhook_receipt(
 event_id text PRIMARY KEY CHECK(event_id ~ '^[A-Za-z0-9_.:-]{1,128}$' AND event_id NOT IN('.','..')),
 event_type text NOT NULL CHECK(event_type IN('TRANSACTION_CRYPTO_PENDING','TRANSACTION_CRYPTO_TRANSFERRING','TRANSACTION_CRYPTO_COMPLETE','TRANSACTION_CRYPTO_FAILED')),
 event_timestamp timestamptz NOT NULL,
 account_id text NOT NULL CHECK(account_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
 profile_id text NOT NULL CHECK(profile_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
 body_sha256 text NOT NULL CHECK(body_sha256 ~ '^[0-9a-f]{64}$'),
 intent_id uuid NOT NULL REFERENCES payments.meld_checkout_intent(id) ON DELETE RESTRICT,
 environment text NOT NULL DEFAULT 'sandbox' CHECK(environment='sandbox'),received_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE payments.meld_checkout_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments.meld_checkout_webhook_receipt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON payments.meld_checkout_intent,payments.meld_checkout_webhook_receipt FROM PUBLIC,mindbliss_auth_core_v1;
CREATE FUNCTION payments.create_meld_sandbox_checkout_intent(p_subject text,p_address text,p_country text,p_amount numeric,p_reference uuid,p_currency text,p_account text)
RETURNS TABLE(id uuid,created_at timestamptz,created boolean,status text,customer_reference uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_customer uuid;r payments.meld_checkout_intent%ROWTYPE;
BEGIN
 BEGIN PERFORM identity.administrative_wallet_person(p_subject);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000'; END;
 IF p_address IS NULL OR p_address !~ '^0x[0-9a-f]{40}$' OR p_country IS NULL OR p_country NOT IN('US','MX','CO')
  OR p_amount IS NULL OR p_amount<>round(p_amount,2) OR p_reference IS NULL OR p_currency IS NULL OR p_currency NOT IN('USD','MXN')
  OR(p_currency='USD' AND NOT(p_amount BETWEEN 50 AND 25000))
  OR(p_currency='MXN' AND(p_country<>'MX' OR NOT(p_amount BETWEEN 1 AND 10000000)))
  OR p_account IS NULL OR p_account !~ '^[A-Za-z0-9_.:-]{1,128}$' OR p_account IN('.','..') THEN
  RAISE EXCEPTION 'wallet_funding_invalid_request' USING ERRCODE='22023';END IF;
 SELECT a.checkout_reference INTO v_customer FROM identity.administrative_wallet_assignment a
 JOIN identity.administrative_wallet_pool p ON p.ordinal=a.pool_ordinal AND p.address=p_address AND p.status='available'
 WHERE a.subject=p_subject FOR SHARE OF a,p;
 IF v_customer IS NULL THEN RAISE EXCEPTION 'wallet_funding_wallet_not_assigned' USING ERRCODE='28000';END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('meld-checkout-owner:'||p_subject,0));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('meld-checkout-reference:'||p_reference::text,0));
 SELECT * INTO r FROM payments.meld_checkout_intent a WHERE a.id=p_reference;
 IF FOUND THEN
  IF r.subject<>p_subject OR r.wallet_address<>p_address OR r.country_code<>p_country OR r.requested_amount<>p_amount
   OR r.source_currency<>p_currency OR r.account_id<>p_account OR r.customer_reference<>v_customer THEN
   RAISE EXCEPTION 'wallet_funding_request_already_used' USING ERRCODE='22023';END IF;
  RETURN QUERY SELECT r.id,r.created_at,false,r.status,r.customer_reference;RETURN;
 END IF;
 IF EXISTS(SELECT 1 FROM payments.meld_sandbox_funding_attempt a WHERE a.id=p_reference)
  OR EXISTS(SELECT 1 FROM payments.reown_funding_intent a WHERE a.id=p_reference) THEN
  RAISE EXCEPTION 'wallet_funding_request_already_used' USING ERRCODE='22023';END IF;
 IF (SELECT count(*) FROM payments.meld_checkout_intent a WHERE a.subject=p_subject AND a.created_at>now()-interval '10 minutes')>=10 THEN
  RAISE EXCEPTION 'wallet_funding_rate_limited' USING ERRCODE='54000';END IF;
 RETURN QUERY INSERT INTO payments.meld_checkout_intent(id,subject,account_id,customer_reference,wallet_address,country_code,source_currency,requested_amount)
 VALUES(p_reference,p_subject,p_account,v_customer,p_address,p_country,p_currency,p_amount)
 RETURNING meld_checkout_intent.id,meld_checkout_intent.created_at,true,meld_checkout_intent.status,meld_checkout_intent.customer_reference;
END $function$;
CREATE FUNCTION payments.finish_meld_sandbox_checkout_mint(p_subject text,p_reference uuid,p_status text,p_hash text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE r payments.meld_checkout_intent%ROWTYPE;
BEGIN
 BEGIN PERFORM identity.administrative_wallet_person(p_subject);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000';END;
 IF p_reference IS NULL OR p_status IS NULL OR p_status NOT IN('minted','unavailable')
  OR(p_status='minted' AND(p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$')) OR(p_status='unavailable' AND p_hash IS NOT NULL) THEN
  RAISE EXCEPTION 'wallet_funding_invalid_request' USING ERRCODE='22023';END IF;
 SELECT * INTO r FROM payments.meld_checkout_intent a WHERE a.id=p_reference AND a.subject=p_subject FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000';END IF;
 IF r.status<>'initiated' THEN RETURN r.status=p_status AND r.mint_url_sha256 IS NOT DISTINCT FROM p_hash;END IF;
 UPDATE payments.meld_checkout_intent SET status=p_status,mint_url_sha256=p_hash,updated_at=now() WHERE id=r.id;
 RETURN true;
END $function$;
CREATE FUNCTION payments.read_meld_checkout_context(p_subject text,p_reference uuid)
RETURNS TABLE(id uuid,subject text,account_id text,customer_reference uuid,wallet_address text,country_code text,requested_amount numeric,source_currency text,
 status text,created_at timestamptz,provider_session_id text,transaction_id text,proof jsonb,checked_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
 BEGIN PERFORM identity.administrative_wallet_person(p_subject);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000';END;
 RETURN QUERY SELECT r.id,r.subject,r.account_id,r.customer_reference,r.wallet_address,r.country_code,r.requested_amount,r.source_currency,
  r.status,r.created_at,r.provider_session_id,r.transaction_id,r.proof,r.checked_at FROM payments.meld_checkout_intent r
 WHERE r.subject=p_subject AND r.id=p_reference;
END $function$;
CREATE FUNCTION payments.read_meld_checkout_history(p_subject text)
RETURNS TABLE(id uuid,subject text,account_id text,customer_reference uuid,wallet_address text,country_code text,requested_amount numeric,source_currency text,
 status text,created_at timestamptz,provider_session_id text,transaction_id text,proof jsonb,checked_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
 BEGIN PERFORM identity.administrative_wallet_person(p_subject);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000';END;
 RETURN QUERY SELECT r.id,r.subject,r.account_id,r.customer_reference,r.wallet_address,r.country_code,r.requested_amount,r.source_currency,
  r.status,r.created_at,r.provider_session_id,r.transaction_id,r.proof,r.checked_at FROM payments.meld_checkout_intent r
 WHERE r.subject=p_subject ORDER BY r.created_at DESC,r.id DESC LIMIT 20;
END $function$;
CREATE FUNCTION payments.read_meld_checkout_webhook_context(p_reference uuid,p_customer uuid)
RETURNS TABLE(id uuid,subject text,account_id text,customer_reference uuid,wallet_address text,country_code text,requested_amount numeric,source_currency text,
 status text,created_at timestamptz,provider_session_id text,transaction_id text,proof jsonb,checked_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_subject text;
BEGIN
 SELECT r.subject INTO v_subject FROM payments.meld_checkout_intent r WHERE r.id=p_reference AND r.customer_reference=p_customer AND r.status='minted';
 IF v_subject IS NULL THEN RETURN;END IF;
 RETURN QUERY SELECT * FROM payments.read_meld_checkout_context(v_subject,p_reference);
END $function$;
CREATE FUNCTION payments.record_meld_checkout_proof(p_subject text,p_reference uuid,p_proof jsonb,p_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE r payments.meld_checkout_intent%ROWTYPE;v_time timestamptz;v_received numeric;v_old text;
BEGIN
 BEGIN PERFORM identity.administrative_wallet_person(p_subject);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000';END;
 IF p_reference IS NULL OR p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' OR p_proof IS NULL OR pg_catalog.jsonb_typeof(p_proof)<>'object'
  OR(SELECT count(*) FROM pg_catalog.jsonb_each(p_proof))<>16 OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_each(p_proof) x
   WHERE pg_catalog.jsonb_typeof(x.value)<>'string' OR x.key NOT IN('transactionId','accountId','sessionId','externalSessionId','externalCustomerId',
    'serviceProvider','countryCode','sourceCurrencyCode','sourceAmount','destinationCurrencyCode','walletAddress','chainId','providerStatus','providerUpdatedAt','receivedAmount','paymentMethodType')) THEN
  RAISE EXCEPTION 'meld_checkout_proof_invalid' USING ERRCODE='22023';END IF;
 IF p_proof->>'transactionId' !~ '^[A-Za-z0-9_.:-]{1,128}$' OR p_proof->>'transactionId' IN('.','..')
  OR p_proof->>'sessionId' !~ '^[A-Za-z0-9_.:-]{1,128}$' OR p_proof->>'sessionId' IN('.','..')
  OR p_proof->>'serviceProvider' NOT IN('BANXA','TRANSAK') OR p_proof->>'paymentMethodType' !~ '^[A-Z0-9_]{2,40}$'
  OR p_proof->>'sourceAmount' !~ '^\d{1,10}\.\d{2}$' OR p_proof->>'receivedAmount' !~ '^\d{1,12}(\.\d{1,6})?$'
  OR p_proof->>'providerUpdatedAt' !~ '^\d{4}-\d{2}-\d{2}T.{1,48}$'
  OR p_proof->>'providerStatus' NOT IN('PENDING_CREATED','PENDING','PROCESSING','AUTHORIZED','ACCEPTED','PARTIALLY_SETTLED','SETTLING',
   'TWO_FA_REQUIRED','TWO_FA_PROVIDED','ERROR','SETTLED','FAILED','DECLINED','CANCELLED','REFUNDED','VOIDED','AUTHORIZATION_EXPIRED') THEN
  RAISE EXCEPTION 'meld_checkout_proof_invalid' USING ERRCODE='22023';END IF;
 BEGIN v_time:=(p_proof->>'providerUpdatedAt')::timestamptz;v_received:=(p_proof->>'receivedAmount')::numeric;
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'meld_checkout_proof_invalid' USING ERRCODE='22023';END;
 IF NOT pg_catalog.isfinite(v_time) OR v_received<0 OR v_received>1000000000 OR(p_proof->>'providerStatus'='SETTLED' AND v_received<=0) THEN
  RAISE EXCEPTION 'meld_checkout_proof_invalid' USING ERRCODE='22023';END IF;
 SELECT * INTO r FROM payments.meld_checkout_intent a WHERE a.id=p_reference AND a.subject=p_subject FOR UPDATE;
 IF NOT FOUND OR r.status<>'minted' THEN RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000';END IF;
 PERFORM 1 FROM identity.administrative_wallet_assignment a JOIN identity.administrative_wallet_pool p ON p.ordinal=a.pool_ordinal
  WHERE a.subject=p_subject AND a.checkout_reference=r.customer_reference AND p.address=r.wallet_address AND p.status='available' FOR SHARE OF a,p;
 IF NOT FOUND OR p_proof->>'externalSessionId'<>r.id::text OR p_proof->>'externalCustomerId'<>r.customer_reference::text
  OR p_proof->>'accountId'<>r.account_id OR p_proof->>'countryCode'<>r.country_code OR p_proof->>'sourceCurrencyCode'<>r.source_currency
  OR(p_proof->>'sourceAmount')::numeric<>r.requested_amount OR p_proof->>'destinationCurrencyCode'<>'USDT_POLYGON'
  OR p_proof->>'walletAddress'<>r.wallet_address OR p_proof->>'chainId'<>'137' THEN
  RAISE EXCEPTION 'meld_checkout_proof_context_mismatch' USING ERRCODE='22023';END IF;
 IF r.proof IS NOT NULL THEN
  IF r.provider_session_id<>p_proof->>'sessionId' OR r.transaction_id<>p_proof->>'transactionId'
   OR r.proof->>'serviceProvider'<>p_proof->>'serviceProvider' OR r.proof->>'paymentMethodType'<>p_proof->>'paymentMethodType' THEN
   RAISE EXCEPTION 'meld_checkout_proof_session_conflict' USING ERRCODE='23505';END IF;
  IF v_time<r.provider_updated_at THEN RETURN r.proof;END IF;
  IF v_time=r.provider_updated_at AND p_proof<>r.proof THEN RAISE EXCEPTION 'meld_checkout_proof_version_conflict' USING ERRCODE='23505';END IF;
  v_old:=r.proof->>'providerStatus';
  IF v_old IN('SETTLED','FAILED','DECLINED','CANCELLED','REFUNDED','VOIDED','AUTHORIZATION_EXPIRED')
   AND p_proof->>'providerStatus' IN('PENDING_CREATED','PENDING','PROCESSING','AUTHORIZED','ACCEPTED','PARTIALLY_SETTLED','SETTLING','TWO_FA_REQUIRED','TWO_FA_PROVIDED','ERROR') THEN RETURN r.proof;END IF;
 END IF;
 UPDATE payments.meld_checkout_intent SET provider_session_id=p_proof->>'sessionId',transaction_id=p_proof->>'transactionId',proof=p_proof,
  proof_sha256=p_hash,provider_updated_at=v_time,checked_at=now(),updated_at=now() WHERE id=r.id;
 RETURN p_proof;
END $function$;
CREATE FUNCTION payments.record_meld_checkout_webhook_receipt(p_event text,p_type text,p_time timestamptz,p_account text,p_profile text,p_hash text,p_reference uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE r payments.meld_checkout_webhook_receipt%ROWTYPE;v_count integer;
BEGIN
 IF p_event IS NULL OR p_event !~ '^[A-Za-z0-9_.:-]{1,128}$' OR p_event IN('.','..') OR p_type IS NULL
  OR p_type NOT IN('TRANSACTION_CRYPTO_PENDING','TRANSACTION_CRYPTO_TRANSFERRING','TRANSACTION_CRYPTO_COMPLETE','TRANSACTION_CRYPTO_FAILED')
  OR p_time IS NULL OR NOT pg_catalog.isfinite(p_time) OR p_account IS NULL OR p_account !~ '^[A-Za-z0-9_.:-]{1,128}$'
  OR p_profile IS NULL OR p_profile !~ '^[A-Za-z0-9_.:-]{1,128}$' OR p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' OR p_reference IS NULL THEN
  RAISE EXCEPTION 'meld_checkout_receipt_invalid' USING ERRCODE='22023';END IF;
 IF NOT EXISTS(SELECT 1 FROM payments.meld_checkout_intent a WHERE a.id=p_reference AND a.status='minted' AND a.account_id=p_account) THEN
  RAISE EXCEPTION 'meld_checkout_receipt_invalid' USING ERRCODE='22023';END IF;
 INSERT INTO payments.meld_checkout_webhook_receipt(event_id,event_type,event_timestamp,account_id,profile_id,body_sha256,intent_id)
  VALUES(p_event,p_type,p_time,p_account,p_profile,p_hash,p_reference) ON CONFLICT(event_id) DO NOTHING;
 GET DIAGNOSTICS v_count=ROW_COUNT;
 IF v_count=0 THEN SELECT * INTO r FROM payments.meld_checkout_webhook_receipt a WHERE a.event_id=p_event;
  IF r.event_type<>p_type OR r.event_timestamp<>p_time OR r.account_id<>p_account OR r.profile_id<>p_profile OR r.body_sha256<>p_hash OR r.intent_id<>p_reference THEN
   RAISE EXCEPTION 'meld_checkout_receipt_collision' USING ERRCODE='23505';END IF;
 END IF;
 RETURN v_count=1;
END $function$;
REVOKE ALL ON FUNCTION payments.create_meld_sandbox_checkout_intent(text,text,text,numeric,uuid,text,text),payments.finish_meld_sandbox_checkout_mint(text,uuid,text,text),
 payments.read_meld_checkout_context(text,uuid),payments.read_meld_checkout_history(text),payments.read_meld_checkout_webhook_context(uuid,uuid),
 payments.record_meld_checkout_proof(text,uuid,jsonb,text),payments.record_meld_checkout_webhook_receipt(text,text,timestamptz,text,text,text,uuid) FROM PUBLIC;
DO $owners$
DECLARE v_owner text;v_signature text;v_table text;item record;
BEGIN
 SELECT pg_catalog.pg_get_userbyid(proowner) INTO v_owner FROM pg_catalog.pg_proc WHERE oid='payments.create_meld_sandbox_funding_attempt_v2(text,text,text,numeric,uuid,text,text,text)'::regprocedure;
 FOREACH v_table IN ARRAY ARRAY['payments.meld_checkout_intent','payments.meld_checkout_webhook_receipt'] LOOP
  EXECUTE pg_catalog.format('ALTER TABLE %s OWNER TO %I',v_table,v_owner);
  FOR item IN SELECT DISTINCT a.grantee FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a WHERE c.oid=v_table::regclass AND a.grantee<>c.relowner LOOP
   IF item.grantee=0 THEN EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %s FROM PUBLIC',v_table);
   ELSE EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %s FROM %I',v_table,pg_catalog.pg_get_userbyid(item.grantee));END IF;
  END LOOP;
 END LOOP;
 FOREACH v_signature IN ARRAY ARRAY['payments.create_meld_sandbox_checkout_intent(text,text,text,numeric,uuid,text,text)','payments.finish_meld_sandbox_checkout_mint(text,uuid,text,text)',
  'payments.read_meld_checkout_context(text,uuid)','payments.read_meld_checkout_history(text)','payments.read_meld_checkout_webhook_context(uuid,uuid)',
  'payments.record_meld_checkout_proof(text,uuid,jsonb,text)','payments.record_meld_checkout_webhook_receipt(text,text,timestamptz,text,text,text,uuid)'] LOOP
  EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO %I',v_signature,v_owner);
  FOR item IN SELECT DISTINCT a.grantee FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a WHERE p.oid=v_signature::regprocedure AND a.grantee<>p.proowner AND a.grantee<>0 LOOP
   EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %I',v_signature,pg_catalog.pg_get_userbyid(item.grantee));END LOOP;
  EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO mindbliss_auth_core_v1',v_signature);
 END LOOP;
END $owners$;
DO $verify$
DECLARE v_signature text;v_owner oid;v_table text;
BEGIN
 SELECT proowner INTO v_owner FROM pg_catalog.pg_proc WHERE oid='payments.create_meld_sandbox_funding_attempt_v2(text,text,text,numeric,uuid,text,text,text)'::regprocedure;
 FOREACH v_table IN ARRAY ARRAY['payments.meld_checkout_intent','payments.meld_checkout_webhook_receipt'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid=v_table::regclass AND relowner=v_owner AND relrowsecurity)
   OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1',v_table,'SELECT,INSERT,UPDATE,DELETE')
   OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a WHERE c.oid=v_table::regclass AND a.grantee<>c.relowner) THEN
   RAISE EXCEPTION 'meld_checkout_isolation_failed';END IF;
 END LOOP;
 FOREACH v_signature IN ARRAY ARRAY['payments.create_meld_sandbox_checkout_intent(text,text,text,numeric,uuid,text,text)','payments.finish_meld_sandbox_checkout_mint(text,uuid,text,text)',
  'payments.read_meld_checkout_context(text,uuid)','payments.read_meld_checkout_history(text)','payments.read_meld_checkout_webhook_context(uuid,uuid)',
  'payments.record_meld_checkout_proof(text,uuid,jsonb,text)','payments.record_meld_checkout_webhook_receipt(text,text,timestamptz,text,text,text,uuid)'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid=v_signature::regprocedure AND proowner=v_owner AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog']::text[])
   OR NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1',v_signature,'EXECUTE') OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
    WHERE p.oid=v_signature::regprocedure AND a.grantee<>p.proowner AND a.grantee<>'mindbliss_auth_core_v1'::regrole) THEN RAISE EXCEPTION 'meld_checkout_isolation_failed';END IF;
 END LOOP;
END $verify$;
COMMIT;
