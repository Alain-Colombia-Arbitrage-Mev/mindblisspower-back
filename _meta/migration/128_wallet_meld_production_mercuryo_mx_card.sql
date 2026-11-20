-- Allow Mercuryo card top-ups in Mexico to native USDC on Polygon.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallet-meld-production-funding-v1',0));

ALTER TABLE payments.wallet_meld_production_attempt
  DROP CONSTRAINT wallet_meld_production_attempt_service_provider_check,
  ADD CONSTRAINT wallet_meld_production_attempt_service_provider_check
    CHECK(service_provider~'^[A-Z0-9_]{2,64}$' AND service_provider NOT IN('BINANCECONNECT','BINANCE_CONNECT')),
  DROP CONSTRAINT wallet_meld_production_attempt_destination_currency_check,
  ADD CONSTRAINT wallet_meld_production_attempt_destination_currency_check CHECK (
    (destination_currency='USDT_POLYGON' AND service_provider NOT IN('RAMPNOW','MERCURYO')) OR (
      destination_currency='USDC_POLYGON' AND service_provider='ONRAMPMONEY' AND (
        (country_code='US' AND source_currency='USD' AND payment_method IN('ACH','LOCAL_BANK_TRANSFER'))
        OR (country_code='MX' AND source_currency='MXN' AND payment_method='SPEI')
        OR (country_code='CO' AND source_currency='COP' AND payment_method IN('PSE','LOCAL_BANK_TRANSFER'))
      )
    ) OR (
      destination_currency='USDC_ARBITRUM' AND country_code='MX' AND source_currency='EUR'
      AND service_provider='ALCHEMYPAY' AND payment_method='CREDIT_DEBIT_CARD'
    ) OR (
      destination_currency IN('USDC_POLYGON','USDC_ARBITRUM','USDC') AND country_code='US' AND source_currency='USD'
      AND service_provider='RAMPNOW' AND payment_method IN('CREDIT_DEBIT_CARD','APPLE_PAY','GOOGLE_PAY','ACH','LOCAL_BANK_TRANSFER')
    ) OR (
      destination_currency='USDC_POLYGON' AND country_code='MX' AND source_currency IN('MXN','USD')
      AND service_provider='MERCURYO' AND payment_method='CREDIT_DEBIT_CARD'
    )
  );

CREATE OR REPLACE FUNCTION payments.create_wallet_meld_production_attempt(p_subject text,p_session text,p_id uuid,p_country text,p_amount numeric,p_currency text,p_method text,p_provider text,p_account text,p_asset text)
RETURNS TABLE(id uuid,address text,customer_reference uuid,created boolean,status text,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
DECLARE b record;r payments.wallet_meld_production_attempt%ROWTYPE;v_now timestamptz;v_chain_id integer;
BEGIN
 PERFORM identity.require_administrative_native_session(p_subject,p_session);
 IF p_id IS NULL OR p_country IS NULL OR p_country!~'^[A-Z]{2}$' OR p_currency IS NULL OR p_currency!~'^[A-Z]{3}$'
  OR p_amount IS NULL OR p_amount::text IN('NaN','Infinity','-Infinity') OR p_amount<>round(p_amount,2)
  OR NOT((p_currency='USD' AND p_amount BETWEEN 50 AND 25000) OR(p_currency<>'USD' AND p_amount BETWEEN 0.01 AND 1000000000))
  OR p_method IS NULL OR p_method!~'^[A-Z0-9_]{2,64}$' OR p_provider IS NULL OR p_provider!~'^[A-Z0-9_]{2,64}$'
  OR p_provider IN('BINANCECONNECT','BINANCE_CONNECT') OR p_asset IS NULL OR p_asset NOT IN('USDT_POLYGON','USDC_POLYGON','USDC_ARBITRUM','USDC')
  OR p_account IS NULL OR p_account!~'^[A-Za-z0-9_.:-]{1,128}$' OR p_account IN('.','..') THEN
  RAISE EXCEPTION 'wallet_production_invalid_request' USING ERRCODE='22023'; END IF;
 v_chain_id:=CASE p_asset
  WHEN 'USDC' THEN 1
  WHEN 'USDC_ARBITRUM' THEN 42161
  ELSE 137
 END;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallet-meld-production-owner:'||p_subject,0));
 SELECT * INTO b FROM identity.read_wallet_meld_production_binding(p_subject,p_session);
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallet-meld-production-attempt-id:'||p_id::text,0));
 SELECT * INTO r FROM payments.wallet_meld_production_attempt a WHERE a.id=p_id;
 IF FOUND THEN
  IF r.subject<>p_subject OR r.native_session_id<>p_session OR r.wallet_address<>b.address OR r.customer_reference<>b.binding_reference
   OR r.country_code<>p_country OR r.requested_amount<>p_amount OR r.source_currency<>p_currency OR r.payment_method<>p_method
   OR r.service_provider<>p_provider OR r.account_id<>p_account OR r.destination_currency<>p_asset OR r.chain_id<>v_chain_id THEN
   RAISE EXCEPTION 'wallet_production_request_already_used' USING ERRCODE='23505'; END IF;
  RETURN QUERY SELECT r.id,r.wallet_address,r.customer_reference,false,r.status,r.created_at; RETURN;
 END IF;
 v_now:=clock_timestamp();
 IF(SELECT count(*) FROM payments.wallet_meld_production_attempt a WHERE a.subject=p_subject AND a.created_at>v_now-interval '10 minutes')>=10 THEN
  RAISE EXCEPTION 'wallet_production_rate_limited' USING ERRCODE='54000'; END IF;
 RETURN QUERY INSERT INTO payments.wallet_meld_production_attempt(id,subject,native_session_id,wallet_address,customer_reference,
  country_code,source_currency,requested_amount,payment_method,service_provider,account_id,destination_currency,chain_id,created_at,updated_at)
 VALUES(p_id,p_subject,p_session,b.address,b.binding_reference,p_country,p_currency,p_amount,p_method,p_provider,p_account,p_asset,v_chain_id,v_now,v_now)
 RETURNING wallet_meld_production_attempt.id,wallet_meld_production_attempt.wallet_address,wallet_meld_production_attempt.customer_reference,
  true,wallet_meld_production_attempt.status,wallet_meld_production_attempt.created_at;
END $function$;

COMMIT;
