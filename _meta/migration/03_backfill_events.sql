-- =============================================================================
-- 03_backfill_events.sql — eventos de árbol mínimos post-migración
-- Pre-req: 02_postload.sql complete; affiliates have correct path/depth.
--
-- DIRECTIVA 2026-06-04: el árbol 2.0 migra conservando POSICIÓN y RANGO,
-- pero el VOLUMEN arranca en 0. Por eso este script YA NO reconstruye PV
-- histórico (la versión anterior reproducía logVicionarioPointsHistory y
-- vicionarioLeadershipBonusRecord en tree_event y recomputaba
-- left/right_pv_lifetime). Ahora:
--   - Se crean sólo eventos 'enrollment' (1 por afiliado) para que el
--     read-model de counts y mv_network_growth_daily tengan base histórica.
--   - left_count/right_count se recomputan (son ESTRUCTURA, no volumen:
--     los usa el desempate weak-leg y el reporting de red).
--   - left/right_pv_lifetime/current y carry quedan en 0 (lo garantiza
--     02_postload y lo verifica 04_reconcile C10).
--   - El histórico monetario completo vive en mlm.wallet_movement
--     (migrado en 02 §6) para auditoría/forense — no genera bloques.
--   - Los rangos heredados quedaron registrados en mlm.affiliate_rank_achieved
--     (02 §3g) con source='legacy'; la carrera nueva corre desde 0 + baseline.
--
-- Run: psql -d vicionpower -f 03_backfill_events.sql -v ON_ERROR_STOP=1
-- =============================================================================

\timing on
SET search_path = mlm, public;

BEGIN;

-- Disable per-row trigger; we'll bulk-insert and recompute counts once.
ALTER TABLE mlm.tree_event DISABLE TRIGGER trg_apply_tree_event;

-- ---------------------------------------------------------------------------
-- 1. Enrollment events — one per affiliate, occurred at created_at
-- ---------------------------------------------------------------------------
INSERT INTO mlm.tree_event (external_ref, kind, affiliate_id, pv_delta_left, pv_delta_right, occurred_at, applied_at)
SELECT 'legacy:enrollment:' || a.id::text,
       'enrollment'::mlm.tree_event_kind,
       a.id, 0, 0,
       a.created_at, a.created_at
  FROM mlm.affiliate a
ON CONFLICT (external_ref) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Recompute STRUCTURAL counts only (set-based, replaces per-row trigger).
--    PV se queda en 0 a propósito — NO sumar pv_delta aquí.
-- ---------------------------------------------------------------------------
WITH desc_with_leg AS (
  SELECT a_anc.id AS ancestor_id,
         substring(ltree2text(subpath(a_desc.path, a_anc.depth + 1, 1)) from 1 for 1) AS leg
    FROM mlm.affiliate a_desc
    JOIN mlm.affiliate a_anc ON a_desc.path <@ a_anc.path AND a_desc.id <> a_anc.id
), agg_count AS (
  SELECT ancestor_id,
         count(*) FILTER (WHERE leg = 'L') AS left_count,
         count(*) FILTER (WHERE leg = 'R') AS right_count
    FROM desc_with_leg
   GROUP BY ancestor_id
)
UPDATE mlm.affiliate a
   SET left_count  = coalesce(c.left_count,  0),
       right_count = coalesce(c.right_count, 0)
  FROM agg_count c
 WHERE a.id = c.ancestor_id;

-- ---------------------------------------------------------------------------
-- 3. Sanity: el volumen DEBE estar en 0 tras la migración (directiva).
--    Falla aquí mismo en vez de esperar a 04_reconcile.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_nonzero int;
BEGIN
  SELECT count(*) INTO v_nonzero
    FROM mlm.affiliate
   WHERE left_pv_lifetime <> 0 OR right_pv_lifetime <> 0
      OR left_pv_current  <> 0 OR right_pv_current  <> 0
      OR left_carry       <> 0 OR right_carry       <> 0;
  IF v_nonzero > 0 THEN
    RAISE EXCEPTION 'Volumen no-cero en % afiliados — la directiva exige PV/carry = 0 al cutover', v_nonzero;
  END IF;
END $$;

-- Re-enable trigger for live operations
ALTER TABLE mlm.tree_event ENABLE TRIGGER trg_apply_tree_event;

COMMIT;

ANALYZE mlm.tree_event;
ANALYZE mlm.affiliate;

\echo '=== 03_backfill_events.sql complete (volumen en 0, sólo estructura) ==='
\echo 'Tree events:'  SELECT kind, count(*) FROM mlm.tree_event GROUP BY kind ORDER BY 1;
