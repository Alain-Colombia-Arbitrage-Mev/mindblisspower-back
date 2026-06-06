-- =============================================================================
-- 05_timescaledb.sql — instala TimescaleDB y convierte tablas en hypertables
--
-- Pre-req:
--   1. Postgres 17 con timescaledb en shared_preload_libraries
--      (ver _meta/devops/postgres/postgresql.conf.tuned después de este patch)
--   2. schema_mlm.sql ya aplicado (tablas existen pero vacías o pequeñas)
--   3. Si la tabla tiene datos, create_hypertable copia rows — más lento pero seguro
--
-- Run order: schema_mlm.sql → 05_timescaledb.sql → migration steps 01-04
--
-- Después de este script:
--   - wallet_movement, tree_event, audit.activity_log son hypertables
--   - Compresión columnar activa para chunks > 30 días
--   - Retention de audit.activity_log a 5 años (Habeas Data Colombia)
--   - Continuous aggregates para reportes mensuales
-- =============================================================================

\timing on
SET search_path = mlm, public;

CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- ---------------------------------------------------------------------------
-- 1. wallet_movement → hypertable
--    Chunk interval: 1 mes. Suficiente para retention queries y compresión.
-- ---------------------------------------------------------------------------
SELECT create_hypertable(
  'mlm.wallet_movement',
  by_range('posted_at', INTERVAL '1 month'),
  if_not_exists => TRUE,
  migrate_data  => TRUE       -- copia filas existentes a chunks correctos
);

-- Compresión columnar: chunks cerrados (sin INSERTs nuevos) > 30 días se comprimen.
-- Ahorro típico: 90-95% del storage. Queries siguen funcionando, descomprime
-- automáticamente al leer (transparent decompression).
ALTER TABLE mlm.wallet_movement SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'wallet_id',
  timescaledb.compress_orderby   = 'posted_at DESC, id DESC'
);

SELECT add_compression_policy('mlm.wallet_movement', INTERVAL '30 days');

-- Índices duplicados se mantienen vivos en chunks comprimidos.
-- Para reportes que filtran por affiliate_id, agregamos un índice secundario:
CREATE INDEX IF NOT EXISTS wallet_movement_affiliate_posted_idx
  ON mlm.wallet_movement (affiliate_id, posted_at DESC);

-- ---------------------------------------------------------------------------
-- 2. tree_event → DELIBERADAMENTE NO hypertable (ADR 0015)
-- ---------------------------------------------------------------------------
-- Motivo: el motor lee tree_event por (affiliate_id + período corto). El
-- partitioning temporal de hypertable no acelera esa query — el b-tree por
-- (affiliate_id, occurred_at) ya hace el trabajo. Compresión tampoco aporta
-- a este volumen.
--
-- Si en producción aparecen slow queries sobre tree_event (medir vía
-- pg_stat_statements), abrir ADR superseder y descomentar:
--
--   ALTER TABLE mlm.tree_event DROP CONSTRAINT IF EXISTS tree_event_pkey;
--   ALTER TABLE mlm.tree_event ADD PRIMARY KEY (id, occurred_at);
--   SELECT create_hypertable('mlm.tree_event',
--     by_range('occurred_at', INTERVAL '1 month'),
--     if_not_exists => TRUE, migrate_data => TRUE);
--   ALTER TABLE mlm.tree_event SET (
--     timescaledb.compress,
--     timescaledb.compress_segmentby = 'affiliate_id',
--     timescaledb.compress_orderby   = 'occurred_at DESC, id DESC');
--   SELECT add_compression_policy('mlm.tree_event', INTERVAL '60 days');

-- ---------------------------------------------------------------------------
-- 3. audit.activity_log → hypertable + retention
--    Habeas Data Colombia exige max 5 años post-última-operación; auto-drop.
-- ---------------------------------------------------------------------------
ALTER TABLE audit.activity_log DROP CONSTRAINT IF EXISTS activity_log_pkey;
ALTER TABLE audit.activity_log ADD PRIMARY KEY (id, occurred_at);

SELECT create_hypertable(
  'audit.activity_log',
  by_range('occurred_at', INTERVAL '1 month'),
  if_not_exists => TRUE,
  migrate_data  => TRUE
);

