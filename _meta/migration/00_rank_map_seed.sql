-- =============================================================================
-- 00_rank_map_seed.sql — Mapeo de rangos legacy 2.0 → carrera de 14 rangos
--
-- Fuente legacy: viciongroup.rank (dump en _meta/mlm_math.out §M1).
-- La escalera 2.0 es IDÉNTICA en nombres y umbrales de puntos a los 14
-- nuevos (schema_ranks.sql); el 2.0 sólo llegaba hasta Corona (12 rangos).
-- Royal (13) y King (14) son nuevos — ningún migrado los hereda.
--
-- Los bonos legacy eran mayores (p.ej. Corona $500k vs $50k nuevo) pero NO
-- importan: los rangos heredados se registran con bono $0 (sin retroactivo).
--
-- Distribución legacy (M4): 108,991 sin rango (no se mapean, quedan NULL);
-- 9,603 con rango: Bronce 3,558 · Plata 1,797 · Oro 1,383 · Platino 1,185 ·
-- Zafiro 661 · Rubí 441 · Esmeralda 286 · Diamante 135 · D.Azul 64 ·
-- D.Negro 36 · Embajador 38 · Corona 19.
--
-- Run order: 01_pgloader.load → ESTE ARCHIVO → 02_postload.sql
-- (02 valida fail-closed que todo rango legacy en uso esté mapeado).
-- =============================================================================

\set ON_ERROR_STOP 1
CREATE SCHEMA IF NOT EXISTS staging;

CREATE TABLE IF NOT EXISTS staging.rank_map (
  legacy_id_rank  integer  PRIMARY KEY,
  new_rank_id     smallint NOT NULL REFERENCES mlm.rank(id),
  notes           text
);

INSERT INTO staging.rank_map (legacy_id_rank, new_rank_id, notes) VALUES
  ( 1,  1, 'Bronce 1,000 pts → BRONZE (idéntico)'),
  ( 2,  2, 'Plata 2,500 pts → SILVER (idéntico)'),
  ( 3,  3, 'Oro 5,000 pts → GOLD (idéntico)'),
  ( 4,  4, 'Platino 10,000 pts → PLATINUM (idéntico)'),
  ( 5,  5, 'Zafiro 25,000 pts → SAPPHIRE (idéntico)'),
  ( 6,  6, 'Rubi 50,000 pts → RUBY (idéntico)'),
  ( 7,  7, 'Esmeralda 100,000 pts → EMERALD (idéntico)'),
  ( 8,  8, 'Diamante 250,000 pts → DIAMOND (idéntico)'),
  ( 9,  9, 'Diamante Azul 500,000 pts → BLUE_DIAMOND (idéntico)'),
  (10, 10, 'Diamante Negro 750,000 pts → BLACK_DIAMOND (idéntico)'),
  (11, 11, 'Embajador 1,000,000 pts → AMBASSADOR (idéntico)'),
  (12, 12, 'Corona E. 5,000,000 pts → CROWN (bono legacy $500k; nuevo $50k — sin retro)')
ON CONFLICT (legacy_id_rank) DO UPDATE
  SET new_rank_id = EXCLUDED.new_rank_id, notes = EXCLUDED.notes;

-- Verificación: el mapeo debe preservar el umbral de puntos exactamente
-- (garantiza que rank_points_baseline = lo que el migrado ya tenía reconocido).
DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
    FROM staging.rank_map rm
    JOIN mlm.rank r ON r.id = rm.new_rank_id
   WHERE (rm.legacy_id_rank, r.required_points) NOT IN (
     (1,1000),(2,2500),(3,5000),(4,10000),(5,25000),(6,50000),(7,100000),
     (8,250000),(9,500000),(10,750000),(11,1000000),(12,5000000));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'rank_map inconsistente: % filas no preservan el umbral de puntos', v_bad;
  END IF;
END $$;

\echo '=== rank_map seed: 12 rangos legacy mapeados 1:1 ==='
SELECT rm.legacy_id_rank, r.code, r.required_points, r.bonus_amount_usd
  FROM staging.rank_map rm JOIN mlm.rank r ON r.id = rm.new_rank_id
 ORDER BY rm.legacy_id_rank;
