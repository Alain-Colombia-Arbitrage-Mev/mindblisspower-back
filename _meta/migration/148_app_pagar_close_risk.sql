-- Trusted periodic MELD observations for the independent App Pagar close.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app-pagar-economy-v1',0));

CREATE TABLE payments.app_pagar_lot_review (
  payment_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  attempted_at timestamptz NOT NULL,
  verified_at timestamptz,
  PRIMARY KEY(payment_id,attempt_id),
  FOREIGN KEY(payment_id) REFERENCES payments.app_pagar_accounting_receipt(payment_id) ON DELETE RESTRICT,
  FOREIGN KEY(attempt_id) REFERENCES payments.app_pagar_allocation(attempt_id) ON DELETE RESTRICT,
  CHECK (verified_at IS NULL OR verified_at<=attempted_at)
);
ALTER TABLE payments.app_pagar_lot_review ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION payments.read_app_pagar_lot_reviews_v1()
RETURNS TABLE(subject text,payment_id uuid,attempt_id uuid,meld_transaction_id text,gross_usd_minor bigint,
  received_atomic bigint,blockchain_tx_hash text,block_number bigint,block_hash text,transfer_log_index integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
  SELECT r.subject,r.payment_id,a.attempt_id,s.meld_transaction_id,a.gross_usd_minor,a.received_atomic,
    s.blockchain_tx_hash,s.block_number,s.block_hash,s.transfer_log_index
  FROM payments.app_pagar_accounting_receipt r
  JOIN payments.app_pagar_allocation a ON a.payment_id=r.payment_id
  JOIN payments.app_meld_settlement s ON s.attempt_id=a.attempt_id
  LEFT JOIN payments.app_pagar_lot_review v ON (v.payment_id,v.attempt_id)=(a.payment_id,a.attempt_id)
  WHERE NOT EXISTS (SELECT 1 FROM payments.app_pagar_economic_hold h WHERE h.payment_id=r.payment_id)
    AND (v.verified_at IS NULL OR v.verified_at<
      (date_trunc('week',statement_timestamp() AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota'))
    AND (v.attempted_at IS NULL OR v.attempted_at<statement_timestamp()-interval '5 minutes')
  ORDER BY v.attempted_at NULLS FIRST,r.posted_at,a.payment_id,a.attempt_id
  LIMIT 8
$function$;

CREATE FUNCTION payments.record_app_pagar_lot_review_v1(p_subject text,p_payment uuid,p_attempt uuid,p_state text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
DECLARE v_now timestamptz:=pg_catalog.clock_timestamp();
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('confirmed','failed','pending') THEN
    RAISE EXCEPTION 'app_pagar_invalid_lot_review' USING ERRCODE='22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app-pagar-economy-v1',0));
  IF NOT EXISTS (
    SELECT 1 FROM payments.app_pagar_accounting_receipt r
    JOIN payments.app_pagar_allocation a ON a.payment_id=r.payment_id
    WHERE r.subject=p_subject AND r.payment_id=p_payment AND a.attempt_id=p_attempt
  ) THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM payments.app_pagar_economic_hold h WHERE h.payment_id=p_payment) THEN RETURN true; END IF;
  IF p_state='failed' THEN
    RETURN payments.hold_app_pagar_economic_receipt_v1(p_subject,p_payment);
  END IF;
  INSERT INTO payments.app_pagar_lot_review(payment_id,attempt_id,attempted_at,verified_at)
    VALUES(p_payment,p_attempt,v_now,CASE WHEN p_state='confirmed' THEN v_now END)
    ON CONFLICT(payment_id,attempt_id) DO UPDATE
    SET attempted_at=excluded.attempted_at,verified_at=excluded.verified_at
    WHERE payments.app_pagar_lot_review.attempted_at<=excluded.attempted_at;
  RETURN true;
END $function$;

CREATE FUNCTION payments.read_app_pagar_review_context_v1(p_subject text,p_attempt uuid)
RETURNS SETOF payments.app_meld_funding_attempt
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
  SELECT f.*
  FROM payments.app_meld_funding_attempt f
  JOIN payments.app_pagar_allocation a ON a.attempt_id=f.id
  JOIN payments.app_pagar_accounting_receipt r ON r.payment_id=a.payment_id
  WHERE f.id=p_attempt AND f.subject=p_subject AND r.subject=p_subject
$function$;

CREATE OR REPLACE FUNCTION payments.app_pagar_close_sources_ready_v1(p_before timestamptz)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT p_before IS NOT NULL AND pg_catalog.isfinite(p_before) AND p_before<=statement_timestamp()
    AND NOT EXISTS (
      SELECT 1 FROM payments.app_pagar_investment i
      WHERE i.activated_at<p_before
        AND NOT EXISTS (SELECT 1 FROM payments.app_pagar_economic_hold h WHERE h.payment_id=i.payment_id)
        AND (
          NOT EXISTS(SELECT 1 FROM payments.app_pagar_allocation a WHERE a.payment_id=i.payment_id)
          OR EXISTS (
            SELECT 1 FROM payments.app_pagar_allocation a LEFT JOIN payments.app_pagar_lot_review v
              ON (v.payment_id,v.attempt_id)=(a.payment_id,a.attempt_id)
            WHERE a.payment_id=i.payment_id AND (v.verified_at IS NULL OR v.verified_at<p_before)
          )
        )
    )
$function$;

CREATE FUNCTION payments.read_app_pagar_benefits_v1(p_subject text,p_native_session text)
RETURNS TABLE(active_gross_usd_minor text,roi_accrued_usd_minor text,own_pv text,bonus_credited_usd_minor text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
DECLARE v_pv text; v_person bigint;
BEGIN
  SELECT p.own_pv INTO v_pv FROM payments.read_app_pagar_points_v1(p_subject,p_native_session) p;
  v_person:=identity.administrative_wallet_person(p_subject);
  RETURN QUERY
    WITH own AS (
      SELECT i.payment_id,i.gross_usd_minor FROM payments.app_pagar_investment i
      WHERE i.subject=p_subject AND i.person_id=v_person
        AND NOT EXISTS(SELECT 1 FROM payments.app_pagar_economic_hold h WHERE h.payment_id=i.payment_id)
    )
    SELECT
      coalesce((SELECT sum(i.gross_usd_minor) FROM own i),0)::text,
      coalesce((SELECT sum(d.accrued_usd_minor) FROM payments.app_pagar_roi_day d JOIN own i USING(payment_id)),0)::text,
      coalesce(v_pv,'0'),
      coalesce((
        SELECT sum(c.credited_usd_minor)
        FROM payments.app_pagar_bonus_credit c JOIN payments.app_pagar_bonus_obligation o USING(kind,reference)
        JOIN mlm.affiliate a ON a.id=o.recipient_affiliate_id
        WHERE a.person_id=v_person
      ),0)::text;
END $function$;

DO $permissions$
DECLARE v_owner name; v_role text; v_signature text;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(c.relowner) INTO STRICT v_owner
    FROM pg_catalog.pg_class c WHERE c.oid='payments.app_pagar_investment'::regclass;
  EXECUTE pg_catalog.format('ALTER TABLE payments.app_pagar_lot_review OWNER TO %I',v_owner);
  FOR v_role IN
    SELECT DISTINCT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END
    FROM pg_catalog.pg_class c,LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
    WHERE c.oid='payments.app_pagar_lot_review'::regclass AND a.grantee<>c.relowner
  LOOP
    EXECUTE 'REVOKE ALL ON TABLE payments.app_pagar_lot_review FROM '||v_role;
  END LOOP;
  FOREACH v_signature IN ARRAY ARRAY['payments.read_app_pagar_lot_reviews_v1()',
    'payments.read_app_pagar_review_context_v1(text,uuid)',
    'payments.record_app_pagar_lot_review_v1(text,uuid,uuid,text)','payments.app_pagar_close_sources_ready_v1(timestamptz)',
    'payments.read_app_pagar_benefits_v1(text,text)']
  LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO %I',v_signature,v_owner);
    FOR v_role IN
      SELECT DISTINCT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END
      FROM pg_catalog.pg_proc p,LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      WHERE p.oid=v_signature::regprocedure AND a.grantee<>p.proowner
    LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION '||v_signature||' FROM '||v_role;
    END LOOP;
  END LOOP;
  GRANT EXECUTE ON FUNCTION payments.read_app_pagar_lot_reviews_v1(),
    payments.read_app_pagar_review_context_v1(text,uuid),
    payments.record_app_pagar_lot_review_v1(text,uuid,uuid,text),
    payments.read_app_pagar_benefits_v1(text,text) TO mindbliss_auth_core_v1;
END $permissions$;
COMMIT;
