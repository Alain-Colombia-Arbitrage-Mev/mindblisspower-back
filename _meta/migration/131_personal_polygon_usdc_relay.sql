-- Add native Circle USDC on Polygon to the existing sponsored journal.
-- Legacy USDT authorizations and receipts are byte-for-byte unchanged.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('polygon-relay-budget:137:POL_WEI',0));

DO $preflight$
DECLARE v_name name; v_count integer;
BEGIN
 IF pg_catalog.current_database()<>'mindbliss_curated_20261025' OR pg_catalog.pg_is_in_recovery()
  OR pg_catalog.to_regprocedure('payments.prepare_personal_polygon_relay(text,text,text,uuid,text,text,text,text,text,text,text,text,text)') IS NULL
  OR pg_catalog.to_regprocedure('payments.prepare_personal_polygon_usdc_relay(text,text,text,uuid,text,text,text,bigint,text,text,text)') IS NOT NULL
  OR pg_catalog.to_regprocedure('payments.guard_personal_polygon_relay()') IS NULL
  OR NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1',
   'payments.prepare_personal_polygon_relay(text,text,text,uuid,text,text,text,text,text,text,text,text,text)','EXECUTE') THEN
  RAISE EXCEPTION 'polygon_usdc_prerequisites_required'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid IN('payments.personal_polygon_relay'::regclass,
     'payments.personal_transfer_request'::regclass,'payments.personal_polygon_native_authorization'::regclass,
     'payments.personal_polygon_relay_event'::regclass) AND (NOT c.relrowsecurity OR NOT pg_catalog.pg_has_role(c.relowner,'USAGE')
     OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1',c.oid,'SELECT,INSERT,UPDATE,DELETE'))) THEN
  RAISE EXCEPTION 'polygon_usdc_existing_isolation_required'; END IF;

 SELECT min(conname::text),count(*) INTO v_name,v_count FROM pg_catalog.pg_constraint
 WHERE conrelid='payments.personal_transfer_request'::regclass AND contype='c'
  AND pg_catalog.pg_get_constraintdef(oid) LIKE '%polygon_native_meta%solana_sponsored%';
 -- The route constraint includes the immutable token and recipient; avoid
 -- touching the independent source_kind enum and the other journal checks.
 IF v_count<>2 THEN RAISE EXCEPTION 'polygon_usdc_transfer_constraint_changed'; END IF;
 SELECT min(conname::text),count(*) INTO v_name,v_count FROM pg_catalog.pg_constraint
 WHERE conrelid='payments.personal_transfer_request'::regclass AND contype='c'
  AND pg_catalog.pg_get_constraintdef(oid) LIKE '%polygon_native_meta%'
  AND pg_catalog.pg_get_constraintdef(oid) LIKE '%0xc2132d05d31c914a87c6611c10748aeb04b58e8f%';
 IF v_count<>1 THEN RAISE EXCEPTION 'polygon_usdc_transfer_constraint_changed'; END IF;
 EXECUTE pg_catalog.format('ALTER TABLE payments.personal_transfer_request DROP CONSTRAINT %I',v_name);

 SELECT min(conname::text),count(*) INTO v_name,v_count FROM pg_catalog.pg_constraint
 WHERE conrelid='payments.personal_polygon_relay'::regclass AND contype='c'
  AND pg_catalog.pg_get_constraintdef(oid) LIKE '%authorized_at IS NULL%attempt_id IS NULL%reconciliation_required%';
 IF v_count<>1 THEN RAISE EXCEPTION 'polygon_usdc_status_constraint_changed'; END IF;
 EXECUTE pg_catalog.format('ALTER TABLE payments.personal_polygon_relay DROP CONSTRAINT %I',v_name);
END $preflight$;

ALTER TABLE payments.personal_transfer_request ADD CONSTRAINT personal_transfer_approved_network_token CHECK(
  (source_kind IN('evm_direct','polygon_native_meta') AND chain_namespace='eip155' AND chain_reference IN('1','137')
   AND wallet_address ~ '^0x[0-9a-f]{40}$' AND recipient_address='0x0a600b03ef5f8e7f3e182b83440c6d292033db0e'
   AND ((chain_reference='1' AND token_address='0xdac17f958d2ee523a2206206994597c13d831ec7')
    OR (chain_reference='137' AND (token_address='0xc2132d05d31c914a87c6611c10748aeb04b58e8f'
     OR (source_kind='polygon_native_meta' AND token_address='0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'))))
   AND (source_kind<>'polygon_native_meta' OR chain_reference='137'))
  OR (source_kind='solana_sponsored' AND chain_namespace='solana' AND chain_reference='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
   AND wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' AND token_address='Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
   AND recipient_address='8U6UD6UmRkYvpubEUg3GG9LBobH5J2c9871mryh1TA5k'));

ALTER TABLE payments.personal_polygon_relay
 DROP CONSTRAINT personal_polygon_relay_token_address_check,
 DROP CONSTRAINT personal_polygon_relay_implementation_address_check,
 ADD CONSTRAINT personal_polygon_relay_approved_token CHECK(
   (token_address='0xc2132d05d31c914a87c6611c10748aeb04b58e8f' AND implementation_address='0x90040487a6c9f949c4f07cadcfb0f3b8eeab4229')
   OR (token_address='0x3c499c542cef5e3811e1192ce70d8cc03d5c3359' AND implementation_address='0x235ae97b28466db30469b89a9fe4cff0659f82cb'
    AND domain_separator='0xcaa2ce1a5703ccbe253a34eb3166df60a705c561b44b192061e28f2a985be2ca'
    AND authorization_nonce::numeric BETWEEN 1 AND 340282366920938463463374607431768211455
    AND expires_at=date_trunc('second',expires_at))),
 ADD CONSTRAINT personal_polygon_relay_authorized_state CHECK(
   (status IN('prepared','expired') AND authorized_at IS NULL AND attempt_id IS NULL AND user_operation_hash IS NULL AND transaction_hash IS NULL)
   OR (status='expired' AND token_address='0x3c499c542cef5e3811e1192ce70d8cc03d5c3359' AND failure_reason='preparation_expired'
    AND authorized_at IS NOT NULL AND authorization_invalidated_at IS NOT NULL AND observed_native_nonce=authorization_nonce
    AND attempt_id IS NULL AND user_operation_hash IS NULL AND transaction_hash IS NULL)
   OR (status='authorized' AND authorized_at IS NOT NULL AND attempt_id IS NULL AND user_operation_hash IS NULL AND transaction_hash IS NULL)
   OR (status IN('broadcasting','ambiguous','submitted','confirmed','failed') AND authorized_at IS NOT NULL AND attempt_id IS NOT NULL
    AND (status='broadcasting' OR user_operation_hash IS NOT NULL))
   OR (status='reconciliation_required' AND failure_reason='authorization_nonce_changed' AND authorized_at IS NOT NULL));

ALTER TABLE payments.personal_polygon_native_authorization
 DROP CONSTRAINT personal_polygon_native_authorization_token_address_check,
 ADD CONSTRAINT personal_polygon_native_authorization_approved_token CHECK(token_address IN(
  '0xc2132d05d31c914a87c6611c10748aeb04b58e8f','0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'));
ALTER TABLE payments.personal_polygon_relay_event
 DROP CONSTRAINT personal_polygon_relay_event_token_address_check,
 ADD CONSTRAINT personal_polygon_relay_event_approved_token CHECK(token_address IN(
  '0xc2132d05d31c914a87c6611c10748aeb04b58e8f','0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'));

CREATE OR REPLACE FUNCTION payments.guard_personal_polygon_relay() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
DECLARE v_reset boolean:=false;
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'polygon_relay_snapshot_immutable' USING ERRCODE='22023'; END IF;
 IF ROW(NEW.id,NEW.subject,NEW.wallet_address,NEW.amount_atomic,NEW.execution_mode,NEW.chain_id,NEW.token_address,NEW.token_decimals,
  NEW.recipient_address,NEW.authorization_nonce,NEW.authorization_digest,NEW.domain_separator,NEW.implementation_address,
  NEW.relayer_address,NEW.entry_point,NEW.max_fee_wei,NEW.owner_daily_cap_wei,NEW.global_daily_cap_wei,NEW.created_at,NEW.expires_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.subject,OLD.wallet_address,OLD.amount_atomic,OLD.execution_mode,OLD.chain_id,OLD.token_address,OLD.token_decimals,
  OLD.recipient_address,OLD.authorization_nonce,OLD.authorization_digest,OLD.domain_separator,OLD.implementation_address,
  OLD.relayer_address,OLD.entry_point,OLD.max_fee_wei,OLD.owner_daily_cap_wei,OLD.global_daily_cap_wei,OLD.created_at,OLD.expires_at)
  OR (OLD.status IN('confirmed','failed','expired','reconciliation_required') AND NEW IS DISTINCT FROM OLD) THEN
  RAISE EXCEPTION 'polygon_relay_snapshot_immutable' USING ERRCODE='22023'; END IF;
 IF OLD.authorized_at IS NOT NULL AND ROW(NEW.authorized_at,NEW.authorization_ciphertext,NEW.authorization_key_id)
  IS DISTINCT FROM ROW(OLD.authorized_at,OLD.authorization_ciphertext,OLD.authorization_key_id) THEN
  RAISE EXCEPTION 'polygon_relay_authorization_immutable' USING ERRCODE='22023'; END IF;
 IF OLD.authorized_at IS NULL AND NEW.authorized_at IS NOT NULL AND (OLD.status<>'prepared' OR NEW.status<>'authorized'
  OR NOT EXISTS(SELECT 1 FROM payments.personal_polygon_native_authorization a WHERE a.payment_id=NEW.id
    AND a.subject=NEW.subject AND a.authorization_digest=NEW.authorization_digest AND a.authorization_nonce=NEW.authorization_nonce)) THEN
  RAISE EXCEPTION 'polygon_relay_authorization_required' USING ERRCODE='22023'; END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
  (OLD.status='prepared' AND NEW.status IN('authorized','expired')) OR (OLD.status='authorized' AND NEW.status='broadcasting')
  OR (OLD.status='authorized' AND NEW.status='reconciliation_required')
  OR (OLD.status='authorized' AND NEW.status='expired' AND OLD.token_address='0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'
   AND NEW.failure_reason='preparation_expired' AND OLD.expires_at<=clock_timestamp()
   AND EXISTS(SELECT 1 FROM payments.personal_polygon_authorization_retirement r WHERE r.payment_id=OLD.id
    AND r.observed_native_nonce=OLD.authorization_nonce))
  OR (OLD.status='broadcasting' AND NEW.status IN('authorized','ambiguous','submitted','confirmed','failed','reconciliation_required'))
  OR (OLD.status='ambiguous' AND NEW.status IN('authorized','submitted','confirmed','failed','reconciliation_required'))
  OR (OLD.status='submitted' AND NEW.status IN('authorized','confirmed','failed','reconciliation_required'))) THEN
  RAISE EXCEPTION 'polygon_relay_invalid_transition' USING ERRCODE='22023'; END IF;
 IF OLD.attempt_id IS NOT NULL AND NEW.attempt_id IS NULL THEN
  v_reset:=(NEW.status='authorized' AND EXISTS(SELECT 1 FROM payments.personal_polygon_relay_attempt a WHERE a.id=OLD.attempt_id
   AND a.payment_id=OLD.id AND ((a.state='released' AND OLD.user_operation_hash IS NULL)
    OR (a.state='expired' AND EXISTS(SELECT 1 FROM payments.personal_polygon_operation_expiry e WHERE e.attempt_id=a.id AND e.observed_native_nonce=OLD.authorization_nonce))
    OR (a.state='failed' AND EXISTS(SELECT 1 FROM payments.personal_polygon_relay_outcome o WHERE o.attempt_id=a.id AND o.result='failed' AND o.observed_native_nonce=OLD.authorization_nonce))))
   OR (NEW.status='reconciliation_required' AND OLD.user_operation_hash IS NULL
    AND EXISTS(SELECT 1 FROM payments.personal_polygon_authorization_retirement r WHERE r.payment_id=OLD.id)
    AND EXISTS(SELECT 1 FROM payments.personal_polygon_relay_attempt a WHERE a.id=OLD.attempt_id AND a.state='released')));
  IF NOT v_reset THEN RAISE EXCEPTION 'polygon_relay_operation_locked' USING ERRCODE='22023'; END IF;
 ELSIF NEW.attempt_id IS DISTINCT FROM OLD.attempt_id AND NOT (OLD.attempt_id IS NULL AND OLD.status='authorized' AND NEW.status='broadcasting'
  AND EXISTS(SELECT 1 FROM payments.personal_polygon_relay_attempt a WHERE a.id=NEW.attempt_id AND a.payment_id=NEW.id AND a.subject=NEW.subject
   AND a.entry_point=NEW.entry_point AND a.relayer_address=NEW.relayer_address AND a.state='building')) THEN
  RAISE EXCEPTION 'polygon_relay_attempt_conflict' USING ERRCODE='22023'; END IF;
 IF NEW.user_operation_hash IS DISTINCT FROM OLD.user_operation_hash AND NOT v_reset THEN
  IF OLD.user_operation_hash IS NOT NULL OR NEW.user_operation_hash IS NULL OR NOT EXISTS(
   SELECT 1 FROM payments.personal_polygon_relay_operation o WHERE o.attempt_id=NEW.attempt_id AND o.payment_id=NEW.id AND o.user_operation_hash=NEW.user_operation_hash) THEN
   RAISE EXCEPTION 'polygon_relay_operation_immutable' USING ERRCODE='22023'; END IF;
 END IF;
 IF OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at AND NOT v_reset THEN
  RAISE EXCEPTION 'polygon_relay_snapshot_immutable' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END $function$;

