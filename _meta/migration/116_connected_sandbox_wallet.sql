-- Connected Reown destinations for the wallet portal's MELD sandbox only.
-- No pool allocation, production binding, financial ledger or commission writes.
BEGIN;
SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('connected-sandbox-wallet-v1',0));
DO $preflight$
DECLARE v_owner oid;
BEGIN
 IF pg_catalog.current_database()<>'mindbliss_curated_20261025' OR pg_catalog.pg_is_in_recovery()
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('identity.require_administrative_native_session(text,text)'::regprocedure))<>'01bb63725c11ae353cb768a42ffa9485'
  OR pg_catalog.md5(pg_catalog.replace(pg_catalog.pg_get_functiondef('identity.administrative_wallet_person(text)'::regprocedure),E'\r\n',E'\n'))<>'e86669cd3e92807cb74739e8603dcbcf'
  OR pg_catalog.to_regclass('identity.sandbox_wallet_challenge') IS NOT NULL
  OR pg_catalog.to_regclass('identity.sandbox_wallet_binding') IS NOT NULL
  OR pg_catalog.to_regclass('payments.connected_wallet_sandbox_attempt') IS NOT NULL THEN
  RAISE EXCEPTION 'sandbox_wallet_requires_fresh_review';END IF;
 SELECT proowner INTO v_owner FROM pg_catalog.pg_proc WHERE oid='identity.require_administrative_native_session(text,text)'::regprocedure;
 IF NOT pg_catalog.pg_has_role(v_owner,'USAGE')
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid='identity.require_administrative_native_session(text,text)'::regprocedure AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog']::text[])
  OR NOT pg_catalog.has_schema_privilege('mindbliss_auth_core_v1','identity','USAGE')
  OR NOT pg_catalog.has_schema_privilege('mindbliss_auth_core_v1','payments','USAGE') THEN
  RAISE EXCEPTION 'sandbox_wallet_scoped_native_identity_required';END IF;
