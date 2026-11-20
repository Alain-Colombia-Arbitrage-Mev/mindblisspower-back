-- Bind an App Pagar prepare to already verified, whole MELD funding lots.
-- These tables retain source evidence and perform no financial posting.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app-pagar-allocation-141',0));

DO $preflight$
BEGIN
  IF pg_catalog.current_database()<>'mindbliss_curated_20261025'
    OR pg_catalog.pg_is_in_recovery()
    OR pg_catalog.to_regclass('payments.app_meld_settlement') IS NULL
    OR pg_catalog.to_regprocedure('payments.read_personal_polygon_relay(text,uuid)') IS NULL
    OR pg_catalog.to_regclass('payments.app_pagar_intent') IS NOT NULL THEN
    RAISE EXCEPTION 'app_pagar_allocation_requires_review';
  END IF;
END $preflight$;

CREATE TABLE payments.app_pagar_intent (
  payment_id uuid PRIMARY KEY REFERENCES payments.personal_polygon_relay(id) ON DELETE RESTRICT,
  subject text NOT NULL REFERENCES auth."user"(id) ON DELETE RESTRICT,
  wallet_address text NOT NULL CHECK(wallet_address~'^0x[0-9a-f]{40}$'),
  token_address text NOT NULL CHECK(token_address IN(
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f','0x3c499c542cef5e3811e1192ce70d8cc03d5c3359')),
  amount_atomic numeric(78,0) NOT NULL CHECK(amount_atomic>0),
  registered_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE INDEX app_pagar_intent_registered_idx ON payments.app_pagar_intent(registered_at,payment_id);

CREATE TABLE payments.app_pagar_candidate (
  payment_id uuid NOT NULL REFERENCES payments.app_pagar_intent(payment_id) ON DELETE RESTRICT,
  attempt_id uuid NOT NULL REFERENCES payments.app_meld_funding_attempt(id) ON DELETE RESTRICT,
  deferred boolean NOT NULL DEFAULT false,
  PRIMARY KEY(payment_id,attempt_id)
);
CREATE INDEX app_pagar_candidate_attempt_idx ON payments.app_pagar_candidate(attempt_id);

CREATE TABLE payments.app_pagar_allocation (
  attempt_id uuid PRIMARY KEY REFERENCES payments.app_meld_settlement(attempt_id) ON DELETE RESTRICT,
  payment_id uuid NOT NULL,
  gross_usd_minor bigint NOT NULL CHECK(gross_usd_minor BETWEEN 1 AND 100000000000),
  received_atomic bigint NOT NULL CHECK(received_atomic BETWEEN 1 AND 1000000000000000),
  confirmed_at timestamptz NOT NULL CHECK(pg_catalog.isfinite(confirmed_at)),
  finalized_block bigint NOT NULL CHECK(finalized_block>0),
  FOREIGN KEY(payment_id,attempt_id) REFERENCES payments.app_pagar_candidate(payment_id,attempt_id) ON DELETE RESTRICT
);
CREATE INDEX app_pagar_allocation_payment_idx ON payments.app_pagar_allocation(payment_id);

CREATE TABLE payments.app_pagar_reconciliation (
  payment_id uuid PRIMARY KEY REFERENCES payments.app_pagar_intent(payment_id) ON DELETE RESTRICT,
  next_check_at timestamptz NOT NULL
);

CREATE FUNCTION payments.protect_app_pagar_evidence_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
  RAISE EXCEPTION 'app_pagar_evidence_retained' USING ERRCODE='23514';
END $function$;

CREATE FUNCTION payments.register_app_pagar_intent_v1(p_subject text,p_payment uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
DECLARE r payments.personal_polygon_relay_internal%ROWTYPE;
BEGIN
  IF p_payment IS NULL OR p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 255
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'app_pagar_invalid_intent' USING ERRCODE='22023';
  END IF;
  SELECT x.* INTO STRICT r FROM payments.read_personal_polygon_relay(p_subject,p_payment) x;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app-pagar-source:'||p_subject,0));
  IF EXISTS(SELECT 1 FROM payments.app_pagar_intent i WHERE i.payment_id=r.id AND i.subject=r.subject) THEN
    RETURN true;
  END IF;
  -- Only a prepared row created in the same transaction can opt in. In
  -- particular, historical transfers and older draft retries keep working.
  IF r.created_at<pg_catalog.transaction_timestamp() OR r.status<>'prepared'
    OR r.expires_at<=pg_catalog.clock_timestamp() OR r.chain_id<>137 OR r.token_decimals<>6
    OR r.recipient_address<>'0x0a600b03ef5f8e7f3e182b83440c6d292033db0e'
    OR r.token_address NOT IN(
      '0xc2132d05d31c914a87c6611c10748aeb04b58e8f','0x3c499c542cef5e3811e1192ce70d8cc03d5c3359') THEN
    RETURN false;
  END IF;

  INSERT INTO payments.app_pagar_intent(payment_id,subject,wallet_address,token_address,amount_atomic)
  VALUES(r.id,r.subject,r.wallet_address,r.token_address,r.amount_atomic::numeric);

  -- Freeze only complete, already committed same-asset Polygon lots covered
  -- by this draft. A payment with more than 20 covered lots is left for
  -- reconciliation; do not silently drop its later lots from the basis.
  WITH available_lots AS NOT MATERIALIZED(
    SELECT a.id AS attempt_id,s.received_atomic,s.block_number,s.transfer_log_index,q.last_outcome,
      (s.gross_usd_minor IS NOT NULL AND s.recorded_at<=r.created_at AND s.provider_settled_at<=r.created_at) AS covered_proof
    FROM payments.app_meld_funding_attempt a
    LEFT JOIN payments.app_meld_settlement s ON s.attempt_id=a.id
    LEFT JOIN payments.app_meld_reconciliation q ON q.attempt_id=a.id
    WHERE a.subject=r.subject AND a.wallet_address=r.wallet_address AND a.status='session_created'
      AND a.chain_id=137 AND (s.chain_id IS NULL OR s.chain_id=137)
      AND a.created_at<=r.created_at AND a.updated_at<=r.created_at
      AND a.destination_currency=CASE WHEN r.token_address='0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'
        THEN 'USDC_POLYGON' ELSE 'USDT_POLYGON' END
      AND NOT EXISTS(SELECT 1 FROM payments.app_pagar_allocation x WHERE x.attempt_id=a.id)
      AND NOT EXISTS(
        SELECT 1 FROM payments.app_pagar_candidate c
        JOIN payments.app_pagar_intent prior ON prior.payment_id=c.payment_id
        CROSS JOIN LATERAL payments.read_personal_polygon_relay(prior.subject,prior.payment_id) p
        WHERE c.attempt_id=a.id
          AND (p.status IN('authorized','broadcasting','ambiguous','submitted','reconciliation_required','confirmed')
            OR (p.status='prepared' AND p.expires_at>r.created_at))
          -- Deferred credits proven too late or too large to cover that prior
          -- payment are not reserved by it for a later independent payment.
          AND NOT (c.deferred AND p.status='confirmed' AND s.attempt_id IS NOT NULL
            AND (s.block_number>=p.block_number::numeric OR s.received_atomic>p.amount_atomic::numeric))
      )
  ), first_lots AS MATERIALIZED(
    SELECT l.* FROM available_lots l WHERE l.covered_proof
    ORDER BY l.block_number,l.transfer_log_index,l.attempt_id LIMIT 21
  ), covered AS MATERIALIZED(
    SELECT q.attempt_id,sum(q.received_atomic) OVER (ORDER BY q.block_number,q.transfer_log_index,q.attempt_id) AS net_total
    FROM first_lots q
  ), eligible AS MATERIALIZED(
    SELECT c.attempt_id FROM covered c WHERE c.net_total<=r.amount_atomic::numeric
  ), deferred AS MATERIALIZED(
    SELECT l.attempt_id FROM available_lots l WHERE NOT l.covered_proof AND l.last_outcome IS DISTINCT FROM 'failed'
    LIMIT 2
  )
  INSERT INTO payments.app_pagar_candidate(payment_id,attempt_id,deferred)
  SELECT r.id,e.attempt_id,false FROM eligible e WHERE (SELECT count(*) FROM eligible)<=20
  UNION ALL
  -- A single earlier authoritative checkout may already have sent funds
  -- even if its proof is only recorded later. Competing unresolved checkouts
  -- and known but insufficient lots must remain unallocated.
  SELECT r.id,d.attempt_id,true FROM deferred d
    WHERE NOT EXISTS(SELECT 1 FROM first_lots) AND (SELECT count(*) FROM deferred)=1;

  RETURN true;
END $function$;

CREATE FUNCTION payments.read_app_pagar_candidates_v1(p_subject text,p_payment uuid)
RETURNS TABLE(attempt_id uuid,meld_transaction_id text,gross_usd_minor bigint,received_atomic bigint,blockchain_tx_hash text,
  block_number bigint,block_hash text,transfer_log_index integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
  SELECT c.attempt_id,s.meld_transaction_id,s.gross_usd_minor,s.received_atomic,s.blockchain_tx_hash,
    s.block_number,s.block_hash,s.transfer_log_index
    FROM payments.app_pagar_intent i
    JOIN payments.app_pagar_candidate c ON c.payment_id=i.payment_id
    JOIN payments.app_meld_settlement s ON s.attempt_id=c.attempt_id
    JOIN identity.wallet_binding b ON b.subject=i.subject AND b.address=i.wallet_address
    WHERE i.payment_id=p_payment AND i.subject=p_subject AND s.gross_usd_minor IS NOT NULL
    ORDER BY s.block_number,s.transfer_log_index,c.attempt_id
$function$;

CREATE FUNCTION payments.allocate_app_pagar_basis_v1(
  p_subject text,p_payment uuid,p_finalized_block bigint,p_verified_attempt_ids uuid[]
)
RETURNS TABLE(attempt_id uuid,gross_usd_minor bigint,received_atomic bigint,confirmed_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
DECLARE r payments.personal_polygon_relay_internal%ROWTYPE; i payments.app_pagar_intent%ROWTYPE;
  candidates uuid[]; complete_count bigint; covered_atomic numeric;
BEGIN
  IF p_payment IS NULL OR p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 255
    OR p_finalized_block IS NULL OR p_finalized_block<1
    OR p_verified_attempt_ids IS NULL OR cardinality(p_verified_attempt_ids)>20 OR array_ndims(p_verified_attempt_ids)>1
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'app_pagar_invalid_proof' USING ERRCODE='22023';
  END IF;
  SELECT x.* INTO i FROM payments.app_pagar_intent x WHERE x.payment_id=p_payment AND x.subject=p_subject;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app-pagar-source:'||p_subject,0));
  SELECT x.* INTO STRICT r FROM payments.read_personal_polygon_relay(p_subject,p_payment) x;
  IF r.status<>'confirmed' OR r.chain_id<>137 OR r.token_decimals<>6
    OR r.recipient_address<>'0x0a600b03ef5f8e7f3e182b83440c6d292033db0e'
    OR (r.subject,r.wallet_address,r.token_address,r.amount_atomic::numeric)
      IS DISTINCT FROM (i.subject,i.wallet_address,i.token_address,i.amount_atomic)
    OR r.confirmations<12 OR r.confirmed_at IS NULL OR r.confirmed_at<i.registered_at
    OR r.user_operation_hash IS NULL OR r.transaction_hash IS NULL OR r.block_hash IS NULL
    OR r.block_number IS NULL OR r.block_number::numeric>p_finalized_block THEN
    RETURN;
  END IF;
  SELECT array_agg(c.attempt_id ORDER BY c.attempt_id) INTO candidates
    FROM payments.app_pagar_candidate c WHERE c.payment_id=i.payment_id;
  -- Require the freshly reverified entire set. A missing or reversed MELD
  -- lot must not make a partial gross accounting entry.
  IF candidates IS NULL OR candidates IS DISTINCT FROM (
    SELECT array_agg(v.id ORDER BY v.id) FROM unnest(p_verified_attempt_ids) v(id)
  ) THEN RETURN; END IF;
  IF EXISTS(SELECT 1 FROM payments.app_pagar_allocation x
    WHERE x.attempt_id=ANY(candidates) AND x.payment_id<>i.payment_id) THEN RETURN; END IF;

  SELECT count(*),sum(s.received_atomic) INTO complete_count,covered_atomic
    FROM payments.app_meld_settlement s
    JOIN payments.app_meld_funding_attempt a ON a.id=s.attempt_id
    JOIN payments.app_pagar_candidate c ON c.payment_id=i.payment_id AND c.attempt_id=s.attempt_id
    WHERE s.attempt_id=ANY(candidates) AND a.subject=i.subject AND a.wallet_address=i.wallet_address
      AND a.status='session_created' AND a.chain_id=137 AND s.chain_id=137 AND s.block_number<r.block_number::numeric
      AND s.gross_usd_minor IS NOT NULL AND a.created_at<=r.created_at AND a.updated_at<=r.created_at
      AND (c.deferred OR (s.recorded_at<=r.created_at AND s.provider_settled_at<=r.created_at))
      AND a.destination_currency=CASE WHEN i.token_address='0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'
        THEN 'USDC_POLYGON' ELSE 'USDT_POLYGON' END;
  IF complete_count<>cardinality(candidates) OR covered_atomic IS NULL OR covered_atomic>i.amount_atomic THEN
    RETURN;
  END IF;

  INSERT INTO payments.app_pagar_allocation AS x(
    attempt_id,payment_id,gross_usd_minor,received_atomic,confirmed_at,finalized_block
  ) SELECT s.attempt_id,i.payment_id,s.gross_usd_minor,s.received_atomic,r.confirmed_at,p_finalized_block
    FROM payments.app_meld_settlement s WHERE s.attempt_id=ANY(candidates)
  ON CONFLICT ON CONSTRAINT app_pagar_allocation_pkey DO NOTHING;
  RETURN QUERY
    SELECT x.attempt_id,x.gross_usd_minor,x.received_atomic,x.confirmed_at
    FROM payments.app_pagar_allocation x WHERE x.payment_id=i.payment_id ORDER BY x.attempt_id;
END $function$;

CREATE FUNCTION payments.read_app_pagar_pending_v1()
RETURNS TABLE(subject text,payment_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
DECLARE i payments.app_pagar_intent%ROWTYPE; v_now timestamptz:=pg_catalog.clock_timestamp(); v_returned integer:=0;
BEGIN
  FOR i IN SELECT x.* FROM payments.app_pagar_intent x
    LEFT JOIN payments.app_pagar_reconciliation q ON q.payment_id=x.payment_id
    WHERE x.registered_at BETWEEN v_now-interval '30 days' AND v_now
      AND (q.next_check_at IS NULL OR q.next_check_at<=v_now)
      AND EXISTS(SELECT 1 FROM payments.app_pagar_candidate c
        JOIN payments.app_meld_settlement s ON s.attempt_id=c.attempt_id
        WHERE c.payment_id=x.payment_id AND s.gross_usd_minor IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM payments.app_pagar_allocation a WHERE a.payment_id=x.payment_id)
    ORDER BY coalesce(q.next_check_at,x.registered_at),x.payment_id
    LIMIT 20 FOR UPDATE OF x SKIP LOCKED
  LOOP
    INSERT INTO payments.app_pagar_reconciliation AS q(payment_id,next_check_at)
      VALUES(i.payment_id,v_now+interval '5 minutes')
    ON CONFLICT ON CONSTRAINT app_pagar_reconciliation_pkey DO UPDATE SET next_check_at=excluded.next_check_at
      WHERE q.next_check_at<=v_now;
    IF NOT FOUND THEN CONTINUE; END IF;
    BEGIN
      IF EXISTS(SELECT 1 FROM payments.read_personal_polygon_relay(i.subject,i.payment_id) r
        WHERE r.status='confirmed' OR (r.status IN('broadcasting','submitted','ambiguous') AND r.user_operation_hash IS NOT NULL)) THEN
        subject:=i.subject; payment_id:=i.payment_id; RETURN NEXT;
        v_returned:=v_returned+1;
        EXIT WHEN v_returned>=5;
      END IF;
    EXCEPTION WHEN SQLSTATE '28000' OR SQLSTATE 'P0002' THEN
      CONTINUE;
    END;
  END LOOP;
END $function$;

DO $permissions$
DECLARE v_owner name; v_role text; v_name text; v_signature text;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(p.proowner) INTO STRICT v_owner FROM pg_catalog.pg_proc p
    WHERE p.oid='payments.save_app_meld_settlement_v1(text,uuid,text,text,integer,bigint,text,timestamptz,bigint,bigint,bigint)'::regprocedure;
  EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION payments.read_personal_polygon_relay(text,uuid) TO %I',v_owner);
  FOREACH v_name IN ARRAY ARRAY['app_pagar_intent','app_pagar_candidate','app_pagar_allocation','app_pagar_reconciliation'] LOOP
    EXECUTE pg_catalog.format('ALTER TABLE payments.%I ENABLE ROW LEVEL SECURITY',v_name);
    IF v_name<>'app_pagar_reconciliation' THEN
      EXECUTE pg_catalog.format('CREATE TRIGGER app_pagar_keep_evidence BEFORE UPDATE OR DELETE OR TRUNCATE ON payments.%I FOR EACH STATEMENT EXECUTE FUNCTION payments.protect_app_pagar_evidence_v1()',v_name);
    END IF;
    EXECUTE pg_catalog.format('ALTER TABLE payments.%I OWNER TO %I',v_name,v_owner);
    FOR v_role IN
      SELECT DISTINCT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END
      FROM pg_catalog.pg_class c,LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE c.relnamespace='payments'::regnamespace AND c.relname=v_name AND a.grantee<>c.relowner
    LOOP
      EXECUTE pg_catalog.format('REVOKE ALL ON TABLE payments.%I FROM %s',v_name,v_role);
    END LOOP;
  END LOOP;
  FOREACH v_signature IN ARRAY ARRAY[
    'payments.protect_app_pagar_evidence_v1()',
    'payments.register_app_pagar_intent_v1(text,uuid)',
    'payments.read_app_pagar_candidates_v1(text,uuid)',
    'payments.allocate_app_pagar_basis_v1(text,uuid,bigint,uuid[])',
    'payments.read_app_pagar_pending_v1()'
  ] LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO %I',v_signature,v_owner);
    FOR v_role IN
      SELECT DISTINCT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END
      FROM pg_catalog.pg_proc p,LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      WHERE p.oid=v_signature::regprocedure AND a.grantee<>p.proowner
    LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION '||v_signature||' FROM '||v_role;
    END LOOP;
    IF v_signature<>'payments.protect_app_pagar_evidence_v1()' THEN
      EXECUTE 'GRANT EXECUTE ON FUNCTION '||v_signature||' TO mindbliss_auth_core_v1';
    END IF;
  END LOOP;
END $permissions$;
COMMIT;
