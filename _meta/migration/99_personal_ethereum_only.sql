-- Personal wallet network cutover only. Historical Polygon receipts and funding
-- requests retain their real chain/asset. Administrative sandbox stays Polygon.
-- New personal requests use Ethereum mainnet USDT; no token transfer, balance
-- credit, membership allocation, commission or historical-row update is made.
BEGIN;
SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('personal-ethereum-only-v1',0));
DO $preflight$
BEGIN
 IF pg_catalog.current_database()<>'mindbliss_curated_20261025' OR pg_catalog.pg_is_in_recovery()
  OR pg_catalog.to_regclass('payments.personal_company_payment') IS NULL
  OR pg_catalog.to_regclass('payments.reown_funding_intent') IS NULL
  OR pg_catalog.to_regprocedure('payments.prepare_personal_company_payment(text,text,text,uuid)') IS NULL
  OR pg_catalog.to_regprocedure('payments.create_reown_funding_intent(text,text,text,numeric,uuid,text,text)') IS NULL
  OR pg_catalog.to_regprocedure('payments.read_wallet_funding_history_v2(text,text)') IS NULL
  OR pg_catalog.to_regprocedure('payments.read_wallet_funding_status_v2(text,text,uuid)') IS NULL THEN
  RAISE EXCEPTION 'personal_ethereum_prerequisites_required';
 END IF;
 IF pg_catalog.to_regprocedure('payments.prepare_personal_company_payment_v2(text,text,text,uuid)') IS NOT NULL
  OR pg_catalog.to_regprocedure('payments.create_reown_funding_intent_v3(text,text,text,numeric,uuid,text,text)') IS NOT NULL
  OR pg_catalog.to_regprocedure('payments.read_wallet_funding_history_v3(text,text)') IS NOT NULL
  OR pg_catalog.to_regprocedure('payments.read_wallet_funding_status_v3(text,text,uuid)') IS NOT NULL
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.create_reown_funding_intent(text,text,text,numeric,uuid,text,text)'::regprocedure))<>'b1b026dc8a91c60ac69fc71c815278d4'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.create_reown_funding_intent(text,text,text,numeric,uuid,text)'::regprocedure))<>'344dc030af4c78ae30c2f60bbc3e9277'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.read_wallet_funding_history_v2(text,text)'::regprocedure))<>'96cf97b192fd3a3d8d01ee25e8111a63'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.read_wallet_funding_status_v2(text,text,uuid)'::regprocedure))<>'f1310a5fc36da6d6951b94d0238f8e28'
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='payments.personal_company_payment'::regclass
   AND conname='personal_company_payment_chain_id_check' AND convalidated AND pg_catalog.pg_get_constraintdef(oid)='CHECK ((chain_id = 137))')
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='payments.personal_company_payment'::regclass
   AND conname='personal_company_payment_token_address_check' AND convalidated
   AND pg_catalog.pg_get_constraintdef(oid)='CHECK ((token_address = ''0xc2132d05d31c914a87c6611c10748aeb04b58e8f''::text))')
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='payments.reown_funding_intent'::regclass
   AND conname='reown_funding_intent_destination_currency_check' AND convalidated
   AND pg_catalog.pg_get_constraintdef(oid)='CHECK ((destination_currency = ''USDT_POLYGON''::text))') THEN
  RAISE EXCEPTION 'personal_ethereum_requires_fresh_review';
 END IF;
 IF EXISTS(SELECT 1 FROM (VALUES
  ('read_personal_company_payment','c5b52c09bc8e557847c3749392035d94'),
  ('guard_personal_company_payment','88247529f627ea098673b99cd23a9929'),
  ('reject_personal_company_payment','8d4b084049311b5a47b3cf286cba452e'),
  ('submit_personal_company_payment','1b359a7a24d2cc5843df8b5542877923'),
  ('verify_personal_company_payment','a631e252eb5461def29e1236ac522fc5'),
  ('abandon_personal_company_payment','9f39ff32d1c7439e46742fcb18a87015'),
  ('prepare_personal_company_payment','35357fbd767d6fd207045b4d53be0af7'),
  ('assert_personal_company_payment_owner','8f3d5e69426336b2f9ddf0ef08a5f623'),
  ('read_personal_company_payment_history','15052c9484fd067c5d0d8e60c90f3e92')) AS expected(name,digest)
  WHERE (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace='payments'::regnamespace
    AND p.proname=expected.name AND pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))=expected.digest)<>1) THEN
  RAISE EXCEPTION 'personal_ethereum_company_policy_requires_review';
 END IF;
 IF pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.personal_company_payment','SELECT,INSERT,UPDATE,DELETE')
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.reown_funding_intent','SELECT,INSERT,UPDATE,DELETE')
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.meld_sandbox_funding_attempt','SELECT,INSERT,UPDATE,DELETE')
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid IN('payments.personal_company_payment'::regclass,
    'payments.reown_funding_intent'::regclass,'payments.meld_sandbox_funding_attempt'::regclass) AND NOT c.relrowsecurity)
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid='payments.personal_company_payment'::regclass
    AND t.tgname='personal_company_payment_immutable' AND t.tgfoid='payments.guard_personal_company_payment()'::regprocedure
    AND t.tgenabled='O' AND NOT t.tgisinternal) THEN
  RAISE EXCEPTION 'personal_ethereum_runtime_isolation_required';
 END IF;
