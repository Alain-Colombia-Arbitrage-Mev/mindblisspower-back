-- PREPARED ONLY. Apply separately after schema review; never at app startup.
-- New NOWPayments orders charge the catalogue price, with the merchant's 1%
-- pricing-policy cost included. This is NOT the provider's actual settlement
-- fee, a commission award, financial readiness approval or membership delivery.
-- Legacy orders and their original totals remain completely unchanged.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SELECT pg_advisory_xact_lock(hashtextextended('nowpayments-included-pricing-v1', 0));

ALTER TABLE payments.nowpayments_membership_attempt
  ADD COLUMN pricing_policy text,
  ADD COLUMN provider_cost_usd numeric(16,4),
  ADD COLUMN commission_base_usd numeric(16,4),
  ADD CONSTRAINT nowpayments_membership_pricing_snapshot_check CHECK (
    (pricing_policy IS NULL AND provider_cost_usd IS NULL AND commission_base_usd IS NULL)
    OR (
      pricing_policy IS NOT NULL AND pricing_policy = 'catalog_includes_provider_1pct_v1'
      AND provider_cost_usd IS NOT NULL AND commission_base_usd IS NOT NULL
      AND amount_usd < 1000000000000
      AND fee_usd = 0
      AND total_cents = amount_usd * 100
      AND provider_cost_usd = amount_usd * 0.01
      AND commission_base_usd = amount_usd * 0.99
      AND provider_cost_usd + commission_base_usd = amount_usd
    )
  );

COMMENT ON COLUMN payments.nowpayments_membership_attempt.pricing_policy IS
  'Immutable order pricing version; NULL means legacy price, never repriced/backfilled.';
COMMENT ON COLUMN payments.nowpayments_membership_attempt.provider_cost_usd IS
  'Included merchant pricing-policy cost at 1% of catalogue price, not actual provider settlement evidence.';
COMMENT ON COLUMN payments.nowpayments_membership_attempt.commission_base_usd IS
  'Immutable 99% net calculation basis only; not an earned commission, balance, ROI or payout.';

CREATE FUNCTION payments.protect_nowpayments_pricing_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.pricing_policy IS DISTINCT FROM 'catalog_includes_provider_1pct_v1'
       OR NEW.provider_cost_usd IS NULL OR NEW.commission_base_usd IS NULL THEN
      RAISE EXCEPTION 'nowpayments_pricing_snapshot_required' USING ERRCODE='23514';
    END IF;
  ELSIF ROW(OLD.pricing_policy,OLD.provider_cost_usd,OLD.commission_base_usd)
        IS DISTINCT FROM ROW(NEW.pricing_policy,NEW.provider_cost_usd,NEW.commission_base_usd) THEN
    RAISE EXCEPTION 'nowpayments_pricing_snapshot_is_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER nowpayments_pricing_snapshot_immutable
  BEFORE INSERT OR UPDATE ON payments.nowpayments_membership_attempt
  FOR EACH ROW EXECUTE FUNCTION payments.protect_nowpayments_pricing_snapshot();

-- No data UPDATE/backfill, role grants, flag changes or financial activation.
COMMIT;
