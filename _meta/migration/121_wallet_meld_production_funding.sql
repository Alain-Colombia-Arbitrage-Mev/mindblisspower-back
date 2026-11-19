-- Wallet portal production funding. Ownership remains the reviewed SQL116
-- Reown binding; sandbox attempts and all financial journals remain separate.
-- These functions only record preparations/provider facts, never money or fees.
BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallet-meld-production-funding-v1',0));
DO $preflight$
DECLARE v_owner oid;
BEGIN
 IF pg_catalog.current_database()<>'mindbliss_curated_20261025' OR pg_catalog.pg_is_in_recovery()
  OR pg_catalog.to_regclass('payments.wallet_meld_production_attempt') IS NOT NULL
  OR pg_catalog.to_regprocedure('payments.create_wallet_meld_production_attempt(text,text,uuid,text,numeric,text,text,text,text)') IS NOT NULL
  OR pg_catalog.to_regprocedure('identity.require_sandbox_wallet_binding(text,text)') IS NULL
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('identity.require_administrative_native_session(text,text)'::regprocedure))<>'01bb63725c11ae353cb768a42ffa9485'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('identity.require_sandbox_wallet_binding(text,text)'::regprocedure))<>'926fd3bc5274532ff8c03c5702115661' THEN
  RAISE EXCEPTION 'wallet_production_requires_fresh_review'; END IF;
 SELECT proowner INTO v_owner FROM pg_catalog.pg_proc WHERE oid='identity.require_administrative_native_session(text,text)'::regprocedure;
 IF NOT pg_catalog.pg_has_role(v_owner,'USAGE')
  OR NOT EXISTS(SELECT FROM pg_catalog.pg_proc WHERE oid='identity.require_sandbox_wallet_binding(text,text)'::regprocedure
   AND proowner=v_owner AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog']::text[])
  OR NOT pg_catalog.has_schema_privilege('mindbliss_auth_core_v1','payments','USAGE') THEN
  RAISE EXCEPTION 'wallet_production_native_identity_required'; END IF;
END $preflight$;

CREATE TABLE payments.wallet_meld_production_attempt(
 id uuid PRIMARY KEY,subject text NOT NULL REFERENCES auth."user"(id) ON DELETE RESTRICT,
 native_session_id text NOT NULL CHECK(length(native_session_id) BETWEEN 1 AND 255),
 wallet_address text NOT NULL CHECK(wallet_address~'^0x[0-9a-f]{40}$' AND wallet_address<>'0x0000000000000000000000000000000000000000'),
 customer_reference uuid NOT NULL,
 environment text NOT NULL DEFAULT 'production' CHECK(environment='production'),
 transaction_type text NOT NULL DEFAULT 'BUY' CHECK(transaction_type='BUY'),
 destination_currency text NOT NULL DEFAULT 'USDT_POLYGON' CHECK(destination_currency='USDT_POLYGON'),
 chain_id integer NOT NULL DEFAULT 137 CHECK(chain_id=137),
 country_code text NOT NULL CHECK(country_code~'^[A-Z]{2}$'),
 source_currency text NOT NULL CHECK(source_currency~'^[A-Z]{3}$'),
 requested_amount numeric(15,2) NOT NULL CHECK((source_currency='USD' AND requested_amount BETWEEN 50 AND 25000)
  OR(source_currency<>'USD' AND requested_amount BETWEEN 0.01 AND 1000000000)),
 service_provider text NOT NULL CHECK(service_provider~'^[A-Z0-9_]{2,64}$' AND service_provider NOT IN('MERCURYO','BINANCECONNECT','BINANCE_CONNECT')),
 payment_method text NOT NULL CHECK(payment_method~'^[A-Z0-9_]{2,64}$'),
 account_id text NOT NULL CHECK(account_id~'^[A-Za-z0-9_.:-]{1,128}$' AND account_id NOT IN('.','..')),
 status text NOT NULL DEFAULT 'initiated' CHECK(status IN('initiated','session_created','unavailable')),
 provider_session_id text CHECK(provider_session_id~'^[A-Za-z0-9_.:-]{1,128}$' AND provider_session_id NOT IN('.','..')),
 provider_customer_id text CHECK(provider_customer_id~'^[A-Za-z0-9_.:-]{1,128}$' AND provider_customer_id NOT IN('.','..')),
 transaction_id text UNIQUE CHECK(transaction_id~'^[A-Za-z0-9_.:-]{1,128}$' AND transaction_id NOT IN('.','..')),
 proof jsonb CHECK(pg_catalog.jsonb_typeof(proof)='object' AND pg_catalog.pg_column_size(proof)<=16384),
 proof_hash text CHECK(proof_hash~'^[0-9a-f]{64}$'),provider_updated_at timestamptz,checked_at timestamptz,
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
 UNIQUE(account_id,provider_session_id),
 CHECK((status='session_created' AND provider_session_id IS NOT NULL AND provider_customer_id IS NOT NULL)
  OR(status<>'session_created' AND provider_session_id IS NULL AND provider_customer_id IS NULL)),
 CHECK((proof IS NULL AND transaction_id IS NULL AND proof_hash IS NULL AND provider_updated_at IS NULL AND checked_at IS NULL)
  OR(proof IS NOT NULL AND status='session_created' AND transaction_id IS NOT NULL AND proof_hash IS NOT NULL AND provider_updated_at IS NOT NULL AND checked_at IS NOT NULL))
);
CREATE INDEX wallet_meld_production_subject_created_idx ON payments.wallet_meld_production_attempt(subject,created_at DESC,id DESC);
ALTER TABLE payments.wallet_meld_production_attempt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON payments.wallet_meld_production_attempt FROM PUBLIC,mindbliss_auth_core_v1;

-- A verified address remains a safe deposit destination after its signing
-- lease expires. This is never a signing, transfer or session-restoration grant.
CREATE FUNCTION identity.read_wallet_meld_production_binding(p_subject text,p_session text)
RETURNS TABLE(address text,binding_reference uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
DECLARE b identity.sandbox_wallet_binding%ROWTYPE;c identity.sandbox_wallet_challenge%ROWTYPE;
BEGIN
 PERFORM identity.require_administrative_native_session(p_subject,p_session);
 SELECT * INTO b FROM identity.sandbox_wallet_binding x WHERE x.subject=p_subject FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'wallet_production_verification_required' USING ERRCODE='28000'; END IF;
 SELECT * INTO c FROM identity.sandbox_wallet_challenge x WHERE x.id=b.challenge_id AND x.subject=p_subject FOR SHARE;
 IF NOT FOUND OR c.native_session_id IS DISTINCT FROM b.native_session_id OR c.wallet_address IS DISTINCT FROM b.wallet_address
  OR c.chain_id<>137 OR b.chain_id<>137 OR c.consumed_at IS DISTINCT FROM b.verified_at OR c.invalidated_at IS NOT NULL
  OR c.signature_hash IS NULL OR c.signature_hash!~'^[0-9a-f]{64}$' OR c.message_hash IS DISTINCT FROM pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(c.message,'UTF8')),'hex')
  OR c.session_context_hash IS DISTINCT FROM pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_subject||E'\n'||b.native_session_id,'UTF8')),'hex')
  OR NOT pg_catalog.isfinite(c.issued_at) OR NOT pg_catalog.isfinite(c.expires_at)
  OR c.consumed_at<c.issued_at OR c.consumed_at>=c.expires_at
  OR NOT pg_catalog.isfinite(b.verified_at) OR b.verified_at>clock_timestamp() THEN
  RAISE EXCEPTION 'wallet_production_verification_required' USING ERRCODE='28000'; END IF;
 RETURN QUERY SELECT b.wallet_address,b.binding_reference;
