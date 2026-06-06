-- =============================================================================
-- 05_partitioning_rds.sql — REEMPLAZO de 05_timescaledb.sql para AWS RDS
--
-- RDS PostgreSQL NO soporta TimescaleDB (licencia TSL). Este script cubre lo
-- mismo con particionado nativo + pg_partman + pg_cron (ambos soportados en RDS):
--
--   05_timescaledb.sql (Hetzner)        →  este script (RDS)
--   ─────────────────────────────────────────────────────────────────────
--   hypertable wallet_movement          →  PARTITION BY RANGE mensual (pg_partman)
--   hypertable audit.activity_log       →  PARTITION BY RANGE mensual (pg_partman)
--   compresión columnar 90-95%          →  N/A (ledger ~5 GB, irrelevante; ADR-0019)
--   retention policy 5 años             →  partman retention + run_maintenance
--   continuous aggregates (×2)          →  matviews vainilla + REFRESH pg_cron
--   mv_network_growth_daily (vainilla)  →  igual, sin cambios de definición
--
-- tree_event sigue SIN particionar (ADR-0015 — el razonamiento aplica igual).
--
-- Pre-req (ANTES de correr esto):
--   1. RDS PostgreSQL 17 con parameter group custom:
--        shared_preload_libraries = 'pg_cron'      (requiere reboot)
--        cron.database_name       = 'vicionpower'  (pg_cron vive en esta DB)
--   2. schema_mlm.sql ya aplicado, tablas VACÍAS (este script aborta si hay datos
--      — debe correr antes de 01_pgloader, igual que su antecesor).
--   3. Roles app_read / app_write / app_admin ya creados (00-init.sql).
--
-- Run order: schema_mlm.sql → governance → payouts v1.1-v1.3 → ranks →
--            ESTE SCRIPT → migration 01-04.
--
-- Post-migración (después de 03_backfill_events.sql):
--   REFRESH MATERIALIZED VIEW mlm.mv_earnings_monthly;       -- sin CONCURRENTLY
--   REFRESH MATERIALIZED VIEW mlm.mv_network_growth_daily;   -- la 1ª vez es más
--   REFRESH MATERIALIZED VIEW mlm.mv_ledger_volume_daily;    -- rápido así
-- =============================================================================

\timing on
SET search_path = mlm, public;

-- ---------------------------------------------------------------------------
-- 0. Guard: tablas deben estar vacías (recreamos DDL, no migramos filas)
-- ---------------------------------------------------------------------------
DO $$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM mlm.wallet_movement)
       + (SELECT count(*) FROM audit.activity_log) INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION
      'wallet_movement/activity_log tienen % filas. Este script recrea las tablas '
      'como particionadas y debe correr ANTES de 01_pgloader. Abort.', n;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Extensiones
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS partman;
CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman;
CREATE EXTENSION IF NOT EXISTS pg_cron;   -- sólo funciona en cron.database_name

-- ---------------------------------------------------------------------------
-- 2. wallet_movement → particionada por RANGE(posted_at), 1 mes
--    DDL idéntico a schema_mlm.sql §4 + PARTITION BY. La PK (id, posted_at)
--    ya incluía la clave de partición (heredado del diseño hypertable).
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS mlm.v_wallet_balance_truth;   -- dependen de la tabla; se
DROP VIEW IF EXISTS mlm.v_operator_margin;        -- recrean abajo
DROP TABLE mlm.wallet_movement;

