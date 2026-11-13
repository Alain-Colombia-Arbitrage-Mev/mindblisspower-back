-- Native-session ownership proof, dry-run transfer drafts and sandbox SELL facts only.
-- No key custody, broadcast, ledger, commission, personal wallet, or BUY113 dependency.
BEGIN;
SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('administrative-wallet-signing-dry-run-v1',0));
DO $preflight$
DECLARE v_owner oid;
BEGIN
 IF pg_catalog.current_database()<>'mindbliss_curated_20261025' OR pg_catalog.pg_is_in_recovery()
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.create_meld_sandbox_funding_attempt_v2(text,text,text,numeric,uuid,text,text,text)'::regprocedure))<>'ac59aee12c97aaed2010090dc22788af'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.record_meld_sandbox_proof(text,uuid,jsonb,text)'::regprocedure))<>'897295b28bfebb9058bc8f1643199bbc'
  OR pg_catalog.to_regclass('identity.administrative_wallet_challenge') IS NOT NULL
  OR pg_catalog.to_regclass('identity.administrative_wallet_binding') IS NOT NULL
  OR pg_catalog.to_regclass('payments.administrative_wallet_transfer_draft') IS NOT NULL
  OR pg_catalog.to_regclass('payments.administrative_offramp_intent') IS NOT NULL THEN
  RAISE EXCEPTION 'administrative_signing_requires_fresh_review';END IF;
 SELECT proowner INTO v_owner FROM pg_catalog.pg_proc WHERE oid='payments.create_meld_sandbox_funding_attempt_v2(text,text,text,numeric,uuid,text,text,text)'::regprocedure;
 IF NOT pg_catalog.pg_has_role(v_owner,'USAGE') OR NOT pg_catalog.has_table_privilege(v_owner,'auth.session','SELECT')
  OR NOT pg_catalog.has_any_column_privilege(v_owner,'auth.session','UPDATE')
  OR NOT pg_catalog.has_schema_privilege('mindbliss_auth_core_v1','identity','USAGE')
  OR NOT pg_catalog.has_schema_privilege('mindbliss_auth_core_v1','payments','USAGE')
  OR(SELECT count(*) FROM pg_catalog.pg_attribute WHERE attrelid='auth.session'::regclass AND NOT attisdropped
    AND((attname='id' AND atttypid='text'::regtype) OR(attname='user_id' AND atttypid='text'::regtype) OR(attname='expires_at' AND atttypid='timestamptz'::regtype)))<>3 THEN
  RAISE EXCEPTION 'administrative_signing_native_session_schema_required';END IF;
