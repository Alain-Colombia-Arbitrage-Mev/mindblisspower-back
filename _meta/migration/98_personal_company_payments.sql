-- Personal Polygon USDT company-payment receipts only. No membership allocation,
-- balance credit, funding mutation, commission, purchase activation or provider call.
-- Explicit reviewed operator migration; never executed by startup/deployment.
BEGIN;
SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('personal-company-payment-receipts-v1',0));
DO $preflight$
BEGIN
 IF pg_catalog.current_database()<>'mindbliss_curated_20261025' OR pg_catalog.pg_is_in_recovery()
  OR pg_catalog.to_regclass('auth.user') IS NULL OR pg_catalog.to_regclass('identity.wallet_binding') IS NULL
  OR pg_catalog.to_regprocedure('identity.administrative_wallet_person(text)') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='mindbliss_auth_core_v1')
  OR pg_catalog.to_regclass('payments.personal_company_payment') IS NOT NULL THEN
  RAISE EXCEPTION 'company_payment_fresh_prerequisites_required';
 END IF;
 IF pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.create_reown_funding_intent(text,text,text,numeric,uuid,text)'::regprocedure))<>'344dc030af4c78ae30c2f60bbc3e9277'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.create_reown_funding_intent(text,text,text,numeric,uuid,text,text)'::regprocedure))<>'b1b026dc8a91c60ac69fc71c815278d4'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.read_wallet_funding_history_v2(text,text)'::regprocedure))<>'96cf97b192fd3a3d8d01ee25e8111a63'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.read_wallet_funding_status_v2(text,text,uuid)'::regprocedure))<>'f1310a5fc36da6d6951b94d0238f8e28'
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.reown_funding_intent','SELECT,INSERT,UPDATE,DELETE')
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.meld_sandbox_funding_attempt','SELECT,INSERT,UPDATE,DELETE')
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','identity.wallet_binding','UPDATE,DELETE') THEN
  RAISE EXCEPTION 'company_payment_requires_reviewed_isolated_runtime';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='payments' AND p.proname IN('assert_personal_company_payment_owner','read_personal_company_payment','read_personal_company_payment_history',
    'prepare_personal_company_payment','submit_personal_company_payment','verify_personal_company_payment',
    'reject_personal_company_payment','abandon_personal_company_payment','guard_personal_company_payment')) THEN
  RAISE EXCEPTION 'company_payment_function_names_require_fresh_review';
 END IF;
END $preflight$;