END $function$;

CREATE FUNCTION payments.protect_wallet_meld_production_attempt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'wallet_production_attempt_immutable' USING ERRCODE='23514'; END IF;
 IF (pg_catalog.to_jsonb(NEW)-ARRAY['status','provider_session_id','provider_customer_id','transaction_id','proof','proof_hash','provider_updated_at','checked_at','updated_at'])
  IS DISTINCT FROM(pg_catalog.to_jsonb(OLD)-ARRAY['status','provider_session_id','provider_customer_id','transaction_id','proof','proof_hash','provider_updated_at','checked_at','updated_at'])
  OR(OLD.status<>'initiated' AND(NEW.status IS DISTINCT FROM OLD.status OR NEW.provider_session_id IS DISTINCT FROM OLD.provider_session_id
   OR NEW.provider_customer_id IS DISTINCT FROM OLD.provider_customer_id)) THEN
  RAISE EXCEPTION 'wallet_production_attempt_immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER wallet_meld_production_snapshot_immutable BEFORE UPDATE ON payments.wallet_meld_production_attempt
 FOR EACH ROW EXECUTE FUNCTION payments.protect_wallet_meld_production_attempt();
CREATE TRIGGER wallet_meld_production_no_delete BEFORE DELETE OR TRUNCATE ON payments.wallet_meld_production_attempt
 FOR EACH STATEMENT EXECUTE FUNCTION payments.protect_wallet_meld_production_attempt();