CREATE FUNCTION payments.prepare_personal_polygon_usdc_relay(p_subject text,p_address text,p_amount text,p_id uuid,p_token_nonce text,
 p_digest text,p_relayer text,p_valid_before bigint,p_max_fee text,p_owner_cap text,p_global_cap text)
RETURNS SETOF payments.personal_polygon_relay_internal LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v payments.personal_polygon_relay%ROWTYPE;v_now timestamptz;v_expiry timestamptz;
BEGIN
 PERFORM payments.assert_personal_company_payment_owner(p_subject,p_address);
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' OR p_id IS NULL
  OR p_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  OR p_amount IS NULL OR p_amount !~ '^[1-9][0-9]{0,77}$' OR p_token_nonce IS NULL OR p_token_nonce !~ '^[1-9][0-9]{0,38}$'
  OR p_digest IS NULL OR p_digest !~ '^0x[0-9a-f]{64}$'
  OR p_relayer IS NULL OR p_relayer !~ '^0x[0-9a-f]{40}$' OR p_relayer='0x0000000000000000000000000000000000000000'
  OR p_valid_before IS NULL OR p_valid_before NOT BETWEEN 1 AND 9007199254740991
  OR p_max_fee IS NULL OR p_max_fee !~ '^[1-9][0-9]{0,18}$' OR p_owner_cap IS NULL OR p_owner_cap !~ '^[1-9][0-9]{0,18}$'
  OR p_global_cap IS NULL OR p_global_cap !~ '^[1-9][0-9]{0,19}$' THEN
  RAISE EXCEPTION 'polygon_relay_invalid_request' USING ERRCODE='22023'; END IF;
 IF NOT payments.polygon_relay_uint256(p_amount) OR p_token_nonce::numeric>340282366920938463463374607431768211455
  OR p_max_fee::numeric>1000000000000000000 OR p_owner_cap::numeric>2000000000000000000 OR p_global_cap::numeric>10000000000000000000
  OR p_max_fee::numeric>p_owner_cap::numeric OR p_owner_cap::numeric>p_global_cap::numeric THEN
  RAISE EXCEPTION 'polygon_relay_invalid_request' USING ERRCODE='22023'; END IF;

 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('polygon-relay-budget:137:POL_WEI',0));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('personal-company-payment:'||p_subject,0));
 SELECT p.* INTO v FROM payments.personal_polygon_relay p WHERE p.id=p_id;
 IF FOUND THEN
  IF v.token_address<>'0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'
   OR ROW(v.subject,v.wallet_address,v.amount_atomic,v.authorization_nonce,v.relayer_address)
    IS DISTINCT FROM ROW(p_subject,p_address,p_amount,p_token_nonce,p_relayer) THEN
   RAISE EXCEPTION 'polygon_relay_request_already_used' USING ERRCODE='22023'; END IF;
  -- Concurrent exact retries reuse the original expiry and digest.
  RETURN QUERY SELECT * FROM payments.read_personal_polygon_relay(p_subject,p_id);RETURN;
 END IF;
 IF EXISTS(SELECT 1 FROM payments.personal_transfer_request r WHERE r.id=p_id) THEN
  RAISE EXCEPTION 'polygon_relay_request_already_used' USING ERRCODE='22023'; END IF;
 IF payments.polygon_relay_budget_total(p_subject)+p_max_fee::numeric>p_owner_cap::numeric
  OR payments.polygon_relay_budget_total(NULL)+p_max_fee::numeric>p_global_cap::numeric THEN
  RAISE EXCEPTION 'polygon_relay_budget_exceeded' USING ERRCODE='54000'; END IF;
 v_now:=clock_timestamp();
 IF p_valid_before<=extract(epoch FROM v_now)
  OR p_valid_before>extract(epoch FROM LEAST(v_now+interval '5 minutes',((v_now AT TIME ZONE 'UTC')::date+1)::timestamp AT TIME ZONE 'UTC')) THEN
  RAISE EXCEPTION 'polygon_relay_expired' USING ERRCODE='22023'; END IF;
 v_expiry:=to_timestamp(p_valid_before);
 INSERT INTO payments.personal_polygon_relay(id,subject,wallet_address,amount_atomic,token_address,authorization_nonce,authorization_digest,relayer_address,
  entry_point,domain_separator,implementation_address,max_fee_wei,owner_daily_cap_wei,global_daily_cap_wei,created_at,expires_at)
 VALUES(p_id,p_subject,p_address,p_amount,'0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',p_token_nonce,p_digest,p_relayer,
  '0x0000000071727de22e5e9d8baf0edac6f37da032','0xcaa2ce1a5703ccbe253a34eb3166df60a705c561b44b192061e28f2a985be2ca',
  '0x235ae97b28466db30469b89a9fe4cff0659f82cb',p_max_fee,p_owner_cap,p_global_cap,v_now,v_expiry);
 INSERT INTO payments.personal_polygon_sponsor_reservation(payment_id,subject,max_fee_wei) VALUES(p_id,p_subject,p_max_fee);
 RETURN QUERY SELECT * FROM payments.read_personal_polygon_relay(p_subject,p_id);
