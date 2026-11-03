-- Operator-only catalog activation requested for a real USD50 payment test.
-- No new SKU, pricing, PV, ROI tier, membership, invoice or financial event.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('enable-existing-usd50-package-v1',0));
DO $$
DECLARE selected mlm.package%ROWTYPE;
BEGIN
 SELECT * INTO selected FROM mlm.package WHERE id=3 FOR UPDATE;
 IF NOT FOUND OR selected.name<>'Pack 3' OR selected.amount_usd<>50.00
    OR selected.pv<>50 OR selected.type<>'11001' THEN
  RAISE EXCEPTION 'usd50_existing_catalog_requires_review';
 END IF;
 IF (SELECT count(*) FROM mlm.plan_config WHERE effective_from<=now()
      AND(effective_to IS NULL OR effective_to>now()))<>1
 OR NOT EXISTS(SELECT 1 FROM mlm.plan_config WHERE effective_from<=now()
      AND(effective_to IS NULL OR effective_to>now()) AND cd_lock_days=365)
 OR (SELECT count(*) FROM mlm.cd_roi_tier WHERE active AND min_amount_usd<=50
      AND(max_amount_usd IS NULL OR max_amount_usd>50))<>1
 OR NOT EXISTS(SELECT 1 FROM mlm.cd_roi_tier WHERE active AND min_amount_usd<=50
      AND(max_amount_usd IS NULL OR max_amount_usd>50)
      AND base_annual_rate=0.25 AND qualified_annual_rate=0.30) THEN
  RAISE EXCEPTION 'usd50_existing_compensation_requires_review';
 END IF;
 IF NOT selected.is_active THEN
  UPDATE mlm.package SET is_active=true,updated_at=now() WHERE id=3 AND NOT is_active;
 END IF;
END $$;
COMMIT;
