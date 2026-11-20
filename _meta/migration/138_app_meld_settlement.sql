-- Durable proofs of finalized deposits from App production MELD checkout attempts.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app-meld-settlement-138',0));

DO $preflight$
DECLARE v_owner oid;
BEGIN
  IF pg_catalog.current_database()<>'mindbliss_curated_20261025'
    OR pg_catalog.pg_is_in_recovery()
    OR pg_catalog.to_regclass('payments.app_meld_funding_attempt') IS NULL
    OR pg_catalog.to_regclass('payments.app_meld_settlement') IS NOT NULL
    OR pg_catalog.to_regprocedure('payments.read_app_meld_funding_v3(text,uuid)') IS NULL
    OR pg_catalog.to_regprocedure('identity.require_administrative_native_session(text,text)') IS NULL THEN
    RAISE EXCEPTION 'app_meld_settlement_requires_review';
  END IF;
  SELECT proowner INTO v_owner FROM pg_catalog.pg_proc
    WHERE oid='identity.require_administrative_native_session(text,text)'::regprocedure;
  IF NOT pg_catalog.pg_has_role(v_owner,'USAGE')
    OR NOT pg_catalog.has_table_privilege(v_owner,'payments.app_meld_funding_attempt','SELECT')
    OR NOT pg_catalog.has_table_privilege(v_owner,'identity.wallet_binding','SELECT')
    OR NOT pg_catalog.has_schema_privilege('mindbliss_auth_core_v1','payments','USAGE') THEN
    RAISE EXCEPTION 'app_meld_settlement_requires_scoped_role';
  END IF;
END $preflight$;

CREATE TABLE payments.app_meld_settlement (
  attempt_id uuid PRIMARY KEY REFERENCES payments.app_meld_funding_attempt(id) ON DELETE RESTRICT,
  account_id text NOT NULL CHECK(account_id~'^[A-Za-z0-9_-]{1,128}$'),
  meld_transaction_id text NOT NULL CHECK(meld_transaction_id~'^[A-Za-z0-9_-]{1,128}$'),
  chain_id integer NOT NULL CHECK(chain_id IN(1,137,42161)),
  blockchain_tx_hash text NOT NULL CHECK(blockchain_tx_hash~'^0x[0-9a-f]{64}$'),
  transfer_log_index integer NOT NULL CHECK(transfer_log_index>=0),
  block_number bigint NOT NULL CHECK(block_number>0),
  block_hash text NOT NULL CHECK(block_hash~'^0x[0-9a-f]{64}$'),
  provider_settled_at timestamptz NOT NULL CHECK(pg_catalog.isfinite(provider_settled_at)),
  gross_usd_minor bigint CHECK(gross_usd_minor BETWEEN 1 AND 100000000000),
  total_fee_usd_minor bigint CHECK(total_fee_usd_minor BETWEEN 0 AND 100000000000),
  received_atomic bigint NOT NULL CHECK(received_atomic BETWEEN 1 AND 1000000000000000),
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE(account_id,meld_transaction_id),
  UNIQUE(chain_id,blockchain_tx_hash,transfer_log_index),
  CHECK(total_fee_usd_minor<=gross_usd_minor)
);
ALTER TABLE payments.app_meld_settlement ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION payments.protect_app_meld_settlement()
RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
  IF TG_OP<>'UPDATE' THEN
    RAISE EXCEPTION 'app_meld_settlement_retained' USING ERRCODE='23514';
  END IF;
  IF (pg_catalog.to_jsonb(NEW)-ARRAY['gross_usd_minor','total_fee_usd_minor'])
      IS DISTINCT FROM (pg_catalog.to_jsonb(OLD)-ARRAY['gross_usd_minor','total_fee_usd_minor'])
    OR (OLD.gross_usd_minor IS NOT NULL AND NEW.gross_usd_minor IS DISTINCT FROM OLD.gross_usd_minor)
    OR (OLD.total_fee_usd_minor IS NOT NULL AND NEW.total_fee_usd_minor IS DISTINCT FROM OLD.total_fee_usd_minor) THEN
    RAISE EXCEPTION 'app_meld_settlement_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $function$;
CREATE TRIGGER app_meld_settlement_immutable
  BEFORE UPDATE OR DELETE ON payments.app_meld_settlement
  FOR EACH ROW EXECUTE FUNCTION payments.protect_app_meld_settlement();

