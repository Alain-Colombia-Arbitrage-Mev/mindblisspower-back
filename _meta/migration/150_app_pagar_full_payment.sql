-- A Pagar package requires the complete set of known verified lots.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app-pagar-full-payment-150',0));

DO $preflight$
BEGIN
  IF pg_catalog.current_database()<>'mindbliss_curated_20261025'
    OR pg_catalog.pg_is_in_recovery()
    OR pg_catalog.to_regclass('payments.app_pagar_accounting_receipt') IS NULL
    OR pg_catalog.to_regprocedure('payments.record_app_pagar_accounting_v1(text,uuid,bigint,uuid[])') IS NULL THEN
    RAISE EXCEPTION 'app_pagar_full_payment_requires_review';
  END IF;
END $preflight$;

-- Both callers already hold the owner-scoped app-pagar-source lock. Keep the
-- same cutoff, asset, binding and reserved-lot exclusions as candidate capture.
CREATE FUNCTION payments.read_app_pagar_required_lots_v1(p_subject text,p_payment uuid)
RETURNS TABLE(attempt_id uuid,received_atomic bigint)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT a.id,s.received_atomic
  FROM payments.read_personal_polygon_relay(p_subject,p_payment) r
  JOIN payments.app_meld_funding_attempt a ON a.subject=r.subject AND a.wallet_address=r.wallet_address
  JOIN payments.app_meld_settlement s ON s.attempt_id=a.id
  WHERE a.status='session_created' AND a.chain_id=137 AND s.chain_id=137
    AND a.created_at<=r.created_at AND a.updated_at<=r.created_at
    AND s.gross_usd_minor IS NOT NULL AND s.recorded_at<=r.created_at AND s.provider_settled_at<=r.created_at
    AND (r.status<>'confirmed' OR s.block_number<r.block_number::numeric)
    AND a.destination_currency=CASE r.token_address
      WHEN '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359' THEN 'USDC_POLYGON'
      WHEN '0xc2132d05d31c914a87c6611c10748aeb04b58e8f' THEN 'USDT_POLYGON'
    END
    AND NOT EXISTS(
      SELECT 1 FROM payments.app_pagar_allocation x WHERE x.attempt_id=a.id AND x.payment_id<>r.id
    )
    AND NOT EXISTS(
      SELECT 1 FROM payments.app_pagar_candidate c
      JOIN payments.app_pagar_intent i ON i.payment_id=c.payment_id
      CROSS JOIN LATERAL payments.read_personal_polygon_relay(i.subject,i.payment_id) p
      WHERE c.attempt_id=a.id AND i.payment_id<>r.id AND i.registered_at<=r.created_at
        AND (p.status IN('authorized','broadcasting','ambiguous','submitted','reconciliation_required','confirmed')
          OR (p.status='prepared' AND p.expires_at>r.created_at))
        AND NOT (c.deferred AND p.status='confirmed'
          AND (s.block_number>=p.block_number::numeric OR s.received_atomic>p.amount_atomic::numeric))
    )
$function$;

CREATE FUNCTION payments.require_app_pagar_full_intent_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  IF NEW.amount_atomic < coalesce((
    SELECT sum(q.received_atomic) FROM payments.read_app_pagar_required_lots_v1(NEW.subject,NEW.payment_id) q
  ),0) THEN
    RAISE EXCEPTION 'polygon_relay_full_payment_required' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END $function$;

CREATE FUNCTION payments.require_app_pagar_full_receipt_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  -- Older, partially frozen drafts may reach the chain after the release.
  -- A missing whole lot rolls back this new receipt and its new allocations.
  IF EXISTS(
    SELECT 1 FROM payments.read_app_pagar_required_lots_v1(NEW.subject,NEW.payment_id) q
    WHERE NOT EXISTS(
      SELECT 1 FROM payments.app_pagar_allocation x
      WHERE x.payment_id=NEW.payment_id AND x.attempt_id=q.attempt_id AND x.received_atomic=q.received_atomic
    )
  ) THEN
    RAISE EXCEPTION 'polygon_relay_full_payment_required' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END $function$;

CREATE TRIGGER app_pagar_require_full_intent BEFORE INSERT ON payments.app_pagar_intent
  FOR EACH ROW EXECUTE FUNCTION payments.require_app_pagar_full_intent_v1();
CREATE TRIGGER app_pagar_require_full_receipt BEFORE INSERT ON payments.app_pagar_accounting_receipt
  FOR EACH ROW EXECUTE FUNCTION payments.require_app_pagar_full_receipt_v1();

DO $permissions$
DECLARE v_owner name; v_grantee text; v_signature text;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(relowner) INTO STRICT v_owner
    FROM pg_catalog.pg_class WHERE oid='payments.app_pagar_intent'::regclass;
  FOREACH v_signature IN ARRAY ARRAY['payments.read_app_pagar_required_lots_v1(text,uuid)',
    'payments.require_app_pagar_full_intent_v1()','payments.require_app_pagar_full_receipt_v1()']
  LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO %I',v_signature,v_owner);
    FOR v_grantee IN
      SELECT DISTINCT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END
      FROM pg_catalog.pg_proc p,LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      WHERE p.oid=v_signature::regprocedure AND a.grantee<>p.proowner
    LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION '||v_signature||' FROM '||v_grantee;
    END LOOP;
  END LOOP;
END $permissions$;
COMMIT;
