-- Production MELD checkout attempts started from App. No balance mutations,
-- no authorization to sign transactions, and no writes to legacy journals.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app-meld-funding-129',0));

DO $preflight$
DECLARE v_owner oid;
BEGIN
 IF pg_catalog.current_database()<>'mindbliss_curated_20261025'
  OR pg_catalog.pg_is_in_recovery()
  OR pg_catalog.to_regclass('identity.wallet_binding') IS NULL
  OR pg_catalog.to_regprocedure('identity.require_administrative_native_session(text,text)') IS NULL
  OR pg_catalog.to_regclass('payments.app_meld_funding_attempt') IS NOT NULL THEN
  RAISE EXCEPTION 'app_meld_funding_requires_review'; END IF;
 SELECT proowner INTO v_owner FROM pg_catalog.pg_proc WHERE oid='identity.require_administrative_native_session(text,text)'::regprocedure;
 IF NOT pg_catalog.pg_has_role(v_owner,'USAGE')
  OR NOT pg_catalog.has_table_privilege(v_owner,'identity.wallet_binding','SELECT')
  OR NOT pg_catalog.has_schema_privilege('mindbliss_auth_core_v1','payments','USAGE') THEN
  RAISE EXCEPTION 'app_meld_funding_requires_scoped_role'; END IF;
END $preflight$;

