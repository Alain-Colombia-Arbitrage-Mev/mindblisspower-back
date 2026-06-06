-- =============================================================================
-- schema_ranks.sql — Carrera de Rangos: 14 hitos económicos (ADR-0017)
--
-- Modelo (definición de negocio 2026-06-04, reemplaza la propuesta "5% del
-- threshold" del plan integral §5.3):
--   - Calificación: PUNTOS ACUMULADOS EN CADA PIERNA ≥ threshold del rango
--       qualifies(a, R) := least(a.left_pv_lifetime, a.right_pv_lifetime)
--                          + a.rank_points_baseline  >=  R.required_points
--   - Bono one-time FIJO por rango (no porcentaje), pagado una sola vez.
--   - Caps: T1 sólo (entra a projected/θ). Bypassa T2 y T3 — es premio de
--     carrera, no comisión recurrente (plan integral §5.4).
--   - NO modifica T3 (ADR-0014 sigue: T3 = period_cap_factor × paquete).
--
-- Migración árbol 2.0 (directiva 2026-06-04):
--   - Se conserva POSICIÓN y RANGO; el VOLUMEN arranca en 0.
--   - Rangos heredados se registran con source='legacy' y bonus 0
--     (SIN bono retroactivo).
--   - rank_points_baseline = required_points del rango heredado → el
--     siguiente rango exige sólo el delta de puntos nuevos.
--
-- Quién evalúa: el cierre de período de bonusengine llama
-- mlm.fn_pending_rank_achievements(), aplica θ al bono, postea la
-- transacción (concept 1003 rank_bonus) e inserta affiliate_rank_achieved.
-- No hay trigger: el ascenso debe pasar por θ y eso sólo lo sabe el cierre.
--
-- Run order: schema_payouts_v1.2.sql → ESTE ARCHIVO
-- TimescaleDB: tablas vainilla (dimensión + ~1 fila por afiliado×rango;
-- no es serie de tiempo — ADR-0015 _meta).
-- =============================================================================

SET search_path = mlm, public;

BEGIN;

-- ---------------------------------------------------------------------------
-- §1. Los 14 rangos. mlm.rank es ahora el catálogo de la carrera (los rangos
--     legacy 2.0 NO se importan aquí; se mapean vía staging.rank_map en
--     02_postload.sql). required_points = puntos exigidos EN CADA PIERNA.
-- ---------------------------------------------------------------------------
INSERT INTO mlm.rank (id, code, name_es, name_en, required_points, accumulated_points, bonus_amount_usd, previous_rank_id, display_order) VALUES
  ( 1, 'BRONZE',        'Bronce',         'Bronze',            1000, NULL,    100.00, NULL,  1),
  ( 2, 'SILVER',        'Plata',          'Silver',            2500, NULL,    200.00,    1,  2),
  ( 3, 'GOLD',          'Oro',            'Gold',              5000, NULL,    500.00,    2,  3),
  ( 4, 'PLATINUM',      'Platino',        'Platinum',         10000, NULL,    750.00,    3,  4),
  ( 5, 'SAPPHIRE',      'Zafiro',         'Sapphire',         25000, NULL,   1000.00,    4,  5),
  ( 6, 'RUBY',          'Rubí',           'Ruby',             50000, NULL,   2500.00,    5,  6),
  ( 7, 'EMERALD',       'Esmeralda',      'Emerald',         100000, NULL,   5000.00,    6,  7),
  ( 8, 'DIAMOND',       'Diamante',       'Diamond',         250000, NULL,  10000.00,    7,  8),
  ( 9, 'BLUE_DIAMOND',  'Diamante Azul',  'Blue Diamond',    500000, NULL,  15000.00,    8,  9),
  (10, 'BLACK_DIAMOND', 'Diamante Negro', 'Black Diamond',   750000, NULL,  20000.00,    9, 10),
  (11, 'AMBASSADOR',    'Embajador',      'Ambassador',     1000000, NULL,  25000.00,   10, 11),
  (12, 'CROWN',         'Corona',         'Crown',          5000000, NULL,  50000.00,   11, 12),
  (13, 'ROYAL',         'Royal',          'Royal',         10000000, NULL,  75000.00,   12, 13),
  (14, 'KING',          'King',           'King',          25000000, NULL, 100000.00,   13, 14)
ON CONFLICT (id) DO UPDATE
  SET code = EXCLUDED.code,
      name_es = EXCLUDED.name_es,
      name_en = EXCLUDED.name_en,
      required_points = EXCLUDED.required_points,
      bonus_amount_usd = EXCLUDED.bonus_amount_usd,
      previous_rank_id = EXCLUDED.previous_rank_id,
      display_order = EXCLUDED.display_order;

-- Exposición total si TODOS los afiliados tocaran los 14 rangos: $305,950
-- por afiliado (suma de bonos fijos). El bono entra a θ ⇒ T1 lo limita.

-- ---------------------------------------------------------------------------
-- §2. affiliate_rank_achieved — 1 fila por (afiliado, rango) alcanzado.
--     Append-only: un rango alcanzado nunca se revierte ni se repaga.
-- ---------------------------------------------------------------------------
CREATE TABLE mlm.affiliate_rank_achieved (
  affiliate_id        bigint   NOT NULL REFERENCES mlm.affiliate(id) ON DELETE RESTRICT,
  rank_id             smallint NOT NULL REFERENCES mlm.rank(id),
  achieved_at         timestamptz NOT NULL DEFAULT now(),
  source              text     NOT NULL DEFAULT 'earned'
                      CHECK (source IN ('earned', 'legacy')),
  binary_period_id    bigint   REFERENCES mlm.binary_period(id),  -- NULL si legacy

  -- Snapshot de puntos al momento del ascenso (auditoría/disputas)
  points_left_at      numeric(20,2),
  points_right_at     numeric(20,2),

  -- Bono: gross fijo del rango, θ aplicado en el cierre, net posteado.
  -- legacy ⇒ todo 0 (sin bono retroactivo).
  bonus_amount_usd    numeric(14,2) NOT NULL DEFAULT 0 CHECK (bonus_amount_usd >= 0),
  theta_applied       numeric(8,6)  CHECK (theta_applied IS NULL OR theta_applied BETWEEN 0 AND 1),
  net_amount_usd      numeric(14,2) NOT NULL DEFAULT 0 CHECK (net_amount_usd >= 0),
  transaction_id      uuid     REFERENCES mlm.transaction(id),

  PRIMARY KEY (affiliate_id, rank_id),
  CONSTRAINT ara_legacy_no_bonus CHECK (
    source <> 'legacy' OR (bonus_amount_usd = 0 AND net_amount_usd = 0 AND transaction_id IS NULL)
  )
);

CREATE INDEX ara_rank_idx   ON mlm.affiliate_rank_achieved(rank_id, achieved_at DESC);
CREATE INDEX ara_period_idx ON mlm.affiliate_rank_achieved(binary_period_id);
CREATE INDEX ara_txn_idx    ON mlm.affiliate_rank_achieved(transaction_id);

-- Append-only enforcement (mismo patrón T4 que wallet_movement)
CREATE FUNCTION mlm.fn_rank_achieved_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'mlm.affiliate_rank_achieved es append-only (rango alcanzado no se revierte)';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_rank_achieved_immutable
  BEFORE UPDATE OR DELETE ON mlm.affiliate_rank_achieved
  FOR EACH ROW EXECUTE FUNCTION mlm.fn_rank_achieved_immutable();

-- ---------------------------------------------------------------------------
-- §2b. Cuotas del bono de rango (Mitigación B, 2026-06-05). Al registrar un
--      ascenso 'earned', el cierre inserta N cuotas (plan_config.
--      rank_installments) con vencimientos cada rank_installment_cadence
--      períodos (semanas). Cada cierre paga las cuotas vencidas × θ de SU
--      período. El hito (affiliate_rank_achieved) se marca al cruzar;
--      sólo el pago se difiere.
-- ---------------------------------------------------------------------------
CREATE TABLE mlm.rank_bonus_installment (
  id              bigint   GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  affiliate_id    bigint   NOT NULL REFERENCES mlm.affiliate(id) ON DELETE RESTRICT,
  rank_id         smallint NOT NULL REFERENCES mlm.rank(id),
  installment_no  smallint NOT NULL CHECK (installment_no >= 1),
  amount_usd      numeric(14,2) NOT NULL CHECK (amount_usd > 0),
  due_at          date     NOT NULL,

  -- Liquidación (NULL = pendiente)
  paid_at         timestamptz,
  theta_applied   numeric(8,6) CHECK (theta_applied IS NULL OR theta_applied BETWEEN 0 AND 1),
  net_amount_usd  numeric(14,2),
  binary_period_id bigint  REFERENCES mlm.binary_period(id),
  transaction_id  uuid     REFERENCES mlm.transaction(id),

  UNIQUE (affiliate_id, rank_id, installment_no),
  FOREIGN KEY (affiliate_id, rank_id)
    REFERENCES mlm.affiliate_rank_achieved (affiliate_id, rank_id)
);

CREATE INDEX rbi_due_idx ON mlm.rank_bonus_installment(due_at)
  WHERE paid_at IS NULL;
CREATE INDEX rbi_affiliate_idx ON mlm.rank_bonus_installment(affiliate_id, rank_id);

-- ---------------------------------------------------------------------------
-- §3. fn_pending_rank_achievements — rangos calificados aún no otorgados.
--     La llama el cierre binario ANTES de calcular θ (los bonos entran a
--     projected). Determinística y sin efectos: el cierre decide e inserta.
-- ---------------------------------------------------------------------------
CREATE FUNCTION mlm.fn_pending_rank_achievements()
RETURNS TABLE (
  affiliate_id     bigint,
  rank_id          smallint,
  bonus_amount_usd numeric(14,2),
  points_left      numeric(20,2),
  points_right     numeric(20,2)
) LANGUAGE sql STABLE AS $$
  SELECT a.id,
         r.id,
         r.bonus_amount_usd,
         a.left_pv_lifetime  + a.rank_points_baseline,
         a.right_pv_lifetime + a.rank_points_baseline
    FROM mlm.affiliate a
    JOIN mlm.rank r
      ON least(a.left_pv_lifetime, a.right_pv_lifetime)
         + a.rank_points_baseline >= r.required_points
   WHERE a.status = 'active'
     AND NOT EXISTS (
           SELECT 1 FROM mlm.affiliate_rank_achieved x
            WHERE x.affiliate_id = a.id AND x.rank_id = r.id)
   ORDER BY a.id, r.required_points;
$$;

-- ---------------------------------------------------------------------------
-- §4. Sincronizar affiliate.current_rank_id con el mayor rango alcanzado
-- ---------------------------------------------------------------------------
CREATE FUNCTION mlm.fn_sync_current_rank() RETURNS trigger AS $$
BEGIN
  UPDATE mlm.affiliate a
     SET current_rank_id = (
           SELECT r.id
             FROM mlm.affiliate_rank_achieved x
             JOIN mlm.rank r ON r.id = x.rank_id
            WHERE x.affiliate_id = NEW.affiliate_id
            ORDER BY r.required_points DESC
            LIMIT 1),
         updated_at = now()
   WHERE a.id = NEW.affiliate_id;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_current_rank
  AFTER INSERT ON mlm.affiliate_rank_achieved
  FOR EACH ROW EXECUTE FUNCTION mlm.fn_sync_current_rank();

-- ---------------------------------------------------------------------------
-- §5. v_rank_progress — dashboard del afiliado: rango actual, siguiente
--     rango y % de avance (sobre puntos efectivos = lifetime + baseline).
-- ---------------------------------------------------------------------------
CREATE VIEW mlm.v_rank_progress AS
SELECT a.id                                          AS affiliate_id,
       a.current_rank_id,
       cr.code                                       AS current_rank_code,
       a.left_pv_lifetime  + a.rank_points_baseline  AS points_left_eff,
       a.right_pv_lifetime + a.rank_points_baseline  AS points_right_eff,
       least(a.left_pv_lifetime, a.right_pv_lifetime)
         + a.rank_points_baseline                    AS points_qualifying,
       nr.id                                         AS next_rank_id,
       nr.code                                       AS next_rank_code,
       nr.required_points                            AS next_rank_points,
       nr.bonus_amount_usd                           AS next_rank_bonus_usd,
       CASE WHEN nr.required_points > 0 THEN
         round(100 * (least(a.left_pv_lifetime, a.right_pv_lifetime)
                      + a.rank_points_baseline) / nr.required_points, 2)
       END                                           AS pct_to_next_rank
  FROM mlm.affiliate a
  LEFT JOIN mlm.rank cr ON cr.id = a.current_rank_id
  LEFT JOIN LATERAL (
    SELECT r.* FROM mlm.rank r
     WHERE r.required_points > least(a.left_pv_lifetime, a.right_pv_lifetime)
                               + a.rank_points_baseline
     ORDER BY r.required_points ASC
     LIMIT 1
  ) nr ON true
 WHERE a.status = 'active';

COMMIT;

\echo '=== schema_ranks.sql aplicado: 14 rangos seed + affiliate_rank_achieved ==='
SELECT id, code, required_points, bonus_amount_usd FROM mlm.rank ORDER BY display_order;
