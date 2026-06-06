-- =============================================================================
-- VicionPower — Schema de payouts (motor de bonos binario)
--
-- Implementa el diseño de mlm_binario_estabilidad.md §5 + mlm_binario_margen_operativo.md.
-- Anclado a ADR 0012.
--
-- Pre-req:
--   1. schema_mlm.sql aplicado.
--   2. schema_governance.sql aplicado (para integración con approval_request).
--   3. 05_timescaledb.sql aplicado.
--
-- Run: psql -U migrator -d vicionpower -f schema_payouts.sql
-- =============================================================================

SET search_path = mlm, public;

-- =============================================================================
-- 1. PLAN CONFIG — parámetros versionados del plan binario
-- =============================================================================
CREATE TABLE mlm.plan_config (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version_label           text NOT NULL UNIQUE,         -- e.g., 'v1', 'v1.1-conservative'
  effective_from          timestamptz NOT NULL,
  effective_to            timestamptz,
  -- Parámetros binarios (ver mlm_binario_estabilidad.md §3.1)
  block_size              integer       NOT NULL CHECK (block_size > 0),
  bonus_per_block         numeric(14,2) NOT NULL CHECK (bonus_per_block > 0),
  depth_cap               integer       NOT NULL CHECK (depth_cap BETWEEN 1 AND 30),
  daily_cap_factor        numeric(8,4)  NOT NULL CHECK (daily_cap_factor > 0),
  lifetime_cap_factor     numeric(8,4)  NOT NULL CHECK (lifetime_cap_factor > 0),
  treasury_alpha          numeric(8,6)  NOT NULL CHECK (treasury_alpha BETWEEN 0 AND 1),
  carry_decay_days        integer       NOT NULL CHECK (carry_decay_days BETWEEN 1 AND 365),
  qualified_directs_left  smallint      NOT NULL CHECK (qualified_directs_left >= 0),
  qualified_directs_right smallint      NOT NULL CHECK (qualified_directs_right >= 0),
  -- Quien creó la config (para audit; debe ser admin con approval_request aprobado)
  created_by_person_id    bigint NOT NULL REFERENCES mlm.person(id),
  approval_request_id     bigint REFERENCES mlm.approval_request(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  notes                   text,

  -- Solo una config "vigente" en cada momento
  CONSTRAINT plan_config_no_overlap EXCLUDE USING gist (
    tstzrange(effective_from, COALESCE(effective_to, 'infinity'::timestamptz)) WITH &&
  ) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX plan_config_effective_idx ON mlm.plan_config(effective_from DESC);

-- =============================================================================
-- 2. BINARY PERIOD — ventana de cálculo (semanal/quincenal típicamente)
-- =============================================================================
CREATE TYPE mlm.binary_period_status AS ENUM (
  'open',       -- aceptando eventos
  'closing',    -- enumerando candidates, calculando theta
  'closed',     -- payments emitted, immutable
  'aborted'     -- error en cálculo, no se emitieron pagos
);

CREATE TABLE mlm.binary_period (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_config_id          bigint NOT NULL REFERENCES mlm.plan_config(id),
  period_start            timestamptz NOT NULL,
  period_end              timestamptz NOT NULL,
  status                  mlm.binary_period_status NOT NULL DEFAULT 'open',

  -- Snapshot inmutable al cerrar (NULL mientras open/closing)
  inflows_total           numeric(20,2),
  events_count            integer,
  candidates_count        integer,
  projected_outflows      numeric(20,2),
  theta                   numeric(8,6) CHECK (theta IS NULL OR theta BETWEEN 0 AND 1),
  total_paid              numeric(20,2),

  closed_at               timestamptz,
  closed_by_person_id     bigint REFERENCES mlm.person(id),

  CONSTRAINT period_dates_valid CHECK (period_end > period_start),
  CONSTRAINT period_unique_window UNIQUE (period_start, period_end),
  CONSTRAINT period_closed_has_data CHECK (
    (status NOT IN ('closed') AND closed_at IS NULL)
    OR
    (status = 'closed' AND closed_at IS NOT NULL AND theta IS NOT NULL
     AND inflows_total IS NOT NULL AND total_paid IS NOT NULL)
  )
);

CREATE INDEX binary_period_status_idx ON mlm.binary_period(status, period_end DESC);

-- =============================================================================
-- 3. BINARY BLOCK PAYMENT — un INSERT por bloque pagado (TimescaleDB hypertable)
-- =============================================================================
CREATE TABLE mlm.binary_block_payment (
  id                      bigint GENERATED ALWAYS AS IDENTITY,
  binary_period_id        bigint NOT NULL REFERENCES mlm.binary_period(id),
  plan_config_id          bigint NOT NULL REFERENCES mlm.plan_config(id),
  affiliate_id            bigint NOT NULL REFERENCES mlm.affiliate(id),
  source_event_id         bigint NOT NULL REFERENCES mlm.tree_event(id),
  -- el evento del comprador que disparó el pago a este ancestro

  blocks                  integer       NOT NULL CHECK (blocks > 0),
  gross_amount            numeric(14,2) NOT NULL CHECK (gross_amount >= 0),
  theta_applied           numeric(8,6)  NOT NULL CHECK (theta_applied BETWEEN 0 AND 1),
  net_amount              numeric(14,2) NOT NULL CHECK (net_amount >= 0),

  -- Cap mechanics: cuánto del gross fue recortado por cada cap
  cap_daily_reduction     numeric(14,2) NOT NULL DEFAULT 0,
  cap_package_reduction   numeric(14,2) NOT NULL DEFAULT 0,

  -- Link al ledger (transaction que efectivamente acredita)
  transaction_id          uuid REFERENCES mlm.transaction(id),

  posted_at               timestamptz NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (id, posted_at),
  -- Idempotencia: un mismo (affiliate, period, source_event) no se paga dos veces
  CONSTRAINT bpp_idempotent UNIQUE (affiliate_id, binary_period_id, source_event_id, posted_at)
);

CREATE INDEX bpp_period_idx       ON mlm.binary_block_payment(binary_period_id, posted_at DESC);
CREATE INDEX bpp_affiliate_idx    ON mlm.binary_block_payment(affiliate_id, posted_at DESC);
CREATE INDEX bpp_transaction_idx  ON mlm.binary_block_payment(transaction_id);

-- DELIBERADAMENTE NO hypertable (ADR 0015).
-- El motor consulta por (affiliate_id, binary_period_id); reporting histórico
-- se hace sobre mlm.mv_earnings_monthly (continuous aggregate sobre
-- wallet_movement). Hypertable agregaría complejidad sobre el INSERT
-- ON CONFLICT y los chunks comprimidos, sin acelerar las queries del motor.
--
-- Si en producción aparecen slow queries sobre binary_block_payment,
-- abrir ADR superseder y descomentar:
--
--   SELECT create_hypertable('mlm.binary_block_payment',
--     by_range('posted_at', INTERVAL '1 month'),
--     if_not_exists => TRUE);
--   ALTER TABLE mlm.binary_block_payment SET (
--     timescaledb.compress,
--     timescaledb.compress_segmentby = 'affiliate_id',
--     timescaledb.compress_orderby   = 'posted_at DESC, id DESC');
--   SELECT add_compression_policy('mlm.binary_block_payment', INTERVAL '60 days');

-- =============================================================================
-- 4. BINARY NODE STATE — estado por nodo en el período activo
-- =============================================================================
-- Una row por (affiliate, period). Mantiene el contador de bloques pagados,
-- carry, y daily counters para enforcement de caps.
CREATE TABLE mlm.binary_node_state (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  affiliate_id            bigint NOT NULL REFERENCES mlm.affiliate(id),
  binary_period_id        bigint NOT NULL REFERENCES mlm.binary_period(id),

  blocks_paid_left        integer NOT NULL DEFAULT 0 CHECK (blocks_paid_left >= 0),
  blocks_paid_right       integer NOT NULL DEFAULT 0 CHECK (blocks_paid_right >= 0),

  carry_left              integer NOT NULL DEFAULT 0 CHECK (carry_left >= 0),
  carry_right             integer NOT NULL DEFAULT 0 CHECK (carry_right >= 0),
  carry_started_at        timestamptz,

  paid_today_amount       numeric(14,2) NOT NULL DEFAULT 0,
  paid_today_date         date,

  paid_period_amount      numeric(14,2) NOT NULL DEFAULT 0,

  qualified               boolean NOT NULL DEFAULT false,
  -- snapshot de qualified() al inicio del período; recomputado al cerrar

  updated_at              timestamptz NOT NULL DEFAULT now(),

  UNIQUE (affiliate_id, binary_period_id)
);

CREATE INDEX bns_period_idx ON mlm.binary_node_state(binary_period_id);

-- =============================================================================
-- 5. PACKAGE CAP STATE — cap unificado por paquete (incluye TODO bono)
-- =============================================================================
-- Crítico: este cap aplica a la SUMA de ROI + binario + rápido + rango + liderazgo
-- atribuibles a un paquete. Es la palanca §2.5 de mlm_binario_margen_operativo.md.
CREATE TABLE mlm.package_cap_state (
  affiliate_package_id    bigint PRIMARY KEY REFERENCES mlm.affiliate_package(id),
  cap_total               numeric(14,2) NOT NULL CHECK (cap_total > 0),
  -- = K_pkg × package.amount_usd al activar paquete
  paid_total              numeric(14,2) NOT NULL DEFAULT 0 CHECK (paid_total >= 0),
  closed_at               timestamptz,
  -- cuando paid_total >= cap_total

  CHECK (paid_total <= cap_total + 0.01)
  -- ^ la transacción que cierra debe respetar el cap (margen 1¢ rounding)
);

CREATE INDEX pcs_open_idx ON mlm.package_cap_state(affiliate_package_id)
  WHERE closed_at IS NULL;

-- =============================================================================
-- 6. TRIGGERS — invariantes T1-T4
-- =============================================================================

-- T2: cap por paquete enforced al UPDATE de paid_total
CREATE OR REPLACE FUNCTION mlm.fn_enforce_package_cap() RETURNS trigger AS $$
BEGIN
  IF NEW.paid_total > NEW.cap_total + 0.01 THEN
    RAISE EXCEPTION 'Package cap breach: package_id=% paid=%.2f cap=%.2f',
      NEW.affiliate_package_id, NEW.paid_total, NEW.cap_total;
  END IF;
  -- Auto-close cuando alcanza el cap
  IF NEW.paid_total >= NEW.cap_total - 0.01 AND NEW.closed_at IS NULL THEN
    NEW.closed_at := now();
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_enforce_package_cap
  BEFORE UPDATE OF paid_total ON mlm.package_cap_state
  FOR EACH ROW EXECUTE FUNCTION mlm.fn_enforce_package_cap();

-- Inicializar package_cap_state al activar un affiliate_package
CREATE OR REPLACE FUNCTION mlm.fn_init_package_cap() RETURNS trigger AS $$
DECLARE
  v_amount  numeric(14,2);
  v_factor  numeric(8,4);
BEGIN
  IF NEW.status = 'active' AND (OLD IS NULL OR OLD.status <> 'active') THEN
    SELECT amount_usd INTO v_amount FROM mlm.package WHERE id = NEW.package_id;
    SELECT lifetime_cap_factor INTO v_factor
      FROM mlm.plan_config
     WHERE effective_to IS NULL OR effective_to > now()
     ORDER BY effective_from DESC LIMIT 1;
    IF v_factor IS NULL THEN v_factor := 2.0; END IF;
    INSERT INTO mlm.package_cap_state (affiliate_package_id, cap_total)
    VALUES (NEW.id, v_amount * v_factor)
    ON CONFLICT (affiliate_package_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_init_package_cap
  AFTER INSERT OR UPDATE OF status ON mlm.affiliate_package
  FOR EACH ROW EXECUTE FUNCTION mlm.fn_init_package_cap();

-- T1: invariant verificable post-cierre — net_total <= alpha × inflows
CREATE OR REPLACE FUNCTION mlm.fn_verify_period_solvency(p_period_id bigint)
RETURNS TABLE(period_id bigint, status text, total_paid numeric, max_allowed numeric, breach numeric) AS $$
  SELECT
    bp.id,
    CASE
      WHEN bp.total_paid <= pc.treasury_alpha * bp.inflows_total + 0.01 THEN 'OK'
      ELSE 'BREACH'
    END,
    bp.total_paid,
    pc.treasury_alpha * bp.inflows_total,
    bp.total_paid - pc.treasury_alpha * bp.inflows_total
    FROM mlm.binary_period bp
    JOIN mlm.plan_config  pc ON pc.id = bp.plan_config_id
   WHERE bp.id = p_period_id AND bp.status = 'closed';
$$ LANGUAGE sql STABLE;

-- T3: cap diario por usuario enforced cuando se inserta un block_payment
CREATE OR REPLACE FUNCTION mlm.fn_enforce_daily_cap() RETURNS trigger AS $$
DECLARE
  v_today date := (NEW.posted_at AT TIME ZONE 'America/Bogota')::date;
  v_paid_today numeric(14,2);
  v_rank_bonus numeric(14,2);
  v_factor numeric(8,4);
  v_max_today numeric(14,2);
BEGIN
  SELECT bns.paid_today_amount, bns.paid_today_date
    INTO v_paid_today, v_today
    FROM mlm.binary_node_state bns
   WHERE bns.affiliate_id = NEW.affiliate_id
     AND bns.binary_period_id = NEW.binary_period_id;

  SELECT pc.daily_cap_factor INTO v_factor
    FROM mlm.plan_config pc WHERE pc.id = NEW.plan_config_id;

  SELECT r.bonus_amount_usd INTO v_rank_bonus
    FROM mlm.affiliate a JOIN mlm.rank r ON r.id = a.current_rank_id
   WHERE a.id = NEW.affiliate_id;
  IF v_rank_bonus IS NULL THEN v_rank_bonus := 100; END IF;

  v_max_today := v_factor * v_rank_bonus;

  IF COALESCE(v_paid_today, 0) + NEW.net_amount > v_max_today + 0.01 THEN
    RAISE EXCEPTION 'Daily cap breach: affiliate=% paid_today=%.2f new=%.2f max=%.2f',
      NEW.affiliate_id, v_paid_today, NEW.net_amount, v_max_today;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_enforce_daily_cap
  BEFORE INSERT ON mlm.binary_block_payment
  FOR EACH ROW EXECUTE FUNCTION mlm.fn_enforce_daily_cap();

-- =============================================================================
-- 7. VIEWS — visibilidad operativa
-- =============================================================================

-- Vista panel afiliado: estado del período activo
CREATE VIEW mlm.v_affiliate_binary_status AS
SELECT
  a.id AS affiliate_id,
  a.left_pv_current,
  a.right_pv_current,
  a.left_carry,
  a.right_carry,
  bns.qualified,
  bns.paid_period_amount,
  bp.theta,
  bp.period_start,
  bp.period_end,
  pc.bonus_per_block,
  pc.block_size,
  pc.daily_cap_factor * COALESCE(r.bonus_amount_usd, 100) AS daily_cap
FROM mlm.affiliate a
LEFT JOIN mlm.binary_node_state bns ON bns.affiliate_id = a.id
LEFT JOIN mlm.binary_period bp     ON bp.id = bns.binary_period_id AND bp.status = 'open'
LEFT JOIN mlm.plan_config   pc     ON pc.id = bp.plan_config_id
LEFT JOIN mlm.rank          r      ON r.id = a.current_rank_id;

-- Vista solvencia por período (para dashboard ops)
CREATE VIEW mlm.v_period_solvency AS
SELECT
  bp.id,
  bp.period_start,
  bp.period_end,
  bp.status,
  bp.inflows_total,
  bp.projected_outflows,
  bp.theta,
  bp.total_paid,
  pc.treasury_alpha,
  pc.treasury_alpha * bp.inflows_total AS max_payout_allowed,
  CASE
    WHEN bp.total_paid IS NULL THEN 'pending'
    WHEN bp.total_paid <= pc.treasury_alpha * bp.inflows_total + 0.01 THEN 'OK'
    ELSE 'BREACH'
  END AS solvency_status,
  CASE WHEN bp.inflows_total > 0
       THEN ROUND(100.0 * bp.total_paid / bp.inflows_total, 2)
       ELSE NULL END AS payout_pct_of_inflow
FROM mlm.binary_period bp
JOIN mlm.plan_config   pc ON pc.id = bp.plan_config_id;

-- Vista margen operativo por período (mlm_binario_margen_operativo.md §6)
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

-- =============================================================================
-- 8. PERMISSIONS
-- =============================================================================
GRANT SELECT ON
  mlm.plan_config, mlm.binary_period, mlm.binary_block_payment,
  mlm.binary_node_state, mlm.package_cap_state,
  mlm.v_affiliate_binary_status, mlm.v_period_solvency, mlm.v_operator_margin
TO app_read;

-- engine_write puede modificar todo durante un cierre de período
GRANT INSERT, UPDATE ON
  mlm.binary_period, mlm.binary_block_payment,
  mlm.binary_node_state, mlm.package_cap_state
TO engine_write;

-- plan_config solo lo modifica admin con approval
GRANT INSERT, UPDATE ON mlm.plan_config TO app_admin;

\echo 'Schema payouts instalado. Siguiente paso: insertar plan_config v1 y abrir primer período.'
\echo ''
\echo 'Plan_config v1 recomendado (Escenario B de mlm_binario_margen_operativo.md):'
\echo "  INSERT INTO mlm.plan_config (version_label, effective_from,"
\echo "    block_size, bonus_per_block, depth_cap, daily_cap_factor,"
\echo "    lifetime_cap_factor, treasury_alpha, carry_decay_days,"
\echo "    qualified_directs_left, qualified_directs_right, created_by_person_id)"
\echo "  VALUES ('v1-conservative', now(),"
\echo "    500, 10.00, 10, 3.0,"
\echo "    2.0, 0.45, 14,"
\echo "    1, 1, <person_id_admin>);"