END $function$;

CREATE FUNCTION payments.expire_personal_polygon_usdc_authorization(p_subject text,p_id uuid,p_block text,p_block_hash text,p_timestamp bigint,p_confirmations integer)
RETURNS SETOF payments.personal_polygon_relay_internal LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v payments.personal_polygon_relay%ROWTYPE;
BEGIN
 SELECT * INTO v FROM payments.polygon_relay_lock(p_subject,p_id,false);
 IF v.token_address<>'0x3c499c542cef5e3811e1192ce70d8cc03d5c3359' THEN
  RAISE EXCEPTION 'polygon_relay_invalid_request' USING ERRCODE='22023'; END IF;
 IF v.status='expired' THEN RETURN QUERY SELECT * FROM payments.read_personal_polygon_relay(p_subject,p_id);RETURN; END IF;
 IF v.status<>'authorized' OR v.attempt_id IS NOT NULL OR v.user_operation_hash IS NOT NULL
  OR p_timestamp IS NULL OR p_timestamp<extract(epoch FROM v.expires_at) OR p_timestamp>extract(epoch FROM clock_timestamp()) THEN
  RAISE EXCEPTION 'polygon_relay_operation_locked' USING ERRCODE='22023'; END IF;
 IF p_block IS NULL OR p_block !~ '^[1-9][0-9]{0,19}$' OR p_block_hash IS NULL OR p_block_hash !~ '^0x[0-9a-f]{64}$'
  OR p_confirmations IS NULL OR p_confirmations<12 THEN
  RAISE EXCEPTION 'polygon_relay_invalid_proof' USING ERRCODE='22023'; END IF;
 IF p_block::numeric>18446744073709551615 THEN RAISE EXCEPTION 'polygon_relay_invalid_proof' USING ERRCODE='22023'; END IF;
 -- The service only calls this after receiving a canonical timestamp and an
 -- unused ERC-3009 authorization at that exact finalized-enough block.
 INSERT INTO payments.personal_polygon_authorization_retirement(payment_id,observed_native_nonce,block_number,block_hash,confirmations)
 VALUES(p_id,v.authorization_nonce,p_block,p_block_hash,p_confirmations);
 UPDATE payments.personal_polygon_sponsor_reservation SET state='released',closed_at=clock_timestamp()
  WHERE payment_id=p_id AND state='held' AND attempt_id IS NULL;
 UPDATE payments.personal_polygon_relay SET status='expired',failure_reason='preparation_expired',
  observed_native_nonce=v.authorization_nonce,authorization_invalidated_at=clock_timestamp() WHERE id=p_id;
 RETURN QUERY SELECT * FROM payments.read_personal_polygon_relay(p_subject,p_id);
