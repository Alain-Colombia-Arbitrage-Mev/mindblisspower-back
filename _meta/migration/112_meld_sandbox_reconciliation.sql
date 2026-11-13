-- Independent sandbox evidence only. No existing rows/functions, balances or commissions are changed.
BEGIN;
SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('meld-sandbox-reconciliation-v1',0));
DO $preflight$
BEGIN
 IF pg_catalog.current_database()<>'mindbliss_curated_20261025' OR pg_catalog.pg_is_in_recovery()
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.create_meld_sandbox_funding_attempt_v2(text,text,text,numeric,uuid,text,text,text)'::regprocedure))<>'ac59aee12c97aaed2010090dc22788af'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.read_wallet_funding_status_v4(text,text,uuid)'::regprocedure))<>'f671bc5bc868a9b537bda306358c09da'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.read_wallet_funding_history_v4(text,text)'::regprocedure))<>'83318c1f9e9ebad5be4b350cfe0aad2b'
  OR pg_catalog.to_regclass('payments.meld_sandbox_proof') IS NOT NULL
  OR pg_catalog.to_regclass('payments.meld_sandbox_webhook_receipt') IS NOT NULL THEN
  RAISE EXCEPTION 'meld_sandbox_reconciliation_requires_fresh_review'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid='identity.administrative_wallet_assignment'::regclass
  AND attname='checkout_reference' AND atttypid='uuid'::regtype AND attnotnull AND NOT attisdropped) THEN
  RAISE EXCEPTION 'meld_sandbox_reconciliation_assignment_metadata_required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid='payments.meld_sandbox_funding_attempt'::regclass AND relrowsecurity AND pg_catalog.pg_has_role(relowner,'USAGE'))
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.meld_sandbox_funding_attempt','SELECT,INSERT,UPDATE,DELETE')
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid='payments.create_meld_sandbox_funding_attempt_v2(text,text,text,numeric,uuid,text,text,text)'::regprocedure
   AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog']::text[] AND pg_catalog.pg_has_role(proowner,'USAGE')) THEN
  RAISE EXCEPTION 'meld_sandbox_reconciliation_isolation_required'; END IF;