END $preflight$;
CREATE TABLE identity.administrative_wallet_challenge(
 id uuid PRIMARY KEY,subject text NOT NULL REFERENCES auth."user"(id) ON DELETE RESTRICT,
 native_session_id text NOT NULL CHECK(length(native_session_id) BETWEEN 1 AND 255),
 wallet_address text NOT NULL CHECK(wallet_address ~ '^0x[0-9a-f]{40}$'),chain_id integer NOT NULL DEFAULT 137 CHECK(chain_id=137),
 nonce text NOT NULL UNIQUE CHECK(nonce ~ '^[0-9a-f]{64}$'),session_context_hash text NOT NULL CHECK(session_context_hash ~ '^[0-9a-f]{64}$'),
 message text NOT NULL CHECK(length(message) BETWEEN 1 AND 4096),message_hash text NOT NULL CHECK(message_hash ~ '^[0-9a-f]{64}$'),
 issued_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,invalidated_at timestamptz,consumed_at timestamptz,
 signature_hash text CHECK(signature_hash ~ '^[0-9a-f]{64}$'),
 CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '5 minutes'),CHECK((consumed_at IS NULL)=(signature_hash IS NULL))
);
CREATE TABLE identity.administrative_wallet_binding(
 subject text NOT NULL REFERENCES auth."user"(id) ON DELETE RESTRICT,native_session_id text NOT NULL CHECK(length(native_session_id) BETWEEN 1 AND 255),
 wallet_address text NOT NULL CHECK(wallet_address ~ '^0x[0-9a-f]{40}$'),chain_id integer NOT NULL DEFAULT 137 CHECK(chain_id=137),
 challenge_id uuid NOT NULL UNIQUE REFERENCES identity.administrative_wallet_challenge(id) ON DELETE RESTRICT,
 verified_at timestamptz NOT NULL,native_expires_at timestamptz NOT NULL,binding_expires_at timestamptz NOT NULL,
 PRIMARY KEY(subject,native_session_id),CHECK(binding_expires_at>verified_at AND binding_expires_at<=verified_at+interval '24 hours' AND binding_expires_at<=native_expires_at)
);
CREATE TABLE payments.administrative_wallet_transfer_draft(
 id uuid PRIMARY KEY,subject text NOT NULL REFERENCES auth."user"(id) ON DELETE RESTRICT,native_session_id text NOT NULL,
 wallet_address text NOT NULL CHECK(wallet_address ~ '^0x[0-9a-f]{40}$'),chain_id integer NOT NULL DEFAULT 137 CHECK(chain_id=137),
 token_address text NOT NULL DEFAULT '0xc2132d05d31c914a87c6611c10748aeb04b58e8f' CHECK(token_address='0xc2132d05d31c914a87c6611c10748aeb04b58e8f'),
 recipient_address text NOT NULL CHECK(recipient_address ~ '^0x[0-9a-f]{40}$' AND recipient_address<>'0x0000000000000000000000000000000000000000' AND recipient_address<>wallet_address AND recipient_address<>token_address),
 amount_atomic numeric(16,0) NOT NULL CHECK(amount_atomic BETWEEN 1 AND 1000000000000000),
 calldata text NOT NULL CHECK(calldata ~ '^0xa9059cbb[0-9a-f]{128}$'),preparation_hash text NOT NULL CHECK(preparation_hash ~ '^[0-9a-f]{64}$'),
 status text NOT NULL DEFAULT 'prepared' CHECK(status='prepared'),execution_mode text NOT NULL DEFAULT 'dry_run' CHECK(execution_mode='dry_run'),
 created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,CHECK(expires_at>created_at AND expires_at<=created_at+interval '5 minutes')
);
CREATE TABLE payments.administrative_offramp_intent(
 id uuid PRIMARY KEY,subject text NOT NULL REFERENCES auth."user"(id) ON DELETE RESTRICT,native_session_id text NOT NULL,
 wallet_address text NOT NULL CHECK(wallet_address ~ '^0x[0-9a-f]{40}$'),customer_reference uuid NOT NULL,
 environment text NOT NULL DEFAULT 'sandbox' CHECK(environment='sandbox'),transaction_type text NOT NULL DEFAULT 'SELL' CHECK(transaction_type='SELL'),
 source_currency text NOT NULL DEFAULT 'USDT_POLYGON' CHECK(source_currency='USDT_POLYGON'),chain_id integer NOT NULL DEFAULT 137 CHECK(chain_id=137),
 source_amount numeric(18,6) NOT NULL CHECK(source_amount BETWEEN 0.000001 AND 1000000000),
 country_code text NOT NULL CHECK(country_code IN('US','MX','CO')),destination_currency text NOT NULL,
 service_provider text NOT NULL CHECK(service_provider ~ '^[A-Z0-9_]{2,64}$'),payment_method text NOT NULL CHECK(payment_method ~ '^[A-Z0-9_]{2,64}$'),
 account_id text NOT NULL CHECK(account_id ~ '^[A-Za-z0-9_.:-]{1,128}$' AND account_id NOT IN('.','..')),
 status text NOT NULL DEFAULT 'initiated' CHECK(status IN('initiated','session_created','unavailable')),
 provider_session_id text CHECK(provider_session_id ~ '^[A-Za-z0-9_.:-]{1,128}$' AND provider_session_id NOT IN('.','..')),
 quoted_destination_amount numeric(24,6) CHECK(quoted_destination_amount>0 AND quoted_destination_amount<=1000000000000000),
 transaction_id text UNIQUE CHECK(transaction_id ~ '^[A-Za-z0-9_.:-]{1,128}$' AND transaction_id NOT IN('.','..')),
 proof jsonb CHECK(pg_catalog.jsonb_typeof(proof)='object' AND pg_catalog.pg_column_size(proof)<=16384),
 proof_hash text CHECK(proof_hash ~ '^[0-9a-f]{64}$'),provider_updated_at timestamptz,checked_at timestamptz,
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
 UNIQUE(account_id,provider_session_id),
 CHECK(destination_currency='USD' OR(destination_currency='MXN' AND country_code='MX') OR(destination_currency='COP' AND country_code='CO')),
 CHECK((status='session_created' AND provider_session_id IS NOT NULL) OR(status<>'session_created' AND provider_session_id IS NULL)),
 CHECK((proof IS NULL AND transaction_id IS NULL AND proof_hash IS NULL AND provider_updated_at IS NULL AND checked_at IS NULL)
  OR(proof IS NOT NULL AND status='session_created' AND transaction_id IS NOT NULL AND proof_hash IS NOT NULL AND provider_updated_at IS NOT NULL AND checked_at IS NOT NULL))
);
ALTER TABLE identity.administrative_wallet_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.administrative_wallet_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments.administrative_wallet_transfer_draft ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments.administrative_offramp_intent ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON identity.administrative_wallet_challenge,identity.administrative_wallet_binding,payments.administrative_wallet_transfer_draft,payments.administrative_offramp_intent FROM PUBLIC,mindbliss_auth_core_v1;