END $preflight$;

-- Permit the two exact immutable receipt identities, never arbitrary EVM assets.
-- Changing defaults does not change a historical row or its recovery evidence.
ALTER TABLE payments.personal_company_payment DROP CONSTRAINT personal_company_payment_chain_id_check;
ALTER TABLE payments.personal_company_payment DROP CONSTRAINT personal_company_payment_token_address_check;
ALTER TABLE payments.personal_company_payment ADD CONSTRAINT personal_company_payment_chain_asset_check CHECK(
 (chain_id=1 AND token_address='0xdac17f958d2ee523a2206206994597c13d831ec7')
 OR (chain_id=137 AND token_address='0xc2132d05d31c914a87c6611c10748aeb04b58e8f'));
ALTER TABLE payments.personal_company_payment ALTER COLUMN chain_id SET DEFAULT 1;
ALTER TABLE payments.personal_company_payment ALTER COLUMN token_address SET DEFAULT '0xdac17f958d2ee523a2206206994597c13d831ec7';
ALTER TABLE payments.reown_funding_intent DROP CONSTRAINT reown_funding_intent_destination_currency_check;
ALTER TABLE payments.reown_funding_intent ADD CONSTRAINT reown_funding_intent_destination_currency_check CHECK(destination_currency IN('USDT_POLYGON','USDT'));
ALTER TABLE payments.reown_funding_intent ALTER COLUMN destination_currency SET DEFAULT 'USDT';