-- Session and scheduled entry points verify their own authority before using
-- the same proof validator and immutable, idempotent write.
CREATE FUNCTION payments.save_app_meld_settlement_v1(
  p_subject text,p_reference uuid,p_transaction_id text,p_blockchain_hash text,
  p_log_index integer,p_block_number bigint,p_block_hash text,p_provider_settled_at timestamptz,
  p_gross_usd_minor bigint,p_total_fee_usd_minor bigint,p_received_atomic bigint)
RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
DECLARE a payments.app_meld_funding_attempt%ROWTYPE; s payments.app_meld_settlement%ROWTYPE;
BEGIN
  IF p_reference IS NULL OR p_transaction_id IS NULL OR p_transaction_id!~'^[A-Za-z0-9_-]{1,128}$'
    OR p_blockchain_hash IS NULL OR p_blockchain_hash!~'^0x[0-9a-f]{64}$'
    OR p_log_index IS NULL OR p_log_index<0 OR p_block_number IS NULL OR p_block_number<1
    OR p_block_hash IS NULL OR p_block_hash!~'^0x[0-9a-f]{64}$'
    OR p_provider_settled_at IS NULL OR NOT pg_catalog.isfinite(p_provider_settled_at)
    OR p_provider_settled_at>pg_catalog.clock_timestamp()+interval '5 minutes'
    OR p_gross_usd_minor NOT BETWEEN 1 AND 100000000000
    OR p_total_fee_usd_minor NOT BETWEEN 0 AND 100000000000
    OR p_total_fee_usd_minor>p_gross_usd_minor
    OR p_received_atomic IS NULL OR p_received_atomic NOT BETWEEN 1 AND 1000000000000000 THEN
    RAISE EXCEPTION 'wallet_funding_invalid_request' USING ERRCODE='22023';
  END IF;

  SELECT x.* INTO a FROM payments.app_meld_funding_attempt x
    WHERE x.id=p_reference AND x.subject=p_subject AND x.status='session_created';
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM identity.wallet_binding b WHERE b.subject=p_subject AND b.address=a.wallet_address
  ) THEN
    RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000';
  END IF;
  IF (a.source_currency='USD' AND p_gross_usd_minor IS DISTINCT FROM (a.requested_amount*100)::bigint)
    OR p_provider_settled_at<a.created_at-interval '5 minutes' THEN
    RAISE EXCEPTION 'wallet_funding_invalid_request' USING ERRCODE='22023';
  END IF;

  INSERT INTO payments.app_meld_settlement (
    attempt_id,account_id,meld_transaction_id,chain_id,blockchain_tx_hash,transfer_log_index,block_number,
    block_hash,provider_settled_at,gross_usd_minor,total_fee_usd_minor,received_atomic
  ) VALUES (
    a.id,a.account_id,p_transaction_id,a.chain_id,p_blockchain_hash,p_log_index,p_block_number,p_block_hash,
    p_provider_settled_at,p_gross_usd_minor,p_total_fee_usd_minor,p_received_atomic
  ) ON CONFLICT DO NOTHING;
  IF FOUND THEN RETURN true; END IF;

  SELECT x.* INTO s FROM payments.app_meld_settlement x WHERE x.attempt_id=a.id FOR UPDATE;
  IF NOT FOUND
    OR (s.account_id,s.meld_transaction_id,s.chain_id,s.blockchain_tx_hash,s.transfer_log_index,s.block_number,s.block_hash,s.received_atomic)
      IS DISTINCT FROM (a.account_id,p_transaction_id,a.chain_id,p_blockchain_hash,p_log_index,p_block_number,p_block_hash,p_received_atomic)
    OR (s.gross_usd_minor IS NOT NULL AND p_gross_usd_minor IS NOT NULL AND s.gross_usd_minor<>p_gross_usd_minor)
    OR (s.total_fee_usd_minor IS NOT NULL AND p_total_fee_usd_minor IS NOT NULL AND s.total_fee_usd_minor<>p_total_fee_usd_minor) THEN
    RAISE EXCEPTION 'wallet_funding_settlement_conflict' USING ERRCODE='23505';
  END IF;

  -- MELD may include a missing FX or fee field on a later read. Keep the
  -- original settlement time and all identity and chain proof values.
  IF (s.gross_usd_minor IS NULL AND p_gross_usd_minor IS NOT NULL)
    OR (s.total_fee_usd_minor IS NULL AND p_total_fee_usd_minor IS NOT NULL) THEN
    UPDATE payments.app_meld_settlement x SET
      gross_usd_minor=coalesce(s.gross_usd_minor,p_gross_usd_minor),
      total_fee_usd_minor=coalesce(s.total_fee_usd_minor,p_total_fee_usd_minor)
      WHERE x.attempt_id=a.id;
  END IF;
  RETURN true;