-- No FK to auth.session: logout must remain free to DELETE the native session.
CREATE FUNCTION identity.require_administrative_native_session(p_subject text,p_session text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_expires timestamptz;
BEGIN
 BEGIN PERFORM identity.administrative_wallet_person(p_subject);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'administrative_signing_forbidden' USING ERRCODE='28000';END;
 IF p_session IS NULL OR length(p_session) NOT BETWEEN 1 AND 255 THEN RAISE EXCEPTION 'administrative_signing_forbidden' USING ERRCODE='28000';END IF;
 SELECT s.expires_at INTO v_expires FROM auth.session s WHERE s.id=p_session AND s.user_id=p_subject AND s.expires_at>clock_timestamp() FOR SHARE;
 IF v_expires IS NULL THEN RAISE EXCEPTION 'administrative_signing_forbidden' USING ERRCODE='28000';END IF;
 RETURN v_expires;
END $function$;

CREATE FUNCTION identity.require_administrative_wallet_binding(p_subject text,p_session text)
RETURNS TABLE(wallet_address text,binding_expires_at timestamptz,native_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_native timestamptz;v_address text;v_until timestamptz;
BEGIN
 v_native:=identity.require_administrative_native_session(p_subject,p_session);
 SELECT p.address INTO v_address FROM identity.administrative_wallet_assignment a JOIN identity.administrative_wallet_pool p ON p.ordinal=a.pool_ordinal
  WHERE a.subject=p_subject AND p.status='available' FOR SHARE OF a,p;
 SELECT b.binding_expires_at INTO v_until FROM identity.administrative_wallet_binding b
  WHERE b.subject=p_subject AND b.native_session_id=p_session AND b.wallet_address=v_address AND b.binding_expires_at>clock_timestamp() FOR SHARE;
 IF v_address IS NULL OR v_until IS NULL OR least(v_until,v_native)<=clock_timestamp() THEN
  RAISE EXCEPTION 'administrative_transfer_binding_required' USING ERRCODE='28000';END IF;
 RETURN QUERY SELECT v_address,least(v_until,v_native),v_native;
END $function$;
CREATE FUNCTION identity.read_administrative_wallet_signing_status(p_subject text,p_session text)
RETURNS TABLE(wallet_address text,verified boolean,binding_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_native timestamptz;v_address text;v_until timestamptz;
BEGIN
 v_native:=identity.require_administrative_native_session(p_subject,p_session);
 SELECT p.address INTO v_address FROM identity.administrative_wallet_assignment a JOIN identity.administrative_wallet_pool p ON p.ordinal=a.pool_ordinal WHERE a.subject=p_subject AND p.status='available';
 IF v_address IS NULL THEN RAISE EXCEPTION 'administrative_signing_forbidden' USING ERRCODE='28000';END IF;
 SELECT least(b.binding_expires_at,v_native) INTO v_until FROM identity.administrative_wallet_binding b WHERE b.subject=p_subject AND b.native_session_id=p_session AND b.wallet_address=v_address AND least(b.binding_expires_at,v_native)>clock_timestamp();
 RETURN QUERY SELECT v_address,v_until IS NOT NULL,v_until;
END $function$;
CREATE FUNCTION identity.create_administrative_wallet_signing_challenge(p_subject text,p_session text,p_id uuid,p_nonce text)
RETURNS TABLE(id uuid,address text,chain_id integer,message text,message_hash text,nonce text,issued_at timestamptz,expires_at timestamptz,session_context_hash text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_native timestamptz;v_address text;v_now timestamptz;v_until timestamptz;v_context text;v_message text;r identity.administrative_wallet_challenge%ROWTYPE;
BEGIN
 v_native:=identity.require_administrative_native_session(p_subject,p_session);
 IF p_id IS NULL OR p_nonce IS NULL OR p_nonce !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'administrative_signing_invalid_challenge' USING ERRCODE='22023';END IF;
 SELECT p.address INTO v_address FROM identity.administrative_wallet_assignment a JOIN identity.administrative_wallet_pool p ON p.ordinal=a.pool_ordinal WHERE a.subject=p_subject AND p.status='available' FOR SHARE OF a,p;
 IF v_address IS NULL THEN RAISE EXCEPTION 'administrative_signing_forbidden' USING ERRCODE='28000';END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('admin-wallet-challenge:'||p_subject,0));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('admin-wallet-challenge-id:'||p_id::text,0));
 IF v_native<=clock_timestamp() THEN RAISE EXCEPTION 'administrative_signing_forbidden' USING ERRCODE='28000';END IF;
 SELECT * INTO r FROM identity.administrative_wallet_challenge c WHERE c.id=p_id;
 IF FOUND THEN
  IF r.subject<>p_subject OR r.native_session_id<>p_session OR r.wallet_address<>v_address OR r.nonce<>p_nonce OR r.consumed_at IS NOT NULL OR r.invalidated_at IS NOT NULL OR r.expires_at<=clock_timestamp() THEN
   RAISE EXCEPTION 'administrative_signing_invalid_challenge' USING ERRCODE='22023';END IF;
  RETURN QUERY SELECT r.id,r.wallet_address,r.chain_id,r.message,r.message_hash,r.nonce,r.issued_at,r.expires_at,r.session_context_hash;RETURN;
 END IF;
 v_now:=clock_timestamp();v_until:=least(v_now+interval '5 minutes',v_native);
 IF v_until<=v_now THEN RAISE EXCEPTION 'administrative_signing_forbidden' USING ERRCODE='28000';END IF;
 IF(SELECT count(*) FROM identity.administrative_wallet_challenge c WHERE c.subject=p_subject AND c.issued_at>v_now-interval '10 minutes')>=5
  OR(SELECT count(*) FROM identity.administrative_wallet_challenge c WHERE c.subject=p_subject AND c.native_session_id=p_session AND c.issued_at>v_now-interval '5 minutes')>=3 THEN
  RAISE EXCEPTION 'administrative_signing_rate_limited' USING ERRCODE='54000';END IF;
 v_context:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_subject||E'\n'||p_session,'UTF8')),'hex');
 v_message:='wallet.mindblisspower.com wants you to verify control of this administrative wallet:'||E'\n'||v_address||E'\n\n'||
  'Mindbliss administrative wallet ownership only. No transaction or transfer of funds.'||E'\nSession context: '||v_context||
  E'\n\nURI: https://wallet.mindblisspower.com/dashboard/wallet-administrative\nVersion: 1\nChain ID: 137\nNonce: '||p_nonce||
  E'\nIssued At: '||pg_catalog.to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')||
  E'\nExpiration Time: '||pg_catalog.to_char(v_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')||E'\nRequest ID: '||p_id::text;
 UPDATE identity.administrative_wallet_challenge SET invalidated_at=v_now WHERE subject=p_subject AND native_session_id=p_session AND consumed_at IS NULL AND invalidated_at IS NULL;
 RETURN QUERY INSERT INTO identity.administrative_wallet_challenge(id,subject,native_session_id,wallet_address,nonce,session_context_hash,message,message_hash,issued_at,expires_at)
 VALUES(p_id,p_subject,p_session,v_address,p_nonce,v_context,v_message,pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_message,'UTF8')),'hex'),v_now,v_until)
 RETURNING administrative_wallet_challenge.id,administrative_wallet_challenge.wallet_address,administrative_wallet_challenge.chain_id,administrative_wallet_challenge.message,
  administrative_wallet_challenge.message_hash,administrative_wallet_challenge.nonce,administrative_wallet_challenge.issued_at,administrative_wallet_challenge.expires_at,administrative_wallet_challenge.session_context_hash;