CREATE TABLE mlm.wallet_movement (
  id              bigint GENERATED ALWAYS AS IDENTITY,
  legacy_id_movement integer,
  transaction_id  uuid NOT NULL REFERENCES mlm.transaction(id) ON DELETE RESTRICT,
  wallet_id       bigint NOT NULL REFERENCES mlm.wallet(id),
  affiliate_id    bigint NOT NULL REFERENCES mlm.affiliate(id),  -- denorm of wallet.affiliate_id, NOT NULL fixes legacy gap
  concept_id      integer NOT NULL REFERENCES mlm.concept(id),
  vicionario_package_id bigint REFERENCES mlm.affiliate_package(id),
  vicionario_package_origin_id bigint REFERENCES mlm.affiliate_package(id),
  rank_id         smallint REFERENCES mlm.rank(id),
  amount          numeric(20,8) NOT NULL,
  -- amount is signed. concept.factor must match sign(amount):
  --   credit (factor=+1)  → amount > 0
  --   debit  (factor=-1)  → amount < 0
  reference       text,
  posted_at       timestamptz NOT NULL,
  available_at    date,                          -- when funds become withdrawable
  is_frozen       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (id, posted_at),
  CONSTRAINT wallet_movement_date_sane
    CHECK (posted_at BETWEEN '2015-01-01' AND now() + interval '7 days')
) PARTITION BY RANGE (posted_at);

-- Índices = los 4 de schema_mlm.sql + el secundario que agregaba 05_timescaledb.
-- Sobre el parent → se propagan a cada partición automáticamente.
CREATE INDEX wallet_movement_wallet_idx    ON mlm.wallet_movement(wallet_id, posted_at DESC);
CREATE INDEX wallet_movement_affiliate_idx ON mlm.wallet_movement(affiliate_id, posted_at DESC);
CREATE INDEX wallet_movement_concept_idx   ON mlm.wallet_movement(concept_id, posted_at DESC);
CREATE INDEX wallet_movement_txn_idx       ON mlm.wallet_movement(transaction_id);

-- Triggers (no se heredan con el DROP/CREATE; mismos nombres y funciones)
CREATE TRIGGER trg_validate_movement
  BEFORE INSERT OR UPDATE ON mlm.wallet_movement
  FOR EACH ROW EXECUTE FUNCTION mlm.fn_validate_movement();
CREATE TRIGGER trg_wallet_balance
  AFTER INSERT OR DELETE ON mlm.wallet_movement
  FOR EACH ROW EXECUTE FUNCTION mlm.fn_update_wallet_balance();

-- Particiones mensuales desde 2015-01 (histórico legacy) + 3 meses premake.
SELECT partman.create_parent(
  p_parent_table    => 'mlm.wallet_movement',
  p_control         => 'posted_at',
  p_interval        => '1 month',
  p_premake         => 3,
  p_start_partition => '2015-01-01'
);

-- Ledger financiero: NUNCA retention. Sólo asegurar creación continua de
-- particiones futuras y herencia de grants en particiones nuevas.
UPDATE partman.part_config
   SET infinite_time_partitions = true,
       inherit_privileges       = true
 WHERE parent_table = 'mlm.wallet_movement';

-- Re-grants (el DROP los perdió; espejo de schema_mlm.sql §12)
GRANT SELECT ON mlm.wallet_movement TO app_read;
GRANT SELECT, INSERT, UPDATE ON mlm.wallet_movement TO app_write;
GRANT ALL ON mlm.wallet_movement TO app_admin;

-- Vista de reconciliación (idéntica a schema_mlm.sql §11)
CREATE VIEW mlm.v_wallet_balance_truth AS
SELECT w.id AS wallet_id, w.affiliate_id, w.asset_id,
       w.balance AS materialized_balance,
       COALESCE(SUM(wm.amount), 0) AS computed_balance,
       w.balance - COALESCE(SUM(wm.amount), 0) AS drift
  FROM mlm.wallet w
  LEFT JOIN mlm.wallet_movement wm ON wm.wallet_id = w.id
 GROUP BY w.id;
GRANT SELECT ON mlm.v_wallet_balance_truth TO app_read;
GRANT SELECT ON mlm.v_wallet_balance_truth TO app_write;
GRANT ALL    ON mlm.v_wallet_balance_truth TO app_admin;

