-- =============================================================================
-- schema_payouts_v1.2.sql — Candados de producción (ADR-0013/0014/0015 motor)
--
-- Agrega a la DB lo que vp-engine ya implementa en el simulador:
--   §1  plan_config — parámetros R1 (recompra), R2 (yield), R3 (puntos),
--       T3 proporcional al paquete (sin rangos), lock 12m, renovación.
--   §2  affiliate — directs_left/right (gate R2) + rank_points_baseline
--       (carrera de rangos, ver schema_ranks.sql).
--   §3  affiliate_payout_state — estado persistente por afiliado del motor
--       (R1 depth thresholds, paused carry, R3 puntos, cadencias R2/R3).
--   §4  concept — conceptos nuevos: r2_yield, r3_points, rank_bonus,
--       renovación (kind=package_purchase para que entre a inflows/θ).
--   §5  v_capital_lock — vista del lock 12 meses sobre capital depositado.
--
-- Run order: schema_mlm.sql → schema_governance.sql → schema_payouts.sql
--            → schema_payouts_v1.1.sql → ESTE ARCHIVO → schema_ranks.sql
--
-- TimescaleDB: ninguna tabla de este patch es hypertable (ADR-0015 _meta:
-- son dimensiones/estado, no series de tiempo). Los pagos R2/R3/rango
-- fluyen por mlm.wallet_movement, que SÍ es hypertable con compresión
-- y continuous aggregates (05_timescaledb.sql) — el reporting los cubre.
-- =============================================================================

SET search_path = mlm, public;

-- ---------------------------------------------------------------------------
-- §0. concept_kind — valores nuevos del enum.
--     ALTER TYPE ... ADD VALUE no puede usarse dentro de la misma transacción
--     que los INSERTs que los usan → van fuera del BEGIN.
-- ---------------------------------------------------------------------------
ALTER TYPE mlm.concept_kind ADD VALUE IF NOT EXISTS 'r2_yield';
ALTER TYPE mlm.concept_kind ADD VALUE IF NOT EXISTS 'r3_points';
ALTER TYPE mlm.concept_kind ADD VALUE IF NOT EXISTS 'rank_bonus';

BEGIN;

-- ---------------------------------------------------------------------------
-- §0b. T4 append-only — hacer cumplir lo que la invariante verifica.
--      Los ALTER DEFAULT PRIVILEGES de schema_mlm §12 regalan UPDATE a
--      app_write sobre TODA tabla nueva del schema, incluyendo las
--      append-only. fn_check_payout_invariants (v1.1) reporta T4=FAIL si
--      alguien ≠ postgres tiene UPDATE/DELETE sobre ellas → revocar.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON mlm.wallet_movement, mlm.binary_block_payment
  FROM app_write, app_admin;