END $preflight$;
CREATE TABLE identity.sandbox_wallet_challenge(
 id uuid PRIMARY KEY,subject text NOT NULL REFERENCES auth."user"(id) ON DELETE RESTRICT,
 native_session_id text NOT NULL CHECK(length(native_session_id) BETWEEN 1 AND 255),
 wallet_address text NOT NULL CHECK(wallet_address ~ '^0x[0-9a-f]{40}$' AND wallet_address<>'0x0000000000000000000000000000000000000000'),
 chain_id integer NOT NULL DEFAULT 137 CHECK(chain_id=137),
 nonce text NOT NULL UNIQUE CHECK(nonce ~ '^[0-9a-f]{64}$'),session_context_hash text NOT NULL CHECK(session_context_hash ~ '^[0-9a-f]{64}$'),
 message text NOT NULL CHECK(length(message) BETWEEN 1 AND 4096),message_hash text NOT NULL CHECK(message_hash ~ '^[0-9a-f]{64}$'),
 issued_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,invalidated_at timestamptz,consumed_at timestamptz,
 signature_hash text CHECK(signature_hash ~ '^[0-9a-f]{64}$'),
 CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '5 minutes'),CHECK((consumed_at IS NULL)=(signature_hash IS NULL))
);
CREATE TABLE identity.sandbox_wallet_binding(
 subject text PRIMARY KEY REFERENCES auth."user"(id) ON DELETE RESTRICT,
 wallet_address text NOT NULL UNIQUE CHECK(wallet_address ~ '^0x[0-9a-f]{40}$' AND wallet_address<>'0x0000000000000000000000000000000000000000'),
 chain_id integer NOT NULL DEFAULT 137 CHECK(chain_id=137),
 binding_reference uuid NOT NULL UNIQUE DEFAULT pg_catalog.gen_random_uuid(),
 native_session_id text NOT NULL CHECK(length(native_session_id) BETWEEN 1 AND 255),
 challenge_id uuid NOT NULL UNIQUE REFERENCES identity.sandbox_wallet_challenge(id) ON DELETE RESTRICT,
 verified_at timestamptz NOT NULL,native_expires_at timestamptz NOT NULL,binding_expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL,
 CHECK(binding_expires_at>verified_at AND binding_expires_at<=verified_at+interval '24 hours' AND binding_expires_at<=native_expires_at)
);
CREATE TABLE payments.connected_wallet_sandbox_attempt(
 id uuid PRIMARY KEY,subject text NOT NULL REFERENCES auth."user"(id) ON DELETE RESTRICT,native_session_id text NOT NULL CHECK(length(native_session_id) BETWEEN 1 AND 255),
 wallet_address text NOT NULL CHECK(wallet_address ~ '^0x[0-9a-f]{40}$' AND wallet_address<>'0x0000000000000000000000000000000000000000'),customer_reference uuid NOT NULL,
 environment text NOT NULL DEFAULT 'sandbox' CHECK(environment='sandbox'),transaction_type text NOT NULL DEFAULT 'BUY' CHECK(transaction_type='BUY'),
 destination_currency text NOT NULL DEFAULT 'USDT_POLYGON' CHECK(destination_currency='USDT_POLYGON'),chain_id integer NOT NULL DEFAULT 137 CHECK(chain_id=137),
 country_code text NOT NULL CHECK(country_code IN('US','MX','CO')),source_currency text NOT NULL CHECK(source_currency='USD' OR(source_currency='MXN' AND country_code='MX')),
 requested_amount numeric(12,2) NOT NULL CHECK((source_currency='USD' AND requested_amount BETWEEN 50 AND 25000)
  OR(source_currency='MXN' AND country_code='MX' AND requested_amount BETWEEN 0.01 AND 10000000)),
 service_provider text NOT NULL DEFAULT 'TRANSAK' CHECK(service_provider='TRANSAK'),payment_method text NOT NULL CHECK(payment_method IN('CREDIT_DEBIT_CARD','APPLE_PAY','GOOGLE_PAY')),
 account_id text NOT NULL CHECK(account_id ~ '^[A-Za-z0-9_.:-]{1,128}$' AND account_id NOT IN('.','..')),
 status text NOT NULL DEFAULT 'initiated' CHECK(status IN('initiated','session_created','unavailable')),
 provider_session_id text CHECK(provider_session_id ~ '^[A-Za-z0-9_.:-]{1,128}$' AND provider_session_id NOT IN('.','..')),
 provider_customer_id text CHECK(provider_customer_id ~ '^[A-Za-z0-9_.:-]{1,128}$' AND provider_customer_id NOT IN('.','..')),
 transaction_id text UNIQUE CHECK(transaction_id ~ '^[A-Za-z0-9_.:-]{1,128}$' AND transaction_id NOT IN('.','..')),
 proof jsonb CHECK(pg_catalog.jsonb_typeof(proof)='object' AND pg_catalog.pg_column_size(proof)<=16384),proof_hash text CHECK(proof_hash ~ '^[0-9a-f]{64}$'),provider_updated_at timestamptz,checked_at timestamptz,
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,UNIQUE(account_id,provider_session_id),
 CHECK((status='session_created' AND provider_session_id IS NOT NULL) OR(status<>'session_created' AND provider_session_id IS NULL AND provider_customer_id IS NULL)),
 CHECK((proof IS NULL AND transaction_id IS NULL AND proof_hash IS NULL AND provider_updated_at IS NULL AND checked_at IS NULL)
  OR(proof IS NOT NULL AND status='session_created' AND transaction_id IS NOT NULL AND proof_hash IS NOT NULL AND provider_updated_at IS NOT NULL AND checked_at IS NOT NULL))
);
ALTER TABLE identity.sandbox_wallet_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.sandbox_wallet_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments.connected_wallet_sandbox_attempt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON identity.sandbox_wallet_challenge,identity.sandbox_wallet_binding,payments.connected_wallet_sandbox_attempt FROM PUBLIC,mindbliss_auth_core_v1;