CREATE TABLE payments.app_meld_funding_attempt (
 id uuid PRIMARY KEY,
 subject text NOT NULL REFERENCES auth."user"(id) ON DELETE RESTRICT,
 native_session_id text NOT NULL CHECK(length(native_session_id) BETWEEN 1 AND 255),
 wallet_address text NOT NULL CHECK(wallet_address~'^0x[0-9a-f]{40}$' AND wallet_address<>'0x0000000000000000000000000000000000000000'),
 customer_reference uuid NOT NULL,
 country_code text NOT NULL CHECK(country_code='MX'),
 source_currency text NOT NULL CHECK(source_currency IN('MXN','USD')),
 destination_currency text NOT NULL DEFAULT 'USDT_POLYGON' CHECK(destination_currency='USDT_POLYGON'),
 chain_id integer NOT NULL DEFAULT 137 CHECK(chain_id=137),
 requested_amount numeric(15,2) NOT NULL,
 payment_method text NOT NULL,
 service_provider text NOT NULL,
 account_id text NOT NULL CHECK(account_id~'^[A-Za-z0-9_-]{1,128}$'),
 status text NOT NULL DEFAULT 'initiated' CHECK(status IN('initiated','session_created','unavailable')),
 provider_session_id text CHECK(provider_session_id~'^[A-Za-z0-9_-]{1,128}$'),
 provider_customer_id text CHECK(provider_customer_id~'^[A-Za-z0-9_-]{1,128}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(account_id,provider_session_id),
 CHECK(
  (service_provider='MERCURYO' AND payment_method='CREDIT_DEBIT_CARD'
   AND ((source_currency='USD' AND requested_amount BETWEEN 30 AND 15000)
    OR (source_currency='MXN' AND requested_amount BETWEEN 931 AND 312013.70)))
  OR (service_provider='ONRAMPMONEY' AND payment_method='SPEI'
   AND source_currency='MXN' AND requested_amount BETWEEN 931 AND 500000)
 ),
 CHECK((status='session_created' AND provider_session_id IS NOT NULL AND provider_customer_id IS NOT NULL)
  OR (status<>'session_created' AND provider_session_id IS NULL AND provider_customer_id IS NULL))
);
CREATE INDEX app_meld_funding_owner_created_idx ON payments.app_meld_funding_attempt(subject,created_at DESC,id DESC);
ALTER TABLE payments.app_meld_funding_attempt ENABLE ROW LEVEL SECURITY;

-- One terminal update is allowed. Even privileged accidental writes must not
-- change the checkout facts or erase the App's audit trail.
CREATE FUNCTION payments.protect_app_meld_funding() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'app_meld_funding_retained' USING ERRCODE='23514'; END IF;
 IF (pg_catalog.to_jsonb(NEW)-ARRAY['status','provider_session_id','provider_customer_id','updated_at'])
    IS DISTINCT FROM (pg_catalog.to_jsonb(OLD)-ARRAY['status','provider_session_id','provider_customer_id','updated_at'])
  OR OLD.status<>'initiated' OR NEW.status NOT IN('session_created','unavailable') THEN
  RAISE EXCEPTION 'app_meld_funding_immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER app_meld_funding_snapshot_immutable BEFORE UPDATE ON payments.app_meld_funding_attempt
 FOR EACH ROW EXECUTE FUNCTION payments.protect_app_meld_funding();
CREATE TRIGGER app_meld_funding_no_delete BEFORE DELETE OR TRUNCATE ON payments.app_meld_funding_attempt
 FOR EACH STATEMENT EXECUTE FUNCTION payments.protect_app_meld_funding();

CREATE FUNCTION payments.reserve_app_meld_funding(
 p_subject text,p_native_session text,p_id uuid,p_wallet text,p_country text,p_currency text,p_amount numeric,
 p_method text,p_provider text,p_account text)
RETURNS TABLE(id uuid,created_at timestamptz,wallet_address text,customer_reference uuid,created boolean,status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
DECLARE r payments.app_meld_funding_attempt%ROWTYPE; v_customer uuid; v_digest text;
BEGIN
 BEGIN PERFORM identity.require_administrative_native_session(p_subject,p_native_session);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000'; END;
 IF p_id IS NULL OR p_wallet IS NULL OR p_wallet!~'^0x[0-9a-f]{40}$'
  OR p_wallet='0x0000000000000000000000000000000000000000'
  OR p_country IS DISTINCT FROM 'MX' OR p_currency IS NULL OR p_method IS NULL OR p_provider IS NULL
  OR p_account IS NULL OR p_account!~'^[A-Za-z0-9_-]{1,128}$'
  OR p_amount IS NULL OR p_amount::text IN('NaN','Infinity','-Infinity') OR p_amount<>pg_catalog.round(p_amount,2)
  OR NOT ((p_provider='MERCURYO' AND p_method='CREDIT_DEBIT_CARD'
      AND ((p_currency='USD' AND p_amount BETWEEN 30 AND 15000) OR (p_currency='MXN' AND p_amount BETWEEN 931 AND 312013.70)))
    OR (p_provider='ONRAMPMONEY' AND p_method='SPEI' AND p_currency='MXN' AND p_amount BETWEEN 931 AND 500000)) THEN
  RAISE EXCEPTION 'wallet_funding_invalid_request' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM identity.wallet_binding b WHERE b.subject=p_subject AND b.address=p_wallet) THEN
  RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000'; END IF;
 -- App-specific stable identifier for the existing permanent wallet binding.
 -- This is a correlation reference, never a credential or ownership proof.
 v_digest:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
  'mindbliss-app-meld-customer-v1:'||p_subject||':'||p_wallet,'UTF8')),'hex');
 v_customer:=(substr(v_digest,1,8)||'-'||substr(v_digest,9,4)||'-8'||substr(v_digest,14,3)||
  '-a'||substr(v_digest,18,3)||'-'||substr(v_digest,21,12))::uuid;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app-meld-funding-owner:'||p_subject,0));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app-meld-funding-attempt:'||p_id::text,0));
 SELECT a.* INTO r FROM payments.app_meld_funding_attempt a WHERE a.id=p_id;
 IF FOUND THEN
  IF (r.subject,r.native_session_id,r.wallet_address,r.customer_reference,r.country_code,r.source_currency,
    r.requested_amount,r.payment_method,r.service_provider,r.account_id)
   IS DISTINCT FROM (p_subject,p_native_session,p_wallet,v_customer,p_country,p_currency,p_amount,p_method,p_provider,p_account) THEN
   RAISE EXCEPTION 'wallet_funding_request_already_used' USING ERRCODE='23505'; END IF;
  RETURN QUERY SELECT r.id,r.created_at,r.wallet_address,r.customer_reference,false,r.status;
  RETURN;
 END IF;
 IF (SELECT count(*) FROM payments.app_meld_funding_attempt a
  WHERE a.subject=p_subject AND a.created_at>clock_timestamp()-interval '10 minutes')>=10 THEN
  RAISE EXCEPTION 'wallet_funding_rate_limited' USING ERRCODE='54000'; END IF;
 RETURN QUERY INSERT INTO payments.app_meld_funding_attempt AS a
  (id,subject,native_session_id,wallet_address,customer_reference,country_code,source_currency,requested_amount,payment_method,service_provider,account_id)
 VALUES(p_id,p_subject,p_native_session,p_wallet,v_customer,p_country,p_currency,p_amount,p_method,p_provider,p_account)
 RETURNING a.id,a.created_at,a.wallet_address,a.customer_reference,true,a.status;
END $function$;