CREATE TABLE payments.personal_company_payment (
 id uuid PRIMARY KEY,
 subject text NOT NULL REFERENCES auth."user"(id) ON DELETE RESTRICT,
 wallet_address text NOT NULL CHECK(wallet_address ~ '^0x[0-9a-f]{40}$'),
 purpose text NOT NULL DEFAULT 'company_payment' CHECK(purpose='company_payment'),
 chain_id integer NOT NULL DEFAULT 137 CHECK(chain_id=137),
 -- Same Polygon PoS proxy in official Polygon mapped-token / USDT0 deployments.
 token_address text NOT NULL DEFAULT '0xc2132d05d31c914a87c6611c10748aeb04b58e8f'
  CHECK(token_address='0xc2132d05d31c914a87c6611c10748aeb04b58e8f'),
 token_decimals smallint NOT NULL DEFAULT 6 CHECK(token_decimals=6),
 recipient_address text NOT NULL DEFAULT '0x0a600b03ef5f8e7f3e182b83440c6d292033db0e'
  CHECK(recipient_address='0x0a600b03ef5f8e7f3e182b83440c6d292033db0e'),
 -- Canonical uint256 string: no JS floating-point coercion or fiat conversion.
 amount_atomic text NOT NULL CHECK(CASE WHEN amount_atomic ~ '^[1-9][0-9]{0,77}$'
  THEN amount_atomic::numeric<=115792089237316195423570985008687907853269984665640564039457584007913129639935 ELSE false END),
 status text NOT NULL DEFAULT 'prepared' CHECK(status IN('prepared','submitted','confirmed','failed')),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
 -- Abandoning an unsigned draft preserves its snapshot/history. A late real
 -- transaction is still registrable and retains this audit timestamp.
 abandoned_at timestamptz CHECK(abandoned_at IS NULL OR abandoned_at>=created_at),
 transaction_hash text UNIQUE CHECK(transaction_hash ~ '^0x[0-9a-f]{64}$'),
 submitted_at timestamptz,
 block_number text CHECK(CASE WHEN block_number IS NULL THEN true WHEN block_number ~ '^[1-9][0-9]{0,18}$'
  THEN block_number::numeric<=9223372036854775807 ELSE false END),
 block_hash text CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
 confirmations integer NOT NULL DEFAULT 0 CHECK(confirmations BETWEEN 0 AND 1000000000),
 confirmed_at timestamptz,
 failed_at timestamptz,
 failure_reason text CHECK(failure_reason IN('transaction_reverted','transaction_mismatch')),
 CHECK(expires_at=created_at+interval '15 minutes'),
 CHECK((status='prepared' AND transaction_hash IS NULL AND submitted_at IS NULL)
  OR (status<>'prepared' AND transaction_hash IS NOT NULL AND submitted_at IS NOT NULL)),
 CHECK((status='confirmed' AND block_number IS NOT NULL AND block_hash IS NOT NULL
   AND confirmations>=12 AND confirmed_at IS NOT NULL)
  OR (status<>'confirmed' AND block_number IS NULL AND block_hash IS NULL AND confirmations=0 AND confirmed_at IS NULL)),
 CHECK((status='failed' AND failure_reason IS NOT NULL AND failed_at IS NOT NULL)
  OR (status<>'failed' AND failure_reason IS NULL AND failed_at IS NULL))
);
CREATE INDEX personal_company_payment_subject_created_idx ON payments.personal_company_payment(subject,created_at DESC,id DESC);
ALTER TABLE payments.personal_company_payment ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON payments.personal_company_payment FROM PUBLIC,mindbliss_auth_core_v1;
-- Existing schema default read grants must not expose these private receipts.
DO $revoke_defaults$
DECLARE item record;
BEGIN
 FOR item IN SELECT DISTINCT a.grantee FROM pg_catalog.pg_class c
  CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
  WHERE c.oid='payments.personal_company_payment'::regclass AND a.grantee<>c.relowner LOOP
  IF item.grantee=0 THEN REVOKE ALL ON payments.personal_company_payment FROM PUBLIC;
  ELSE EXECUTE pg_catalog.format('REVOKE ALL ON payments.personal_company_payment FROM %I',pg_catalog.pg_get_userbyid(item.grantee)); END IF;
 END LOOP;
END $revoke_defaults$;

CREATE FUNCTION payments.guard_personal_company_payment() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'company_payment_delete_forbidden' USING ERRCODE='22023'; END IF;
 IF ROW(NEW.id,NEW.subject,NEW.wallet_address,NEW.purpose,NEW.chain_id,NEW.token_address,NEW.token_decimals,
   NEW.recipient_address,NEW.amount_atomic,NEW.created_at,NEW.expires_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.subject,OLD.wallet_address,OLD.purpose,OLD.chain_id,OLD.token_address,OLD.token_decimals,
   OLD.recipient_address,OLD.amount_atomic,OLD.created_at,OLD.expires_at)
  OR (OLD.transaction_hash IS NOT NULL AND NEW.transaction_hash IS DISTINCT FROM OLD.transaction_hash)
  OR (OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at) THEN
  RAISE EXCEPTION 'company_payment_snapshot_immutable' USING ERRCODE='22023';
 END IF;
 IF NEW.abandoned_at IS DISTINCT FROM OLD.abandoned_at THEN
  IF OLD.status='prepared' AND NEW.status='prepared' AND OLD.abandoned_at IS NULL AND NEW.abandoned_at IS NOT NULL
   AND (to_jsonb(NEW)-'abandoned_at')=(to_jsonb(OLD)-'abandoned_at') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'company_payment_snapshot_immutable' USING ERRCODE='22023';
 END IF;
 IF (OLD.status='prepared' AND NEW.status='submitted') OR (OLD.status='submitted' AND NEW.status IN('confirmed','failed')) THEN
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'company_payment_invalid_transition' USING ERRCODE='22023';
END $function$;
CREATE TRIGGER personal_company_payment_immutable BEFORE UPDATE OR DELETE ON payments.personal_company_payment
 FOR EACH ROW EXECUTE FUNCTION payments.guard_personal_company_payment();

