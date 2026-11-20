-- Bounded background reconciliation of production MELD checkouts created in App.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app-meld-reconciliation-140',0));

DO $preflight$
DECLARE v_owner oid;
BEGIN
  IF pg_catalog.current_database()<>'mindbliss_curated_20261025'
    OR pg_catalog.pg_is_in_recovery()
    OR pg_catalog.to_regclass('payments.app_meld_funding_attempt') IS NULL
    OR pg_catalog.to_regclass('payments.app_meld_settlement') IS NULL
    OR pg_catalog.to_regclass('payments.app_meld_reconciliation') IS NOT NULL
    OR pg_catalog.to_regprocedure('payments.save_app_meld_settlement_v1(text,uuid,text,text,integer,bigint,text,timestamptz,bigint,bigint,bigint)') IS NULL THEN
    RAISE EXCEPTION 'app_meld_reconciliation_requires_review';
  END IF;
  SELECT proowner INTO v_owner FROM pg_catalog.pg_proc
    WHERE oid='payments.save_app_meld_settlement_v1(text,uuid,text,text,integer,bigint,text,timestamptz,bigint,bigint,bigint)'::regprocedure;
  IF NOT pg_catalog.pg_has_role(v_owner,'USAGE')
    OR NOT pg_catalog.has_table_privilege(v_owner,'identity.wallet_binding','SELECT')
    OR NOT pg_catalog.has_table_privilege(v_owner,'payments.app_meld_funding_attempt','SELECT')
    OR NOT pg_catalog.has_table_privilege(v_owner,'payments.app_meld_funding_attempt','UPDATE')
    OR pg_catalog.has_function_privilege('mindbliss_auth_core_v1',
      'payments.save_app_meld_settlement_v1(text,uuid,text,text,integer,bigint,text,timestamptz,bigint,bigint,bigint)','EXECUTE')
    OR NOT pg_catalog.has_schema_privilege('mindbliss_auth_core_v1','payments','USAGE') THEN
    RAISE EXCEPTION 'app_meld_reconciliation_requires_scoped_role';
  END IF;
END $preflight$;

CREATE TABLE payments.app_meld_reconciliation(
  attempt_id uuid PRIMARY KEY REFERENCES payments.app_meld_funding_attempt(id) ON DELETE RESTRICT,
  lease_id uuid,
  lease_expires_at timestamptz,
  next_check_at timestamptz NOT NULL,
  last_outcome text CHECK(last_outcome IN('pending','failed','confirmed')),
  CHECK((lease_id IS NULL)=(lease_expires_at IS NULL)),
  CHECK(last_outcome IS DISTINCT FROM 'failed' OR lease_id IS NULL)
);
ALTER TABLE payments.app_meld_reconciliation ENABLE ROW LEVEL SECURITY;

CREATE INDEX app_meld_funding_reconciliation_candidates_idx
  ON payments.app_meld_funding_attempt(created_at,id) WHERE status='session_created';

