-- Allow native USDC on Polygon for the verified Onramp Money COP rails.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallet-meld-production-funding-v1',0));

ALTER TABLE payments.wallet_meld_production_attempt
  DROP CONSTRAINT wallet_meld_production_attempt_destination_currency_check,
  ADD CONSTRAINT wallet_meld_production_attempt_destination_currency_check CHECK (
    destination_currency='USDT_POLYGON' OR (
      destination_currency='USDC_POLYGON' AND service_provider='ONRAMPMONEY' AND (
        (country_code='US' AND source_currency='USD' AND payment_method IN('ACH','LOCAL_BANK_TRANSFER'))
        OR (country_code='MX' AND source_currency='MXN' AND payment_method='SPEI')
        OR (country_code='CO' AND source_currency='COP' AND payment_method IN('PSE','LOCAL_BANK_TRANSFER'))
      )
    )
  );
COMMIT;
