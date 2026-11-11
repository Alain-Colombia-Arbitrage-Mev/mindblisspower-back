-- Explicit personal USDT payments on Ethereum or Polygon. The selected chain
-- fixes its existing six-decimal token and the same company receiver. This adds
-- one narrow prepare capability; historical rows and all other writers stay put.
BEGIN;
SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('personal-multichain-payments-v1',0));
DO $preflight$
BEGIN
 IF pg_catalog.current_database()<>'mindbliss_curated_20261025' OR pg_catalog.pg_is_in_recovery()
  OR pg_catalog.to_regclass('payments.personal_company_payment') IS NULL
  OR pg_catalog.to_regprocedure('payments.prepare_personal_company_payment_v2(text,text,text,uuid)') IS NULL
  OR pg_catalog.to_regprocedure('payments.assert_personal_company_payment_owner(text,text)') IS NULL THEN
  RAISE EXCEPTION 'personal_multichain_prerequisites_required';
 END IF;
 IF pg_catalog.to_regprocedure('payments.prepare_personal_company_payment_v3(text,text,text,uuid,integer)') IS NOT NULL
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.prepare_personal_company_payment_v2(text,text,text,uuid)'::regprocedure))<>'45ea9b552297682f449a9941c203f604'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.create_reown_funding_intent_v3(text,text,text,numeric,uuid,text,text)'::regprocedure))<>'007348b2aec908a2257bd76112c67cc5'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.read_wallet_funding_history_v3(text,text)'::regprocedure))<>'0302bda008fbb6b6007e17879d447981'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.read_wallet_funding_status_v3(text,text,uuid)'::regprocedure))<>'c78f17016d1d77a3b804218dc3253503'
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='payments.personal_company_payment'::regclass
   AND conname='personal_company_payment_chain_asset_check' AND convalidated
   AND pg_catalog.pg_get_constraintdef(oid)='CHECK ((((chain_id = 1) AND (token_address = ''0xdac17f958d2ee523a2206206994597c13d831ec7''::text)) OR ((chain_id = 137) AND (token_address = ''0xc2132d05d31c914a87c6611c10748aeb04b58e8f''::text))))') THEN
  RAISE EXCEPTION 'personal_multichain_requires_fresh_review';
 END IF;
 IF EXISTS(SELECT 1 FROM (VALUES
  ('read_personal_company_payment','c5b52c09bc8e557847c3749392035d94'),
  ('guard_personal_company_payment','88247529f627ea098673b99cd23a9929'),
  ('reject_personal_company_payment','8d4b084049311b5a47b3cf286cba452e'),
  ('submit_personal_company_payment','1b359a7a24d2cc5843df8b5542877923'),
  ('verify_personal_company_payment','a631e252eb5461def29e1236ac522fc5'),
  ('abandon_personal_company_payment','9f39ff32d1c7439e46742fcb18a87015'),
  ('assert_personal_company_payment_owner','8f3d5e69426336b2f9ddf0ef08a5f623'),
  ('read_personal_company_payment_history','15052c9484fd067c5d0d8e60c90f3e92')) AS expected(name,digest)
  WHERE (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace='payments'::regnamespace
    AND p.proname=expected.name AND pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))=expected.digest)<>1) THEN
  RAISE EXCEPTION 'personal_multichain_company_policy_requires_review';
 END IF;
 IF NOT pg_catalog.pg_has_role((SELECT relowner FROM pg_catalog.pg_class WHERE oid='payments.personal_company_payment'::regclass),'USAGE')
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.personal_company_payment','SELECT,INSERT,UPDATE,DELETE')
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.reown_funding_intent','SELECT,INSERT,UPDATE,DELETE')
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.meld_sandbox_funding_attempt','SELECT,INSERT,UPDATE,DELETE')
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid IN('payments.personal_company_payment'::regclass,
   'payments.reown_funding_intent'::regclass,'payments.meld_sandbox_funding_attempt'::regclass) AND NOT c.relrowsecurity)
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid='payments.personal_company_payment'::regclass
   AND t.tgname='personal_company_payment_immutable' AND t.tgfoid='payments.guard_personal_company_payment()'::regprocedure
   AND t.tgenabled='O' AND NOT t.tgisinternal) THEN
  RAISE EXCEPTION 'personal_multichain_runtime_isolation_required';
 END IF;
END $preflight$;

CREATE FUNCTION payments.prepare_personal_company_payment_v3(
 p_subject text,p_address text,p_amount_atomic text,p_id uuid,p_chain_id integer)
