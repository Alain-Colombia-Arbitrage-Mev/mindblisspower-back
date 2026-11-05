-- PostgreSQL 17 reporting, without Timescale, pg_cron or table replacement.
-- Apply explicitly after schema_mlm.sql. Never run automatically at startup.
-- Existing rows, keys, triggers, affiliate positions and grants are preserved.
-- Materialized views start unpopulated: refresh them explicitly before use.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF current_setting('server_version_num')::integer < 170000 THEN
    RAISE EXCEPTION 'PostgreSQL 17 or later is required';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    RAISE EXCEPTION 'Timescale database detected. Restore/convert into a NEW vanilla PostgreSQL database first; do not drop the extension or reuse PGDATA';
  END IF;
  IF to_regclass('mlm.wallet_movement') IS NULL
     OR to_regclass('mlm.tree_event') IS NULL
     OR to_regclass('audit.activity_log') IS NULL THEN
    RAISE EXCEPTION 'Apply the base Mindbliss schema before PostgreSQL reporting';
  END IF;
END $$;

CREATE MATERIALIZED VIEW IF NOT EXISTS mlm.mv_earnings_monthly AS
SELECT affiliate_id,
       date_trunc('month', posted_at, 'UTC') AS month,
       concept_id,
       count(*) AS n_movements,
       sum(amount) FILTER (WHERE amount > 0) AS total_credit,
       sum(amount) FILTER (WHERE amount < 0) AS total_debit,
       sum(amount) AS net_amount
FROM mlm.wallet_movement
GROUP BY affiliate_id, month, concept_id
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS mv_earnings_monthly_uidx
  ON mlm.mv_earnings_monthly(affiliate_id, month, concept_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS mlm.mv_network_growth_daily AS
SELECT date_trunc('day', occurred_at, 'UTC') AS day,
       count(*) FILTER (WHERE kind = 'enrollment') AS new_enrollments,
       count(*) FILTER (WHERE kind = 'pv_credit') AS pv_events,
       count(*) FILTER (WHERE kind = 'binary_payout') AS payouts,
       sum(pv_delta_left + pv_delta_right) AS total_pv_volume
FROM mlm.tree_event
GROUP BY day
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS mv_network_growth_daily_day_idx
  ON mlm.mv_network_growth_daily(day);

CREATE MATERIALIZED VIEW IF NOT EXISTS mlm.mv_ledger_volume_daily AS
SELECT date_trunc('day', posted_at, 'UTC') AS day,
       concept_id,
       count(*) AS n,
       sum(amount) AS total,
       sum(abs(amount)) AS gross_volume
FROM mlm.wallet_movement
GROUP BY day, concept_id
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS mv_ledger_volume_daily_uidx
  ON mlm.mv_ledger_volume_daily(day, concept_id);

-- Roles are provisioned by the base schema, not by a runtime application.
GRANT SELECT ON mlm.mv_earnings_monthly, mlm.mv_network_growth_daily,
                mlm.mv_ledger_volume_daily TO app_read, app_write;
GRANT MAINTAIN ON mlm.mv_earnings_monthly, mlm.mv_network_growth_daily,
                  mlm.mv_ledger_volume_daily TO app_admin;
COMMIT;