END $function$;
CREATE FUNCTION identity.read_administrative_wallet_signing_challenge(p_subject text,p_session text,p_id uuid)
RETURNS TABLE(id uuid,address text,chain_id integer,message text,message_hash text,nonce text,issued_at timestamptz,expires_at timestamptz,session_context_hash text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
 PERFORM identity.require_administrative_native_session(p_subject,p_session);
 RETURN QUERY SELECT c.id,c.wallet_address,c.chain_id,c.message,c.message_hash,c.nonce,c.issued_at,c.expires_at,c.session_context_hash
 FROM identity.administrative_wallet_challenge c JOIN identity.administrative_wallet_assignment a ON a.subject=c.subject
 JOIN identity.administrative_wallet_pool p ON p.ordinal=a.pool_ordinal AND p.address=c.wallet_address AND p.status='available'
 WHERE c.id=p_id AND c.subject=p_subject AND c.native_session_id=p_session AND c.consumed_at IS NULL AND c.invalidated_at IS NULL AND c.expires_at>clock_timestamp();
END $function$;
CREATE FUNCTION identity.consume_administrative_wallet_signing_challenge(p_subject text,p_session text,p_id uuid,p_recovered text,p_message_hash text,p_signature_hash text)
RETURNS TABLE(verified boolean,binding_expires_at timestamptz,address text,chain_id integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_native timestamptz;v_address text;v_now timestamptz;v_until timestamptz;r identity.administrative_wallet_challenge%ROWTYPE;
BEGIN
 v_native:=identity.require_administrative_native_session(p_subject,p_session);
 SELECT p.address INTO v_address FROM identity.administrative_wallet_assignment a JOIN identity.administrative_wallet_pool p ON p.ordinal=a.pool_ordinal WHERE a.subject=p_subject AND p.status='available' FOR SHARE OF a,p;
 SELECT * INTO r FROM identity.administrative_wallet_challenge c WHERE c.id=p_id AND c.subject=p_subject AND c.native_session_id=p_session FOR UPDATE;
 v_now:=clock_timestamp();
 IF NOT FOUND OR r.consumed_at IS NOT NULL OR r.invalidated_at IS NOT NULL OR r.expires_at<=v_now OR v_native<=v_now THEN
  RAISE EXCEPTION 'administrative_signing_invalid_challenge' USING ERRCODE='22023';END IF;
 IF v_address IS NULL OR v_address<>r.wallet_address OR p_recovered IS NULL OR lower(p_recovered)<>v_address OR p_message_hash IS DISTINCT FROM r.message_hash
  OR p_signature_hash IS NULL OR p_signature_hash !~ '^[0-9a-f]{64}$' THEN
  RAISE EXCEPTION 'administrative_signing_signature_invalid' USING ERRCODE='22023';END IF;
 v_until:=least(v_native,v_now+interval '24 hours');
 UPDATE identity.administrative_wallet_challenge SET consumed_at=v_now,signature_hash=p_signature_hash WHERE id=r.id;
 INSERT INTO identity.administrative_wallet_binding(subject,native_session_id,wallet_address,challenge_id,verified_at,native_expires_at,binding_expires_at)
 VALUES(p_subject,p_session,v_address,r.id,v_now,v_native,v_until) ON CONFLICT(subject,native_session_id) DO UPDATE
 SET wallet_address=EXCLUDED.wallet_address,challenge_id=EXCLUDED.challenge_id,verified_at=EXCLUDED.verified_at,native_expires_at=EXCLUDED.native_expires_at,binding_expires_at=EXCLUDED.binding_expires_at;
 RETURN QUERY SELECT true,v_until,v_address,137;
END $function$;
CREATE FUNCTION payments.prepare_administrative_wallet_transfer(p_subject text,p_session text,p_id uuid,p_recipient text,p_amount text,p_calldata text,p_hash text)
RETURNS TABLE(id uuid,wallet_address text,recipient_address text,amount_atomic text,calldata text,preparation_hash text,created_at timestamptz,expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE b record;r payments.administrative_wallet_transfer_draft%ROWTYPE;v_amount numeric;v_atomic bigint;v_data text;v_json text;v_hash text;v_now timestamptz;v_token text:='0xc2132d05d31c914a87c6611c10748aeb04b58e8f';
BEGIN
 SELECT * INTO b FROM identity.require_administrative_wallet_binding(p_subject,p_session);
 IF p_recipient IS NULL OR p_recipient !~ '^0x[0-9a-f]{40}$' OR p_recipient IN('0x0000000000000000000000000000000000000000',v_token,b.wallet_address) THEN
  RAISE EXCEPTION 'administrative_transfer_invalid_recipient' USING ERRCODE='22023';END IF;
 IF p_id IS NULL OR p_amount IS NULL OR p_amount !~ '^\d{1,10}(\.\d{1,6})?$' THEN RAISE EXCEPTION 'administrative_transfer_invalid_amount' USING ERRCODE='22023';END IF;
 v_amount:=p_amount::numeric;
 IF NOT(v_amount BETWEEN 0.000001 AND 1000000000) THEN RAISE EXCEPTION 'administrative_transfer_invalid_amount' USING ERRCODE='22023';END IF;
 v_atomic:=(v_amount*1000000)::bigint;
 v_data:='0xa9059cbb'||pg_catalog.lpad(pg_catalog.substr(p_recipient,3),64,'0')||pg_catalog.lpad(pg_catalog.to_hex(v_atomic),64,'0');
 v_json:='{"version":1,"chainId":137,"from":"'||b.wallet_address||'","to":"'||v_token||'","recipient":"'||p_recipient||'","amountUnits":"'||v_atomic::text||'","data":"'||v_data||'","value":"0x0"}';
 v_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_json,'UTF8')),'hex');
 IF p_calldata IS DISTINCT FROM v_data OR p_hash IS DISTINCT FROM v_hash THEN RAISE EXCEPTION 'administrative_transfer_invalid_request' USING ERRCODE='22023';END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('admin-transfer:'||p_subject,0));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('admin-transfer-id:'||p_id::text,0));
 IF least(b.binding_expires_at,b.native_expires_at)<=clock_timestamp() THEN RAISE EXCEPTION 'administrative_transfer_binding_required' USING ERRCODE='28000';END IF;
 SELECT * INTO r FROM payments.administrative_wallet_transfer_draft a WHERE a.id=p_id;
 IF FOUND THEN
  IF r.subject<>p_subject OR r.native_session_id<>p_session OR r.wallet_address<>b.wallet_address OR r.recipient_address<>p_recipient OR r.amount_atomic<>v_atomic OR r.preparation_hash<>v_hash THEN
   RAISE EXCEPTION 'administrative_transfer_request_already_used' USING ERRCODE='22023';END IF;
  RETURN QUERY SELECT r.id,r.wallet_address,r.recipient_address,r.amount_atomic::text,r.calldata,r.preparation_hash,r.created_at,r.expires_at;RETURN;
 END IF;
 v_now:=clock_timestamp();
 IF least(b.binding_expires_at,b.native_expires_at)<=v_now THEN RAISE EXCEPTION 'administrative_transfer_binding_required' USING ERRCODE='28000';END IF;
 IF(SELECT count(*) FROM payments.administrative_wallet_transfer_draft a WHERE a.subject=p_subject AND a.created_at>v_now-interval '10 minutes')>=10 THEN
  RAISE EXCEPTION 'administrative_transfer_rate_limited' USING ERRCODE='54000';END IF;
 RETURN QUERY INSERT INTO payments.administrative_wallet_transfer_draft(id,subject,native_session_id,wallet_address,recipient_address,amount_atomic,calldata,preparation_hash,created_at,expires_at)
 VALUES(p_id,p_subject,p_session,b.wallet_address,p_recipient,v_atomic,v_data,v_hash,v_now,least(v_now+interval '5 minutes',b.binding_expires_at,b.native_expires_at))
 RETURNING administrative_wallet_transfer_draft.id,administrative_wallet_transfer_draft.wallet_address,administrative_wallet_transfer_draft.recipient_address,
  administrative_wallet_transfer_draft.amount_atomic::text,administrative_wallet_transfer_draft.calldata,administrative_wallet_transfer_draft.preparation_hash,administrative_wallet_transfer_draft.created_at,administrative_wallet_transfer_draft.expires_at;