-- ---------------------------------------------------------------------------
-- §1. plan_config — candados ADR-0013 (R1), ADR-0014 (T3 sin rangos),
--     ADR-0015 (R2 yield + lock), ADR-0016 (R3 puntos), ADR-0017 (rangos).
--     Todos con DEFAULT que replica el comportamiento previo (opt-in).
-- ---------------------------------------------------------------------------
ALTER TABLE mlm.plan_config
  -- T3 proporcional al paquete (ADR-0014). 0 = fallback legacy
  -- daily_cap_factor × rank.bonus_amount_usd (ver bonusengine/candidate.go).
  ADD COLUMN period_cap_factor          numeric(8,4) NOT NULL DEFAULT 0
    CHECK (period_cap_factor >= 0),

  -- R1 — recompra obligatoria por profundidad (ADR-0013)
  ADD COLUMN depth_repurchase_enabled   boolean      NOT NULL DEFAULT false,
  ADD COLUMN repurchase_threshold       integer      NOT NULL DEFAULT 10
    CHECK (repurchase_threshold > 0),
  ADD COLUMN purchase_stale_periods     integer      NOT NULL DEFAULT 0
    CHECK (purchase_stale_periods >= 0),          -- 0 = sin requalificación
  ADD COLUMN pause_mode                 text         NOT NULL DEFAULT 'skip'
    CHECK (pause_mode IN ('skip', 'carry', 'reduce')),   -- P-A | P-B | P-C
  ADD COLUMN pause_reduction_factor     numeric(8,4) NOT NULL DEFAULT 0.5
    CHECK (pause_reduction_factor BETWEEN 0 AND 1),
  ADD COLUMN paused_carry_decay_periods integer      NOT NULL DEFAULT 4
    CHECK (paused_carry_decay_periods >= 0),
  ADD COLUMN renewal_cost_factor        numeric(8,4) NOT NULL DEFAULT 0
    CHECK (renewal_cost_factor >= 0),             -- 0.10 = renovación al 10% pkg

  -- R2 — yield 25% anual gateado por 2 directos balanced (ADR-0015)
  ADD COLUMN yield_enabled              boolean      NOT NULL DEFAULT false,
  ADD COLUMN yield_annual_rate          numeric(8,4) NOT NULL DEFAULT 0.25
    CHECK (yield_annual_rate >= 0),
  ADD COLUMN yield_cadence_periods      integer      NOT NULL DEFAULT 4
    CHECK (yield_cadence_periods > 0),

  -- Lock 12 meses sobre el capital depositado (ADR-0015 candado C)
  ADD COLUMN capital_lock_periods       integer      NOT NULL DEFAULT 52
    CHECK (capital_lock_periods >= 0),

  -- R3 — bono de puntos (ADR-0016)
  ADD COLUMN points_enabled             boolean      NOT NULL DEFAULT false,
  ADD COLUMN points_per_block           numeric(8,2) NOT NULL DEFAULT 1
    CHECK (points_per_block >= 0),
  ADD COLUMN points_dollars_per_point   numeric(8,2) NOT NULL DEFAULT 1
    CHECK (points_dollars_per_point >= 0),
  ADD COLUMN points_cadence_periods     integer      NOT NULL DEFAULT 4
    CHECK (points_cadence_periods > 0),

  -- Carrera de rangos (ADR-0017, ver schema_ranks.sql)
  ADD COLUMN ranks_enabled              boolean      NOT NULL DEFAULT false,
  -- Mitigación B (decidida 2026-06-05): el bono de rango se paga en N
  -- cuotas iguales cada `cadence` períodos. Evita la "avalancha de rangos"
  -- (miles de hitos chicos simultáneos hunden θ: 0.48→1.00 con 4 cuotas en
  -- la simulación de lanzamiento). 1 = pago único.
  ADD COLUMN rank_installments          integer      NOT NULL DEFAULT 4
    CHECK (rank_installments >= 1),
  ADD COLUMN rank_installment_cadence   integer      NOT NULL DEFAULT 4
    CHECK (rank_installment_cadence >= 1);

-- ---------------------------------------------------------------------------
-- §1b. T3 proporcional también en el trigger de DB (ADR-0014). El
--      fn_enforce_daily_cap de schema_payouts.sql usaba la regla legacy
--      daily_cap_factor × rank.bonus; ahora manda period_cap_factor ×
--      paquete activo del afiliado (fallback legacy si factor = 0).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mlm.fn_enforce_daily_cap() RETURNS trigger AS $$
DECLARE
  v_paid_today numeric(14,2);
  v_max_today  numeric(14,2);
  v_pcf        numeric(8,4);
  v_factor     numeric(8,4);
  v_pkg        numeric(14,2);
  v_rank_bonus numeric(14,2);