END $function$;

-- Preserve the previous reader's USDT-only response through a Worker rollback.
CREATE OR REPLACE FUNCTION payments.read_personal_polygon_relay_history(p_subject text)
RETURNS SETOF payments.personal_polygon_relay_internal LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_address text;
BEGIN
 SELECT b.address INTO v_address FROM identity.wallet_binding b WHERE b.subject=p_subject;
 PERFORM payments.assert_personal_company_payment_owner(p_subject,v_address);
 RETURN QUERY SELECT p.* FROM payments.personal_polygon_relay_internal p WHERE p.subject=p_subject AND p.wallet_address=v_address
  AND p.token_address='0xc2132d05d31c914a87c6611c10748aeb04b58e8f' ORDER BY p.created_at DESC,p.id DESC LIMIT 20;
END $function$;

CREATE FUNCTION payments.read_personal_polygon_relay_history_v2(p_subject text)
RETURNS SETOF payments.personal_polygon_relay_internal LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_address text;
BEGIN
 SELECT b.address INTO v_address FROM identity.wallet_binding b WHERE b.subject=p_subject;
 PERFORM payments.assert_personal_company_payment_owner(p_subject,v_address);
 RETURN QUERY SELECT p.* FROM payments.personal_polygon_relay_internal p WHERE p.subject=p_subject AND p.wallet_address=v_address
  ORDER BY p.created_at DESC,p.id DESC LIMIT 20;
