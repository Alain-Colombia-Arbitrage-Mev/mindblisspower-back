-- Add Apple Pay and Google Pay for the existing US USD RampNow USDC routes.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallet-meld-production-funding-v1',0));

ALTER TABLE payments.wallet_meld_production_attempt
  DROP CONSTRAINT wallet_meld_production_attempt_destination_currency_check,
  ADD CONSTRAINT wallet_meld_production_attempt_destination_currency_check CHECK (
    (destination_currency='USDT_POLYGON' AND service_provider<>'RAMPNOW') OR (
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
      AND service_provider='RAMPNOW' AND payment_method IN('CREDIT_DEBIT_CARD','APPLE_PAY','GOOGLE_PAY')
    )
  );

CREATE OR REPLACE FUNCTION payments.record_wallet_meld_production_proof(p_subject text,p_id uuid,p_proof jsonb,p_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
DECLARE r payments.wallet_meld_production_attempt%ROWTYPE;v_time timestamptz;v_amount numeric;v_old text;
 v_rampnow_us_card boolean;v_delivery_matches boolean;
BEGIN
 -- Only the trusted Native provider reader calls this recorder. A callback,
 -- browser body or this journal alone must never post a financial credit.
 BEGIN PERFORM identity.administrative_wallet_person(p_subject);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'wallet_production_forbidden' USING ERRCODE='28000'; END;
 IF p_id IS NULL OR p_hash IS NULL OR p_hash!~'^[0-9a-f]{64}$' OR p_proof IS NULL OR pg_catalog.jsonb_typeof(p_proof) IS DISTINCT FROM 'object'
  OR pg_catalog.pg_column_size(p_proof)>16384 OR(SELECT count(*) FROM pg_catalog.jsonb_each(p_proof))<>16
  OR NOT(p_proof ?& ARRAY['transactionId','accountId','sessionId','externalSessionId','externalCustomerId','serviceProvider','countryCode','sourceCurrencyCode',
   'sourceAmount','destinationCurrencyCode','walletAddress','chainId','providerStatus','providerUpdatedAt','receivedAmount','paymentMethodType']::text[])
  OR EXISTS(SELECT FROM pg_catalog.jsonb_each(p_proof) x WHERE pg_catalog.jsonb_typeof(x.value) IS DISTINCT FROM 'string'
   OR x.key NOT IN('transactionId','accountId','sessionId','externalSessionId','externalCustomerId','serviceProvider','countryCode','sourceCurrencyCode',
    'sourceAmount','destinationCurrencyCode','walletAddress','chainId','providerStatus','providerUpdatedAt','receivedAmount','paymentMethodType')) THEN
  RAISE EXCEPTION 'wallet_production_proof_invalid' USING ERRCODE='22023'; END IF;
 IF p_proof->>'transactionId'!~'^[A-Za-z0-9_.:-]{1,128}$' OR p_proof->>'transactionId' IN('.','..')
  OR p_proof->>'sourceAmount'!~'^\d{1,10}\.\d{2}$' OR p_proof->>'receivedAmount'!~'^\d{1,12}(\.\d{1,6})?$'
  OR p_proof->>'providerUpdatedAt'!~'^\d{4}-\d{2}-\d{2}T.{1,48}$'
  OR p_proof->>'providerStatus' NOT IN('PENDING_CREATED','PENDING','PROCESSING','AUTHORIZED','ACCEPTED','PARTIALLY_SETTLED','SETTLING','TWO_FA_REQUIRED',
   'TWO_FA_PROVIDED','ERROR','SETTLED','FAILED','DECLINED','CANCELLED','REFUNDED','VOIDED','AUTHORIZATION_EXPIRED') THEN
  RAISE EXCEPTION 'wallet_production_proof_invalid' USING ERRCODE='22023'; END IF;
 BEGIN v_time:=(p_proof->>'providerUpdatedAt')::timestamptz;v_amount:=(p_proof->>'receivedAmount')::numeric;
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'wallet_production_proof_invalid' USING ERRCODE='22023'; END;
 IF NOT pg_catalog.isfinite(v_time) OR v_time>clock_timestamp()+interval '5 minutes' OR v_amount<0 OR v_amount>1000000000000
  OR(p_proof->>'providerStatus'='SETTLED' AND v_amount<=0) THEN RAISE EXCEPTION 'wallet_production_proof_invalid' USING ERRCODE='22023'; END IF;
 SELECT * INTO r FROM payments.wallet_meld_production_attempt a WHERE a.id=p_id AND a.subject=p_subject FOR UPDATE;
 IF NOT FOUND OR r.status<>'session_created' OR p_proof->>'accountId' IS DISTINCT FROM r.account_id
  OR p_proof->>'sessionId' IS DISTINCT FROM r.provider_session_id OR p_proof->>'externalSessionId' IS DISTINCT FROM r.id::text
  OR p_proof->>'externalCustomerId' IS DISTINCT FROM r.customer_reference::text OR p_proof->>'serviceProvider' IS DISTINCT FROM r.service_provider
  OR p_proof->>'paymentMethodType' IS DISTINCT FROM r.payment_method OR p_proof->>'countryCode' IS DISTINCT FROM r.country_code
  OR p_proof->>'sourceCurrencyCode' IS DISTINCT FROM r.source_currency OR(p_proof->>'sourceAmount')::numeric IS DISTINCT FROM r.requested_amount
  OR p_proof->>'walletAddress' IS DISTINCT FROM r.wallet_address THEN
  RAISE EXCEPTION 'wallet_production_proof_context_mismatch' USING ERRCODE='22023'; END IF;
 v_rampnow_us_card:=r.service_provider='RAMPNOW' AND r.country_code='US' AND r.source_currency='USD'
  AND r.payment_method IN('CREDIT_DEBIT_CARD','APPLE_PAY','GOOGLE_PAY') AND r.destination_currency IN('USDC_POLYGON','USDC_ARBITRUM','USDC');
 v_delivery_matches:=CASE
  WHEN v_rampnow_us_card AND (p_proof->>'providerStatus'='SETTLED' OR r.proof->>'providerStatus' IN('SETTLED','REFUNDED')) THEN
   (p_proof->>'destinationCurrencyCode'='USDC_POLYGON' AND p_proof->>'chainId'='137')
   OR (p_proof->>'destinationCurrencyCode'='USDC_ARBITRUM' AND p_proof->>'chainId'='42161')
   OR (p_proof->>'destinationCurrencyCode'='USDC' AND p_proof->>'chainId'='1')
  ELSE p_proof->>'destinationCurrencyCode'=r.destination_currency AND p_proof->>'chainId'=r.chain_id::text
 END;
 IF NOT v_delivery_matches THEN RAISE EXCEPTION 'wallet_production_proof_context_mismatch' USING ERRCODE='22023'; END IF;
 IF v_time<r.created_at-interval '5 minutes' THEN RAISE EXCEPTION 'wallet_production_proof_invalid' USING ERRCODE='22023'; END IF;
 IF r.proof IS NOT NULL THEN
  IF r.transaction_id IS DISTINCT FROM p_proof->>'transactionId' THEN RAISE EXCEPTION 'wallet_production_proof_transaction_conflict' USING ERRCODE='23505'; END IF;
  IF v_time<r.provider_updated_at THEN RETURN r.proof; END IF;
  IF v_time=r.provider_updated_at AND p_proof IS DISTINCT FROM r.proof THEN RAISE EXCEPTION 'wallet_production_proof_version_conflict' USING ERRCODE='23505'; END IF;
  IF p_proof=r.proof THEN RETURN r.proof; END IF;
  v_old:=r.proof->>'providerStatus';
  IF v_rampnow_us_card AND v_old IN('SETTLED','REFUNDED')
   AND (p_proof->>'destinationCurrencyCode' IS DISTINCT FROM r.proof->>'destinationCurrencyCode'
    OR p_proof->>'chainId' IS DISTINCT FROM r.proof->>'chainId') THEN
   RAISE EXCEPTION 'wallet_production_proof_context_mismatch' USING ERRCODE='22023'; END IF;
  IF v_old IN('SETTLED','FAILED','DECLINED','CANCELLED','REFUNDED','VOIDED','AUTHORIZATION_EXPIRED')
   AND p_proof->>'providerStatus' IN('PENDING_CREATED','PENDING','PROCESSING','AUTHORIZED','ACCEPTED','PARTIALLY_SETTLED','SETTLING','TWO_FA_REQUIRED','TWO_FA_PROVIDED','ERROR') THEN RETURN r.proof; END IF;
 END IF;
 UPDATE payments.wallet_meld_production_attempt SET transaction_id=p_proof->>'transactionId',proof=p_proof,proof_hash=p_hash,
  provider_updated_at=v_time,checked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE wallet_meld_production_attempt.id=r.id;
 RETURN p_proof;
END $function$;

COMMIT;
