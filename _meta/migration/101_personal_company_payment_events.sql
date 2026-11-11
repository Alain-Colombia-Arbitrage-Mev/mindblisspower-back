-- Append-only activity for Mindbliss personal USDT transfers. Canonical events
-- are emitted atomically by the receipt table; browser observations remain
-- explicitly unverified and cannot advance any payment or financial ledger.
BEGIN;
SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('personal-company-payment-events-v1',0));
DO $preflight$
BEGIN
 IF pg_catalog.current_database()<>'mindbliss_curated_20261025' OR pg_catalog.pg_is_in_recovery()
  OR pg_catalog.to_regclass('payments.personal_company_payment') IS NULL
  OR pg_catalog.to_regprocedure('payments.prepare_personal_company_payment_v3(text,text,text,uuid,integer)') IS NULL THEN
  RAISE EXCEPTION 'company_payment_event_prerequisites_required';
 END IF;
 IF pg_catalog.to_regclass('payments.personal_company_payment_event') IS NOT NULL
  OR pg_catalog.to_regprocedure('payments.record_personal_company_payment_event(text,uuid,uuid,uuid,text,text,text)') IS NOT NULL
  OR pg_catalog.to_regprocedure('payments.read_personal_company_payment_activity(text,uuid,uuid,integer)') IS NOT NULL
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.prepare_personal_company_payment_v3(text,text,text,uuid,integer)'::regprocedure))<>'655b1dc08cc2ccd354bac7fe7d07abba'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.guard_personal_company_payment()'::regprocedure))<>'88247529f627ea098673b99cd23a9929'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.assert_personal_company_payment_owner(text,text)'::regprocedure))<>'8f3d5e69426336b2f9ddf0ef08a5f623'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.submit_personal_company_payment(text,uuid,text)'::regprocedure))<>'1b359a7a24d2cc5843df8b5542877923'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.verify_personal_company_payment(text,uuid,text,text,text,integer)'::regprocedure))<>'a631e252eb5461def29e1236ac522fc5'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.reject_personal_company_payment(text,uuid,text,text)'::regprocedure))<>'8d4b084049311b5a47b3cf286cba452e'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.abandon_personal_company_payment(text,uuid)'::regprocedure))<>'9f39ff32d1c7439e46742fcb18a87015' THEN
  RAISE EXCEPTION 'company_payment_event_requires_fresh_review';
 END IF;
 IF NOT pg_catalog.pg_has_role((SELECT relowner FROM pg_catalog.pg_class WHERE oid='payments.personal_company_payment'::regclass),'USAGE')
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.personal_company_payment','SELECT,INSERT,UPDATE,DELETE')
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.reown_funding_intent','SELECT,INSERT,UPDATE,DELETE')
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.meld_sandbox_funding_attempt','SELECT,INSERT,UPDATE,DELETE')
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid='payments.personal_company_payment'::regclass AND relrowsecurity)
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='payments.personal_company_payment'::regclass
   AND tgname='personal_company_payment_immutable' AND tgfoid='payments.guard_personal_company_payment()'::regprocedure AND tgenabled='O' AND NOT tgisinternal) THEN
  RAISE EXCEPTION 'company_payment_event_runtime_isolation_required';
 END IF;
END $preflight$;