BEGIN
  SELECT bns.paid_today_amount INTO v_paid_today
    FROM mlm.binary_node_state bns
   WHERE bns.affiliate_id = NEW.affiliate_id
     AND bns.binary_period_id = NEW.binary_period_id;

  SELECT pc.period_cap_factor, pc.daily_cap_factor
    INTO v_pcf, v_factor
    FROM mlm.plan_config pc WHERE pc.id = NEW.plan_config_id;

  IF COALESCE(v_pcf, 0) > 0 THEN
    -- ADR-0014: T3 = period_cap_factor × paquete activo del afiliado.
    SELECT p.amount_usd INTO v_pkg
      FROM mlm.affiliate_package ap
      JOIN mlm.package p ON p.id = ap.package_id
     WHERE ap.affiliate_id = NEW.affiliate_id AND ap.status = 'active'
     ORDER BY ap.id LIMIT 1;
    v_max_today := v_pcf * COALESCE(v_pkg, 0);
  ELSE
    -- Legacy: daily_cap_factor × rank.bonus (fallback $100 sin rango).
    SELECT r.bonus_amount_usd INTO v_rank_bonus
      FROM mlm.affiliate a JOIN mlm.rank r ON r.id = a.current_rank_id
     WHERE a.id = NEW.affiliate_id;
    v_max_today := v_factor * COALESCE(v_rank_bonus, 100);
  END IF;

  IF COALESCE(v_paid_today, 0) + NEW.net_amount > v_max_today + 0.01 THEN
    RAISE EXCEPTION 'Daily cap breach: affiliate=% paid_today=%.2f new=%.2f max=%.2f',
      NEW.affiliate_id, v_paid_today, NEW.net_amount, v_max_today;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- §2. affiliate — gate R2 + baseline de carrera de rangos.
--     directs_left/right: nº de patrocinados directos (sponsor_id = este
--     afiliado) que cayeron en cada pierna binaria. Actualizado por la app
--     en el placement (autoPlaceAffiliate) — se incrementa una sola vez por
--     recluta, baja frecuencia de UPDATE, OK en la tabla affiliate.
--     rank_points_baseline: puntos acreditados por el rango heredado del
--     árbol 2.0. La calificación de rango usa
--       least(left_pv_lifetime, right_pv_lifetime) + baseline ≥ required_points
--     → un migrado con rango N necesita sólo el DELTA hasta el rango N+1
--       (su volumen real arranca en 0; el baseline representa lo ya
--       reconocido). Para exigir el threshold completo desde cero, basta
--       UPDATE ... SET rank_points_baseline = 0.
-- ---------------------------------------------------------------------------
ALTER TABLE mlm.affiliate
  ADD COLUMN directs_left          integer       NOT NULL DEFAULT 0
    CHECK (directs_left >= 0),
  ADD COLUMN directs_right         integer       NOT NULL DEFAULT 0
    CHECK (directs_right >= 0),
  ADD COLUMN rank_points_baseline  numeric(20,2) NOT NULL DEFAULT 0
    CHECK (rank_points_baseline >= 0);

-- ---------------------------------------------------------------------------
-- §3. affiliate_payout_state — estado caliente del motor, 1:1 con affiliate.
--     Separado de mlm.affiliate porque se actualiza en cada cierre de
--     período (hot churn) y affiliate tiene índices ltree/gist caros de
--     mantener. fillfactor 90 para HOT updates.
--     Espejo de simulator.Node (r1.go, r2.go, r3.go) en persistencia.
-- ---------------------------------------------------------------------------
CREATE TABLE mlm.affiliate_payout_state (
  affiliate_id                    bigint PRIMARY KEY
                                  REFERENCES mlm.affiliate(id) ON DELETE RESTRICT,

  -- R1 (ADR-0013): profundidad máxima del downline y thresholds cruzados
  max_downline_depth              integer       NOT NULL DEFAULT 0,
  last_depth_threshold_crossed    integer       NOT NULL DEFAULT 0,  -- múltiplo de repurchase_threshold
  last_depth_threshold_period_id  bigint        REFERENCES mlm.binary_period(id),
  last_purchase_at                timestamptz,                       -- última compra/renovación
  last_purchase_period_id         bigint        REFERENCES mlm.binary_period(id),

  -- R1 modo P-B: bono pausado pendiente de cumplimiento
  paused_carry                    numeric(20,2) NOT NULL DEFAULT 0
    CHECK (paused_carry >= 0),
  paused_carry_updated_period_id  bigint        REFERENCES mlm.binary_period(id),

  -- R2 (ADR-0015): última cadencia de yield pagada (idempotencia del cierre)
  last_yield_period_id            bigint        REFERENCES mlm.binary_period(id),

  -- R3 (ADR-0016): puntos acumulados por bloques pagados, pendientes de conversión
  points_accrued                  numeric(20,2) NOT NULL DEFAULT 0
    CHECK (points_accrued >= 0),
  last_points_period_id           bigint        REFERENCES mlm.binary_period(id),

  updated_at                      timestamptz   NOT NULL DEFAULT now()
) WITH (fillfactor = 90);

