-- New personal onramps use USDT on Polygon only. Historical Ethereum/Polygon
-- funding and payments retain their actual network, identifiers and receipts.
-- Administrative Meld sandbox, balances, ledgers and memberships are untouched.
BEGIN;
SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('personal-polygon-funding-v1',0));
DO $preflight$
BEGIN
 IF pg_catalog.current_database()<>'mindbliss_curated_20261025' OR pg_catalog.pg_is_in_recovery()
  OR pg_catalog.to_regclass('payments.reown_funding_intent') IS NULL
  OR pg_catalog.to_regclass('payments.personal_company_payment') IS NULL
  OR pg_catalog.to_regclass('payments.meld_sandbox_funding_attempt') IS NULL
  OR pg_catalog.to_regprocedure('payments.create_reown_funding_intent_v3(text,text,text,numeric,uuid,text,text)') IS NULL
  OR pg_catalog.to_regprocedure('payments.read_wallet_funding_history_v3(text,text)') IS NULL
  OR pg_catalog.to_regprocedure('payments.read_wallet_funding_status_v3(text,text,uuid)') IS NULL THEN
  RAISE EXCEPTION 'personal_polygon_funding_prerequisites_required';
 END IF;
 IF pg_catalog.to_regprocedure('payments.create_reown_funding_intent_v4(text,text,text,numeric,uuid,text,text)') IS NOT NULL
  OR pg_catalog.to_regprocedure('payments.guard_new_personal_payment_network()') IS NOT NULL
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.create_reown_funding_intent_v3(text,text,text,numeric,uuid,text,text)'::regprocedure))<>'007348b2aec908a2257bd76112c67cc5'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.read_wallet_funding_history_v3(text,text)'::regprocedure))<>'0302bda008fbb6b6007e17879d447981'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.read_wallet_funding_status_v3(text,text,uuid)'::regprocedure))<>'c78f17016d1d77a3b804218dc3253503'
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='payments.reown_funding_intent'::regclass
   AND conname='reown_funding_intent_destination_currency_check' AND convalidated
   AND pg_catalog.pg_get_constraintdef(oid)='CHECK ((destination_currency = ANY (ARRAY[''USDT_POLYGON''::text, ''USDT''::text])))')
  OR (SELECT pg_catalog.pg_get_expr(d.adbin,d.adrelid) FROM pg_catalog.pg_attrdef d
   JOIN pg_catalog.pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
   WHERE d.adrelid='payments.reown_funding_intent'::regclass AND a.attname='destination_currency')<>'''USDT''::text' THEN
  RAISE EXCEPTION 'personal_polygon_funding_requires_fresh_review';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid IN('payments.reown_funding_intent'::regclass,
    'payments.personal_company_payment'::regclass,'payments.meld_sandbox_funding_attempt'::regclass)
   AND (NOT c.relrowsecurity OR NOT pg_catalog.pg_has_role(c.relowner,'USAGE')))
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.reown_funding_intent','SELECT,INSERT,UPDATE,DELETE')
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.personal_company_payment','SELECT,INSERT,UPDATE,DELETE')
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.meld_sandbox_funding_attempt','SELECT,INSERT,UPDATE,DELETE')
  OR NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.create_reown_funding_intent_v3(text,text,text,numeric,uuid,text,text)','EXECUTE')
  OR NOT pg_catalog.pg_has_role((SELECT proowner FROM pg_catalog.pg_proc WHERE oid=
    'payments.create_reown_funding_intent_v3(text,text,text,numeric,uuid,text,text)'::regprocedure),'USAGE') THEN
  RAISE EXCEPTION 'personal_polygon_funding_runtime_isolation_required';
 END IF;
END $preflight$;

ALTER TABLE payments.reown_funding_intent ALTER COLUMN destination_currency SET DEFAULT 'USDT_POLYGON';

CREATE FUNCTION payments.create_reown_funding_intent_v4(
 p_subject text,p_address text,p_country text,p_amount numeric,p_request_id uuid,p_payment_method text,p_source_currency text)
RETURNS TABLE(id uuid,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_existing payments.reown_funding_intent%ROWTYPE;
BEGIN
 BEGIN PERFORM identity.administrative_wallet_person(p_subject);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000'; END;
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'wallet_funding_unavailable' USING ERRCODE='40001'; END IF;
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

-- Do not reinterpret an old Ethereum writer as Polygon: an older client could
-- otherwise open Ethereum checkout while the database recorded Polygon.
CREATE OR REPLACE FUNCTION payments.create_reown_funding_intent_v3(
 p_subject text,p_address text,p_country text,p_amount numeric,p_request_id uuid,p_payment_method text,p_source_currency text)
RETURNS TABLE(id uuid,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
 BEGIN PERFORM identity.administrative_wallet_person(p_subject);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000'; END;
 RAISE EXCEPTION 'wallet_funding_network_changed' USING ERRCODE='22023';
END $function$;

-- INSERT only: existing Ethereum drafts, terminal receipts, immutable replays,
-- late transaction hashes and verification UPDATEs remain valid on their chain.
CREATE FUNCTION payments.guard_new_personal_payment_network()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
 IF TG_TABLE_SCHEMA<>'payments' OR TG_OP<>'INSERT' THEN
  RAISE EXCEPTION 'personal_wallet_network_guard_invalid_context' USING ERRCODE='22023';
 ELSIF TG_TABLE_NAME='personal_company_payment' THEN
  IF NEW.chain_id IS DISTINCT FROM 137 THEN
   RAISE EXCEPTION 'company_payment_network_changed' USING ERRCODE='22023'; END IF;
 ELSIF TG_TABLE_NAME='reown_funding_intent' THEN
  IF NEW.destination_currency IS DISTINCT FROM 'USDT_POLYGON' THEN
   RAISE EXCEPTION 'wallet_funding_network_changed' USING ERRCODE='22023'; END IF;
 ELSE
  RAISE EXCEPTION 'personal_wallet_network_guard_invalid_context' USING ERRCODE='22023';
 END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER personal_company_payment_00_network BEFORE INSERT ON payments.personal_company_payment
 FOR EACH ROW EXECUTE FUNCTION payments.guard_new_personal_payment_network();
-- Also fence invocations of the old PL/pgSQL writer which started before this
-- DDL and were waiting on an owner lock. A replaced function body alone cannot
-- revoke such an already-running invocation's explicit Ethereum INSERT.
CREATE TRIGGER reown_funding_intent_00_network BEFORE INSERT ON payments.reown_funding_intent
 FOR EACH ROW EXECUTE FUNCTION payments.guard_new_personal_payment_network();

REVOKE ALL ON FUNCTION payments.create_reown_funding_intent_v4(text,text,text,numeric,uuid,text,text),
 payments.guard_new_personal_payment_network() FROM PUBLIC;
DO $revoke_defaults$
DECLARE item record;
BEGIN
 FOR item IN SELECT DISTINCT p.oid,a.grantee FROM pg_catalog.pg_proc p
  CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
  WHERE p.oid IN('payments.create_reown_funding_intent_v4(text,text,text,numeric,uuid,text,text)'::regprocedure,
   'payments.guard_new_personal_payment_network()'::regprocedure) AND a.grantee<>p.proowner AND a.grantee<>0 LOOP
  EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %I',item.oid::regprocedure,pg_catalog.pg_get_userbyid(item.grantee));
 END LOOP;
END $revoke_defaults$;
GRANT EXECUTE ON FUNCTION payments.create_reown_funding_intent_v4(text,text,text,numeric,uuid,text,text) TO mindbliss_auth_core_v1;
DO $verify$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid='payments.create_reown_funding_intent_v4(text,text,text,numeric,uuid,text,text)'::regprocedure
    AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog']::text[])
  OR NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.create_reown_funding_intent_v4(text,text,text,numeric,uuid,text,text)','EXECUTE')
  OR pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.guard_new_personal_payment_network()','EXECUTE')
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
   WHERE p.oid='payments.create_reown_funding_intent_v4(text,text,text,numeric,uuid,text,text)'::regprocedure
    AND a.grantee<>p.proowner AND a.grantee<>'mindbliss_auth_core_v1'::regrole)
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.reown_funding_intent','SELECT,INSERT,UPDATE,DELETE')
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.read_wallet_funding_history_v3(text,text)'::regprocedure))<>'0302bda008fbb6b6007e17879d447981'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.read_wallet_funding_status_v3(text,text,uuid)'::regprocedure))<>'c78f17016d1d77a3b804218dc3253503' THEN
  RAISE EXCEPTION 'personal_polygon_funding_runtime_isolation_failed';
 END IF;
END $verify$;
COMMIT;
