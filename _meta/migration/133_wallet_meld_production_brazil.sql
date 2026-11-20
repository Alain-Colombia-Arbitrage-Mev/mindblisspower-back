-- Allow Brazil BRL funding to native USDC on Arbitrum.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallet-meld-production-funding-v1',0));

ALTER TABLE payments.wallet_meld_production_attempt
  DROP CONSTRAINT wallet_meld_production_attempt_destination_currency_check,
  ADD CONSTRAINT wallet_meld_production_attempt_destination_currency_check CHECK (
    (destination_currency='USDT_POLYGON' AND country_code<>'BR' AND service_provider NOT IN('RAMPNOW','MERCURYO')) OR (
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
    ) OR (
      destination_currency='USDC_ARBITRUM' AND country_code='BR' AND source_currency='BRL'
      AND ((service_provider='ALCHEMYPAY' AND payment_method='PIX' AND requested_amount BETWEEN 50 AND 20000)
        OR (service_provider='MERCURYO' AND payment_method='CREDIT_DEBIT_CARD' AND requested_amount BETWEEN 155.65 AND 93387.41))
    )
  );

COMMIT;