-- FKs a binary_period: índices manuales (Postgres no auto-indexa FK)
CREATE INDEX aps_last_purchase_period_idx ON mlm.affiliate_payout_state(last_purchase_period_id);
-- Cierre R1: barrido de afiliados con carry pausado pendiente
CREATE INDEX aps_paused_carry_idx ON mlm.affiliate_payout_state(affiliate_id)
  WHERE paused_carry > 0;

-- ---------------------------------------------------------------------------
-- §4. Conceptos nuevos (rango 1000+ reservado para post-legacy, ver
--     02_postload.sql). factor=+1: crédito al afiliado.
--     La RENOVACIÓN usa kind='package_purchase' a propósito: el cierre
--     binario suma inflows por kind=package_purchase (bonusengine), así la
--     renovación entra a θ sin tocar el motor. Se distingue por concept.id.
-- ---------------------------------------------------------------------------
INSERT INTO mlm.concept (id, kind, name_es, name_en, factor, requires_pair, active) VALUES
  (1001, 'r2_yield',         'Yield R2 (25% anual)',        'R2 yield (25% APR)',        1, false, true),
  (1002, 'r3_points',        'Bono de puntos R3',           'R3 points bonus',           1, false, true),
  (1003, 'rank_bonus',       'Bono de rango (carrera)',     'Rank achievement bonus',    1, false, true),
  (1004, 'package_purchase', 'Renovación de paquete (R1)',  'Package renewal (R1)',      1, false, true)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- §5. Capital lock — vista de liquidez (candado C, ADR-0015).
--     El lock NO afecta T1/θ; es métrica de tesorería + check de retiro en
--     walletbridge. Períodos del plan = semanas (cadencia semanal).
-- ---------------------------------------------------------------------------
CREATE VIEW mlm.v_capital_lock AS
SELECT ap.id                                  AS affiliate_package_id,
       ap.affiliate_id,
       p.amount_usd                           AS principal_usd,
       ap.activated_at,
       ap.activated_at
         + make_interval(weeks => pc.capital_lock_periods) AS unlocks_at,
       now() < ap.activated_at
         + make_interval(weeks => pc.capital_lock_periods) AS is_locked
  FROM mlm.affiliate_package ap
  JOIN mlm.package p ON p.id = ap.package_id
  CROSS JOIN LATERAL (
    SELECT capital_lock_periods
      FROM mlm.plan_config
     WHERE effective_from <= now()
       AND (effective_to IS NULL OR effective_to > now())
     ORDER BY effective_from DESC
     LIMIT 1
  ) pc
 WHERE ap.status = 'active'
   AND ap.activated_at IS NOT NULL;

COMMENT ON VIEW mlm.v_capital_lock IS
  'Lock 12m sobre capital depositado (ADR-0015 candado C). Walletbridge debe '
  'rechazar retiros de capital mientras is_locked; bonos (binario/R2/R3/rango) '
  'son de libre retiro. Reporting: SUM(principal_usd) WHERE is_locked = pasivo bloqueado.';

COMMIT;

\echo '=== schema_payouts_v1.2.sql aplicado ==='
\echo 'Siguiente: schema_ranks.sql (carrera de 14 rangos)'