CREATE FUNCTION payments.prepare_personal_company_payment_v2(p_subject text,p_address text,p_amount_atomic text,p_id uuid)
RETURNS TABLE(id uuid,wallet_address text,amount_atomic text,status text,expires_at timestamptz,created_at timestamptz,
 transaction_hash text,block_number text,block_hash text,confirmations integer,recipient_address text,chain_id integer,
 token_address text,token_decimals smallint,failure_reason text,submitted_at timestamptz,confirmed_at timestamptz,abandoned_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_row payments.personal_company_payment%ROWTYPE;
BEGIN
 PERFORM payments.assert_personal_company_payment_owner(p_subject,p_address);
 IF p_id IS NULL OR p_amount_atomic IS NULL OR p_amount_atomic !~ '^[1-9][0-9]{0,77}$' THEN
  RAISE EXCEPTION 'company_payment_invalid_request' USING ERRCODE='22023'; END IF;
 IF p_amount_atomic::numeric>115792089237316195423570985008687907853269984665640564039457584007913129639935 THEN
  RAISE EXCEPTION 'company_payment_invalid_request' USING ERRCODE='22023'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('personal-company-payment:'||p_subject,0));
 SELECT r.* INTO v_row FROM payments.personal_company_payment r WHERE r.id=p_id;
 IF FOUND THEN
  IF v_row.subject<>p_subject OR v_row.wallet_address<>p_address OR v_row.amount_atomic<>p_amount_atomic
   OR v_row.chain_id<>1 OR v_row.token_address<>'0xdac17f958d2ee523a2206206994597c13d831ec7' THEN
   RAISE EXCEPTION 'company_payment_request_already_used' USING ERRCODE='22023'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM payments.personal_company_payment r WHERE r.subject=p_subject
    AND (r.status='submitted' OR (r.status='prepared' AND r.expires_at>now() AND r.abandoned_at IS NULL))) THEN
   RAISE EXCEPTION 'company_payment_pending_exists' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM payments.personal_company_payment r WHERE r.subject=p_subject AND r.created_at>now()-interval '10 minutes')>=5 THEN
   RAISE EXCEPTION 'company_payment_rate_limited' USING ERRCODE='54000'; END IF;
  INSERT INTO payments.personal_company_payment(id,subject,wallet_address,amount_atomic,chain_id,token_address)
   VALUES(p_id,p_subject,p_address,p_amount_atomic,1,'0xdac17f958d2ee523a2206206994597c13d831ec7');
 END IF;
 RETURN QUERY SELECT * FROM payments.read_personal_company_payment(p_subject,p_id);
END $function$;

-- A warm old API cannot create a new Polygon draft after the cutover. Existing
-- records can still be read/submitted/verified through their original identity.
CREATE OR REPLACE FUNCTION payments.prepare_personal_company_payment(p_subject text,p_address text,p_amount_atomic text,p_id uuid)
RETURNS TABLE(id uuid,wallet_address text,amount_atomic text,status text,expires_at timestamptz,created_at timestamptz,
 transaction_hash text,block_number text,block_hash text,confirmations integer,recipient_address text,chain_id integer,
 token_address text,token_decimals smallint,failure_reason text,submitted_at timestamptz,confirmed_at timestamptz,abandoned_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
 PERFORM payments.assert_personal_company_payment_owner(p_subject,p_address);
 RAISE EXCEPTION 'company_payment_network_changed' USING ERRCODE='22023';
END $function$;

CREATE FUNCTION payments.create_reown_funding_intent_v3(
 p_subject text,p_address text,p_country text,p_amount numeric,p_request_id uuid,p_payment_method text,p_source_currency text)
RETURNS TABLE(id uuid,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_existing payments.reown_funding_intent%ROWTYPE;
BEGIN
 BEGIN PERFORM identity.administrative_wallet_person(p_subject);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000'; END;
 IF p_address IS NULL OR p_address !~ '^0x[0-9a-f]{40}$'
  OR p_country IS NULL OR p_country NOT IN('US','MX','CO') OR p_request_id IS NULL
  OR p_payment_method IS NULL OR p_payment_method !~ '^[A-Z0-9_]{2,40}$' OR p_payment_method IN('NETELLER','SKRILL')
  OR p_source_currency IS NULL OR p_source_currency NOT IN('USD','MXN')
  OR p_amount IS NULL OR p_amount<>round(p_amount,2)
  OR (p_source_currency='USD' AND NOT(p_amount BETWEEN 30 AND 15000))
  OR (p_source_currency='MXN' AND (p_country<>'MX' OR p_payment_method<>'SPEI' OR NOT(p_amount BETWEEN 931 AND 1000000000))) THEN
  RAISE EXCEPTION 'wallet_funding_invalid_request' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM identity.wallet_binding b WHERE b.subject=p_subject AND b.address=p_address) THEN
  RAISE EXCEPTION 'wallet_funding_wallet_not_linked' USING ERRCODE='28000'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('reown-funding:'||p_subject,0));
 SELECT r.* INTO v_existing FROM payments.reown_funding_intent r WHERE r.id=p_request_id;
 IF FOUND THEN
  IF v_existing.subject<>p_subject OR v_existing.wallet_address<>p_address
   OR v_existing.country_code<>p_country OR v_existing.requested_amount<>p_amount
   OR v_existing.payment_method IS DISTINCT FROM p_payment_method OR v_existing.source_currency IS DISTINCT FROM p_source_currency
   OR v_existing.destination_currency<>'USDT' THEN
   RAISE EXCEPTION 'wallet_funding_request_already_used' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT v_existing.id,v_existing.created_at; RETURN;
 END IF;
 IF (SELECT count(*) FROM payments.reown_funding_intent r WHERE r.subject=p_subject AND r.created_at>now()-interval '10 minutes')>=10 THEN
  RAISE EXCEPTION 'wallet_funding_rate_limited' USING ERRCODE='54000'; END IF;
 RETURN QUERY INSERT INTO payments.reown_funding_intent(id,subject,wallet_address,country_code,requested_amount,payment_method,source_currency,destination_currency)
  VALUES(p_request_id,p_subject,p_address,p_country,p_amount,p_payment_method,p_source_currency,'USDT')
  RETURNING reown_funding_intent.id,reown_funding_intent.created_at;