CREATE FUNCTION identity.read_sandbox_wallet_binding(p_subject text,p_session text)
RETURNS TABLE(address text,verified boolean,binding_reference uuid,verified_at timestamptz,expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_native timestamptz;r identity.sandbox_wallet_binding%ROWTYPE;v_verified boolean;
BEGIN
 v_native:=identity.require_administrative_native_session(p_subject,p_session);
 SELECT * INTO r FROM identity.sandbox_wallet_binding b WHERE b.subject=p_subject;
 IF NOT FOUND THEN RETURN QUERY SELECT NULL::text,false,NULL::uuid,NULL::timestamptz,NULL::timestamptz;RETURN;END IF;
 v_verified:=r.native_session_id=p_session AND least(r.binding_expires_at,v_native)>clock_timestamp();
 RETURN QUERY SELECT r.wallet_address,v_verified,r.binding_reference,r.verified_at,CASE WHEN v_verified THEN least(r.binding_expires_at,v_native) ELSE NULL::timestamptz END;
END $function$;
CREATE FUNCTION identity.create_sandbox_wallet_challenge(p_subject text,p_session text,p_address text,p_id uuid,p_nonce text)
RETURNS TABLE(id uuid,address text,chain_id integer,message text,message_hash text,nonce text,issued_at timestamptz,expires_at timestamptz,session_context_hash text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_native timestamptz;v_now timestamptz;v_until timestamptz;v_context text;v_message text;v_address text;r identity.sandbox_wallet_challenge%ROWTYPE;
BEGIN
 v_native:=identity.require_administrative_native_session(p_subject,p_session);
 IF p_id IS NULL OR p_nonce IS NULL OR p_nonce !~ '^[0-9a-f]{64}$' OR p_address IS NULL OR p_address !~ '^0x[0-9a-f]{40}$' OR p_address='0x0000000000000000000000000000000000000000' THEN
  RAISE EXCEPTION 'sandbox_wallet_invalid_challenge' USING ERRCODE='22023';END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sandbox-wallet-owner:'||p_subject,0));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sandbox-wallet-challenge-id:'||p_id::text,0));
 SELECT b.wallet_address INTO v_address FROM identity.sandbox_wallet_binding b WHERE b.subject=p_subject;
 IF v_address IS NOT NULL AND v_address<>p_address THEN RAISE EXCEPTION 'sandbox_wallet_address_immutable' USING ERRCODE='23505';END IF;
 IF EXISTS(SELECT 1 FROM identity.sandbox_wallet_binding b WHERE b.wallet_address=p_address AND b.subject<>p_subject) THEN RAISE EXCEPTION 'sandbox_wallet_address_in_use' USING ERRCODE='23505';END IF;
 IF v_native<=clock_timestamp() THEN RAISE EXCEPTION 'administrative_signing_forbidden' USING ERRCODE='28000';END IF;
 SELECT * INTO r FROM identity.sandbox_wallet_challenge c WHERE c.id=p_id;
 IF FOUND THEN
  IF r.subject<>p_subject OR r.native_session_id<>p_session OR r.wallet_address<>p_address OR r.nonce<>p_nonce OR r.consumed_at IS NOT NULL OR r.invalidated_at IS NOT NULL OR r.expires_at<=clock_timestamp() THEN
   RAISE EXCEPTION 'sandbox_wallet_invalid_challenge' USING ERRCODE='22023';END IF;
  RETURN QUERY SELECT r.id,r.wallet_address,r.chain_id,r.message,r.message_hash,r.nonce,r.issued_at,r.expires_at,r.session_context_hash;RETURN;
 END IF;
 v_now:=clock_timestamp();v_until:=least(v_now+interval '5 minutes',v_native);
 IF v_until<=v_now THEN RAISE EXCEPTION 'administrative_signing_forbidden' USING ERRCODE='28000';END IF;
 IF(SELECT count(*) FROM identity.sandbox_wallet_challenge c WHERE c.subject=p_subject AND c.issued_at>v_now-interval '10 minutes')>=5
  OR(SELECT count(*) FROM identity.sandbox_wallet_challenge c WHERE c.subject=p_subject AND c.native_session_id=p_session AND c.issued_at>v_now-interval '5 minutes')>=3 THEN
  RAISE EXCEPTION 'sandbox_wallet_rate_limited' USING ERRCODE='54000';END IF;
 v_context:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_subject||E'\n'||p_session,'UTF8')),'hex');
 v_message:='wallet.mindblisspower.com wants you to verify control of this sandbox wallet:'||E'\n'||p_address||E'\n\n'||
  'Mindbliss sandbox wallet ownership only. No transaction or transfer of funds.'||E'\nSession context: '||v_context||
  E'\n\nURI: https://wallet.mindblisspower.com/dashboard/wallet-administrative\nVersion: 1\nChain ID: 137\nNonce: '||p_nonce||
  E'\nIssued At: '||pg_catalog.to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')||
  E'\nExpiration Time: '||pg_catalog.to_char(v_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')||E'\nRequest ID: '||p_id::text;
 UPDATE identity.sandbox_wallet_challenge SET invalidated_at=v_now WHERE subject=p_subject AND native_session_id=p_session AND consumed_at IS NULL AND invalidated_at IS NULL;
 RETURN QUERY INSERT INTO identity.sandbox_wallet_challenge(id,subject,native_session_id,wallet_address,nonce,session_context_hash,message,message_hash,issued_at,expires_at)
 VALUES(p_id,p_subject,p_session,p_address,p_nonce,v_context,v_message,pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_message,'UTF8')),'hex'),v_now,v_until)
 RETURNING sandbox_wallet_challenge.id,sandbox_wallet_challenge.wallet_address,sandbox_wallet_challenge.chain_id,sandbox_wallet_challenge.message,
  sandbox_wallet_challenge.message_hash,sandbox_wallet_challenge.nonce,sandbox_wallet_challenge.issued_at,sandbox_wallet_challenge.expires_at,sandbox_wallet_challenge.session_context_hash;
