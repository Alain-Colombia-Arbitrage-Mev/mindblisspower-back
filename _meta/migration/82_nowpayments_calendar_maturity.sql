-- Operator-reviewed NOW-only maturity invariant. Never run at app startup.
-- No recalculation, financial row update, principal credit or external payout.
-- Deploy together with the matching NOW engine; old inserts fail closed.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('nowpayments-scoped-engine-v1',0));

ALTER TABLE payments.nowpayments_engine_obligation
 ADD CONSTRAINT nowpayments_commission_calendar_month_v1
 CHECK(kind='roi' OR available_at =
   (((created_at AT TIME ZONE 'America/Bogota') + interval '1 month')
     AT TIME ZONE 'America/Bogota'));

-- Owner-filtered aggregation and recent detail; no global ledger rewrite.
CREATE INDEX nowpayments_engine_obligation_member_created_idx
 ON payments.nowpayments_engine_obligation(affiliate_id,created_at DESC,id DESC);
COMMIT;