END $function$;
CREATE FUNCTION payments.read_administrative_wallet_transfer_history(p_subject text,p_session text)
RETURNS TABLE(id uuid,wallet_address text,recipient_address text,amount_atomic text,calldata text,preparation_hash text,created_at timestamptz,expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
 PERFORM identity.require_administrative_native_session(p_subject,p_session);
 RETURN QUERY SELECT r.id,r.wallet_address,r.recipient_address,r.amount_atomic::text,r.calldata,r.preparation_hash,r.created_at,r.expires_at FROM payments.administrative_wallet_transfer_draft r
 WHERE r.subject=p_subject ORDER BY r.created_at DESC,r.id DESC LIMIT 20;
END $function$;
CREATE FUNCTION payments.create_administrative_offramp_intent(p_subject text,p_session text,p_id uuid,p_country text,p_fiat text,p_amount text,p_provider text,p_method text,p_account text)
RETURNS TABLE(id uuid,wallet_address text,customer_reference uuid,status text,created boolean,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE b record;r payments.administrative_offramp_intent%ROWTYPE;v_amount numeric;v_customer uuid;v_now timestamptz;
BEGIN
 SELECT * INTO b FROM identity.require_administrative_wallet_binding(p_subject,p_session);
 IF p_id IS NULL OR p_country IS NULL OR p_country NOT IN('US','MX','CO') OR p_fiat IS NULL
  OR NOT(p_fiat='USD' OR(p_fiat='MXN' AND p_country='MX') OR(p_fiat='COP' AND p_country='CO'))
  OR p_amount IS NULL OR p_amount !~ '^\d{1,10}(\.\d{1,6})?$' OR p_provider IS NULL OR p_provider !~ '^[A-Z0-9_]{2,64}$'
  OR p_method IS NULL OR p_method !~ '^[A-Z0-9_]{2,64}$' OR p_account IS NULL OR p_account !~ '^[A-Za-z0-9_.:-]{1,128}$' OR p_account IN('.','..') THEN
  RAISE EXCEPTION 'administrative_offramp_invalid_request' USING ERRCODE='22023';END IF;
 v_amount:=p_amount::numeric;
 IF NOT(v_amount BETWEEN 0.000001 AND 1000000000) THEN RAISE EXCEPTION 'administrative_offramp_invalid_request' USING ERRCODE='22023';END IF;
 SELECT a.checkout_reference INTO v_customer FROM identity.administrative_wallet_assignment a WHERE a.subject=p_subject;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('admin-offramp:'||p_subject,0));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('admin-offramp-id:'||p_id::text,0));
 IF least(b.binding_expires_at,b.native_expires_at)<=clock_timestamp() THEN RAISE EXCEPTION 'administrative_transfer_binding_required' USING ERRCODE='28000';END IF;
 SELECT * INTO r FROM payments.administrative_offramp_intent a WHERE a.id=p_id;
 IF FOUND THEN
  IF r.subject<>p_subject OR r.native_session_id<>p_session OR r.wallet_address<>b.wallet_address OR r.customer_reference<>v_customer
   OR r.country_code<>p_country OR r.destination_currency<>p_fiat OR r.source_amount<>v_amount OR r.service_provider<>p_provider OR r.payment_method<>p_method OR r.account_id<>p_account THEN
   RAISE EXCEPTION 'administrative_offramp_request_already_used' USING ERRCODE='22023';END IF;
  RETURN QUERY SELECT r.id,r.wallet_address,r.customer_reference,r.status,false,r.created_at;RETURN;
 END IF;
 v_now:=clock_timestamp();
 IF v_customer IS NULL OR least(b.binding_expires_at,b.native_expires_at)<=v_now THEN RAISE EXCEPTION 'administrative_transfer_binding_required' USING ERRCODE='28000';END IF;
 IF(SELECT count(*) FROM payments.administrative_offramp_intent a WHERE a.subject=p_subject AND a.created_at>v_now-interval '10 minutes')>=10 THEN
  RAISE EXCEPTION 'administrative_offramp_rate_limited' USING ERRCODE='54000';END IF;
 RETURN QUERY INSERT INTO payments.administrative_offramp_intent(id,subject,native_session_id,wallet_address,customer_reference,source_amount,country_code,destination_currency,service_provider,payment_method,account_id,created_at,updated_at)
 VALUES(p_id,p_subject,p_session,b.wallet_address,v_customer,v_amount,p_country,p_fiat,p_provider,p_method,p_account,v_now,v_now)
 RETURNING administrative_offramp_intent.id,administrative_offramp_intent.wallet_address,administrative_offramp_intent.customer_reference,administrative_offramp_intent.status,true,administrative_offramp_intent.created_at;