END $function$;

DO $private_acl$
DECLARE v_owner name;v_function text;v_role text;
BEGIN
 SELECT pg_catalog.pg_get_userbyid(proowner) INTO v_owner FROM pg_catalog.pg_proc
 WHERE oid='payments.prepare_personal_polygon_relay(text,text,text,uuid,text,text,text,text,text,text,text,text,text)'::regprocedure;
 FOREACH v_function IN ARRAY ARRAY[
  'payments.prepare_personal_polygon_usdc_relay(text,text,text,uuid,text,text,text,bigint,text,text,text)',
  'payments.expire_personal_polygon_usdc_authorization(text,uuid,text,text,bigint,integer)',
  'payments.read_personal_polygon_relay_history_v2(text)'
 ] LOOP
  EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO %I',v_function,v_owner);
  FOR v_role IN SELECT DISTINCT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END
   FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
   WHERE p.oid=v_function::regprocedure AND a.grantee<>p.proowner LOOP
   EXECUTE 'REVOKE ALL ON FUNCTION '||v_function||' FROM '||v_role;
  END LOOP;
  EXECUTE 'GRANT EXECUTE ON FUNCTION '||v_function||' TO mindbliss_auth_core_v1';
  IF NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1',v_function,'EXECUTE') OR EXISTS(
   SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
   WHERE p.oid=v_function::regprocedure AND a.grantee<>p.proowner AND a.grantee<>'mindbliss_auth_core_v1'::regrole) THEN
   RAISE EXCEPTION 'polygon_usdc_private_isolation_failed'; END IF;
 END LOOP;
END $private_acl$;
COMMIT;