CREATE FUNCTION payments.claim_app_meld_reconciliation_v1()
RETURNS TABLE(
  lease_id uuid,id uuid,subject text,wallet_address text,customer_reference uuid,
  country_code text,source_currency text,destination_currency text,chain_id integer,requested_amount numeric,
  payment_method text,service_provider text,account_id text,status text,
  provider_session_id text,provider_customer_id text,created_at timestamptz,updated_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
DECLARE v_now timestamptz:=pg_catalog.clock_timestamp();
BEGIN
  RETURN QUERY
    WITH candidates AS MATERIALIZED(
      SELECT a.id
      FROM payments.app_meld_funding_attempt a
      LEFT JOIN payments.app_meld_reconciliation q ON q.attempt_id=a.id
      LEFT JOIN payments.app_meld_settlement s ON s.attempt_id=a.id
      WHERE a.status='session_created' AND a.created_at BETWEEN v_now-interval '30 days' AND v_now
        AND s.gross_usd_minor IS NULL
        AND q.last_outcome IS DISTINCT FROM 'failed'
        AND (q.next_check_at IS NULL OR q.next_check_at<=v_now)
        AND (q.lease_expires_at IS NULL OR q.lease_expires_at<=v_now)
        AND EXISTS(SELECT 1 FROM identity.wallet_binding b WHERE b.subject=a.subject AND b.address=a.wallet_address)
      ORDER BY coalesce(q.next_check_at,a.created_at),a.id
      LIMIT 5 FOR UPDATE OF a SKIP LOCKED
    ), claimed AS (
      INSERT INTO payments.app_meld_reconciliation AS q(attempt_id,lease_id,lease_expires_at,next_check_at)
        SELECT c.id,pg_catalog.gen_random_uuid(),v_now+interval '2 minutes',v_now+interval '5 minutes'
        FROM candidates c
      ON CONFLICT(attempt_id) DO UPDATE SET lease_id=EXCLUDED.lease_id,lease_expires_at=EXCLUDED.lease_expires_at,
        next_check_at=EXCLUDED.next_check_at
        WHERE q.next_check_at<=v_now AND q.last_outcome IS DISTINCT FROM 'failed'
          AND (q.lease_expires_at IS NULL OR q.lease_expires_at<=v_now)
      RETURNING q.attempt_id,q.lease_id
    )
    SELECT c.lease_id,a.id,a.subject,a.wallet_address,a.customer_reference,
      a.country_code,a.source_currency,a.destination_currency,a.chain_id,a.requested_amount,a.payment_method,
      a.service_provider,a.account_id,a.status,a.provider_session_id,a.provider_customer_id,a.created_at,a.updated_at
    FROM claimed c JOIN payments.app_meld_funding_attempt a ON a.id=c.attempt_id
    ORDER BY a.created_at,a.id;
END $function$;

CREATE FUNCTION payments.finish_app_meld_reconciliation_v1(p_attempt uuid,p_lease uuid,p_outcome text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
DECLARE q payments.app_meld_reconciliation%ROWTYPE; v_now timestamptz;
BEGIN
  IF p_attempt IS NULL OR p_lease IS NULL OR p_outcome IS NULL OR p_outcome NOT IN('pending','failed','confirmed') THEN
    RAISE EXCEPTION 'wallet_funding_invalid_request' USING ERRCODE='22023';
  END IF;
  SELECT x.* INTO q FROM payments.app_meld_reconciliation x
    WHERE x.attempt_id=p_attempt AND x.lease_id=p_lease FOR UPDATE;
  v_now:=pg_catalog.clock_timestamp();
  IF NOT FOUND OR q.lease_expires_at<=v_now THEN RETURN false; END IF;
  IF p_outcome='confirmed' AND NOT EXISTS(SELECT 1 FROM payments.app_meld_settlement s WHERE s.attempt_id=p_attempt) THEN
    RAISE EXCEPTION 'wallet_funding_settlement_missing' USING ERRCODE='23514';
  END IF;
  UPDATE payments.app_meld_reconciliation x SET lease_id=NULL,lease_expires_at=NULL,last_outcome=p_outcome,
    next_check_at=greatest(q.next_check_at,v_now+interval '5 minutes')
    WHERE x.attempt_id=p_attempt;
  RETURN true;
END $function$;

CREATE FUNCTION payments.record_app_meld_scheduled_settlement_v1(
  p_reference uuid,p_lease uuid,p_transaction_id text,p_blockchain_hash text,
  p_log_index integer,p_block_number bigint,p_block_hash text,p_provider_settled_at timestamptz,
  p_gross_usd_minor bigint,p_total_fee_usd_minor bigint,p_received_atomic bigint)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
DECLARE v_subject text; v_expires timestamptz;
BEGIN
  SELECT a.subject,q.lease_expires_at INTO v_subject,v_expires
    FROM payments.app_meld_reconciliation q JOIN payments.app_meld_funding_attempt a ON a.id=q.attempt_id
    WHERE q.attempt_id=p_reference AND q.lease_id=p_lease AND a.status='session_created'
    FOR UPDATE OF q;
  IF NOT FOUND OR v_expires<=pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000';
  END IF;
  RETURN payments.save_app_meld_settlement_v1(
    v_subject,p_reference,p_transaction_id,p_blockchain_hash,p_log_index,p_block_number,p_block_hash,
    p_provider_settled_at,p_gross_usd_minor,p_total_fee_usd_minor,p_received_atomic);
END $function$;

DO $permissions$
DECLARE v_owner name; v_role text; v_signature text;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(proowner) INTO v_owner FROM pg_catalog.pg_proc
    WHERE oid='payments.save_app_meld_settlement_v1(text,uuid,text,text,integer,bigint,text,timestamptz,bigint,bigint,bigint)'::regprocedure;
  EXECUTE pg_catalog.format('ALTER TABLE payments.app_meld_reconciliation OWNER TO %I',v_owner);
  FOR v_role IN
    SELECT DISTINCT CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(acl.grantee)) END
    FROM pg_catalog.pg_class c,LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl
    WHERE c.oid='payments.app_meld_reconciliation'::regclass AND acl.grantee<>c.relowner
  LOOP
    EXECUTE 'REVOKE ALL ON TABLE payments.app_meld_reconciliation FROM '||v_role;
  END LOOP;
  FOREACH v_signature IN ARRAY ARRAY[
    'payments.claim_app_meld_reconciliation_v1()',
    'payments.finish_app_meld_reconciliation_v1(uuid,uuid,text)',
    'payments.record_app_meld_scheduled_settlement_v1(uuid,uuid,text,text,integer,bigint,text,timestamptz,bigint,bigint,bigint)'
  ] LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO %I',v_signature,v_owner);
    FOR v_role IN
      SELECT DISTINCT CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(acl.grantee)) END
      FROM pg_catalog.pg_proc p,LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
      WHERE p.oid=v_signature::regprocedure AND acl.grantee<>p.proowner
    LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION '||v_signature||' FROM '||v_role;
    END LOOP;
    EXECUTE 'GRANT EXECUTE ON FUNCTION '||v_signature||' TO mindbliss_auth_core_v1';
  END LOOP;
  IF pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.app_meld_reconciliation',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid='payments.app_meld_reconciliation'::regclass) THEN
    RAISE EXCEPTION 'app_meld_reconciliation_permissions_changed';
  END IF;
END $permissions$;
COMMIT;