ALTER TABLE audit.activity_log SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'entity_type',
  timescaledb.compress_orderby   = 'occurred_at DESC'
);

SELECT add_compression_policy('audit.activity_log', INTERVAL '90 days');

-- Retention: drop chunks > 5 años. Corre semanal, idempotente.
SELECT add_retention_policy('audit.activity_log', INTERVAL '5 years');

-- ---------------------------------------------------------------------------
-- 4. Continuous aggregates — vistas materializadas con refresh incremental
-- ---------------------------------------------------------------------------

-- 4.1 Earnings mensuales por afiliado
-- Reemplaza el reporte que en el sistema legacy era una query pesada full-scan.
-- Refresh cada hora; el último mes recalcula incremental, los anteriores son frozen.
CREATE MATERIALIZED VIEW IF NOT EXISTS mlm.mv_earnings_monthly
WITH (timescaledb.continuous) AS
SELECT
  affiliate_id,
  time_bucket('1 month', posted_at) AS month,
  concept_id,
  count(*) AS n_movements,
  sum(amount) FILTER (WHERE amount > 0) AS total_credit,
  sum(amount) FILTER (WHERE amount < 0) AS total_debit,
  sum(amount) AS net_amount
FROM mlm.wallet_movement
GROUP BY affiliate_id, month, concept_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('mlm.mv_earnings_monthly',
  start_offset      => INTERVAL '13 months',  -- recalcula últimos 13 meses si hay backfill
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour'
);

-- 4.2 Network growth diario (cuántos enrollments por día)
-- NOTA (ADR 0015): tree_event NO es hypertable, así que esto NO puede ser
-- continuous aggregate de Timescale. Se crea como vista materializada vainilla
-- y se refresca con pg_cron cada 15 min.
CREATE MATERIALIZED VIEW IF NOT EXISTS mlm.mv_network_growth_daily AS
SELECT
  date_trunc('day', occurred_at) AS day,
  count(*) FILTER (WHERE kind = 'enrollment') AS new_enrollments,
  count(*) FILTER (WHERE kind = 'pv_credit')  AS pv_events,
  count(*) FILTER (WHERE kind = 'binary_payout') AS payouts,
  sum(pv_delta_left + pv_delta_right) AS total_pv_volume
FROM mlm.tree_event
GROUP BY day
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS mv_network_growth_daily_day_idx
  ON mlm.mv_network_growth_daily(day);

-- Refresh con pg_cron (instalado en Hetzner via shared_preload_libraries).
-- CONCURRENTLY requiere unique index (creado arriba).
--   SELECT cron.schedule('mv-network-growth-refresh', '*/15 * * * *',
--     $$REFRESH MATERIALIZED VIEW CONCURRENTLY mlm.mv_network_growth_daily;$$);

-- 4.3 Volumen del ledger por día (para dashboard ops)
CREATE MATERIALIZED VIEW IF NOT EXISTS mlm.mv_ledger_volume_daily
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 day', posted_at) AS day,
  concept_id,
  count(*) AS n,
  sum(amount) AS total,
  sum(abs(amount)) AS gross_volume
FROM mlm.wallet_movement
GROUP BY day, concept_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('mlm.mv_ledger_volume_daily',
  start_offset      => INTERVAL '90 days',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour'
);

-- ---------------------------------------------------------------------------
-- 5. Verificación
-- ---------------------------------------------------------------------------
\echo '=== Hypertables creados ==='
SELECT hypertable_schema, hypertable_name, num_chunks, compression_enabled
  FROM timescaledb_information.hypertables
 ORDER BY hypertable_schema, hypertable_name;

\echo ''
\echo '=== Compression policies ==='
SELECT hypertable_schema, hypertable_name, config
  FROM timescaledb_information.jobs
 WHERE proc_name = 'policy_compression'
 ORDER BY hypertable_name;

\echo ''
\echo '=== Continuous aggregates ==='
SELECT view_schema, view_name, materialized_only
  FROM timescaledb_information.continuous_aggregates;

\echo ''
\echo '=== Retention policies ==='
SELECT hypertable_schema, hypertable_name, config
  FROM timescaledb_information.jobs
 WHERE proc_name = 'policy_retention';

\echo ''
\echo 'TimescaleDB setup complete. Run migration steps 01_pgloader → 04_reconcile.'