END $function$;
CREATE FUNCTION identity.read_sandbox_wallet_challenge(p_subject text,p_session text,p_id uuid)
RETURNS TABLE(id uuid,address text,chain_id integer,message text,message_hash text,nonce text,issued_at timestamptz,expires_at timestamptz,session_context_hash text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
 PERFORM identity.require_administrative_native_session(p_subject,p_session);
 RETURN QUERY SELECT c.id,c.wallet_address,c.chain_id,c.message,c.message_hash,c.nonce,c.issued_at,c.expires_at,c.session_context_hash
 FROM identity.sandbox_wallet_challenge c WHERE c.id=p_id AND c.subject=p_subject AND c.native_session_id=p_session
  AND c.consumed_at IS NULL AND c.invalidated_at IS NULL AND c.expires_at>clock_timestamp()
  AND NOT EXISTS(SELECT 1 FROM identity.sandbox_wallet_binding b WHERE(b.subject=c.subject AND b.wallet_address<>c.wallet_address) OR(b.wallet_address=c.wallet_address AND b.subject<>c.subject));
END $function$;
CREATE FUNCTION identity.consume_sandbox_wallet_challenge(p_subject text,p_session text,p_id uuid,p_recovered text,p_message_hash text,p_signature_hash text)
RETURNS TABLE(address text,verified boolean,binding_reference uuid,verified_at timestamptz,expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_native timestamptz;v_now timestamptz;v_until timestamptz;r identity.sandbox_wallet_challenge%ROWTYPE;b identity.sandbox_wallet_binding%ROWTYPE;
BEGIN
 v_native:=identity.require_administrative_native_session(p_subject,p_session);
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sandbox-wallet-owner:'||p_subject,0));
 SELECT * INTO r FROM identity.sandbox_wallet_challenge c WHERE c.id=p_id AND c.subject=p_subject AND c.native_session_id=p_session FOR UPDATE;
 v_now:=clock_timestamp();
 IF NOT FOUND OR r.consumed_at IS NOT NULL OR r.invalidated_at IS NOT NULL OR r.expires_at<=v_now OR v_native<=v_now THEN RAISE EXCEPTION 'sandbox_wallet_invalid_challenge' USING ERRCODE='22023';END IF;
 IF p_recovered IS NULL OR lower(p_recovered)<>r.wallet_address OR p_message_hash IS DISTINCT FROM r.message_hash OR p_signature_hash IS NULL OR p_signature_hash !~ '^[0-9a-f]{64}$' THEN
  RAISE EXCEPTION 'sandbox_wallet_signature_invalid' USING ERRCODE='22023';END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sandbox-wallet-address:'||r.wallet_address,0));
 SELECT * INTO b FROM identity.sandbox_wallet_binding existing WHERE existing.subject=p_subject;
 IF FOUND AND b.wallet_address<>r.wallet_address THEN RAISE EXCEPTION 'sandbox_wallet_address_immutable' USING ERRCODE='23505';END IF;
 IF EXISTS(SELECT 1 FROM identity.sandbox_wallet_binding other WHERE other.wallet_address=r.wallet_address AND other.subject<>p_subject) THEN RAISE EXCEPTION 'sandbox_wallet_address_in_use' USING ERRCODE='23505';END IF;
 v_now:=clock_timestamp();v_until:=least(v_native,v_now+interval '24 hours');
 IF r.expires_at<=v_now OR v_until<=v_now THEN RAISE EXCEPTION 'sandbox_wallet_invalid_challenge' USING ERRCODE='22023';END IF;
 UPDATE identity.sandbox_wallet_challenge SET consumed_at=v_now,signature_hash=p_signature_hash WHERE id=r.id;
 INSERT INTO identity.sandbox_wallet_binding(subject,wallet_address,native_session_id,challenge_id,verified_at,native_expires_at,binding_expires_at,created_at)
 VALUES(p_subject,r.wallet_address,p_session,r.id,v_now,v_native,v_until,v_now)
 ON CONFLICT(subject) DO UPDATE SET native_session_id=EXCLUDED.native_session_id,challenge_id=EXCLUDED.challenge_id,verified_at=EXCLUDED.verified_at,native_expires_at=EXCLUDED.native_expires_at,binding_expires_at=EXCLUDED.binding_expires_at;
 RETURN QUERY SELECT * FROM identity.read_sandbox_wallet_binding(p_subject,p_session);
END $function$;
CREATE FUNCTION identity.require_sandbox_wallet_binding(p_subject text,p_session text)
RETURNS TABLE(wallet_address text,customer_reference uuid,binding_expires_at timestamptz,native_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_native timestamptz;b identity.sandbox_wallet_binding%ROWTYPE;
BEGIN
 v_native:=identity.require_administrative_native_session(p_subject,p_session);
 SELECT * INTO b FROM identity.sandbox_wallet_binding r WHERE r.subject=p_subject AND r.native_session_id=p_session FOR SHARE;
 IF NOT FOUND OR least(b.binding_expires_at,v_native)<=clock_timestamp() THEN RAISE EXCEPTION 'sandbox_wallet_binding_required' USING ERRCODE='28000';END IF;
 RETURN QUERY SELECT b.wallet_address,b.binding_reference,least(b.binding_expires_at,v_native),v_native;
END $function$;
CREATE FUNCTION payments.create_connected_wallet_sandbox_attempt(p_subject text,p_session text,p_id uuid,p_country text,p_amount numeric,p_currency text,p_method text,p_account text)
RETURNS TABLE(id uuid,address text,customer_reference uuid,status text,created boolean,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE b record;r payments.connected_wallet_sandbox_attempt%ROWTYPE;v_now timestamptz;
BEGIN
 PERFORM identity.require_administrative_native_session(p_subject,p_session);
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sandbox-wallet-owner:'||p_subject,0));
 SELECT * INTO b FROM identity.require_sandbox_wallet_binding(p_subject,p_session);
 IF p_id IS NULL OR p_country IS NULL OR p_country NOT IN('US','MX','CO') OR p_amount IS NULL OR p_amount<>round(p_amount,2)
  OR p_currency IS NULL OR NOT((p_currency='USD' AND p_amount BETWEEN 50 AND 25000) OR(p_currency='MXN' AND p_country='MX' AND p_amount BETWEEN 0.01 AND 10000000))
  OR p_method IS NULL OR p_method NOT IN('CREDIT_DEBIT_CARD','APPLE_PAY','GOOGLE_PAY') OR p_account IS NULL OR p_account !~ '^[A-Za-z0-9_.:-]{1,128}$' OR p_account IN('.','..') THEN
  RAISE EXCEPTION 'sandbox_wallet_funding_invalid_request' USING ERRCODE='22023';END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sandbox-wallet-attempt-id:'||p_id::text,0));
 IF least(b.binding_expires_at,b.native_expires_at)<=clock_timestamp() THEN RAISE EXCEPTION 'sandbox_wallet_binding_required' USING ERRCODE='28000';END IF;
 SELECT * INTO r FROM payments.connected_wallet_sandbox_attempt a WHERE a.id=p_id;
 IF FOUND THEN
  IF r.subject<>p_subject OR r.native_session_id<>p_session OR r.wallet_address<>b.wallet_address OR r.customer_reference<>b.customer_reference OR r.country_code<>p_country
   OR r.requested_amount<>p_amount OR r.source_currency<>p_currency OR r.payment_method<>p_method OR r.account_id<>p_account THEN
   RAISE EXCEPTION 'sandbox_wallet_funding_request_already_used' USING ERRCODE='23505';END IF;
  RETURN QUERY SELECT r.id,r.wallet_address,r.customer_reference,r.status,false,r.created_at;RETURN;
 END IF;
 v_now:=clock_timestamp();
 IF(SELECT count(*) FROM payments.connected_wallet_sandbox_attempt a WHERE a.subject=p_subject AND a.created_at>v_now-interval '10 minutes')>=10 THEN RAISE EXCEPTION 'sandbox_wallet_funding_rate_limited' USING ERRCODE='54000';END IF;
 RETURN QUERY INSERT INTO payments.connected_wallet_sandbox_attempt(id,subject,native_session_id,wallet_address,customer_reference,country_code,source_currency,requested_amount,payment_method,account_id,created_at,updated_at)
 VALUES(p_id,p_subject,p_session,b.wallet_address,b.customer_reference,p_country,p_currency,p_amount,p_method,p_account,v_now,v_now)
 RETURNING connected_wallet_sandbox_attempt.id,connected_wallet_sandbox_attempt.wallet_address,connected_wallet_sandbox_attempt.customer_reference,connected_wallet_sandbox_attempt.status,true,connected_wallet_sandbox_attempt.created_at;
END $function$;
CREATE FUNCTION payments.finish_connected_wallet_sandbox_attempt(p_subject text,p_session text,p_id uuid,p_status text,p_provider_session text,p_provider_customer text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE b record;r payments.connected_wallet_sandbox_attempt%ROWTYPE;
BEGIN
 PERFORM identity.require_administrative_native_session(p_subject,p_session);
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sandbox-wallet-owner:'||p_subject,0));
 SELECT * INTO b FROM identity.require_sandbox_wallet_binding(p_subject,p_session);
 IF p_id IS NULL OR p_status IS NULL OR p_status NOT IN('session_created','unavailable')
  OR(p_status='session_created' AND(p_provider_session IS NULL OR p_provider_session !~ '^[A-Za-z0-9_.:-]{1,128}$' OR p_provider_session IN('.','..')
    OR(p_provider_customer IS NOT NULL AND(p_provider_customer !~ '^[A-Za-z0-9_.:-]{1,128}$' OR p_provider_customer IN('.','..')))))
  OR(p_status='unavailable' AND(p_provider_session IS NOT NULL OR p_provider_customer IS NOT NULL)) THEN RAISE EXCEPTION 'sandbox_wallet_funding_invalid_request' USING ERRCODE='22023';END IF;
 SELECT * INTO r FROM payments.connected_wallet_sandbox_attempt a WHERE a.id=p_id AND a.subject=p_subject AND a.native_session_id=p_session FOR UPDATE;
 IF NOT FOUND OR r.wallet_address<>b.wallet_address OR r.customer_reference<>b.customer_reference THEN RAISE EXCEPTION 'sandbox_wallet_funding_forbidden' USING ERRCODE='28000';END IF;
 IF least(b.binding_expires_at,b.native_expires_at)<=clock_timestamp() THEN RAISE EXCEPTION 'sandbox_wallet_binding_required' USING ERRCODE='28000';END IF;
 IF r.status<>'initiated' THEN RETURN r.status=p_status AND r.provider_session_id IS NOT DISTINCT FROM p_provider_session AND r.provider_customer_id IS NOT DISTINCT FROM p_provider_customer;END IF;
 UPDATE payments.connected_wallet_sandbox_attempt SET status=p_status,provider_session_id=p_provider_session,provider_customer_id=p_provider_customer,updated_at=clock_timestamp() WHERE id=r.id;
 RETURN true;
END $function$;
CREATE FUNCTION payments.read_connected_wallet_sandbox_attempt(p_subject text,p_session text,p_id uuid)
RETURNS TABLE(id uuid,subject text,address text,customer_reference uuid,account_id text,country_code text,source_currency text,requested_amount numeric,service_provider text,payment_method text,status text,provider_session_id text,provider_customer_id text,created_at timestamptz,updated_at timestamptz,proof jsonb,checked_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
 PERFORM identity.require_administrative_native_session(p_subject,p_session);
 RETURN QUERY SELECT r.id,r.subject,r.wallet_address,r.customer_reference,r.account_id,r.country_code,r.source_currency,r.requested_amount,r.service_provider,r.payment_method,r.status,r.provider_session_id,r.provider_customer_id,r.created_at,r.updated_at,r.proof,r.checked_at
 FROM payments.connected_wallet_sandbox_attempt r WHERE r.id=p_id AND r.subject=p_subject;
END $function$;
CREATE FUNCTION payments.read_connected_wallet_sandbox_history(p_subject text,p_session text)
RETURNS TABLE(id uuid,subject text,address text,customer_reference uuid,account_id text,country_code text,source_currency text,requested_amount numeric,service_provider text,payment_method text,status text,provider_session_id text,provider_customer_id text,created_at timestamptz,updated_at timestamptz,proof jsonb,checked_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
 PERFORM identity.require_administrative_native_session(p_subject,p_session);
 RETURN QUERY SELECT r.id,r.subject,r.wallet_address,r.customer_reference,r.account_id,r.country_code,r.source_currency,r.requested_amount,r.service_provider,r.payment_method,r.status,r.provider_session_id,r.provider_customer_id,r.created_at,r.updated_at,r.proof,r.checked_at
 FROM payments.connected_wallet_sandbox_attempt r WHERE r.subject=p_subject ORDER BY r.created_at DESC,r.id DESC LIMIT 20;
END $function$;
CREATE FUNCTION payments.record_connected_wallet_sandbox_proof(p_subject text,p_id uuid,p_proof jsonb,p_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE r payments.connected_wallet_sandbox_attempt%ROWTYPE;v_time timestamptz;v_amount numeric;v_old text;
BEGIN
 -- Provider facts for an immutable owned sandbox snapshot; never financial posting.
 BEGIN PERFORM identity.administrative_wallet_person(p_subject);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'sandbox_wallet_funding_forbidden' USING ERRCODE='28000';END;
 IF p_id IS NULL OR p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' OR p_proof IS NULL OR pg_catalog.jsonb_typeof(p_proof)<>'object' OR pg_catalog.pg_column_size(p_proof)>16384
  OR(SELECT count(*) FROM pg_catalog.jsonb_each(p_proof))<>16
  OR NOT(p_proof ?& ARRAY['transactionId','accountId','sessionId','externalSessionId','externalCustomerId','serviceProvider','countryCode','sourceCurrencyCode','sourceAmount','destinationCurrencyCode','walletAddress','chainId','providerStatus','providerUpdatedAt','receivedAmount','paymentMethodType']::text[])
  OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_each(p_proof) x WHERE pg_catalog.jsonb_typeof(x.value)<>'string'
   OR x.key NOT IN('transactionId','accountId','sessionId','externalSessionId','externalCustomerId','serviceProvider','countryCode','sourceCurrencyCode','sourceAmount','destinationCurrencyCode','walletAddress','chainId','providerStatus','providerUpdatedAt','receivedAmount','paymentMethodType')) THEN
  RAISE EXCEPTION 'sandbox_wallet_proof_invalid' USING ERRCODE='22023';END IF;
 IF p_proof->>'transactionId' !~ '^[A-Za-z0-9_.:-]{1,128}$' OR p_proof->>'transactionId' IN('.','..')
  OR p_proof->>'sourceAmount' !~ '^\d{1,10}(\.\d{1,2})?$' OR p_proof->>'receivedAmount' !~ '^\d{1,12}(\.\d{1,6})?$'
  OR p_proof->>'providerUpdatedAt' !~ '^\d{4}-\d{2}-\d{2}T.{1,48}$'
  OR p_proof->>'providerStatus' NOT IN('PENDING_CREATED','PENDING','PROCESSING','AUTHORIZED','ACCEPTED','PARTIALLY_SETTLED','SETTLING','TWO_FA_REQUIRED','TWO_FA_PROVIDED','ERROR','SETTLED','FAILED','DECLINED','CANCELLED','REFUNDED','VOIDED','AUTHORIZATION_EXPIRED') THEN
  RAISE EXCEPTION 'sandbox_wallet_proof_invalid' USING ERRCODE='22023';END IF;
 BEGIN v_time:=(p_proof->>'providerUpdatedAt')::timestamptz;v_amount:=(p_proof->>'receivedAmount')::numeric;
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'sandbox_wallet_proof_invalid' USING ERRCODE='22023';END;
 IF NOT pg_catalog.isfinite(v_time) OR v_time>clock_timestamp()+interval '5 minutes' OR v_amount<0 OR v_amount>1000000000000
  OR(p_proof->>'providerStatus'='SETTLED' AND v_amount<=0) THEN RAISE EXCEPTION 'sandbox_wallet_proof_invalid' USING ERRCODE='22023';END IF;
 SELECT * INTO r FROM payments.connected_wallet_sandbox_attempt a WHERE a.id=p_id AND a.subject=p_subject FOR UPDATE;
 IF NOT FOUND OR r.status<>'session_created' OR p_proof->>'accountId'<>r.account_id OR p_proof->>'sessionId'<>r.provider_session_id
  OR p_proof->>'externalSessionId'<>r.id::text OR p_proof->>'externalCustomerId'<>r.customer_reference::text OR p_proof->>'serviceProvider'<>'TRANSAK'
  OR p_proof->>'paymentMethodType'<>r.payment_method OR p_proof->>'countryCode'<>r.country_code OR p_proof->>'sourceCurrencyCode'<>r.source_currency
  OR(p_proof->>'sourceAmount')::numeric<>r.requested_amount OR p_proof->>'destinationCurrencyCode'<>'USDT_POLYGON' OR p_proof->>'walletAddress'<>r.wallet_address OR p_proof->>'chainId'<>'137' THEN
  RAISE EXCEPTION 'sandbox_wallet_proof_context_mismatch' USING ERRCODE='22023';END IF;
 IF v_time<r.created_at-interval '5 minutes' THEN RAISE EXCEPTION 'sandbox_wallet_proof_invalid' USING ERRCODE='22023';END IF;
 IF r.proof IS NOT NULL THEN
  IF r.transaction_id<>p_proof->>'transactionId' THEN RAISE EXCEPTION 'sandbox_wallet_proof_transaction_conflict' USING ERRCODE='23505';END IF;
  IF v_time<r.provider_updated_at THEN RETURN r.proof;END IF;
  IF v_time=r.provider_updated_at AND p_proof<>r.proof THEN RAISE EXCEPTION 'sandbox_wallet_proof_version_conflict' USING ERRCODE='23505';END IF;
  v_old:=r.proof->>'providerStatus';
  IF v_old IN('SETTLED','FAILED','DECLINED','CANCELLED','REFUNDED','VOIDED','AUTHORIZATION_EXPIRED')
   AND p_proof->>'providerStatus' IN('PENDING_CREATED','PENDING','PROCESSING','AUTHORIZED','ACCEPTED','PARTIALLY_SETTLED','SETTLING','TWO_FA_REQUIRED','TWO_FA_PROVIDED','ERROR') THEN RETURN r.proof;END IF;
 END IF;
 UPDATE payments.connected_wallet_sandbox_attempt SET transaction_id=p_proof->>'transactionId',proof=p_proof,proof_hash=p_hash,provider_updated_at=v_time,checked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=r.id;
 RETURN p_proof;
END $function$;
CREATE INDEX sandbox_wallet_challenge_subject_issued_idx ON identity.sandbox_wallet_challenge(subject,issued_at DESC);
CREATE INDEX connected_sandbox_attempt_subject_created_idx ON payments.connected_wallet_sandbox_attempt(subject,created_at DESC,id DESC);
DO $owners$
DECLARE v_owner text;v_signature text;v_table text;item record;
BEGIN
 SELECT pg_catalog.pg_get_userbyid(proowner) INTO v_owner FROM pg_catalog.pg_proc WHERE oid='identity.require_administrative_native_session(text,text)'::regprocedure;
 FOREACH v_table IN ARRAY ARRAY['identity.sandbox_wallet_challenge','identity.sandbox_wallet_binding','payments.connected_wallet_sandbox_attempt'] LOOP
  EXECUTE pg_catalog.format('ALTER TABLE %s OWNER TO %I',v_table,v_owner);
  FOR item IN SELECT DISTINCT a.grantee FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a WHERE c.oid=v_table::regclass AND a.grantee<>c.relowner LOOP
   IF item.grantee=0 THEN EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %s FROM PUBLIC',v_table);ELSE EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %s FROM %I',v_table,pg_catalog.pg_get_userbyid(item.grantee));END IF;
  END LOOP;
 END LOOP;
 FOREACH v_signature IN ARRAY ARRAY['identity.read_sandbox_wallet_binding(text,text)','identity.create_sandbox_wallet_challenge(text,text,text,uuid,text)','identity.read_sandbox_wallet_challenge(text,text,uuid)','identity.consume_sandbox_wallet_challenge(text,text,uuid,text,text,text)','identity.require_sandbox_wallet_binding(text,text)','payments.create_connected_wallet_sandbox_attempt(text,text,uuid,text,numeric,text,text,text)','payments.finish_connected_wallet_sandbox_attempt(text,text,uuid,text,text,text)','payments.read_connected_wallet_sandbox_attempt(text,text,uuid)','payments.read_connected_wallet_sandbox_history(text,text)','payments.record_connected_wallet_sandbox_proof(text,uuid,jsonb,text)'] LOOP
  EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO %I',v_signature,v_owner);
  EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,mindbliss_auth_core_v1',v_signature);
  FOR item IN SELECT DISTINCT a.grantee FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a WHERE p.oid=v_signature::regprocedure AND a.grantee<>p.proowner LOOP
   IF item.grantee=0 THEN EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',v_signature);ELSE EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %I',v_signature,pg_catalog.pg_get_userbyid(item.grantee));END IF;
  END LOOP;
  IF v_signature<>'identity.require_sandbox_wallet_binding(text,text)' THEN EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO mindbliss_auth_core_v1',v_signature);END IF;
 END LOOP;
END $owners$;
DO $verify$
DECLARE v_owner oid;v_table text;v_signature text;v_runtime boolean;
BEGIN
 SELECT proowner INTO v_owner FROM pg_catalog.pg_proc WHERE oid='identity.require_administrative_native_session(text,text)'::regprocedure;
 FOREACH v_table IN ARRAY ARRAY['identity.sandbox_wallet_challenge','identity.sandbox_wallet_binding','payments.connected_wallet_sandbox_attempt'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid=v_table::regclass AND relowner=v_owner AND relrowsecurity)
   OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1',v_table,'SELECT,INSERT,UPDATE,DELETE')
   OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a WHERE c.oid=v_table::regclass AND a.grantee<>c.relowner) THEN RAISE EXCEPTION 'sandbox_wallet_isolation_failed';END IF;
 END LOOP;
 FOREACH v_signature IN ARRAY ARRAY['identity.read_sandbox_wallet_binding(text,text)','identity.create_sandbox_wallet_challenge(text,text,text,uuid,text)','identity.read_sandbox_wallet_challenge(text,text,uuid)','identity.consume_sandbox_wallet_challenge(text,text,uuid,text,text,text)','identity.require_sandbox_wallet_binding(text,text)','payments.create_connected_wallet_sandbox_attempt(text,text,uuid,text,numeric,text,text,text)','payments.finish_connected_wallet_sandbox_attempt(text,text,uuid,text,text,text)','payments.read_connected_wallet_sandbox_attempt(text,text,uuid)','payments.read_connected_wallet_sandbox_history(text,text)','payments.record_connected_wallet_sandbox_proof(text,uuid,jsonb,text)'] LOOP
  v_runtime:=v_signature<>'identity.require_sandbox_wallet_binding(text,text)';
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid=v_signature::regprocedure AND proowner=v_owner AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog']::text[])
   OR pg_catalog.has_function_privilege('mindbliss_auth_core_v1',v_signature,'EXECUTE')<>v_runtime
   OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a WHERE p.oid=v_signature::regprocedure AND a.grantee<>p.proowner AND(NOT v_runtime OR a.grantee<>'mindbliss_auth_core_v1'::regrole)) THEN RAISE EXCEPTION 'sandbox_wallet_isolation_failed';END IF;
 END LOOP;
END $verify$;
COMMIT;