CREATE FUNCTION payments.create_wallet_meld_production_attempt(p_subject text,p_session text,p_id uuid,p_country text,p_amount numeric,p_currency text,p_method text,p_provider text,p_account text)
RETURNS TABLE(id uuid,address text,customer_reference uuid,created boolean,status text,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
DECLARE b record;r payments.wallet_meld_production_attempt%ROWTYPE;v_now timestamptz;
BEGIN
 PERFORM identity.require_administrative_native_session(p_subject,p_session);
 IF p_id IS NULL OR p_country IS NULL OR p_country!~'^[A-Z]{2}$' OR p_currency IS NULL OR p_currency!~'^[A-Z]{3}$'
  OR p_amount IS NULL OR p_amount::text IN('NaN','Infinity','-Infinity') OR p_amount<>round(p_amount,2)
  OR NOT((p_currency='USD' AND p_amount BETWEEN 50 AND 25000) OR(p_currency<>'USD' AND p_amount BETWEEN 0.01 AND 1000000000))
  OR p_method IS NULL OR p_method!~'^[A-Z0-9_]{2,64}$' OR p_provider IS NULL OR p_provider!~'^[A-Z0-9_]{2,64}$'
  OR p_provider IN('MERCURYO','BINANCECONNECT','BINANCE_CONNECT')
  OR p_account IS NULL OR p_account!~'^[A-Za-z0-9_.:-]{1,128}$' OR p_account IN('.','..') THEN
  RAISE EXCEPTION 'wallet_production_invalid_request' USING ERRCODE='22023'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallet-meld-production-owner:'||p_subject,0));
 SELECT * INTO b FROM identity.read_wallet_meld_production_binding(p_subject,p_session);
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallet-meld-production-attempt-id:'||p_id::text,0));
 SELECT * INTO r FROM payments.wallet_meld_production_attempt a WHERE a.id=p_id;
 IF FOUND THEN
  IF r.subject<>p_subject OR r.native_session_id<>p_session OR r.wallet_address<>b.address OR r.customer_reference<>b.binding_reference
   OR r.country_code<>p_country OR r.requested_amount<>p_amount OR r.source_currency<>p_currency OR r.payment_method<>p_method
   OR r.service_provider<>p_provider OR r.account_id<>p_account THEN
   RAISE EXCEPTION 'wallet_production_request_already_used' USING ERRCODE='23505'; END IF;
  RETURN QUERY SELECT r.id,r.wallet_address,r.customer_reference,false,r.status,r.created_at; RETURN;
 END IF;
 v_now:=clock_timestamp();
 IF(SELECT count(*) FROM payments.wallet_meld_production_attempt a WHERE a.subject=p_subject AND a.created_at>v_now-interval '10 minutes')>=10 THEN
  RAISE EXCEPTION 'wallet_production_rate_limited' USING ERRCODE='54000'; END IF;
 RETURN QUERY INSERT INTO payments.wallet_meld_production_attempt(id,subject,native_session_id,wallet_address,customer_reference,
  country_code,source_currency,requested_amount,payment_method,service_provider,account_id,created_at,updated_at)
 VALUES(p_id,p_subject,p_session,b.address,b.binding_reference,p_country,p_currency,p_amount,p_method,p_provider,p_account,v_now,v_now)
 RETURNING wallet_meld_production_attempt.id,wallet_meld_production_attempt.wallet_address,wallet_meld_production_attempt.customer_reference,
  true,wallet_meld_production_attempt.status,wallet_meld_production_attempt.created_at;
END $function$;

CREATE FUNCTION payments.finish_wallet_meld_production_attempt(p_subject text,p_session text,p_id uuid,p_status text,p_provider_session text,p_provider_customer text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
DECLARE b record;r payments.wallet_meld_production_attempt%ROWTYPE;
BEGIN
 PERFORM identity.require_administrative_native_session(p_subject,p_session);
 IF p_id IS NULL OR p_status IS NULL OR p_status NOT IN('session_created','unavailable')
  OR(p_status='session_created' AND(p_provider_session IS NULL OR p_provider_session!~'^[A-Za-z0-9_.:-]{1,128}$' OR p_provider_session IN('.','..')
   OR p_provider_customer IS NULL OR p_provider_customer!~'^[A-Za-z0-9_.:-]{1,128}$' OR p_provider_customer IN('.','..')))
  OR(p_status='unavailable' AND(p_provider_session IS NOT NULL OR p_provider_customer IS NOT NULL)) THEN
  RAISE EXCEPTION 'wallet_production_invalid_request' USING ERRCODE='22023'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallet-meld-production-owner:'||p_subject,0));
 SELECT * INTO b FROM identity.read_wallet_meld_production_binding(p_subject,p_session);
 SELECT * INTO r FROM payments.wallet_meld_production_attempt a WHERE a.id=p_id AND a.subject=p_subject AND a.native_session_id=p_session FOR UPDATE;
 IF NOT FOUND OR r.wallet_address<>b.address OR r.customer_reference<>b.binding_reference THEN
  RAISE EXCEPTION 'wallet_production_forbidden' USING ERRCODE='28000'; END IF;
 IF r.status<>'initiated' THEN RETURN r.status=p_status AND r.provider_session_id IS NOT DISTINCT FROM p_provider_session
  AND r.provider_customer_id IS NOT DISTINCT FROM p_provider_customer; END IF;
 UPDATE payments.wallet_meld_production_attempt SET status=p_status,provider_session_id=p_provider_session,
  provider_customer_id=p_provider_customer,updated_at=clock_timestamp() WHERE wallet_meld_production_attempt.id=r.id;
 RETURN true;
END $function$;

CREATE FUNCTION payments.read_wallet_meld_production_attempt(p_subject text,p_session text,p_id uuid)
RETURNS TABLE(id uuid,subject text,address text,customer_reference uuid,account_id text,country_code text,source_currency text,requested_amount numeric,
 service_provider text,payment_method text,status text,provider_session_id text,provider_customer_id text,created_at timestamptz,updated_at timestamptz,proof jsonb,checked_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
BEGIN
 PERFORM identity.require_administrative_native_session(p_subject,p_session);
 RETURN QUERY SELECT r.id,r.subject,r.wallet_address,r.customer_reference,r.account_id,r.country_code,r.source_currency,r.requested_amount,
  r.service_provider,r.payment_method,r.status,r.provider_session_id,r.provider_customer_id,r.created_at,r.updated_at,r.proof,r.checked_at
 FROM payments.wallet_meld_production_attempt r WHERE r.id=p_id AND r.subject=p_subject;
END $function$;
CREATE FUNCTION payments.read_wallet_meld_production_history(p_subject text,p_session text)
RETURNS TABLE(id uuid,subject text,address text,customer_reference uuid,account_id text,country_code text,source_currency text,requested_amount numeric,
 service_provider text,payment_method text,status text,provider_session_id text,provider_customer_id text,created_at timestamptz,updated_at timestamptz,proof jsonb,checked_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
BEGIN
 PERFORM identity.require_administrative_native_session(p_subject,p_session);
 RETURN QUERY SELECT r.id,r.subject,r.wallet_address,r.customer_reference,r.account_id,r.country_code,r.source_currency,r.requested_amount,
  r.service_provider,r.payment_method,r.status,r.provider_session_id,r.provider_customer_id,r.created_at,r.updated_at,r.proof,r.checked_at
 FROM payments.wallet_meld_production_attempt r WHERE r.subject=p_subject ORDER BY r.created_at DESC,r.id DESC LIMIT 20;
END $function$;

CREATE FUNCTION payments.record_wallet_meld_production_proof(p_subject text,p_id uuid,p_proof jsonb,p_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
DECLARE r payments.wallet_meld_production_attempt%ROWTYPE;v_time timestamptz;v_amount numeric;v_old text;
BEGIN
 -- Only the trusted Native provider reader calls this recorder. A callback,
 -- browser body or this journal alone must never post a financial credit.
 BEGIN PERFORM identity.administrative_wallet_person(p_subject);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'wallet_production_forbidden' USING ERRCODE='28000'; END;
 IF p_id IS NULL OR p_hash IS NULL OR p_hash!~'^[0-9a-f]{64}$' OR p_proof IS NULL OR pg_catalog.jsonb_typeof(p_proof) IS DISTINCT FROM 'object'
  OR pg_catalog.pg_column_size(p_proof)>16384 OR(SELECT count(*) FROM pg_catalog.jsonb_each(p_proof))<>16
  OR NOT(p_proof ?& ARRAY['transactionId','accountId','sessionId','externalSessionId','externalCustomerId','serviceProvider','countryCode','sourceCurrencyCode',
   'sourceAmount','destinationCurrencyCode','walletAddress','chainId','providerStatus','providerUpdatedAt','receivedAmount','paymentMethodType']::text[])
  OR EXISTS(SELECT FROM pg_catalog.jsonb_each(p_proof) x WHERE pg_catalog.jsonb_typeof(x.value) IS DISTINCT FROM 'string'
   OR x.key NOT IN('transactionId','accountId','sessionId','externalSessionId','externalCustomerId','serviceProvider','countryCode','sourceCurrencyCode',
    'sourceAmount','destinationCurrencyCode','walletAddress','chainId','providerStatus','providerUpdatedAt','receivedAmount','paymentMethodType')) THEN
  RAISE EXCEPTION 'wallet_production_proof_invalid' USING ERRCODE='22023'; END IF;
 IF p_proof->>'transactionId'!~'^[A-Za-z0-9_.:-]{1,128}$' OR p_proof->>'transactionId' IN('.','..')
  OR p_proof->>'sourceAmount'!~'^\d{1,10}\.\d{2}$' OR p_proof->>'receivedAmount'!~'^\d{1,12}(\.\d{1,6})?$'
  OR p_proof->>'providerUpdatedAt'!~'^\d{4}-\d{2}-\d{2}T.{1,48}$'
  OR p_proof->>'providerStatus' NOT IN('PENDING_CREATED','PENDING','PROCESSING','AUTHORIZED','ACCEPTED','PARTIALLY_SETTLED','SETTLING','TWO_FA_REQUIRED',
   'TWO_FA_PROVIDED','ERROR','SETTLED','FAILED','DECLINED','CANCELLED','REFUNDED','VOIDED','AUTHORIZATION_EXPIRED') THEN
  RAISE EXCEPTION 'wallet_production_proof_invalid' USING ERRCODE='22023'; END IF;
 BEGIN v_time:=(p_proof->>'providerUpdatedAt')::timestamptz;v_amount:=(p_proof->>'receivedAmount')::numeric;
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'wallet_production_proof_invalid' USING ERRCODE='22023'; END;
 IF NOT pg_catalog.isfinite(v_time) OR v_time>clock_timestamp()+interval '5 minutes' OR v_amount<0 OR v_amount>1000000000000
  OR(p_proof->>'providerStatus'='SETTLED' AND v_amount<=0) THEN RAISE EXCEPTION 'wallet_production_proof_invalid' USING ERRCODE='22023'; END IF;
 SELECT * INTO r FROM payments.wallet_meld_production_attempt a WHERE a.id=p_id AND a.subject=p_subject FOR UPDATE;
 IF NOT FOUND OR r.status<>'session_created' OR p_proof->>'accountId' IS DISTINCT FROM r.account_id
  OR p_proof->>'sessionId' IS DISTINCT FROM r.provider_session_id OR p_proof->>'externalSessionId' IS DISTINCT FROM r.id::text
  OR p_proof->>'externalCustomerId' IS DISTINCT FROM r.customer_reference::text OR p_proof->>'serviceProvider' IS DISTINCT FROM r.service_provider
  OR p_proof->>'paymentMethodType' IS DISTINCT FROM r.payment_method OR p_proof->>'countryCode' IS DISTINCT FROM r.country_code
  OR p_proof->>'sourceCurrencyCode' IS DISTINCT FROM r.source_currency OR(p_proof->>'sourceAmount')::numeric IS DISTINCT FROM r.requested_amount
  OR p_proof->>'destinationCurrencyCode' IS DISTINCT FROM 'USDT_POLYGON' OR p_proof->>'walletAddress' IS DISTINCT FROM r.wallet_address
  OR p_proof->>'chainId' IS DISTINCT FROM '137' THEN
  RAISE EXCEPTION 'wallet_production_proof_context_mismatch' USING ERRCODE='22023'; END IF;
 IF v_time<r.created_at-interval '5 minutes' THEN RAISE EXCEPTION 'wallet_production_proof_invalid' USING ERRCODE='22023'; END IF;
 IF r.proof IS NOT NULL THEN
  IF r.transaction_id IS DISTINCT FROM p_proof->>'transactionId' THEN RAISE EXCEPTION 'wallet_production_proof_transaction_conflict' USING ERRCODE='23505'; END IF;
  IF v_time<r.provider_updated_at THEN RETURN r.proof; END IF;
  IF v_time=r.provider_updated_at AND p_proof IS DISTINCT FROM r.proof THEN RAISE EXCEPTION 'wallet_production_proof_version_conflict' USING ERRCODE='23505'; END IF;
  IF p_proof=r.proof THEN RETURN r.proof; END IF;
  v_old:=r.proof->>'providerStatus';
  IF v_old IN('SETTLED','FAILED','DECLINED','CANCELLED','REFUNDED','VOIDED','AUTHORIZATION_EXPIRED')
   AND p_proof->>'providerStatus' IN('PENDING_CREATED','PENDING','PROCESSING','AUTHORIZED','ACCEPTED','PARTIALLY_SETTLED','SETTLING','TWO_FA_REQUIRED','TWO_FA_PROVIDED','ERROR') THEN RETURN r.proof; END IF;
 END IF;
 UPDATE payments.wallet_meld_production_attempt SET transaction_id=p_proof->>'transactionId',proof=p_proof,proof_hash=p_hash,
  provider_updated_at=v_time,checked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE wallet_meld_production_attempt.id=r.id;
 RETURN p_proof;
END $function$;

DO $owners$
DECLARE v_owner text;v_signature text;item record;
BEGIN
 SELECT pg_catalog.pg_get_userbyid(proowner) INTO v_owner FROM pg_catalog.pg_proc WHERE oid='identity.require_administrative_native_session(text,text)'::regprocedure;
 EXECUTE pg_catalog.format('ALTER TABLE payments.wallet_meld_production_attempt OWNER TO %I',v_owner);
 FOR item IN SELECT DISTINCT a.grantee FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl)a
  WHERE c.oid='payments.wallet_meld_production_attempt'::regclass AND a.grantee<>c.relowner LOOP
  EXECUTE pg_catalog.format('REVOKE ALL ON payments.wallet_meld_production_attempt FROM %s',CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(item.grantee)) END);
 END LOOP;
 FOREACH v_signature IN ARRAY ARRAY['identity.read_wallet_meld_production_binding(text,text)','payments.protect_wallet_meld_production_attempt()',
  'payments.create_wallet_meld_production_attempt(text,text,uuid,text,numeric,text,text,text,text)',
  'payments.finish_wallet_meld_production_attempt(text,text,uuid,text,text,text)',
  'payments.read_wallet_meld_production_attempt(text,text,uuid)','payments.read_wallet_meld_production_history(text,text)',
  'payments.record_wallet_meld_production_proof(text,uuid,jsonb,text)'] LOOP
  EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO %I',v_signature,v_owner);
  EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,mindbliss_auth_core_v1',v_signature);
  FOR item IN SELECT DISTINCT a.grantee FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl)a
   WHERE p.oid=v_signature::regprocedure AND a.grantee<>p.proowner LOOP
   EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %s',v_signature,CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(item.grantee)) END);
  END LOOP;
  IF v_signature<>'payments.protect_wallet_meld_production_attempt()' THEN
   EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO mindbliss_auth_core_v1',v_signature);
  END IF;
 END LOOP;
END $owners$;
DO $verify$
DECLARE v_owner oid;v_signature text;v_runtime boolean;
BEGIN
 SELECT proowner INTO v_owner FROM pg_catalog.pg_proc WHERE oid='identity.require_administrative_native_session(text,text)'::regprocedure;
 IF NOT EXISTS(SELECT FROM pg_catalog.pg_class WHERE oid='payments.wallet_meld_production_attempt'::regclass AND relowner=v_owner AND relrowsecurity)
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.wallet_meld_production_attempt','SELECT,INSERT,UPDATE,DELETE')
  OR EXISTS(SELECT FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl)a
   WHERE c.oid='payments.wallet_meld_production_attempt'::regclass AND a.grantee<>c.relowner) THEN
  RAISE EXCEPTION 'wallet_production_isolation_failed'; END IF;
 FOREACH v_signature IN ARRAY ARRAY['identity.read_wallet_meld_production_binding(text,text)','payments.protect_wallet_meld_production_attempt()',
  'payments.create_wallet_meld_production_attempt(text,text,uuid,text,numeric,text,text,text,text)',
  'payments.finish_wallet_meld_production_attempt(text,text,uuid,text,text,text)',
  'payments.read_wallet_meld_production_attempt(text,text,uuid)','payments.read_wallet_meld_production_history(text,text)',
  'payments.record_wallet_meld_production_proof(text,uuid,jsonb,text)'] LOOP
  v_runtime:=v_signature<>'payments.protect_wallet_meld_production_attempt()';
  IF NOT EXISTS(SELECT FROM pg_catalog.pg_proc WHERE oid=v_signature::regprocedure AND proowner=v_owner AND prosecdef
   AND proconfig=ARRAY['search_path=pg_catalog','lock_timeout=2s','statement_timeout=8s']::text[])
   OR pg_catalog.has_function_privilege('mindbliss_auth_core_v1',v_signature,'EXECUTE') IS DISTINCT FROM v_runtime
   OR EXISTS(SELECT FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl)a WHERE p.oid=v_signature::regprocedure
    AND a.grantee<>p.proowner AND(NOT v_runtime OR a.grantee<>'mindbliss_auth_core_v1'::regrole OR a.is_grantable OR a.privilege_type<>'EXECUTE')) THEN
   RAISE EXCEPTION 'wallet_production_isolation_failed'; END IF;
 END LOOP;
END $verify$;
COMMIT;