CREATE FUNCTION payments.finish_app_meld_funding(
 p_subject text,p_native_session text,p_id uuid,p_status text,p_session text,p_customer text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
DECLARE r payments.app_meld_funding_attempt%ROWTYPE;
BEGIN
 BEGIN PERFORM identity.require_administrative_native_session(p_subject,p_native_session);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000'; END;
 IF p_id IS NULL OR p_status IS NULL OR p_status NOT IN('session_created','unavailable')
  OR (p_status='session_created' AND (p_session IS NULL OR p_session!~'^[A-Za-z0-9_-]{1,128}$'
    OR p_customer IS NULL OR p_customer!~'^[A-Za-z0-9_-]{1,128}$'))
  OR (p_status='unavailable' AND (p_session IS NOT NULL OR p_customer IS NOT NULL)) THEN
  RAISE EXCEPTION 'wallet_funding_invalid_request' USING ERRCODE='22023'; END IF;
 SELECT a.* INTO r FROM payments.app_meld_funding_attempt a
 WHERE a.id=p_id AND a.subject=p_subject AND a.native_session_id=p_native_session FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM identity.wallet_binding b WHERE b.subject=p_subject AND b.address=r.wallet_address) THEN
  RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000'; END IF;
 IF r.status<>'initiated' THEN
  RETURN (r.status,r.provider_session_id,r.provider_customer_id) IS NOT DISTINCT FROM (p_status,p_session,p_customer);
 END IF;
 UPDATE payments.app_meld_funding_attempt a SET status=p_status,provider_session_id=p_session,provider_customer_id=p_customer,
  updated_at=clock_timestamp() WHERE a.id=p_id;
 RETURN true;
END $function$;

CREATE FUNCTION payments.read_app_meld_funding(p_subject text,p_id uuid)
RETURNS SETOF payments.app_meld_funding_attempt
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
BEGIN
 BEGIN PERFORM identity.administrative_wallet_person(p_subject);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000'; END;
 RETURN QUERY SELECT a.* FROM payments.app_meld_funding_attempt a
  WHERE a.subject=p_subject AND (p_id IS NULL OR a.id=p_id)
  ORDER BY a.created_at DESC,a.id DESC LIMIT 20;
END $function$;

DO $permissions$
DECLARE v_owner name; v_role text; v_signature text; v_grant boolean;
BEGIN
 SELECT pg_catalog.pg_get_userbyid(proowner) INTO v_owner
  FROM pg_catalog.pg_proc WHERE oid='identity.require_administrative_native_session(text,text)'::regprocedure;
 EXECUTE pg_catalog.format('ALTER TABLE payments.app_meld_funding_attempt OWNER TO %I',v_owner);
 FOR v_role IN
  SELECT DISTINCT CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(acl.grantee)) END
  FROM pg_catalog.pg_class c, LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl
  WHERE c.oid='payments.app_meld_funding_attempt'::regclass AND acl.grantee<>c.relowner
 LOOP EXECUTE 'REVOKE ALL ON TABLE payments.app_meld_funding_attempt FROM '||v_role; END LOOP;
 FOREACH v_signature IN ARRAY ARRAY[
  'payments.protect_app_meld_funding()',
  'payments.reserve_app_meld_funding(text,text,uuid,text,text,text,numeric,text,text,text)',
  'payments.finish_app_meld_funding(text,text,uuid,text,text,text)',
  'payments.read_app_meld_funding(text,uuid)'
 ] LOOP
  EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO %I',v_signature,v_owner);
  FOR v_role IN
   SELECT DISTINCT CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(acl.grantee)) END
   FROM pg_catalog.pg_proc p, LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
   WHERE p.oid=v_signature::regprocedure AND acl.grantee<>p.proowner
  LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||v_signature||' FROM '||v_role; END LOOP;
  v_grant:=v_signature<>'payments.protect_app_meld_funding()';
  IF v_grant THEN EXECUTE 'GRANT EXECUTE ON FUNCTION '||v_signature||' TO mindbliss_auth_core_v1'; END IF;
  IF pg_catalog.has_function_privilege('mindbliss_auth_core_v1',v_signature,'EXECUTE') IS DISTINCT FROM v_grant THEN
   RAISE EXCEPTION 'app_meld_funding_function_permissions_changed'; END IF;
 END LOOP;
 IF pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.app_meld_funding_attempt','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  OR NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid='payments.app_meld_funding_attempt'::regclass) THEN
  RAISE EXCEPTION 'app_meld_funding_table_permissions_changed'; END IF;
END $permissions$;
COMMIT;