END $function$;
CREATE FUNCTION payments.finish_administrative_offramp_intent(p_subject text,p_session text,p_id uuid,p_status text,p_provider_session text,p_quote numeric)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE b record;r payments.administrative_offramp_intent%ROWTYPE;
BEGIN
 SELECT * INTO b FROM identity.require_administrative_wallet_binding(p_subject,p_session);
 IF p_id IS NULL OR p_status IS NULL OR p_status NOT IN('session_created','unavailable')
  OR(p_status='session_created' AND(p_provider_session IS NULL OR p_provider_session !~ '^[A-Za-z0-9_.:-]{1,128}$' OR p_provider_session IN('.','..')))
  OR(p_status='unavailable' AND(p_provider_session IS NOT NULL OR p_quote IS NOT NULL))
  OR(p_quote IS NOT NULL AND NOT(p_quote>0 AND p_quote<=1000000000000000 AND p_quote=round(p_quote,6))) THEN
  RAISE EXCEPTION 'administrative_offramp_invalid_request' USING ERRCODE='22023';END IF;
 SELECT * INTO r FROM payments.administrative_offramp_intent a WHERE a.id=p_id AND a.subject=p_subject AND a.native_session_id=p_session FOR UPDATE;
 IF NOT FOUND OR r.wallet_address<>b.wallet_address THEN RAISE EXCEPTION 'administrative_signing_forbidden' USING ERRCODE='28000';END IF;
 IF least(b.binding_expires_at,b.native_expires_at)<=clock_timestamp() THEN RAISE EXCEPTION 'administrative_transfer_binding_required' USING ERRCODE='28000';END IF;
 IF r.status<>'initiated' THEN RETURN r.status=p_status AND r.provider_session_id IS NOT DISTINCT FROM p_provider_session AND r.quoted_destination_amount IS NOT DISTINCT FROM p_quote;END IF;
 UPDATE payments.administrative_offramp_intent SET status=p_status,provider_session_id=p_provider_session,quoted_destination_amount=p_quote,updated_at=clock_timestamp() WHERE id=r.id;
 RETURN true;