CREATE TABLE payments.personal_company_payment_event (
 event_id uuid PRIMARY KEY CHECK(event_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 payment_id uuid NOT NULL REFERENCES payments.personal_company_payment(id) ON DELETE RESTRICT,
 subject text NOT NULL REFERENCES auth."user"(id) ON DELETE RESTRICT,
 attempt_id uuid CHECK(attempt_id IS NULL OR attempt_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 source text NOT NULL CHECK(source IN('canonical','client_reported')),
 event text NOT NULL,
 canonical_status text,
 chain_id integer NOT NULL,
 token_address text NOT NULL,
 token_decimals smallint NOT NULL CHECK(token_decimals=6),
 wallet_address text NOT NULL CHECK(wallet_address ~ '^0x[0-9a-f]{40}$'),
 recipient_address text NOT NULL CHECK(recipient_address='0x0a600b03ef5f8e7f3e182b83440c6d292033db0e'),
 amount_atomic text NOT NULL CHECK(CASE WHEN amount_atomic ~ '^[1-9][0-9]{0,77}$'
  THEN amount_atomic::numeric<=115792089237316195423570985008687907853269984665640564039457584007913129639935 ELSE false END),
 transaction_hash text CHECK(transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-f]{64}$'),
 code text CHECK(code IS NULL OR code IN('user_rejected','wallet_changed','network_changed','rpc_unavailable',
  'registration_unavailable','verification_unavailable','recovery_unavailable','unknown')),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((chain_id=1 AND token_address='0xdac17f958d2ee523a2206206994597c13d831ec7')
  OR (chain_id=137 AND token_address='0xc2132d05d31c914a87c6611c10748aeb04b58e8f')),
 CHECK((source='canonical' AND event IN('prepared','submitted','confirmed','failed','abandoned','snapshot')
   AND attempt_id IS NULL AND code IS NULL AND canonical_status IS NOT NULL AND canonical_status IN('prepared','submitted','confirmed','failed')
   AND (event='snapshot' OR canonical_status=CASE event WHEN 'abandoned' THEN 'prepared' ELSE event END)
   AND ((canonical_status='prepared' AND transaction_hash IS NULL) OR (canonical_status<>'prepared' AND transaction_hash IS NOT NULL)))
  OR (source='client_reported' AND canonical_status IS NULL
   AND event IN('wallet_prompt_opened','wallet_rejected','wallet_failed','broadcast_uncertain','broadcast_observed',
    'recovery_detected','registration_failed','verification_requested','verification_failed')
   AND (transaction_hash IS NULL OR event IN('broadcast_observed','recovery_detected','registration_failed','verification_requested','verification_failed'))
   AND (event<>'broadcast_observed' OR transaction_hash IS NOT NULL)))
);
CREATE INDEX personal_company_event_subject_seq_idx ON payments.personal_company_payment_event(subject,seq DESC);
CREATE INDEX personal_company_event_payment_seq_idx ON payments.personal_company_payment_event(subject,payment_id,seq DESC);
CREATE INDEX personal_company_event_client_rate_idx ON payments.personal_company_payment_event(subject,created_at DESC) WHERE source='client_reported';
CREATE INDEX personal_company_event_attempt_idx ON payments.personal_company_payment_event(attempt_id) WHERE attempt_id IS NOT NULL;
CREATE UNIQUE INDEX personal_company_event_canonical_unique ON payments.personal_company_payment_event(payment_id,event) WHERE source='canonical';
ALTER TABLE payments.personal_company_payment_event ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION payments.guard_personal_company_payment_event() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN RAISE EXCEPTION 'company_payment_event_append_only' USING ERRCODE='22023'; END $function$;
CREATE TRIGGER personal_company_event_immutable BEFORE UPDATE OR DELETE ON payments.personal_company_payment_event
 FOR EACH ROW EXECUTE FUNCTION payments.guard_personal_company_payment_event();
CREATE TRIGGER personal_company_event_no_truncate BEFORE TRUNCATE ON payments.personal_company_payment_event
 FOR EACH STATEMENT EXECUTE FUNCTION payments.guard_personal_company_payment_event();

CREATE FUNCTION payments.capture_personal_company_payment_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_event text;
BEGIN
 IF TG_OP='INSERT' THEN v_event:=NEW.status;
 ELSIF NEW.status IS DISTINCT FROM OLD.status THEN v_event:=NEW.status;
 ELSIF NEW.abandoned_at IS DISTINCT FROM OLD.abandoned_at AND NEW.abandoned_at IS NOT NULL THEN v_event:='abandoned';
 ELSE RETURN NEW; END IF;
 -- Serialize canonical and client observations per owner until commit. Seek
 -- cursors therefore cannot skip a late-committing lower sequence for this user.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('personal-company-events:'||NEW.subject,0));
 INSERT INTO payments.personal_company_payment_event(event_id,payment_id,subject,source,event,canonical_status,
  chain_id,token_address,token_decimals,wallet_address,recipient_address,amount_atomic,transaction_hash)
 VALUES(pg_catalog.gen_random_uuid(),NEW.id,NEW.subject,'canonical',v_event,NEW.status,
  NEW.chain_id,NEW.token_address,NEW.token_decimals,NEW.wallet_address,NEW.recipient_address,NEW.amount_atomic,NEW.transaction_hash)
 ON CONFLICT(payment_id,event) WHERE source='canonical' DO NOTHING;
 RETURN NEW;
END $function$;
CREATE TRIGGER personal_company_payment_audit AFTER INSERT OR UPDATE ON payments.personal_company_payment
 FOR EACH ROW EXECUTE FUNCTION payments.capture_personal_company_payment_event();

-- One deterministic reference per existing receipt, recorded now. This is an
-- honest snapshot of its current state, never fabricated past transition dates.
WITH snapshots AS (SELECT p.*,pg_catalog.md5('mindbliss-personal-payment-snapshot-v1:'||p.id::text) AS digest
 FROM payments.personal_company_payment p)
INSERT INTO payments.personal_company_payment_event(event_id,payment_id,subject,source,event,canonical_status,
 chain_id,token_address,token_decimals,wallet_address,recipient_address,amount_atomic,transaction_hash)
SELECT (pg_catalog.substr(s.digest,1,12)||'3'||pg_catalog.substr(s.digest,14,3)||'a'||pg_catalog.substr(s.digest,18,15))::uuid,
 s.id,s.subject,'canonical','snapshot',s.status,s.chain_id,s.token_address,s.token_decimals,s.wallet_address,s.recipient_address,s.amount_atomic,s.transaction_hash
 FROM snapshots s ORDER BY s.created_at,s.id;

CREATE FUNCTION payments.record_personal_company_payment_event(
 p_subject text,p_payment_id uuid,p_event_id uuid,p_attempt_id uuid,p_event text,p_hash text,p_code text)
RETURNS TABLE(event_id uuid,payment_id uuid,attempt_id uuid,source text,event text,chain_id integer,token_address text,
 wallet_address text,recipient_address text,amount_atomic text,transaction_hash text,code text,created_at timestamptz,canonical_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_payment payments.personal_company_payment%ROWTYPE;v_event payments.personal_company_payment_event%ROWTYPE;
BEGIN
 BEGIN PERFORM identity.administrative_wallet_person(p_subject);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'company_payment_forbidden' USING ERRCODE='28000'; END;
 IF p_payment_id IS NULL OR p_event_id IS NULL
  OR p_event_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  OR (p_attempt_id IS NOT NULL AND p_attempt_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
  OR p_event IS NULL OR p_event NOT IN('wallet_prompt_opened','wallet_rejected','wallet_failed','broadcast_uncertain','broadcast_observed',
   'recovery_detected','registration_failed','verification_requested','verification_failed')
  OR (p_hash IS NOT NULL AND (p_hash !~ '^0x[0-9a-f]{64}$' OR p_event NOT IN('broadcast_observed','recovery_detected','registration_failed','verification_requested','verification_failed')))
  OR (p_event='broadcast_observed' AND p_hash IS NULL)
  OR (p_code IS NOT NULL AND p_code NOT IN('user_rejected','wallet_changed','network_changed','rpc_unavailable',
   'registration_unavailable','verification_unavailable','recovery_unavailable','unknown')) THEN
  RAISE EXCEPTION 'company_payment_invalid_request' USING ERRCODE='22023'; END IF;
 SELECT p.* INTO v_payment FROM payments.personal_company_payment p WHERE p.id=p_payment_id AND p.subject=p_subject;
 IF NOT FOUND THEN RAISE EXCEPTION 'company_payment_not_found' USING ERRCODE='P0002'; END IF;
 PERFORM payments.assert_personal_company_payment_owner(p_subject,v_payment.wallet_address);
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('personal-company-events:'||p_subject,0));
 IF p_attempt_id IS NOT NULL THEN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('personal-company-attempt:'||p_attempt_id::text,0));
  IF EXISTS(SELECT 1 FROM payments.personal_company_payment_event e WHERE e.attempt_id=p_attempt_id
    AND (e.subject<>p_subject OR e.payment_id<>p_payment_id)) THEN
   RAISE EXCEPTION 'company_payment_event_conflict' USING ERRCODE='22023'; END IF;
 END IF;
 SELECT e.* INTO v_event FROM payments.personal_company_payment_event e WHERE e.event_id=p_event_id;
 IF FOUND THEN
  IF ROW(v_event.subject,v_event.payment_id,v_event.attempt_id,v_event.source,v_event.event,v_event.transaction_hash,v_event.code)
   IS DISTINCT FROM ROW(p_subject,p_payment_id,p_attempt_id,'client_reported'::text,p_event,p_hash,p_code) THEN
   RAISE EXCEPTION 'company_payment_event_conflict' USING ERRCODE='22023'; END IF;
 ELSE
  IF (SELECT count(*) FROM payments.personal_company_payment_event e WHERE e.subject=p_subject
    AND e.source='client_reported' AND e.created_at>now()-interval '10 minutes')>=30 THEN
   RAISE EXCEPTION 'company_payment_rate_limited' USING ERRCODE='54000'; END IF;
  BEGIN
   INSERT INTO payments.personal_company_payment_event(event_id,payment_id,subject,attempt_id,source,event,
    chain_id,token_address,token_decimals,wallet_address,recipient_address,amount_atomic,transaction_hash,code)
   VALUES(p_event_id,p_payment_id,p_subject,p_attempt_id,'client_reported',p_event,
    v_payment.chain_id,v_payment.token_address,v_payment.token_decimals,v_payment.wallet_address,v_payment.recipient_address,v_payment.amount_atomic,p_hash,p_code);
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'company_payment_event_conflict' USING ERRCODE='22023'; END;
 END IF;
 RETURN QUERY SELECT e.event_id,e.payment_id,e.attempt_id,e.source,e.event,e.chain_id,e.token_address,
  e.wallet_address,e.recipient_address,e.amount_atomic,e.transaction_hash,e.code,e.created_at,e.canonical_status
  FROM payments.personal_company_payment_event e WHERE e.event_id=p_event_id AND e.subject=p_subject;
END $function$;

CREATE FUNCTION payments.read_personal_company_payment_activity(
 p_subject text,p_payment_id uuid,p_cursor_id uuid,p_limit integer)
RETURNS TABLE(event_id uuid,payment_id uuid,attempt_id uuid,source text,event text,chain_id integer,token_address text,
 wallet_address text,recipient_address text,amount_atomic text,transaction_hash text,code text,created_at timestamptz,canonical_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_address text;v_cursor bigint;
BEGIN
 SELECT b.address INTO v_address FROM identity.wallet_binding b WHERE b.subject=p_subject;
 PERFORM payments.assert_personal_company_payment_owner(p_subject,v_address);
 IF p_limit IS NULL OR p_limit<1 OR p_limit>51 THEN RAISE EXCEPTION 'company_payment_invalid_request' USING ERRCODE='22023'; END IF;
 IF p_payment_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM payments.personal_company_payment p
   WHERE p.id=p_payment_id AND p.subject=p_subject AND p.wallet_address=v_address) THEN
  RAISE EXCEPTION 'company_payment_not_found' USING ERRCODE='P0002'; END IF;
 IF p_cursor_id IS NOT NULL THEN
  SELECT e.seq INTO v_cursor FROM payments.personal_company_payment_event e
   WHERE e.event_id=p_cursor_id AND e.subject=p_subject AND e.wallet_address=v_address AND (p_payment_id IS NULL OR e.payment_id=p_payment_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'company_payment_invalid_cursor' USING ERRCODE='22023'; END IF;
 END IF;
 RETURN QUERY SELECT e.event_id,e.payment_id,e.attempt_id,e.source,e.event,e.chain_id,e.token_address,
  e.wallet_address,e.recipient_address,e.amount_atomic,e.transaction_hash,e.code,e.created_at,e.canonical_status
  FROM payments.personal_company_payment_event e WHERE e.subject=p_subject AND e.wallet_address=v_address
   AND (p_payment_id IS NULL OR e.payment_id=p_payment_id) AND (v_cursor IS NULL OR e.seq<v_cursor)
  ORDER BY e.seq DESC LIMIT p_limit;
END $function$;

-- Remove schema default table/sequence/function grants, including inherited
-- reporting defaults. Runtime can execute only the two owner-scoped functions.
REVOKE ALL ON FUNCTION payments.guard_personal_company_payment_event(),payments.capture_personal_company_payment_event(),
 payments.record_personal_company_payment_event(text,uuid,uuid,uuid,text,text,text),
 payments.read_personal_company_payment_activity(text,uuid,uuid,integer) FROM PUBLIC;
DO $revoke_defaults$
DECLARE item record;
BEGIN
 FOR item IN SELECT c.oid,c.relkind,a.grantee FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
  WHERE c.oid IN('payments.personal_company_payment_event'::regclass,
    pg_catalog.pg_get_serial_sequence('payments.personal_company_payment_event','seq')::regclass) AND a.grantee<>c.relowner LOOP
  EXECUTE pg_catalog.format('REVOKE ALL ON %s %s FROM %s',CASE WHEN item.relkind='S' THEN 'SEQUENCE' ELSE 'TABLE' END,item.oid::regclass,
   CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(item.grantee)) END);
 END LOOP;
 FOR item IN SELECT p.oid,a.grantee FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
  WHERE p.oid IN('payments.guard_personal_company_payment_event()'::regprocedure,
   'payments.capture_personal_company_payment_event()'::regprocedure,
   'payments.record_personal_company_payment_event(text,uuid,uuid,uuid,text,text,text)'::regprocedure,
   'payments.read_personal_company_payment_activity(text,uuid,uuid,integer)'::regprocedure) AND a.grantee<>p.proowner LOOP
  EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %s',item.oid::regprocedure,
   CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(item.grantee)) END);
 END LOOP;