-- Vista margen operativo (idéntica a schema_payouts.sql §7)
CREATE VIEW mlm.v_operator_margin AS
SELECT
  bp.id AS period_id,
  bp.period_start,
  bp.period_end,
  bp.inflows_total,
  COALESCE(bp.total_paid, 0) AS bonos_pagados,
  COALESCE((SELECT SUM(wm.amount * c.factor)
              FROM mlm.wallet_movement wm JOIN mlm.concept c ON c.id = wm.concept_id
             WHERE c.kind = 'platform_fee'
               AND wm.posted_at BETWEEN bp.period_start AND bp.period_end), 0) AS opex,
  bp.inflows_total - COALESCE(bp.total_paid, 0) AS margen_bruto,
  CASE WHEN bp.inflows_total > 0
       THEN ROUND(100.0 * (bp.inflows_total - COALESCE(bp.total_paid, 0)) / bp.inflows_total, 2)
       ELSE NULL END AS margen_pct,
  bp.theta
FROM mlm.binary_period bp
WHERE bp.status = 'closed';
GRANT SELECT ON mlm.v_operator_margin TO app_read;

-- ---------------------------------------------------------------------------
-- 3. tree_event → DELIBERADAMENTE NO particionada (ADR 0015, sigue vigente)
--    El motor lee por (affiliate_id + período corto); el b-tree existente basta.
--    Si aparecen slow queries (pg_stat_statements), abrir ADR superseder y
--    particionar con partman igual que wallet_movement.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 4. audit.activity_log → particionada + retention 5 años (Habeas Data)
--    PK pasa de (id) a (id, occurred_at) — igual que hacía 05_timescaledb.sql.
-- ---------------------------------------------------------------------------
DROP TABLE audit.activity_log;