END $function$;

CREATE FUNCTION payments.record_app_meld_settlement_v1(
  p_subject text,p_native_session text,p_reference uuid,p_transaction_id text,p_blockchain_hash text,
  p_log_index integer,p_block_number bigint,p_block_hash text,p_provider_settled_at timestamptz,
  p_gross_usd_minor bigint,p_total_fee_usd_minor bigint,p_received_atomic bigint)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
BEGIN
  BEGIN PERFORM identity.require_administrative_native_session(p_subject,p_native_session);
  EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000'; END;
  RETURN payments.save_app_meld_settlement_v1(
    p_subject,p_reference,p_transaction_id,p_blockchain_hash,p_log_index,p_block_number,p_block_hash,
    p_provider_settled_at,p_gross_usd_minor,p_total_fee_usd_minor,p_received_atomic);
END $function$;

CREATE FUNCTION payments.read_app_meld_settlement_v1(p_subject text,p_native_session text,p_reference uuid)
RETURNS TABLE(
  attempt_id uuid,wallet_address text,source_currency text,source_amount text,destination_currency text,chain_id integer,
  service_provider text,meld_transaction_id text,blockchain_tx_hash text,transfer_log_index integer,block_number text,
  block_hash text,provider_settled_at timestamptz,gross_usd_minor text,total_fee_usd_minor text,received_atomic text,recorded_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
BEGIN
  BEGIN PERFORM identity.require_administrative_native_session(p_subject,p_native_session);
  EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000'; END;
  RETURN QUERY
    SELECT a.id,a.wallet_address,a.source_currency,a.requested_amount::text,a.destination_currency,s.chain_id,
      a.service_provider,s.meld_transaction_id,s.blockchain_tx_hash,s.transfer_log_index,s.block_number::text,
      s.block_hash,s.provider_settled_at,s.gross_usd_minor::text,s.total_fee_usd_minor::text,s.received_atomic::text,s.recorded_at
    FROM payments.app_meld_funding_attempt a JOIN payments.app_meld_settlement s ON s.attempt_id=a.id
    WHERE a.subject=p_subject AND (p_reference IS NULL OR a.id=p_reference)
    ORDER BY a.created_at DESC,a.id DESC LIMIT 20;
END $function$;

DO $permissions$
DECLARE v_owner name; v_role text; v_signature text;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(proowner) INTO v_owner FROM pg_catalog.pg_proc
    WHERE oid='identity.require_administrative_native_session(text,text)'::regprocedure;
  EXECUTE pg_catalog.format('ALTER TABLE payments.app_meld_settlement OWNER TO %I',v_owner);
  FOR v_role IN
    SELECT DISTINCT CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(acl.grantee)) END
    FROM pg_catalog.pg_class c,LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl
    WHERE c.oid='payments.app_meld_settlement'::regclass AND acl.grantee<>c.relowner
  LOOP
    EXECUTE 'REVOKE ALL ON TABLE payments.app_meld_settlement FROM '||v_role;
  END LOOP;
  FOREACH v_signature IN ARRAY ARRAY[
    'payments.protect_app_meld_settlement()',
    'payments.save_app_meld_settlement_v1(text,uuid,text,text,integer,bigint,text,timestamptz,bigint,bigint,bigint)',
    'payments.record_app_meld_settlement_v1(text,text,uuid,text,text,integer,bigint,text,timestamptz,bigint,bigint,bigint)',
    'payments.read_app_meld_settlement_v1(text,text,uuid)'
  ] LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO %I',v_signature,v_owner);
    FOR v_role IN
      SELECT DISTINCT CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(acl.grantee)) END
      FROM pg_catalog.pg_proc p,LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
      WHERE p.oid=v_signature::regprocedure AND acl.grantee<>p.proowner
    LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION '||v_signature||' FROM '||v_role;
    END LOOP;
    IF v_signature IN(
      'payments.record_app_meld_settlement_v1(text,text,uuid,text,text,integer,bigint,text,timestamptz,bigint,bigint,bigint)',
      'payments.read_app_meld_settlement_v1(text,text,uuid)'
    ) THEN
      EXECUTE 'GRANT EXECUTE ON FUNCTION '||v_signature||' TO mindbliss_auth_core_v1';
    END IF;
  END LOOP;
  IF pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.app_meld_settlement',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid='payments.app_meld_settlement'::regclass) THEN
    RAISE EXCEPTION 'app_meld_settlement_permissions_changed';
  END IF;
END $permissions$;
COMMIT;