END $revoke_defaults$;
GRANT EXECUTE ON FUNCTION payments.record_personal_company_payment_event(text,uuid,uuid,uuid,text,text,text),
 payments.read_personal_company_payment_activity(text,uuid,uuid,integer) TO mindbliss_auth_core_v1;
DO $verify$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
   WHERE c.oid IN('payments.personal_company_payment_event'::regclass,
    pg_catalog.pg_get_serial_sequence('payments.personal_company_payment_event','seq')::regclass) AND a.grantee<>c.relowner)
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid='payments.personal_company_payment_event'::regclass AND relrowsecurity)
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.personal_company_payment_event','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
  OR (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.oid IN(
    'payments.capture_personal_company_payment_event()'::regprocedure,
    'payments.record_personal_company_payment_event(text,uuid,uuid,uuid,text,text,text)'::regprocedure,
    'payments.read_personal_company_payment_activity(text,uuid,uuid,integer)'::regprocedure)
   AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog']::text[])<>3
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
   WHERE p.oid IN('payments.guard_personal_company_payment_event()'::regprocedure,'payments.capture_personal_company_payment_event()'::regprocedure,
    'payments.record_personal_company_payment_event(text,uuid,uuid,uuid,text,text,text)'::regprocedure,
    'payments.read_personal_company_payment_activity(text,uuid,uuid,integer)'::regprocedure)
   AND a.grantee<>p.proowner AND (a.grantee<>'mindbliss_auth_core_v1'::regrole
    OR p.proname IN('guard_personal_company_payment_event','capture_personal_company_payment_event')))
  OR NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.record_personal_company_payment_event(text,uuid,uuid,uuid,text,text,text)','EXECUTE')
  OR NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.read_personal_company_payment_activity(text,uuid,uuid,integer)','EXECUTE') THEN
  RAISE EXCEPTION 'company_payment_event_runtime_isolation_failed';
 END IF;
END $verify$;
COMMIT;