END $function$;

-- Legacy writers fail closed; changing their implicit default to Ethereum could
-- open a Polygon checkout while storing Ethereum, so no delegation is permitted.
CREATE OR REPLACE FUNCTION payments.create_reown_funding_intent(
 p_subject text,p_address text,p_country text,p_amount numeric,p_request_id uuid,p_payment_method text,p_source_currency text)
RETURNS TABLE(id uuid,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
 BEGIN PERFORM identity.administrative_wallet_person(p_subject);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000'; END;
 RAISE EXCEPTION 'wallet_funding_network_changed' USING ERRCODE='22023';
END $function$;

CREATE FUNCTION payments.read_wallet_funding_history_v3(p_subject text,p_kind text)
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

CREATE FUNCTION payments.read_wallet_funding_status_v3(p_subject text,p_kind text,p_reference uuid)
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

-- A warm reader that assumes Polygon must never relabel a new Ethereum record.
CREATE OR REPLACE FUNCTION payments.read_wallet_funding_history_v2(p_subject text,p_kind text)
RETURNS TABLE(id uuid,wallet_kind text,environment text,provider text,status text,wallet_address text,
 country_code text,requested_amount numeric,created_at timestamptz,source_currency text,payment_method text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT r.id,r.wallet_kind,r.environment,r.provider,r.status,r.wallet_address,r.country_code,r.requested_amount,r.created_at,r.source_currency,r.payment_method
 FROM payments.read_wallet_funding_history_v3(p_subject,p_kind) r WHERE r.destination_currency='USDT_POLYGON';
$function$;
CREATE OR REPLACE FUNCTION payments.read_wallet_funding_status_v2(p_subject text,p_kind text,p_reference uuid)
RETURNS TABLE(id uuid,wallet_kind text,environment text,provider text,status text,wallet_address text,
 country_code text,requested_amount numeric,created_at timestamptz,source_currency text,payment_method text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT r.id,r.wallet_kind,r.environment,r.provider,r.status,r.wallet_address,r.country_code,r.requested_amount,r.created_at,r.source_currency,r.payment_method
 FROM payments.read_wallet_funding_status_v3(p_subject,p_kind,p_reference) r WHERE r.destination_currency='USDT_POLYGON';
$function$;
CREATE OR REPLACE FUNCTION payments.read_wallet_funding_history(p_subject text,p_kind text)
RETURNS TABLE(id uuid,wallet_kind text,environment text,provider text,status text,wallet_address text,
 country_code text,requested_amount numeric,created_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT r.id,r.wallet_kind,r.environment,r.provider,r.status,r.wallet_address,r.country_code,r.requested_amount,r.created_at
 FROM payments.read_wallet_funding_history_v3(p_subject,p_kind) r WHERE r.destination_currency='USDT_POLYGON' AND r.source_currency='USD';
$function$;
CREATE OR REPLACE FUNCTION payments.read_wallet_funding_status(p_subject text,p_kind text,p_reference uuid)
RETURNS TABLE(id uuid,wallet_kind text,environment text,provider text,status text,wallet_address text,
 country_code text,requested_amount numeric,created_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT r.id,r.wallet_kind,r.environment,r.provider,r.status,r.wallet_address,r.country_code,r.requested_amount,r.created_at
 FROM payments.read_wallet_funding_status_v3(p_subject,p_kind,p_reference) r WHERE r.destination_currency='USDT_POLYGON' AND r.source_currency='USD';
$function$;

REVOKE ALL ON FUNCTION payments.prepare_personal_company_payment_v2(text,text,text,uuid),
 payments.create_reown_funding_intent_v3(text,text,text,numeric,uuid,text,text),
 payments.read_wallet_funding_history_v3(text,text),payments.read_wallet_funding_status_v3(text,text,uuid) FROM PUBLIC;
DO $revoke_defaults$
DECLARE item record;
BEGIN
 FOR item IN SELECT DISTINCT p.oid,a.grantee FROM pg_catalog.pg_proc p
  CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
  WHERE p.oid IN('payments.prepare_personal_company_payment_v2(text,text,text,uuid)'::regprocedure,
   'payments.create_reown_funding_intent_v3(text,text,text,numeric,uuid,text,text)'::regprocedure,
   'payments.read_wallet_funding_history_v3(text,text)'::regprocedure,'payments.read_wallet_funding_status_v3(text,text,uuid)'::regprocedure)
  AND a.grantee<>p.proowner AND a.grantee<>0 LOOP
  EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %I',item.oid::regprocedure,pg_catalog.pg_get_userbyid(item.grantee));
 END LOOP;
END $revoke_defaults$;
GRANT EXECUTE ON FUNCTION payments.prepare_personal_company_payment_v2(text,text,text,uuid),
 payments.create_reown_funding_intent_v3(text,text,text,numeric,uuid,text,text),
 payments.read_wallet_funding_history_v3(text,text),payments.read_wallet_funding_status_v3(text,text,uuid) TO mindbliss_auth_core_v1;
DO $verify$
BEGIN
 IF (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.oid IN(
   'payments.prepare_personal_company_payment_v2(text,text,text,uuid)'::regprocedure,
   'payments.create_reown_funding_intent_v3(text,text,text,numeric,uuid,text,text)'::regprocedure,
   'payments.read_wallet_funding_history_v3(text,text)'::regprocedure,
   'payments.read_wallet_funding_status_v3(text,text,uuid)'::regprocedure)
  AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog']::text[])=4
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
   WHERE p.oid IN('payments.prepare_personal_company_payment_v2(text,text,text,uuid)'::regprocedure,
    'payments.create_reown_funding_intent_v3(text,text,text,numeric,uuid,text,text)'::regprocedure,
    'payments.read_wallet_funding_history_v3(text,text)'::regprocedure,'payments.read_wallet_funding_status_v3(text,text,uuid)'::regprocedure)
   AND a.grantee<>p.proowner AND a.grantee<>'mindbliss_auth_core_v1'::regrole)
  AND pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.prepare_personal_company_payment_v2(text,text,text,uuid)','EXECUTE')
  AND pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.create_reown_funding_intent_v3(text,text,text,numeric,uuid,text,text)','EXECUTE')
  AND pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.read_wallet_funding_history_v3(text,text)','EXECUTE')
  AND pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.read_wallet_funding_status_v3(text,text,uuid)','EXECUTE')
  AND NOT pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.personal_company_payment','SELECT,INSERT,UPDATE,DELETE')
  AND NOT pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.reown_funding_intent','SELECT,INSERT,UPDATE,DELETE')
  AND NOT pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.meld_sandbox_funding_attempt','SELECT,INSERT,UPDATE,DELETE')
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid IN('payments.personal_company_payment'::regclass,
   'payments.reown_funding_intent'::regclass,'payments.meld_sandbox_funding_attempt'::regclass) AND NOT c.relrowsecurity) THEN RETURN; END IF;
 RAISE EXCEPTION 'personal_ethereum_runtime_isolation_failed';
END $verify$;
COMMIT;
