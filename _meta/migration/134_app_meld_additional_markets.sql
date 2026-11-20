-- Add five verified Onramp Money markets to the App journal. The existing
-- approved-market constraint keeps using this same function and all of its
-- previous routes remain valid.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app-meld-funding-134',0));

DO $preflight$
DECLARE v_route regprocedure; v_definition text;
BEGIN
 v_route:=pg_catalog.to_regprocedure('payments.app_meld_funding_route_allowed(text,text,numeric,text,text,text)');
 IF pg_catalog.current_database()<>'mindbliss_curated_20261025'
  OR pg_catalog.pg_is_in_recovery()
  OR pg_catalog.to_regclass('payments.app_meld_funding_attempt') IS NULL
  OR v_route IS NULL THEN
  RAISE EXCEPTION 'app_meld_additional_markets_requires_132'; END IF;

 v_definition:=pg_catalog.pg_get_functiondef(v_route);
 IF v_definition NOT LIKE '%USDC_ARBITRUM%'
  OR v_definition NOT LIKE '%ALCHEMYPAY%'
  OR v_definition NOT LIKE '%PIX%'
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c
   WHERE c.conrelid='payments.app_meld_funding_attempt'::regclass
    AND c.conname='app_meld_funding_approved_market_check' AND c.convalidated
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_depend d
     WHERE d.classid='pg_catalog.pg_constraint'::regclass AND d.objid=c.oid
      AND d.refclassid='pg_catalog.pg_proc'::regclass AND d.refobjid=v_route)) THEN
  RAISE EXCEPTION 'app_meld_additional_markets_requires_132'; END IF;
END $preflight$;

CREATE OR REPLACE FUNCTION payments.app_meld_funding_route_allowed(
 p_country text,p_currency text,p_amount numeric,p_method text,p_provider text,p_asset text)
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $function$
 SELECT coalesce(
  (p_country='MX' AND p_asset='USDT_POLYGON' AND (
   (p_provider='MERCURYO' AND p_method='CREDIT_DEBIT_CARD'
    AND ((p_currency='USD' AND p_amount BETWEEN 30 AND 15000)
     OR (p_currency='MXN' AND p_amount BETWEEN 931 AND 312013.70)))
   OR (p_provider='ONRAMPMONEY' AND p_method='SPEI' AND p_currency='MXN' AND p_amount BETWEEN 931 AND 500000)))
  OR (p_country='US' AND p_currency='USD' AND p_asset='USDC_POLYGON' AND (
   (p_provider='RAMPNOW' AND p_method IN('CREDIT_DEBIT_CARD','APPLE_PAY','GOOGLE_PAY','ACH','LOCAL_BANK_TRANSFER')
    AND p_amount BETWEEN 50 AND 10000)
   OR (p_provider='ONRAMPMONEY' AND p_method IN('ACH','LOCAL_BANK_TRANSFER') AND p_amount BETWEEN 50 AND 15000)))
  OR (p_country='CO' AND p_currency='COP' AND p_asset='USDC_POLYGON' AND p_provider='ONRAMPMONEY'
   AND p_method IN('PSE','LOCAL_BANK_TRANSFER') AND p_amount BETWEEN 170000 AND 4000000)
  OR (p_country='BR' AND p_currency='BRL' AND p_asset='USDC_ARBITRUM' AND (
   (p_provider='ALCHEMYPAY' AND p_method='PIX' AND p_amount BETWEEN 50 AND 20000)
   OR (p_provider='MERCURYO' AND p_method='CREDIT_DEBIT_CARD' AND p_amount BETWEEN 155.65 AND 93387.41)))
  OR (p_asset='USDT_POLYGON' AND p_provider='ONRAMPMONEY' AND (
   (p_country='PE' AND p_currency='PEN' AND p_method='LOCAL_BANK_TRANSFER' AND p_amount BETWEEN 19 AND 4500000)
   OR (p_country='AR' AND p_currency='ARS' AND p_method='LOCAL_BANK_TRANSFER' AND p_amount BETWEEN 25000 AND 6600000)
   OR (p_country='DE' AND p_currency='EUR' AND p_method='SEPA' AND p_amount BETWEEN 10 AND 100000)
   OR (p_country='KE' AND p_currency='KES' AND p_method='MPESA' AND p_amount BETWEEN 1850 AND 700000)
   OR (p_country='VN' AND p_currency='VND' AND p_method='VIETQR' AND p_amount BETWEEN 55000 AND 450000000
      AND p_amount=pg_catalog.trunc(p_amount)))),false);
$function$;

DO $permissions$
BEGIN
 IF pg_catalog.has_function_privilege('mindbliss_auth_core_v1',
   'payments.app_meld_funding_route_allowed(text,text,numeric,text,text,text)','EXECUTE')
  OR NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1',
   'payments.reserve_app_meld_funding(text,text,uuid,text,text,text,numeric,text,text,text,text)','EXECUTE') THEN
  RAISE EXCEPTION 'app_meld_funding_function_permissions_changed'; END IF;
END $permissions$;
COMMIT;
