-- Count confirmed per-attempt gas costs instead of permanently consuming the
-- worst-case reservation for each completed Polygon operation. Held or unknown
-- reservations remain fully charged. Caps, signatures and history are unchanged.
BEGIN;
SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('polygon-relay-budget:137:POL_WEI',0));
DO $preflight$
BEGIN
 IF pg_catalog.current_database()<>'mindbliss_curated_20261025' OR pg_catalog.pg_is_in_recovery()
  OR pg_catalog.to_regclass('payments.personal_polygon_sponsor_reservation') IS NULL
  OR pg_catalog.to_regclass('payments.personal_polygon_relay_outcome') IS NULL
  OR pg_catalog.to_regprocedure('payments.polygon_relay_budget_total(text)') IS NULL
  OR pg_catalog.to_regprocedure('payments.create_reown_funding_intent_v4(text,text,text,numeric,uuid,text,text)') IS NULL THEN
  RAISE EXCEPTION 'polygon_relay_actual_budget_prerequisites_required'; END IF;
 IF pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.polygon_relay_budget_total(text)'::regprocedure))<>'28fa5a89dfd45ab778fcfe398fbcc9f1'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.confirm_personal_polygon_relay(text,uuid,uuid,text,text,text,text,integer,text)'::regprocedure))<>'d2f96326e693eff26c8c81a304c861ae'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.reject_personal_polygon_relay(text,uuid,uuid,text,text,text,text,integer,text,text,text)'::regprocedure))<>'4f1f4caba8c7a172c57bc7eb0a35c208'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.guard_polygon_relay_append_only()'::regprocedure))<>'9594f6559cbbaf0793d62a0e1bf41590' THEN
  RAISE EXCEPTION 'polygon_relay_actual_budget_requires_fresh_review'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid='payments.polygon_relay_budget_total(text)'::regprocedure
    AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog']::text[] AND pg_catalog.pg_has_role(proowner,'USAGE'))
  OR pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.polygon_relay_budget_total(text)','EXECUTE')
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid IN('payments.personal_polygon_sponsor_reservation'::regclass,
    'payments.personal_polygon_relay_outcome'::regclass) AND (NOT relrowsecurity OR NOT pg_catalog.pg_has_role(relowner,'USAGE')))
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.personal_polygon_sponsor_reservation','SELECT,INSERT,UPDATE,DELETE')
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.personal_polygon_relay_outcome','SELECT,INSERT,UPDATE,DELETE') THEN
  RAISE EXCEPTION 'polygon_relay_actual_budget_runtime_isolation_required'; END IF;
END $preflight$;

-- An authorization may have multiple attempts, including a reverted attempt
-- followed by success. Its mutable current payment row is not a gas ledger.
-- Only the immutable outcome for this exact reservation's attempt is usable.
CREATE OR REPLACE FUNCTION payments.polygon_relay_budget_total(p_subject text) RETURNS numeric
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT coalesce(sum(CASE
  WHEN r.state='spent' AND o.confirmations>=12 AND o.result IN('confirmed','failed')
   AND CASE WHEN o.actual_gas_cost_wei ~ '^[1-9][0-9]{0,18}$'
    THEN o.actual_gas_cost_wei::numeric<=r.max_fee_wei::numeric ELSE false END
  THEN o.actual_gas_cost_wei::numeric
  ELSE r.max_fee_wei::numeric END),0)
 FROM payments.personal_polygon_sponsor_reservation r
 JOIN payments.personal_polygon_relay p ON p.id=r.payment_id
 LEFT JOIN payments.personal_polygon_relay_outcome o ON o.attempt_id=r.attempt_id AND o.payment_id=r.payment_id
 WHERE (p_subject IS NULL OR r.subject=p_subject) AND r.unit='POL_WEI' AND
  ((r.state='held' AND (p.status<>'prepared' OR p.expires_at>clock_timestamp()))
   OR (r.state='spent' AND (r.closed_at AT TIME ZONE 'UTC')::date=(clock_timestamp() AT TIME ZONE 'UTC')::date));
$function$;

DO $verify$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid='payments.polygon_relay_budget_total(text)'::regprocedure
    AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog']::text[])
  OR pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.polygon_relay_budget_total(text)','EXECUTE')
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
   WHERE p.oid='payments.polygon_relay_budget_total(text)'::regprocedure AND a.grantee<>p.proowner) THEN
  RAISE EXCEPTION 'polygon_relay_actual_budget_runtime_isolation_failed'; END IF;
END $verify$;
COMMIT;