CREATE FUNCTION payments.assert_personal_company_payment_owner(p_subject text,p_address text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
 BEGIN PERFORM identity.administrative_wallet_person(p_subject);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'company_payment_forbidden' USING ERRCODE='28000'; END;
 IF p_address IS NULL OR p_address !~ '^0x[0-9a-f]{40}$'
  OR NOT EXISTS(SELECT 1 FROM identity.wallet_binding b WHERE b.subject=p_subject AND b.address=p_address) THEN
  RAISE EXCEPTION 'company_payment_forbidden' USING ERRCODE='28000';
 END IF;
END $function$;

CREATE FUNCTION payments.read_personal_company_payment(p_subject text,p_id uuid)
RETURNS TABLE(id uuid,wallet_address text,amount_atomic text,status text,expires_at timestamptz,created_at timestamptz,
 transaction_hash text,block_number text,block_hash text,confirmations integer,recipient_address text,chain_id integer,
 token_address text,token_decimals smallint,failure_reason text,submitted_at timestamptz,confirmed_at timestamptz,abandoned_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_row payments.personal_company_payment%ROWTYPE;
BEGIN
 IF p_id IS NULL THEN RAISE EXCEPTION 'company_payment_invalid_request' USING ERRCODE='22023'; END IF;
 SELECT r.* INTO v_row FROM payments.personal_company_payment r WHERE r.id=p_id AND r.subject=p_subject;
 IF NOT FOUND THEN
  BEGIN PERFORM identity.administrative_wallet_person(p_subject);
  EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'company_payment_forbidden' USING ERRCODE='28000'; END;
  RETURN;
 END IF;
 PERFORM payments.assert_personal_company_payment_owner(p_subject,v_row.wallet_address);
 RETURN QUERY SELECT r.id,r.wallet_address,r.amount_atomic,r.status,r.expires_at,r.created_at,r.transaction_hash,
  r.block_number,r.block_hash,r.confirmations,r.recipient_address,r.chain_id,r.token_address,r.token_decimals,
  r.failure_reason,r.submitted_at,r.confirmed_at,r.abandoned_at FROM payments.personal_company_payment r WHERE r.id=p_id AND r.subject=p_subject;
END $function$;

CREATE FUNCTION payments.read_personal_company_payment_history(p_subject text)
RETURNS TABLE(id uuid,wallet_address text,amount_atomic text,status text,expires_at timestamptz,created_at timestamptz,
 transaction_hash text,block_number text,block_hash text,confirmations integer,recipient_address text,chain_id integer,
 token_address text,token_decimals smallint,failure_reason text,submitted_at timestamptz,confirmed_at timestamptz,abandoned_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_address text;
BEGIN
 SELECT b.address INTO v_address FROM identity.wallet_binding b WHERE b.subject=p_subject;
 PERFORM payments.assert_personal_company_payment_owner(p_subject,v_address);
 RETURN QUERY SELECT r.id,r.wallet_address,r.amount_atomic,r.status,r.expires_at,r.created_at,r.transaction_hash,
  r.block_number,r.block_hash,r.confirmations,r.recipient_address,r.chain_id,r.token_address,r.token_decimals,
  r.failure_reason,r.submitted_at,r.confirmed_at,r.abandoned_at FROM payments.personal_company_payment r WHERE r.subject=p_subject
  ORDER BY r.created_at DESC,r.id DESC LIMIT 20;
END $function$;

CREATE FUNCTION payments.prepare_personal_company_payment(p_subject text,p_address text,p_amount_atomic text,p_id uuid)
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
  IF v_row.subject<>p_subject OR v_row.wallet_address<>p_address OR v_row.amount_atomic<>p_amount_atomic THEN
   RAISE EXCEPTION 'company_payment_request_already_used' USING ERRCODE='22023'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM payments.personal_company_payment r WHERE r.subject=p_subject
    AND (r.status='submitted' OR (r.status='prepared' AND r.expires_at>now() AND r.abandoned_at IS NULL))) THEN
   RAISE EXCEPTION 'company_payment_pending_exists' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM payments.personal_company_payment r WHERE r.subject=p_subject AND r.created_at>now()-interval '10 minutes')>=5 THEN
   RAISE EXCEPTION 'company_payment_rate_limited' USING ERRCODE='54000'; END IF;
  INSERT INTO payments.personal_company_payment(id,subject,wallet_address,amount_atomic) VALUES(p_id,p_subject,p_address,p_amount_atomic);
 END IF;
 RETURN QUERY SELECT * FROM payments.read_personal_company_payment(p_subject,p_id);
END $function$;

-- The HTTP service validates the real transaction's sender/token/calldata/value
-- before claiming its hash, preventing another user from reserving a public hash.
CREATE FUNCTION payments.submit_personal_company_payment(p_subject text,p_id uuid,p_hash text)
RETURNS TABLE(id uuid,wallet_address text,amount_atomic text,status text,expires_at timestamptz,created_at timestamptz,
 transaction_hash text,block_number text,block_hash text,confirmations integer,recipient_address text,chain_id integer,
 token_address text,token_decimals smallint,failure_reason text,submitted_at timestamptz,confirmed_at timestamptz,abandoned_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_row payments.personal_company_payment%ROWTYPE;
BEGIN
 IF p_id IS NULL OR p_hash IS NULL OR p_hash !~ '^0x[0-9a-f]{64}$' THEN
  RAISE EXCEPTION 'company_payment_invalid_request' USING ERRCODE='22023'; END IF;
 SELECT r.* INTO v_row FROM payments.personal_company_payment r WHERE r.id=p_id AND r.subject=p_subject FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'company_payment_not_found' USING ERRCODE='P0002'; END IF;
 PERFORM payments.assert_personal_company_payment_owner(p_subject,v_row.wallet_address);
 IF v_row.transaction_hash IS NOT NULL THEN
  IF v_row.transaction_hash<>p_hash THEN RAISE EXCEPTION 'company_payment_request_already_used' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT * FROM payments.read_personal_company_payment(p_subject,p_id); RETURN;
 END IF;
 IF v_row.status<>'prepared' THEN RAISE EXCEPTION 'company_payment_invalid_transition' USING ERRCODE='22023'; END IF;
 BEGIN
  UPDATE payments.personal_company_payment r SET status='submitted',transaction_hash=p_hash,submitted_at=now() WHERE r.id=p_id;
 EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'company_payment_hash_reused' USING ERRCODE='23505'; END;
 -- Expiry prevents a new wallet prompt; it never discards an already-broadcast payment.
 RETURN QUERY SELECT * FROM payments.read_personal_company_payment(p_subject,p_id);
END $function$;

-- This capability is server-only. SQL validates evidence shape and immutable
-- receipt identity; the trusted HTTP verifier obtains and checks canonical RPC
-- transaction/receipt/USDT Transfer logs, block hash and at least 12 confirmations.
CREATE FUNCTION payments.verify_personal_company_payment(p_subject text,p_id uuid,p_hash text,p_block_number text,p_block_hash text,p_confirmations integer)
RETURNS TABLE(id uuid,wallet_address text,amount_atomic text,status text,expires_at timestamptz,created_at timestamptz,
 transaction_hash text,block_number text,block_hash text,confirmations integer,recipient_address text,chain_id integer,
 token_address text,token_decimals smallint,failure_reason text,submitted_at timestamptz,confirmed_at timestamptz,abandoned_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_row payments.personal_company_payment%ROWTYPE;
BEGIN
 IF p_id IS NULL OR p_hash IS NULL OR p_hash !~ '^0x[0-9a-f]{64}$'
  OR p_block_number IS NULL OR p_block_number !~ '^[1-9][0-9]{0,18}$'
  OR p_block_hash IS NULL OR p_block_hash !~ '^0x[0-9a-f]{64}$'
  OR p_confirmations IS NULL OR p_confirmations NOT BETWEEN 12 AND 1000000000 THEN
  RAISE EXCEPTION 'company_payment_verification_invalid' USING ERRCODE='22023'; END IF;
 IF p_block_number::numeric>9223372036854775807 THEN
  RAISE EXCEPTION 'company_payment_verification_invalid' USING ERRCODE='22023'; END IF;
 SELECT r.* INTO v_row FROM payments.personal_company_payment r WHERE r.id=p_id AND r.subject=p_subject FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'company_payment_not_found' USING ERRCODE='P0002'; END IF;
 PERFORM payments.assert_personal_company_payment_owner(p_subject,v_row.wallet_address);
 IF v_row.transaction_hash IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'company_payment_confirmation_conflict' USING ERRCODE='22023'; END IF;
 IF v_row.status='confirmed' THEN
  IF v_row.block_number<>p_block_number OR v_row.block_hash<>p_block_hash THEN
   RAISE EXCEPTION 'company_payment_confirmation_conflict' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT * FROM payments.read_personal_company_payment(p_subject,p_id); RETURN;
 END IF;
 IF v_row.status<>'submitted' THEN RAISE EXCEPTION 'company_payment_invalid_transition' USING ERRCODE='22023'; END IF;
 UPDATE payments.personal_company_payment r SET status='confirmed',block_number=p_block_number,block_hash=p_block_hash,
  confirmations=p_confirmations,confirmed_at=now() WHERE r.id=p_id;
 RETURN QUERY SELECT * FROM payments.read_personal_company_payment(p_subject,p_id);
END $function$;

CREATE FUNCTION payments.reject_personal_company_payment(p_subject text,p_id uuid,p_hash text,p_reason text)
RETURNS TABLE(id uuid,wallet_address text,amount_atomic text,status text,expires_at timestamptz,created_at timestamptz,
 transaction_hash text,block_number text,block_hash text,confirmations integer,recipient_address text,chain_id integer,
 token_address text,token_decimals smallint,failure_reason text,submitted_at timestamptz,confirmed_at timestamptz,abandoned_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_row payments.personal_company_payment%ROWTYPE;
BEGIN
 IF p_id IS NULL OR p_hash IS NULL OR p_hash !~ '^0x[0-9a-f]{64}$'
  OR p_reason IS NULL OR p_reason NOT IN('transaction_reverted','transaction_mismatch') THEN
  RAISE EXCEPTION 'company_payment_invalid_request' USING ERRCODE='22023'; END IF;
 SELECT r.* INTO v_row FROM payments.personal_company_payment r WHERE r.id=p_id AND r.subject=p_subject FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'company_payment_not_found' USING ERRCODE='P0002'; END IF;
 PERFORM payments.assert_personal_company_payment_owner(p_subject,v_row.wallet_address);
 IF v_row.transaction_hash IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'company_payment_confirmation_conflict' USING ERRCODE='22023'; END IF;
 IF v_row.status='failed' AND v_row.failure_reason=p_reason THEN
  RETURN QUERY SELECT * FROM payments.read_personal_company_payment(p_subject,p_id); RETURN;
 END IF;
 IF v_row.status<>'submitted' THEN RAISE EXCEPTION 'company_payment_invalid_transition' USING ERRCODE='22023'; END IF;
 UPDATE payments.personal_company_payment r SET status='failed',failure_reason=p_reason,failed_at=now() WHERE r.id=p_id;
 RETURN QUERY SELECT * FROM payments.read_personal_company_payment(p_subject,p_id);
END $function$;

-- Explicit cancellation of an unsigned local draft. Never deletes evidence or
-- prevents a late already-broadcast hash from becoming a submitted receipt.
CREATE FUNCTION payments.abandon_personal_company_payment(p_subject text,p_id uuid)
RETURNS TABLE(id uuid,wallet_address text,amount_atomic text,status text,expires_at timestamptz,created_at timestamptz,
 transaction_hash text,block_number text,block_hash text,confirmations integer,recipient_address text,chain_id integer,
 token_address text,token_decimals smallint,failure_reason text,submitted_at timestamptz,confirmed_at timestamptz,abandoned_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_row payments.personal_company_payment%ROWTYPE;
BEGIN
 IF p_id IS NULL THEN RAISE EXCEPTION 'company_payment_invalid_request' USING ERRCODE='22023'; END IF;
 SELECT r.* INTO v_row FROM payments.personal_company_payment r WHERE r.id=p_id AND r.subject=p_subject FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'company_payment_not_found' USING ERRCODE='P0002'; END IF;
 PERFORM payments.assert_personal_company_payment_owner(p_subject,v_row.wallet_address);
 IF v_row.status<>'prepared' THEN RAISE EXCEPTION 'company_payment_invalid_transition' USING ERRCODE='22023'; END IF;
 IF v_row.abandoned_at IS NULL THEN
  UPDATE payments.personal_company_payment r SET abandoned_at=now() WHERE r.id=p_id;
 END IF;
 RETURN QUERY SELECT * FROM payments.read_personal_company_payment(p_subject,p_id);
END $function$;

DO $revoke_function_defaults$
DECLARE item record;
BEGIN
 FOR item IN SELECT p.oid::regprocedure AS signature,a.grantee FROM pg_catalog.pg_proc p
  CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
  WHERE p.pronamespace='payments'::regnamespace AND p.proname IN('guard_personal_company_payment',
   'assert_personal_company_payment_owner','read_personal_company_payment','read_personal_company_payment_history',
   'prepare_personal_company_payment','submit_personal_company_payment','verify_personal_company_payment','reject_personal_company_payment','abandon_personal_company_payment')
  AND a.grantee<>p.proowner LOOP
  IF item.grantee=0 THEN EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',item.signature);
  ELSE EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %I',item.signature,pg_catalog.pg_get_userbyid(item.grantee)); END IF;
 END LOOP;
END $revoke_function_defaults$;
REVOKE ALL ON FUNCTION payments.guard_personal_company_payment(),payments.assert_personal_company_payment_owner(text,text),
 payments.read_personal_company_payment(text,uuid),payments.read_personal_company_payment_history(text),payments.prepare_personal_company_payment(text,text,text,uuid),
 payments.submit_personal_company_payment(text,uuid,text),payments.verify_personal_company_payment(text,uuid,text,text,text,integer),
 payments.reject_personal_company_payment(text,uuid,text,text),payments.abandon_personal_company_payment(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION payments.read_personal_company_payment(text,uuid),payments.read_personal_company_payment_history(text),payments.prepare_personal_company_payment(text,text,text,uuid),
 payments.submit_personal_company_payment(text,uuid,text),payments.verify_personal_company_payment(text,uuid,text,text,text,integer),
 payments.reject_personal_company_payment(text,uuid,text,text),payments.abandon_personal_company_payment(text,uuid) TO mindbliss_auth_core_v1;
DO $verify$
BEGIN
 IF pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.personal_company_payment','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid='payments.personal_company_payment'::regclass AND relrowsecurity)
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
   WHERE c.oid='payments.personal_company_payment'::regclass AND a.grantee<>c.relowner)
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
   WHERE p.pronamespace='payments'::regnamespace AND p.proname LIKE '%personal_company_payment%'
    AND a.grantee<>p.proowner AND (a.grantee=0 OR a.grantee<>'mindbliss_auth_core_v1'::regrole
     OR p.proname IN('guard_personal_company_payment','assert_personal_company_payment_owner')))
  OR (SELECT count(*) FROM pg_catalog.pg_proc WHERE pronamespace='payments'::regnamespace
   AND proname IN('read_personal_company_payment','read_personal_company_payment_history','prepare_personal_company_payment','submit_personal_company_payment',
    'verify_personal_company_payment','reject_personal_company_payment','abandon_personal_company_payment') AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog']::text[])<>7 THEN
  RAISE EXCEPTION 'company_payment_runtime_isolation_failed';
 END IF;
END $verify$;
COMMIT;
