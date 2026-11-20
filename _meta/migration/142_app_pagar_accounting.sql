-- App Pagar accounting inputs derived only from completed verified allocations.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app-pagar-accounting-142',0));

CREATE TABLE payments.app_pagar_accounting_receipt (
  payment_id uuid PRIMARY KEY REFERENCES payments.app_pagar_intent(payment_id) ON DELETE RESTRICT,
  subject text NOT NULL,
  token_address text NOT NULL CHECK(token_address IN(
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f','0x3c499c542cef5e3811e1192ce70d8cc03d5c3359')),
  user_operation_hash text NOT NULL UNIQUE CHECK(user_operation_hash~'^0x[0-9a-f]{64}$'),
  transaction_hash text NOT NULL CHECK(transaction_hash~'^0x[0-9a-f]{64}$'),
  gross_usd_minor numeric(24,0) NOT NULL CHECK(gross_usd_minor>0),
  treasury_received_atomic numeric(78,0) NOT NULL CHECK(treasury_received_atomic>0),
  allocated_received_atomic numeric(78,0) NOT NULL CHECK(allocated_received_atomic>0 AND allocated_received_atomic<=treasury_received_atomic),
  previous_gross_usd_minor numeric(24,0) NOT NULL CHECK(previous_gross_usd_minor>=0),
  cumulative_gross_usd_minor numeric(24,0) GENERATED ALWAYS AS (previous_gross_usd_minor+gross_usd_minor) STORED,
  pv_delta numeric(24,0) GENERATED ALWAYS AS (
    pg_catalog.div(previous_gross_usd_minor+gross_usd_minor,100::numeric)-pg_catalog.div(previous_gross_usd_minor,100::numeric)
  ) STORED,
  confirmed_at timestamptz NOT NULL CHECK(pg_catalog.isfinite(confirmed_at)),
  posted_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE(subject,previous_gross_usd_minor),
  UNIQUE(subject,cumulative_gross_usd_minor)
);
ALTER TABLE payments.app_pagar_accounting_receipt ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION payments.reject_app_pagar_accounting_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
  RAISE EXCEPTION 'app_pagar_accounting_immutable' USING ERRCODE='23514';
END $function$;
CREATE TRIGGER app_pagar_accounting_immutable BEFORE UPDATE OR DELETE ON payments.app_pagar_accounting_receipt
  FOR EACH ROW EXECUTE FUNCTION payments.reject_app_pagar_accounting_mutation();
CREATE TRIGGER app_pagar_accounting_no_truncate BEFORE TRUNCATE ON payments.app_pagar_accounting_receipt
  FOR EACH STATEMENT EXECUTE FUNCTION payments.reject_app_pagar_accounting_mutation();

-- The verified receipt amount and attributable net are distinct. Excess paid
-- over matched top-ups is retained as unallocated, never counted as principal.
-- This ledger supplies inputs to a future payout worker without applying them.
CREATE FUNCTION payments.post_app_pagar_accounting_v1(p_subject text,p_payment uuid)
RETURNS TABLE(payment_id uuid,gross_usd_minor text,treasury_received_atomic text,allocated_received_atomic text,
  previous_gross_usd_minor text,cumulative_gross_usd_minor text,pv_delta text,confirmed_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
DECLARE
  v_payment payments.personal_polygon_relay_internal%ROWTYPE;
  v_source_count bigint;
  v_matched_count bigint;
  v_gross numeric;
  v_net numeric;
  v_previous numeric;
BEGIN
  IF p_subject IS NULL OR p_subject='' OR p_payment IS NULL THEN RETURN; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app-pagar-accounting-owner:'||p_subject,0));

  IF NOT EXISTS(
    SELECT 1 FROM payments.app_pagar_accounting_receipt r WHERE r.payment_id=p_payment AND r.subject=p_subject
  ) THEN
    SELECT p.* INTO v_payment
    FROM payments.app_pagar_intent i
    JOIN LATERAL payments.read_personal_polygon_relay(i.subject,i.payment_id) p ON p.id=i.payment_id
    WHERE i.payment_id=p_payment AND i.subject=p_subject
      AND (p.subject,p.wallet_address,p.token_address,p.amount_atomic::numeric)
          =(i.subject,i.wallet_address,i.token_address,i.amount_atomic)
      AND p.chain_id=137 AND p.token_decimals=6
      AND p.recipient_address='0x0a600b03ef5f8e7f3e182b83440c6d292033db0e'
      AND p.status='confirmed' AND p.confirmed_at IS NOT NULL
      AND p.confirmations>=12 AND p.user_operation_hash IS NOT NULL AND p.transaction_hash IS NOT NULL;
    IF NOT FOUND THEN RETURN; END IF;

    SELECT pg_catalog.count(*) INTO v_source_count
      FROM payments.app_pagar_candidate c WHERE c.payment_id=p_payment;
    IF v_source_count=0 THEN RETURN; END IF;
    SELECT pg_catalog.count(*),pg_catalog.sum(a.gross_usd_minor),pg_catalog.sum(a.received_atomic)
      INTO v_matched_count,v_gross,v_net
    FROM payments.app_pagar_allocation a JOIN payments.app_pagar_candidate c
      ON c.payment_id=a.payment_id AND c.attempt_id=a.attempt_id
    WHERE a.payment_id=p_payment AND a.confirmed_at=v_payment.confirmed_at;
    IF v_matched_count<>v_source_count OR v_gross<=0 OR v_net<=0 OR v_net>v_payment.amount_atomic::numeric
      OR v_source_count<>(SELECT pg_catalog.count(*) FROM payments.app_pagar_allocation a WHERE a.payment_id=p_payment) THEN
      RETURN;
    END IF;

    SELECT coalesce(pg_catalog.max(r.cumulative_gross_usd_minor),0) INTO v_previous
      FROM payments.app_pagar_accounting_receipt r WHERE r.subject=p_subject;
    INSERT INTO payments.app_pagar_accounting_receipt (
      payment_id,subject,token_address,user_operation_hash,transaction_hash,gross_usd_minor,
      treasury_received_atomic,allocated_received_atomic,previous_gross_usd_minor,confirmed_at
    ) VALUES (
      p_payment,p_subject,v_payment.token_address,v_payment.user_operation_hash,v_payment.transaction_hash,v_gross,
      v_payment.amount_atomic::numeric,v_net,v_previous,v_payment.confirmed_at
    );
  END IF;

  RETURN QUERY SELECT r.payment_id,r.gross_usd_minor::text,r.treasury_received_atomic::text,
    r.allocated_received_atomic::text,r.previous_gross_usd_minor::text,r.cumulative_gross_usd_minor::text,
    r.pv_delta::text,r.confirmed_at
  FROM payments.app_pagar_accounting_receipt r WHERE r.payment_id=p_payment AND r.subject=p_subject;
END $function$;

CREATE FUNCTION payments.record_app_pagar_accounting_v1(
  p_subject text,p_payment uuid,p_finalized_block bigint,p_verified_attempt_ids uuid[]
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
BEGIN
  PERFORM 1 FROM payments.allocate_app_pagar_basis_v1(p_subject,p_payment,p_finalized_block,p_verified_attempt_ids);
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM payments.post_app_pagar_accounting_v1(p_subject,p_payment);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'app_pagar_accounting_proof_conflict' USING ERRCODE='23514';
  END IF;
  RETURN true;
END $function$;

DO $permissions$
DECLARE v_owner name; v_role text; v_signature text;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(c.relowner) INTO STRICT v_owner
    FROM pg_catalog.pg_class c WHERE c.oid='payments.app_pagar_allocation'::regclass;
  EXECUTE pg_catalog.format('ALTER TABLE payments.app_pagar_accounting_receipt OWNER TO %I',v_owner);
  FOR v_role IN
    SELECT DISTINCT CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(acl.grantee)) END
    FROM pg_catalog.pg_class c,LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl
    WHERE c.oid='payments.app_pagar_accounting_receipt'::regclass AND acl.grantee<>c.relowner
  LOOP
    EXECUTE 'REVOKE ALL ON TABLE payments.app_pagar_accounting_receipt FROM '||v_role;
  END LOOP;
  FOREACH v_signature IN ARRAY ARRAY['payments.post_app_pagar_accounting_v1(text,uuid)',
    'payments.record_app_pagar_accounting_v1(text,uuid,bigint,uuid[])','payments.reject_app_pagar_accounting_mutation()']
  LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO %I',v_signature,v_owner);
    FOR v_role IN
      SELECT DISTINCT CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(acl.grantee)) END
      FROM pg_catalog.pg_proc p,LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
      WHERE p.oid=v_signature::regprocedure AND acl.grantee<>p.proowner
    LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION '||v_signature||' FROM '||v_role;
    END LOOP;
  END LOOP;
  REVOKE EXECUTE ON FUNCTION payments.allocate_app_pagar_basis_v1(text,uuid,bigint,uuid[]) FROM mindbliss_auth_core_v1;
  GRANT EXECUTE ON FUNCTION payments.record_app_pagar_accounting_v1(text,uuid,bigint,uuid[]) TO mindbliss_auth_core_v1;
  IF pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.app_pagar_accounting_receipt',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR pg_catalog.has_function_privilege('mindbliss_auth_core_v1',
      'payments.allocate_app_pagar_basis_v1(text,uuid,bigint,uuid[])','EXECUTE')
    OR pg_catalog.has_function_privilege('mindbliss_auth_core_v1',
      'payments.post_app_pagar_accounting_v1(text,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'app_pagar_accounting_permissions_changed';
  END IF;
END $permissions$;
COMMIT;