CREATE TABLE audit.activity_log (
  id              bigint GENERATED ALWAYS AS IDENTITY,
  actor_user_id   text REFERENCES auth.user(id),
  entity_type     text NOT NULL,
  entity_id       text NOT NULL,
  action          text NOT NULL,
  before_data     jsonb,
  after_data      jsonb,
  ip              inet,
  user_agent      text,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX activity_log_entity_idx ON audit.activity_log(entity_type, entity_id, occurred_at DESC);
CREATE INDEX activity_log_actor_idx  ON audit.activity_log(actor_user_id, occurred_at DESC);

-- Start partition = borde de retención (5 años atrás); todo lo más viejo
-- caería fuera de retention de inmediato, no tiene sentido crear esos chunks.
DO $$
BEGIN
  PERFORM partman.create_parent(
    p_parent_table    => 'audit.activity_log',
    p_control         => 'occurred_at',
    p_interval        => '1 month',
    p_premake         => 3,
    p_start_partition => to_char(date_trunc('month', now() - interval '5 years'), 'YYYY-MM-DD')
  );
END $$;

-- Retention: drop físico de particiones > 5 años (Habeas Data Colombia,
-- ADR-0009). Lo ejecuta run_maintenance_proc() vía pg_cron (sección 6).
UPDATE partman.part_config
   SET retention                = '5 years',
       retention_keep_table     = false,
       infinite_time_partitions = true,
       inherit_privileges       = true
 WHERE parent_table = 'audit.activity_log';

-- Re-grants (espejo de schema_mlm.sql §12)
GRANT SELECT, INSERT ON audit.activity_log TO app_write;
GRANT ALL ON audit.activity_log TO app_admin;

-- ---------------------------------------------------------------------------
-- 5. Matviews de reporting — vainilla (sin continuous aggregates)
--    Se crean WITH DATA sobre tablas vacías: quedan "populated" y los REFRESH
--    CONCURRENTLY de pg_cron funcionan desde el primer minuto.
-- ---------------------------------------------------------------------------

-- 5.1 Earnings mensuales por afiliado (era continuous aggregate)
-- NOTA: el refresh es full-recompute (~31M filas post-migración, segundos a
-- decenas de segundos). Si pesa, bajar frecuencia a cada 6h o agregar por
-- partición. time_bucket('1 month') → date_trunc('month').
CREATE MATERIALIZED VIEW IF NOT EXISTS mlm.mv_earnings_monthly AS
SELECT
  affiliate_id,
  date_trunc('month', posted_at) AS month,
  concept_id,
  count(*) AS n_movements,
  sum(amount) FILTER (WHERE amount > 0) AS total_credit,
  sum(amount) FILTER (WHERE amount < 0) AS total_debit,
  sum(amount) AS net_amount
FROM mlm.wallet_movement
GROUP BY affiliate_id, month, concept_id;

CREATE UNIQUE INDEX IF NOT EXISTS mv_earnings_monthly_uidx
  ON mlm.mv_earnings_monthly(affiliate_id, month, concept_id);

-- 5.2 Network growth diario — idéntica a 05_timescaledb.sql §4.2 (ya era vainilla)
CREATE MATERIALIZED VIEW IF NOT EXISTS mlm.mv_network_growth_daily AS
SELECT
  date_trunc('day', occurred_at) AS day,
  count(*) FILTER (WHERE kind = 'enrollment') AS new_enrollments,
  count(*) FILTER (WHERE kind = 'pv_credit')  AS pv_events,
  count(*) FILTER (WHERE kind = 'binary_payout') AS payouts,
  sum(pv_delta_left + pv_delta_right) AS total_pv_volume
FROM mlm.tree_event
GROUP BY day;

CREATE UNIQUE INDEX IF NOT EXISTS mv_network_growth_daily_day_idx
  ON mlm.mv_network_growth_daily(day);

-- 5.3 Volumen del ledger por día (era continuous aggregate)
CREATE MATERIALIZED VIEW IF NOT EXISTS mlm.mv_ledger_volume_daily AS
SELECT
  date_trunc('day', posted_at) AS day,
  concept_id,
  count(*) AS n,
  sum(amount) AS total,
  sum(abs(amount)) AS gross_volume
FROM mlm.wallet_movement
GROUP BY day, concept_id;

CREATE UNIQUE INDEX IF NOT EXISTS mv_ledger_volume_daily_uidx
  ON mlm.mv_ledger_volume_daily(day, concept_id);

GRANT SELECT ON mlm.mv_earnings_monthly, mlm.mv_network_growth_daily,
                mlm.mv_ledger_volume_daily TO app_read, app_write;

-- ---------------------------------------------------------------------------
-- 6. pg_cron — mantenimiento de particiones + refresh de matviews
--    (reemplaza las policies de Timescale y el pg_cron comentado del original)
-- ---------------------------------------------------------------------------
-- Partman: crea particiones futuras + aplica retention. Diario 03:15 UTC.
SELECT cron.schedule('partman-maintenance', '15 3 * * *',
  $$CALL partman.run_maintenance_proc()$$);

-- Refresh matviews (CONCURRENTLY no bloquea lectores; requiere unique index ✓)
SELECT cron.schedule('mv-earnings-monthly-refresh', '5 * * * *',
  $$REFRESH MATERIALIZED VIEW CONCURRENTLY mlm.mv_earnings_monthly$$);
SELECT cron.schedule('mv-network-growth-refresh', '*/15 * * * *',
  $$REFRESH MATERIALIZED VIEW CONCURRENTLY mlm.mv_network_growth_daily$$);
SELECT cron.schedule('mv-ledger-volume-refresh', '35 * * * *',
  $$REFRESH MATERIALIZED VIEW CONCURRENTLY mlm.mv_ledger_volume_daily$$);

-- ---------------------------------------------------------------------------
-- 7. Verificación
-- ---------------------------------------------------------------------------
\echo '=== Tablas particionadas y nº de particiones ==='
SELECT parent.relnamespace::regnamespace AS schema, parent.relname AS table,
       count(child.oid) AS partitions
  FROM pg_inherits
  JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
  JOIN pg_class child  ON child.oid  = pg_inherits.inhrelid
 GROUP BY 1, 2 ORDER BY 1, 2;

\echo ''
\echo '=== Config pg_partman (retention, premake) ==='
SELECT parent_table, partition_interval, premake, retention,
       infinite_time_partitions
  FROM partman.part_config ORDER BY parent_table;

\echo ''
\echo '=== Jobs pg_cron ==='
SELECT jobname, schedule, command FROM cron.job ORDER BY jobname;

\echo ''
\echo 'RDS partitioning setup complete. Run migration steps 01_pgloader → 04_reconcile.'