END $function$;
CREATE FUNCTION payments.read_administrative_offramp_intent(p_subject text,p_session text,p_id uuid)
RETURNS TABLE(id uuid,subject text,wallet_address text,customer_reference uuid,account_id text,country_code text,destination_currency text,source_amount numeric,amount_atomic text,service_provider text,payment_method text,status text,provider_session_id text,quoted_destination_amount numeric,proof jsonb,provider_updated_at timestamptz,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
 PERFORM identity.require_administrative_native_session(p_subject,p_session);
 RETURN QUERY SELECT r.id,r.subject,r.wallet_address,r.customer_reference,r.account_id,r.country_code,r.destination_currency,r.source_amount,(r.source_amount*1000000)::bigint::text,r.service_provider,r.payment_method,r.status,r.provider_session_id,r.quoted_destination_amount,r.proof,r.provider_updated_at,r.created_at
 FROM payments.administrative_offramp_intent r WHERE r.id=p_id AND r.subject=p_subject;
END $function$;
CREATE FUNCTION payments.read_administrative_offramp_history(p_subject text,p_session text)
RETURNS TABLE(id uuid,subject text,wallet_address text,customer_reference uuid,account_id text,country_code text,destination_currency text,source_amount numeric,amount_atomic text,service_provider text,payment_method text,status text,provider_session_id text,quoted_destination_amount numeric,proof jsonb,provider_updated_at timestamptz,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
 PERFORM identity.require_administrative_native_session(p_subject,p_session);
 RETURN QUERY SELECT r.id,r.subject,r.wallet_address,r.customer_reference,r.account_id,r.country_code,r.destination_currency,r.source_amount,(r.source_amount*1000000)::bigint::text,r.service_provider,r.payment_method,r.status,r.provider_session_id,r.quoted_destination_amount,r.proof,r.provider_updated_at,r.created_at
 FROM payments.administrative_offramp_intent r WHERE r.subject=p_subject ORDER BY r.created_at DESC,r.id DESC LIMIT 20;
END $function$;
CREATE FUNCTION payments.read_administrative_offramp_webhook_context(p_id uuid,p_customer uuid,p_provider_session text)
RETURNS TABLE(id uuid,subject text,wallet_address text,customer_reference uuid,account_id text,country_code text,destination_currency text,source_amount numeric,amount_atomic text,service_provider text,payment_method text,status text,provider_session_id text,quoted_destination_amount numeric,proof jsonb,provider_updated_at timestamptz,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
 RETURN QUERY SELECT r.id,r.subject,r.wallet_address,r.customer_reference,r.account_id,r.country_code,r.destination_currency,r.source_amount,(r.source_amount*1000000)::bigint::text,r.service_provider,r.payment_method,r.status,r.provider_session_id,r.quoted_destination_amount,r.proof,r.provider_updated_at,r.created_at
 FROM payments.administrative_offramp_intent r WHERE r.id=p_id AND r.customer_reference=p_customer AND r.provider_session_id=p_provider_session AND r.status='session_created';
END $function$;
CREATE FUNCTION payments.record_administrative_offramp_proof(p_id uuid,p_proof jsonb,p_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE r payments.administrative_offramp_intent%ROWTYPE;v_time timestamptz;v_amount numeric;v_old text;
BEGIN
 IF p_id IS NULL OR p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' OR p_proof IS NULL OR pg_catalog.jsonb_typeof(p_proof)<>'object'
  OR(SELECT count(*) FROM pg_catalog.jsonb_each(p_proof)) NOT IN(16,17)
  OR NOT(p_proof ?& ARRAY['transactionId','accountId','sessionId','externalSessionId','externalCustomerId','serviceProvider','countryCode','destinationCurrencyCode','sourceCurrencyCode','sourceAmount','sourceWalletAddress','chainId','paymentMethodType','providerStatus','providerUpdatedAt','destinationAmount']::text[])
  OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_each(p_proof) x WHERE pg_catalog.jsonb_typeof(x.value)<>'string'
   OR x.key NOT IN('transactionId','accountId','sessionId','externalSessionId','externalCustomerId','serviceProvider','countryCode','destinationCurrencyCode','sourceCurrencyCode','sourceAmount','sourceWalletAddress','chainId','paymentMethodType','providerStatus','providerUpdatedAt','destinationAmount','depositWalletAddress')) THEN
  RAISE EXCEPTION 'administrative_offramp_proof_invalid' USING ERRCODE='22023';END IF;
 IF p_proof->>'transactionId' !~ '^[A-Za-z0-9_.:-]{1,128}$' OR p_proof->>'transactionId' IN('.','..')
  OR p_proof->>'sourceAmount' !~ '^\d{1,10}(\.\d{1,6})?$' OR p_proof->>'destinationAmount' !~ '^\d{1,16}(\.\d{1,6})?$'
  OR(p_proof ? 'depositWalletAddress' AND(p_proof->>'depositWalletAddress' !~ '^0x[0-9a-f]{40}$' OR p_proof->>'depositWalletAddress'='0x0000000000000000000000000000000000000000'))
  OR p_proof->>'providerUpdatedAt' !~ '^\d{4}-\d{2}-\d{2}T.{1,48}$'
  OR p_proof->>'providerStatus' NOT IN('PENDING_CREATED','PENDING','PROCESSING','AUTHORIZED','ACCEPTED','PARTIALLY_SETTLED','SETTLING','TWO_FA_REQUIRED','TWO_FA_PROVIDED','ERROR','SETTLED','FAILED','DECLINED','CANCELLED','REFUNDED','VOIDED','AUTHORIZATION_EXPIRED') THEN
  RAISE EXCEPTION 'administrative_offramp_proof_invalid' USING ERRCODE='22023';END IF;
 BEGIN v_time:=(p_proof->>'providerUpdatedAt')::timestamptz;v_amount:=(p_proof->>'destinationAmount')::numeric;
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'administrative_offramp_proof_invalid' USING ERRCODE='22023';END;
 IF NOT pg_catalog.isfinite(v_time) OR v_amount<0 OR v_amount>1000000000000000 OR(p_proof->>'providerStatus'='SETTLED' AND v_amount<=0) THEN
  RAISE EXCEPTION 'administrative_offramp_proof_invalid' USING ERRCODE='22023';END IF;
 SELECT * INTO r FROM payments.administrative_offramp_intent a WHERE a.id=p_id FOR UPDATE;
 IF NOT FOUND OR r.status<>'session_created' OR p_proof->>'accountId'<>r.account_id OR p_proof->>'externalSessionId'<>r.id::text
  OR p_proof->>'externalCustomerId'<>r.customer_reference::text OR p_proof->>'sessionId'<>r.provider_session_id
  OR p_proof->>'serviceProvider'<>r.service_provider OR p_proof->>'paymentMethodType'<>r.payment_method OR p_proof->>'countryCode'<>r.country_code
  OR p_proof->>'sourceCurrencyCode'<>'USDT_POLYGON' OR p_proof->>'destinationCurrencyCode'<>r.destination_currency OR(p_proof->>'sourceAmount')::numeric<>r.source_amount
  OR p_proof->>'sourceWalletAddress'<>r.wallet_address OR p_proof->>'chainId'<>'137'
  OR(p_proof ? 'depositWalletAddress' AND p_proof->>'depositWalletAddress'=r.wallet_address) THEN RAISE EXCEPTION 'administrative_offramp_proof_context_mismatch' USING ERRCODE='22023';END IF;
 IF r.proof IS NOT NULL THEN
  IF r.transaction_id<>p_proof->>'transactionId' THEN RAISE EXCEPTION 'administrative_offramp_proof_transaction_conflict' USING ERRCODE='23505';END IF;
  IF r.proof ? 'depositWalletAddress' AND(r.proof->>'depositWalletAddress' IS DISTINCT FROM p_proof->>'depositWalletAddress') THEN
   RAISE EXCEPTION 'administrative_offramp_proof_deposit_conflict' USING ERRCODE='23505';END IF;
  IF v_time<r.provider_updated_at THEN RETURN r.proof;END IF;
  IF v_time=r.provider_updated_at AND p_proof<>r.proof THEN RAISE EXCEPTION 'administrative_offramp_proof_version_conflict' USING ERRCODE='23505';END IF;
  v_old:=r.proof->>'providerStatus';
  IF v_old IN('SETTLED','FAILED','DECLINED','CANCELLED','REFUNDED','VOIDED','AUTHORIZATION_EXPIRED') AND p_proof->>'providerStatus' IN('PENDING_CREATED','PENDING','PROCESSING','AUTHORIZED','ACCEPTED','PARTIALLY_SETTLED','SETTLING','TWO_FA_REQUIRED','TWO_FA_PROVIDED','ERROR') THEN RETURN r.proof;END IF;
 END IF;
 UPDATE payments.administrative_offramp_intent SET transaction_id=p_proof->>'transactionId',proof=p_proof,proof_hash=p_hash,provider_updated_at=v_time,checked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=r.id;
 RETURN p_proof;
END $function$;
CREATE INDEX administrative_challenge_subject_issued_idx ON identity.administrative_wallet_challenge(subject,issued_at DESC);
CREATE INDEX administrative_transfer_subject_created_idx ON payments.administrative_wallet_transfer_draft(subject,created_at DESC,id DESC);
CREATE INDEX administrative_offramp_subject_created_idx ON payments.administrative_offramp_intent(subject,created_at DESC,id DESC);
DO $owners$
DECLARE v_owner text;v_signature text;v_table text;item record;
BEGIN
 SELECT pg_catalog.pg_get_userbyid(proowner) INTO v_owner FROM pg_catalog.pg_proc WHERE oid='payments.create_meld_sandbox_funding_attempt_v2(text,text,text,numeric,uuid,text,text,text)'::regprocedure;
 FOREACH v_table IN ARRAY ARRAY['identity.administrative_wallet_challenge','identity.administrative_wallet_binding','payments.administrative_wallet_transfer_draft','payments.administrative_offramp_intent'] LOOP
  EXECUTE pg_catalog.format('ALTER TABLE %s OWNER TO %I',v_table,v_owner);
  FOR item IN SELECT DISTINCT a.grantee FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a WHERE c.oid=v_table::regclass AND a.grantee<>c.relowner LOOP
   IF item.grantee=0 THEN EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %s FROM PUBLIC',v_table);ELSE EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %s FROM %I',v_table,pg_catalog.pg_get_userbyid(item.grantee));END IF;
  END LOOP;
 END LOOP;
 FOREACH v_signature IN ARRAY ARRAY['identity.require_administrative_native_session(text,text)','identity.require_administrative_wallet_binding(text,text)',
  'identity.read_administrative_wallet_signing_status(text,text)','identity.create_administrative_wallet_signing_challenge(text,text,uuid,text)',
  'identity.read_administrative_wallet_signing_challenge(text,text,uuid)','identity.consume_administrative_wallet_signing_challenge(text,text,uuid,text,text,text)',
  'payments.prepare_administrative_wallet_transfer(text,text,uuid,text,text,text,text)','payments.read_administrative_wallet_transfer_history(text,text)',
  'payments.create_administrative_offramp_intent(text,text,uuid,text,text,text,text,text,text)','payments.finish_administrative_offramp_intent(text,text,uuid,text,text,numeric)',
  'payments.read_administrative_offramp_intent(text,text,uuid)','payments.read_administrative_offramp_history(text,text)',
  'payments.read_administrative_offramp_webhook_context(uuid,uuid,text)','payments.record_administrative_offramp_proof(uuid,jsonb,text)'] LOOP
  EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO %I',v_signature,v_owner);
  -- NULL proacl still grants implicit PUBLIC EXECUTE; materialize and remove it.
  EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,mindbliss_auth_core_v1',v_signature);
  FOR item IN SELECT DISTINCT a.grantee FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a WHERE p.oid=v_signature::regprocedure AND a.grantee<>p.proowner LOOP
   IF item.grantee=0 THEN EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',v_signature);ELSE EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %I',v_signature,pg_catalog.pg_get_userbyid(item.grantee));END IF;
  END LOOP;
  IF v_signature NOT IN('identity.require_administrative_native_session(text,text)','identity.require_administrative_wallet_binding(text,text)') THEN
   EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO mindbliss_auth_core_v1',v_signature);END IF;
 END LOOP;
END $owners$;
DO $verify$
DECLARE v_owner oid;v_table text;v_signature text;v_runtime boolean;
BEGIN
 SELECT proowner INTO v_owner FROM pg_catalog.pg_proc WHERE oid='payments.create_meld_sandbox_funding_attempt_v2(text,text,text,numeric,uuid,text,text,text)'::regprocedure;
 FOREACH v_table IN ARRAY ARRAY['identity.administrative_wallet_challenge','identity.administrative_wallet_binding','payments.administrative_wallet_transfer_draft','payments.administrative_offramp_intent'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid=v_table::regclass AND relowner=v_owner AND relrowsecurity)
   OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1',v_table,'SELECT,INSERT,UPDATE,DELETE') OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a WHERE c.oid=v_table::regclass AND a.grantee<>c.relowner) THEN
   RAISE EXCEPTION 'administrative_signing_isolation_failed';END IF;
 END LOOP;
 FOREACH v_signature IN ARRAY ARRAY['identity.require_administrative_native_session(text,text)','identity.require_administrative_wallet_binding(text,text)',
  'identity.read_administrative_wallet_signing_status(text,text)','identity.create_administrative_wallet_signing_challenge(text,text,uuid,text)',
  'identity.read_administrative_wallet_signing_challenge(text,text,uuid)','identity.consume_administrative_wallet_signing_challenge(text,text,uuid,text,text,text)',
  'payments.prepare_administrative_wallet_transfer(text,text,uuid,text,text,text,text)','payments.read_administrative_wallet_transfer_history(text,text)',
  'payments.create_administrative_offramp_intent(text,text,uuid,text,text,text,text,text,text)','payments.finish_administrative_offramp_intent(text,text,uuid,text,text,numeric)',
  'payments.read_administrative_offramp_intent(text,text,uuid)','payments.read_administrative_offramp_history(text,text)',
  'payments.read_administrative_offramp_webhook_context(uuid,uuid,text)','payments.record_administrative_offramp_proof(uuid,jsonb,text)'] LOOP
  v_runtime:=v_signature NOT IN('identity.require_administrative_native_session(text,text)','identity.require_administrative_wallet_binding(text,text)');
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid=v_signature::regprocedure AND proowner=v_owner AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog']::text[])
   OR pg_catalog.has_function_privilege('mindbliss_auth_core_v1',v_signature,'EXECUTE')<>v_runtime
   OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a WHERE p.oid=v_signature::regprocedure AND a.grantee<>p.proowner AND(NOT v_runtime OR a.grantee<>'mindbliss_auth_core_v1'::regrole)) THEN
   RAISE EXCEPTION 'administrative_signing_isolation_failed';END IF;
 END LOOP;
END $verify$;
COMMIT;