END $preflight$;
CREATE TABLE payments.meld_sandbox_proof(
 attempt_id uuid PRIMARY KEY REFERENCES payments.meld_sandbox_funding_attempt(id) ON DELETE RESTRICT,
 subject text NOT NULL REFERENCES auth."user"(id) ON DELETE RESTRICT,
 environment text NOT NULL DEFAULT 'sandbox' CHECK(environment='sandbox'),
 transaction_id text NOT NULL UNIQUE CHECK(transaction_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
 provider_updated_at timestamptz NOT NULL,
 proof jsonb NOT NULL CHECK(pg_catalog.jsonb_typeof(proof)='object'),
 proof_sha256 text NOT NULL CHECK(proof_sha256 ~ '^[0-9a-f]{64}$'),
 checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payments.meld_sandbox_webhook_receipt(
 event_id text PRIMARY KEY CHECK(event_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
 event_type text NOT NULL CHECK(event_type IN('WEBHOOK_TEST','TRANSACTION_CRYPTO_PENDING','TRANSACTION_CRYPTO_TRANSFERRING','TRANSACTION_CRYPTO_COMPLETE','TRANSACTION_CRYPTO_FAILED')),
 event_timestamp timestamptz NOT NULL,
 account_id text NOT NULL CHECK(account_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
 profile_id text CHECK(profile_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
 body_sha256 text NOT NULL CHECK(body_sha256 ~ '^[0-9a-f]{64}$'),
 attempt_id uuid REFERENCES payments.meld_sandbox_funding_attempt(id) ON DELETE RESTRICT,
 environment text NOT NULL DEFAULT 'sandbox' CHECK(environment='sandbox'),
 received_at timestamptz NOT NULL DEFAULT now(),
 CHECK((event_type='WEBHOOK_TEST' AND attempt_id IS NULL)
  OR(event_type<>'WEBHOOK_TEST' AND attempt_id IS NOT NULL AND profile_id IS NOT NULL))
);
ALTER TABLE payments.meld_sandbox_proof ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments.meld_sandbox_webhook_receipt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON payments.meld_sandbox_proof,payments.meld_sandbox_webhook_receipt FROM PUBLIC,mindbliss_auth_core_v1;

CREATE FUNCTION payments.read_meld_sandbox_reconciliation_context(p_subject text,p_reference uuid)
RETURNS TABLE(id uuid,subject text,wallet_address text,country_code text,requested_amount numeric,source_currency text,
 service_provider text,payment_method text,provider_session_id text,customer_reference uuid,proof jsonb,checked_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
 BEGIN PERFORM identity.administrative_wallet_person(p_subject);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000'; END;
 IF p_reference IS NULL THEN RAISE EXCEPTION 'wallet_funding_invalid_reference' USING ERRCODE='22023'; END IF;
 RETURN QUERY SELECT r.id,r.subject,r.wallet_address,r.country_code,r.requested_amount,r.source_currency,
  r.service_provider,r.payment_method,r.provider_session_id,a.checkout_reference,s.proof,s.checked_at
 FROM payments.meld_sandbox_funding_attempt r
 JOIN identity.administrative_wallet_assignment a ON a.subject=r.subject
 JOIN identity.administrative_wallet_pool p ON p.ordinal=a.pool_ordinal AND p.address=r.wallet_address AND p.status='available'
 LEFT JOIN payments.meld_sandbox_proof s ON s.attempt_id=r.id AND s.subject=r.subject
 WHERE r.subject=p_subject AND r.id=p_reference AND r.environment='sandbox' AND r.wallet_kind='administrative'
  AND r.provider='meld' AND r.destination_currency='USDT_POLYGON';
END $function$;
CREATE FUNCTION payments.read_meld_sandbox_confirmations(p_subject text,p_references uuid[])
RETURNS TABLE(id uuid,proof jsonb) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
 BEGIN PERFORM identity.administrative_wallet_person(p_subject);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000'; END;
 IF p_references IS NULL OR pg_catalog.cardinality(p_references)>50 OR pg_catalog.array_ndims(p_references)>1
  OR EXISTS(SELECT 1 FROM pg_catalog.unnest(p_references) r WHERE r IS NULL) THEN
  RAISE EXCEPTION 'wallet_funding_invalid_reference' USING ERRCODE='22023'; END IF;
 RETURN QUERY SELECT r.id,s.proof FROM payments.meld_sandbox_funding_attempt r
 JOIN payments.meld_sandbox_proof s ON s.attempt_id=r.id AND s.subject=r.subject
 JOIN identity.administrative_wallet_assignment a ON a.subject=r.subject
 JOIN identity.administrative_wallet_pool p ON p.ordinal=a.pool_ordinal AND p.address=r.wallet_address AND p.status='available'
 WHERE r.subject=p_subject AND r.id=ANY(p_references) AND r.environment='sandbox' AND r.wallet_kind='administrative'
  AND r.provider='meld' AND r.destination_currency='USDT_POLYGON';
END $function$;
CREATE FUNCTION payments.read_meld_sandbox_webhook_context(p_reference uuid,p_customer uuid,p_session text)
RETURNS TABLE(id uuid,subject text,wallet_address text,country_code text,requested_amount numeric,source_currency text,
 service_provider text,payment_method text,provider_session_id text,customer_reference uuid,proof jsonb,checked_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_subject text;
BEGIN
 IF p_reference IS NULL OR p_customer IS NULL OR p_session IS NULL OR p_session !~ '^[A-Za-z0-9_.:-]{1,128}$' THEN RETURN; END IF;
 SELECT r.subject INTO v_subject FROM payments.meld_sandbox_funding_attempt r
 JOIN identity.administrative_wallet_assignment a ON a.subject=r.subject
 WHERE r.id=p_reference AND r.provider_session_id=p_session AND r.status='session_created' AND a.checkout_reference=p_customer;
 IF v_subject IS NULL THEN RETURN; END IF;
 RETURN QUERY SELECT * FROM payments.read_meld_sandbox_reconciliation_context(v_subject,p_reference);
END $function$;
CREATE FUNCTION payments.record_meld_sandbox_proof(p_subject text,p_reference uuid,p_proof jsonb,p_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE r payments.meld_sandbox_funding_attempt%ROWTYPE;s payments.meld_sandbox_proof%ROWTYPE;
 v_customer uuid;v_time timestamptz;v_received numeric;v_old_status text;
BEGIN
 BEGIN PERFORM identity.administrative_wallet_person(p_subject);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000'; END;
 IF p_reference IS NULL OR p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' OR p_proof IS NULL
  OR pg_catalog.jsonb_typeof(p_proof)<>'object' THEN RAISE EXCEPTION 'sandbox_proof_invalid' USING ERRCODE='22023'; END IF;
 IF (SELECT count(*) FROM pg_catalog.jsonb_each(p_proof))<>16
  OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_each(p_proof) x WHERE pg_catalog.jsonb_typeof(x.value)<>'string'
   OR x.key NOT IN('transactionId','accountId','sessionId','externalSessionId','externalCustomerId','serviceProvider','countryCode','sourceCurrencyCode',
    'sourceAmount','destinationCurrencyCode','walletAddress','chainId','providerStatus','providerUpdatedAt','receivedAmount','paymentMethodType')) THEN
  RAISE EXCEPTION 'sandbox_proof_invalid' USING ERRCODE='22023'; END IF;
 -- Exactly 16 evidence attributes; all must be present, string typed, and bounded.
 IF p_proof->>'transactionId' !~ '^[A-Za-z0-9_.:-]{1,128}$' OR p_proof->>'accountId' !~ '^[A-Za-z0-9_.:-]{1,128}$'
  OR p_proof->>'receivedAmount' !~ '^\d{1,12}(\.\d{1,6})?$' OR p_proof->>'sourceAmount' !~ '^\d{1,10}\.\d{2}$'
  OR p_proof->>'providerUpdatedAt' !~ '^\d{4}-\d{2}-\d{2}T.{1,48}$'
  OR p_proof->>'providerStatus' NOT IN('PENDING_CREATED','PENDING','PROCESSING','AUTHORIZED','ACCEPTED','PARTIALLY_SETTLED','SETTLING',
   'TWO_FA_REQUIRED','TWO_FA_PROVIDED','ERROR','SETTLED','FAILED','DECLINED','CANCELLED','REFUNDED','VOIDED','AUTHORIZATION_EXPIRED') THEN
  RAISE EXCEPTION 'sandbox_proof_invalid' USING ERRCODE='22023'; END IF;
 BEGIN v_time:=(p_proof->>'providerUpdatedAt')::timestamptz;v_received:=(p_proof->>'receivedAmount')::numeric;
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'sandbox_proof_invalid' USING ERRCODE='22023'; END;
 IF NOT pg_catalog.isfinite(v_time) OR v_received<0 OR v_received>1000000000
  OR(p_proof->>'providerStatus'='SETTLED' AND v_received<=0) THEN RAISE EXCEPTION 'sandbox_proof_invalid' USING ERRCODE='22023'; END IF;
 SELECT * INTO r FROM payments.meld_sandbox_funding_attempt a WHERE a.id=p_reference AND a.subject=p_subject FOR UPDATE;
 IF NOT FOUND OR r.environment<>'sandbox' OR r.wallet_kind<>'administrative' OR r.provider<>'meld' OR r.status<>'session_created' THEN
  RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000'; END IF;
 SELECT a.checkout_reference INTO v_customer FROM identity.administrative_wallet_assignment a
 JOIN identity.administrative_wallet_pool p ON p.ordinal=a.pool_ordinal AND p.status='available' AND p.address=r.wallet_address
 WHERE a.subject=p_subject FOR SHARE OF a,p;
 IF v_customer IS NULL OR p_proof->>'externalSessionId'<>r.id::text OR p_proof->>'externalCustomerId'<>v_customer::text
  OR p_proof->>'sessionId' IS DISTINCT FROM r.provider_session_id OR p_proof->>'serviceProvider'<>r.service_provider
  OR p_proof->>'countryCode'<>r.country_code OR p_proof->>'sourceCurrencyCode'<>r.source_currency OR p_proof->>'paymentMethodType'<>r.payment_method
  OR (p_proof->>'sourceAmount')::numeric<>r.requested_amount OR p_proof->>'destinationCurrencyCode'<>'USDT_POLYGON'
  OR p_proof->>'walletAddress'<>r.wallet_address OR p_proof->>'chainId'<>'137' THEN
  RAISE EXCEPTION 'sandbox_proof_context_mismatch' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM payments.meld_sandbox_proof a WHERE a.attempt_id=r.id FOR UPDATE;
 IF FOUND THEN
  IF s.subject<>p_subject OR s.transaction_id<>p_proof->>'transactionId' OR s.proof->>'accountId'<>p_proof->>'accountId' THEN
   RAISE EXCEPTION 'sandbox_proof_transaction_conflict' USING ERRCODE='23505'; END IF;
  IF v_time<s.provider_updated_at THEN RETURN s.proof; END IF;
  IF v_time=s.provider_updated_at AND p_proof<>s.proof THEN RAISE EXCEPTION 'sandbox_proof_version_conflict' USING ERRCODE='23505'; END IF;
  v_old_status:=s.proof->>'providerStatus';
  IF v_old_status IN('SETTLED','FAILED','DECLINED','CANCELLED','REFUNDED','VOIDED','AUTHORIZATION_EXPIRED')
   AND p_proof->>'providerStatus' IN('PENDING_CREATED','PENDING','PROCESSING','AUTHORIZED','ACCEPTED','PARTIALLY_SETTLED','SETTLING','TWO_FA_REQUIRED','TWO_FA_PROVIDED','ERROR') THEN RETURN s.proof; END IF;
  UPDATE payments.meld_sandbox_proof SET proof=p_proof,proof_sha256=p_sha256,provider_updated_at=v_time,checked_at=now() WHERE attempt_id=r.id;
 ELSE
  INSERT INTO payments.meld_sandbox_proof(attempt_id,subject,transaction_id,provider_updated_at,proof,proof_sha256)
   VALUES(r.id,p_subject,p_proof->>'transactionId',v_time,p_proof,p_sha256);
 END IF;
 RETURN p_proof;
END $function$;
CREATE FUNCTION payments.record_meld_sandbox_webhook_receipt(p_event text,p_type text,p_timestamp timestamptz,p_account text,p_profile text,p_hash text,p_attempt uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_existing payments.meld_sandbox_webhook_receipt%ROWTYPE;v_count integer;
BEGIN
 IF p_event IS NULL OR p_event !~ '^[A-Za-z0-9_.:-]{1,128}$' OR p_type IS NULL
  OR p_type NOT IN('WEBHOOK_TEST','TRANSACTION_CRYPTO_PENDING','TRANSACTION_CRYPTO_TRANSFERRING','TRANSACTION_CRYPTO_COMPLETE','TRANSACTION_CRYPTO_FAILED')
  OR p_timestamp IS NULL OR NOT pg_catalog.isfinite(p_timestamp) OR p_account IS NULL OR p_account !~ '^[A-Za-z0-9_.:-]{1,128}$'
  OR p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' OR(p_profile IS NOT NULL AND p_profile !~ '^[A-Za-z0-9_.:-]{1,128}$')
  OR(p_type='WEBHOOK_TEST' AND p_attempt IS NOT NULL) OR(p_type<>'WEBHOOK_TEST' AND(p_attempt IS NULL OR p_profile IS NULL)) THEN
  RAISE EXCEPTION 'sandbox_webhook_invalid' USING ERRCODE='22023'; END IF;
 IF p_attempt IS NOT NULL AND NOT EXISTS(SELECT 1 FROM payments.meld_sandbox_funding_attempt a
   WHERE a.id=p_attempt AND a.status='session_created' AND a.environment='sandbox' AND a.wallet_kind='administrative' AND a.provider='meld') THEN
  RAISE EXCEPTION 'sandbox_webhook_invalid' USING ERRCODE='22023'; END IF;
 INSERT INTO payments.meld_sandbox_webhook_receipt(event_id,event_type,event_timestamp,account_id,profile_id,body_sha256,attempt_id)
  VALUES(p_event,p_type,p_timestamp,p_account,p_profile,p_hash,p_attempt) ON CONFLICT(event_id) DO NOTHING;
 GET DIAGNOSTICS v_count=ROW_COUNT;
 IF v_count=0 THEN
  SELECT * INTO v_existing FROM payments.meld_sandbox_webhook_receipt WHERE event_id=p_event;
  IF v_existing.body_sha256<>p_hash OR v_existing.event_type<>p_type OR v_existing.account_id<>p_account
   OR v_existing.profile_id IS DISTINCT FROM p_profile OR v_existing.attempt_id IS DISTINCT FROM p_attempt
   OR v_existing.event_timestamp<>p_timestamp THEN RAISE EXCEPTION 'sandbox_webhook_event_collision' USING ERRCODE='23505'; END IF;
 END IF;
 RETURN v_count=1;
END $function$;
REVOKE ALL ON FUNCTION payments.read_meld_sandbox_confirmations(text,uuid[]),payments.read_meld_sandbox_reconciliation_context(text,uuid),payments.read_meld_sandbox_webhook_context(uuid,uuid,text),
 payments.record_meld_sandbox_proof(text,uuid,jsonb,text),payments.record_meld_sandbox_webhook_receipt(text,text,timestamptz,text,text,text,uuid) FROM PUBLIC;
DO $owners$
DECLARE v_owner text;v_signature text;v_table text;item record;
BEGIN
 SELECT pg_catalog.pg_get_userbyid(proowner) INTO v_owner FROM pg_catalog.pg_proc
  WHERE oid='payments.create_meld_sandbox_funding_attempt_v2(text,text,text,numeric,uuid,text,text,text)'::regprocedure;
 FOREACH v_table IN ARRAY ARRAY['payments.meld_sandbox_proof','payments.meld_sandbox_webhook_receipt'] LOOP
  EXECUTE pg_catalog.format('ALTER TABLE %s OWNER TO %I',v_table,v_owner);
  FOR item IN SELECT DISTINCT a.grantee FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
   WHERE c.oid=v_table::regclass AND a.grantee<>c.relowner LOOP
   IF item.grantee=0 THEN EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %s FROM PUBLIC',v_table);
   ELSE EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %s FROM %I',v_table,pg_catalog.pg_get_userbyid(item.grantee));END IF;
  END LOOP;
 END LOOP;
 FOREACH v_signature IN ARRAY ARRAY['payments.read_meld_sandbox_confirmations(text,uuid[])','payments.read_meld_sandbox_reconciliation_context(text,uuid)','payments.read_meld_sandbox_webhook_context(uuid,uuid,text)',
  'payments.record_meld_sandbox_proof(text,uuid,jsonb,text)','payments.record_meld_sandbox_webhook_receipt(text,text,timestamptz,text,text,text,uuid)'] LOOP
  EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO %I',v_signature,v_owner);
  FOR item IN SELECT DISTINCT a.grantee FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
   WHERE p.oid=v_signature::regprocedure AND a.grantee<>p.proowner AND a.grantee<>0 LOOP
   EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %I',v_signature,pg_catalog.pg_get_userbyid(item.grantee));END LOOP;
  EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO mindbliss_auth_core_v1',v_signature);
 END LOOP;
END $owners$;
DO $verify$
DECLARE v_signature text;v_owner oid;v_table text;
BEGIN
 SELECT proowner INTO v_owner FROM pg_catalog.pg_proc WHERE oid='payments.create_meld_sandbox_funding_attempt_v2(text,text,text,numeric,uuid,text,text,text)'::regprocedure;
 FOREACH v_table IN ARRAY ARRAY['payments.meld_sandbox_proof','payments.meld_sandbox_webhook_receipt'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid=v_table::regclass AND relrowsecurity AND relowner=v_owner)
   OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1',v_table,'SELECT,INSERT,UPDATE,DELETE')
   OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
    WHERE c.oid=v_table::regclass AND a.grantee<>c.relowner) THEN RAISE EXCEPTION 'sandbox_proof_isolation_failed';END IF;
 END LOOP;
 FOREACH v_signature IN ARRAY ARRAY['payments.read_meld_sandbox_confirmations(text,uuid[])','payments.read_meld_sandbox_reconciliation_context(text,uuid)','payments.read_meld_sandbox_webhook_context(uuid,uuid,text)',
  'payments.record_meld_sandbox_proof(text,uuid,jsonb,text)','payments.record_meld_sandbox_webhook_receipt(text,text,timestamptz,text,text,text,uuid)'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid=v_signature::regprocedure AND proowner=v_owner AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog']::text[])
   OR NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1',v_signature,'EXECUTE')
   OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a WHERE p.oid=v_signature::regprocedure
    AND a.grantee<>p.proowner AND a.grantee<>'mindbliss_auth_core_v1'::regrole) THEN RAISE EXCEPTION 'sandbox_proof_isolation_failed';END IF;
 END LOOP;
END $verify$;
COMMIT;