RETURNS TABLE(id uuid,wallet_address text,amount_atomic text,status text,expires_at timestamptz,created_at timestamptz,
 transaction_hash text,block_number text,block_hash text,confirmations integer,recipient_address text,chain_id integer,
 token_address text,token_decimals smallint,failure_reason text,submitted_at timestamptz,confirmed_at timestamptz,abandoned_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_row payments.personal_company_payment%ROWTYPE;v_token text;
BEGIN
 PERFORM payments.assert_personal_company_payment_owner(p_subject,p_address);
 IF p_id IS NULL OR p_chain_id IS NULL OR p_chain_id NOT IN(1,137)
  OR p_amount_atomic IS NULL OR p_amount_atomic !~ '^[1-9][0-9]{0,77}$' THEN
  RAISE EXCEPTION 'company_payment_invalid_request' USING ERRCODE='22023'; END IF;
 IF p_amount_atomic::numeric>115792089237316195423570985008687907853269984665640564039457584007913129639935 THEN
  RAISE EXCEPTION 'company_payment_invalid_request' USING ERRCODE='22023'; END IF;
 v_token:=CASE p_chain_id WHEN 1 THEN '0xdac17f958d2ee523a2206206994597c13d831ec7'
  WHEN 137 THEN '0xc2132d05d31c914a87c6611c10748aeb04b58e8f' END;
 -- This lock/pending/rate scope spans both chains. A network toggle cannot
 -- create another active payment or bypass the member's preparation limit.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('personal-company-payment:'||p_subject,0));
 SELECT r.* INTO v_row FROM payments.personal_company_payment r WHERE r.id=p_id;
 IF FOUND THEN
  IF v_row.subject<>p_subject OR v_row.wallet_address<>p_address OR v_row.amount_atomic<>p_amount_atomic
   OR v_row.chain_id<>p_chain_id OR v_row.token_address<>v_token THEN
   RAISE EXCEPTION 'company_payment_request_already_used' USING ERRCODE='22023'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM payments.personal_company_payment r WHERE r.subject=p_subject
    AND (r.status='submitted' OR (r.status='prepared' AND r.expires_at>now() AND r.abandoned_at IS NULL))) THEN
   RAISE EXCEPTION 'company_payment_pending_exists' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM payments.personal_company_payment r WHERE r.subject=p_subject AND r.created_at>now()-interval '10 minutes')>=5 THEN
   RAISE EXCEPTION 'company_payment_rate_limited' USING ERRCODE='54000'; END IF;
  INSERT INTO payments.personal_company_payment(id,subject,wallet_address,amount_atomic,chain_id,token_address)
   VALUES(p_id,p_subject,p_address,p_amount_atomic,p_chain_id,v_token);
 END IF;
 RETURN QUERY SELECT * FROM payments.read_personal_company_payment(p_subject,p_id);
END $function$;

REVOKE ALL ON FUNCTION payments.prepare_personal_company_payment_v3(text,text,text,uuid,integer) FROM PUBLIC;
DO $revoke_defaults$
DECLARE item record;
BEGIN
 FOR item IN SELECT a.grantee FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
  WHERE p.oid='payments.prepare_personal_company_payment_v3(text,text,text,uuid,integer)'::regprocedure
   AND a.grantee<>p.proowner AND a.grantee<>0 LOOP
  EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION payments.prepare_personal_company_payment_v3(text,text,text,uuid,integer) FROM %I',pg_catalog.pg_get_userbyid(item.grantee));
 END LOOP;
END $revoke_defaults$;
GRANT EXECUTE ON FUNCTION payments.prepare_personal_company_payment_v3(text,text,text,uuid,integer) TO mindbliss_auth_core_v1;
DO $verify$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid='payments.prepare_personal_company_payment_v3(text,text,text,uuid,integer)'::regprocedure
   AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog']::text[])
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
   WHERE p.oid='payments.prepare_personal_company_payment_v3(text,text,text,uuid,integer)'::regprocedure
   AND a.grantee<>p.proowner AND a.grantee<>'mindbliss_auth_core_v1'::regrole)
  OR NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.prepare_personal_company_payment_v3(text,text,text,uuid,integer)','EXECUTE')
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.personal_company_payment','SELECT,INSERT,UPDATE,DELETE') THEN
  RAISE EXCEPTION 'personal_multichain_runtime_isolation_failed';
 END IF;
END $verify$;
COMMIT;
