-- =============================================================================
-- 04_reconcile.sql — validation gate. Migration is NOT successful until all
-- checks return PASS. Output is a summary table + per-check details.
-- Pre-req: 03_backfill_events.sql complete; staging.* still present.
-- Run: psql -d vicionpower -f 04_reconcile.sql -v ON_ERROR_STOP=1
-- =============================================================================

\timing on
SET search_path = mlm, public;

DROP TABLE IF EXISTS staging.reconcile_results;
CREATE TABLE staging.reconcile_results (
  check_name       text PRIMARY KEY,
  status           text CHECK (status IN ('PASS', 'FAIL', 'WARN')),
  source_value     numeric,
  target_value     numeric,
  drift            numeric,
  offending_rows   bigint,
  details          jsonb,
  checked_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- C1: row counts per major table
-- ---------------------------------------------------------------------------
INSERT INTO staging.reconcile_results (check_name, status, source_value, target_value, drift, offending_rows)
SELECT 'count.affiliate',
       CASE WHEN s.c = t.c THEN 'PASS' ELSE 'FAIL' END,
       s.c, t.c, t.c - s.c, abs(t.c - s.c)
  FROM (SELECT count(*) AS c FROM staging.vicionario) s,
       (SELECT count(*) AS c FROM mlm.affiliate)     t;

INSERT INTO staging.reconcile_results (check_name, status, source_value, target_value, drift, offending_rows)
SELECT 'count.wallet',
       CASE WHEN s.c = t.c THEN 'PASS' ELSE 'FAIL' END,
       s.c, t.c, t.c - s.c, abs(t.c - s.c)
  FROM (SELECT count(*) AS c FROM staging.wallet) s,
       (SELECT count(*) AS c FROM mlm.wallet)    t;

INSERT INTO staging.reconcile_results (check_name, status, source_value, target_value, drift, offending_rows)
SELECT 'count.movement',
       CASE WHEN (s.c - q.c) = t.c THEN 'PASS' ELSE 'FAIL' END,
       s.c - q.c, t.c, t.c - (s.c - q.c), abs(t.c - (s.c - q.c))
  FROM (SELECT count(*) AS c FROM staging.movement) s,
       (SELECT count(*) AS c FROM staging.movement_quarantine) q,
       (SELECT count(*) AS c FROM mlm.wallet_movement)         t;

-- ---------------------------------------------------------------------------
-- C2: total amount per concept × month
-- ---------------------------------------------------------------------------
WITH src AS (
  SELECT m.idconcept,
         to_char(m.timecreation, 'YYYY-MM') AS ym,
         sum(m.import * coalesce(c.factor, 1)) AS total
    FROM staging.movement m
    JOIN staging.concept c ON c.idconcept = m.idconcept
   WHERE NOT EXISTS (SELECT 1 FROM staging.movement_quarantine q WHERE q.idmovement = m.idmovement)
   GROUP BY 1, 2
), tgt AS (
  SELECT wm.concept_id AS idconcept,
         to_char(wm.posted_at AT TIME ZONE 'America/Bogota', 'YYYY-MM') AS ym,
         sum(wm.amount) AS total
    FROM mlm.wallet_movement wm
   GROUP BY 1, 2
), diff AS (
  SELECT coalesce(s.idconcept, t.idconcept) AS concept_id,
         coalesce(s.ym, t.ym)               AS ym,
         coalesce(s.total, 0)               AS source_total,
         coalesce(t.total, 0)               AS target_total,
         coalesce(t.total, 0) - coalesce(s.total, 0) AS drift
    FROM src s FULL OUTER JOIN tgt t ON s.idconcept = t.idconcept AND s.ym = t.ym
)
INSERT INTO staging.reconcile_results (check_name, status, source_value, target_value, drift, offending_rows, details)
SELECT 'amount.concept_x_month',
       CASE WHEN sum(CASE WHEN abs(drift) > 0.01 THEN 1 ELSE 0 END) = 0 THEN 'PASS' ELSE 'FAIL' END,
       sum(source_total),
       sum(target_total),
       sum(target_total) - sum(source_total),
       sum(CASE WHEN abs(drift) > 0.01 THEN 1 ELSE 0 END),
       jsonb_build_object(
         'top_drifts', (
           SELECT jsonb_agg(row_to_json(d))
             FROM (SELECT * FROM diff WHERE abs(drift) > 0.01
                   ORDER BY abs(drift) DESC LIMIT 20) d
         )
       )
  FROM diff;

-- ---------------------------------------------------------------------------
-- C3: wallet balance drift (materialized vs computed)
-- ---------------------------------------------------------------------------
INSERT INTO staging.reconcile_results (check_name, status, source_value, target_value, drift, offending_rows)
SELECT 'wallet.balance_drift',
       CASE WHEN count(*) FILTER (WHERE abs(drift) > 0.00000001) = 0 THEN 'PASS' ELSE 'FAIL' END,
       NULL, NULL, sum(abs(drift)),
       count(*) FILTER (WHERE abs(drift) > 0.00000001)
  FROM mlm.v_wallet_balance_truth;

-- ---------------------------------------------------------------------------
-- C4: tree PV drift (materialized vs computed from tree_event)
-- ---------------------------------------------------------------------------
INSERT INTO staging.reconcile_results (check_name, status, source_value, target_value, drift, offending_rows)
SELECT 'tree.pv_drift',
       CASE WHEN count(*) FILTER (
              WHERE materialized_left  <> computed_left
                 OR materialized_right <> computed_right
            ) = 0 THEN 'PASS' ELSE 'FAIL' END,
       NULL, NULL, NULL,
       count(*) FILTER (
         WHERE materialized_left  <> computed_left
            OR materialized_right <> computed_right
       )
  FROM mlm.v_tree_pv_truth;

-- ---------------------------------------------------------------------------
-- C5: path integrity — every non-root has nlevel(path) = depth + 1
-- ---------------------------------------------------------------------------
INSERT INTO staging.reconcile_results (check_name, status, source_value, target_value, drift, offending_rows)
SELECT 'tree.path_integrity',
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
       NULL, NULL, NULL,
       count(*)
  FROM mlm.affiliate
 WHERE nlevel(path) <> depth + 1;

-- ---------------------------------------------------------------------------
-- C6: orphan affiliates (parent_id points to non-existent affiliate)
-- ---------------------------------------------------------------------------
INSERT INTO staging.reconcile_results (check_name, status, source_value, target_value, drift, offending_rows)
SELECT 'tree.orphans',
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
       NULL, NULL, NULL, count(*)
  FROM mlm.affiliate a
 WHERE a.parent_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM mlm.affiliate p WHERE p.id = a.parent_id);

-- ---------------------------------------------------------------------------
-- C7: every affiliate has a person; every person with auth.user link is unique
-- ---------------------------------------------------------------------------
INSERT INTO staging.reconcile_results (check_name, status, source_value, target_value, drift, offending_rows)
SELECT 'identity.affiliate_has_person',
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
       NULL, NULL, NULL, count(*)
  FROM mlm.affiliate a LEFT JOIN mlm.person p ON p.id = a.person_id
 WHERE p.id IS NULL;

-- ---------------------------------------------------------------------------
-- C8: legacy unpaired transactions count (informational)
--     Not a failure — captures the $348M concepto 16 backlog as a single number.
-- ---------------------------------------------------------------------------
INSERT INTO staging.reconcile_results (check_name, status, source_value, target_value, drift, offending_rows, details)
SELECT 'legacy.unpaired_amount',
       'WARN',  -- always warn so it surfaces on the dashboard
       NULL, NULL, NULL,
       count(*),
       jsonb_build_object(
         'total_amount', sum(wm.amount),
         'concept_breakdown', (
           SELECT jsonb_agg(jsonb_build_object('concept_id', concept_id, 'sum', s, 'n', n))
             FROM (
               SELECT concept_id, sum(amount) AS s, count(*) AS n
                 FROM mlm.wallet_movement wm2
                 JOIN mlm.concept c ON c.id = wm2.concept_id
                WHERE c.requires_pair = false AND c.kind IN ('inter_platform','manual_adjustment','reversal')
                GROUP BY concept_id
             ) x
         )
       )
  FROM mlm.wallet_movement wm
  JOIN mlm.concept c ON c.id = wm.concept_id
 WHERE c.requires_pair = false
   AND c.kind IN ('inter_platform','manual_adjustment','reversal');

-- ---------------------------------------------------------------------------
-- C9: quarantined movements (data quality)
-- ---------------------------------------------------------------------------
INSERT INTO staging.reconcile_results (check_name, status, source_value, target_value, drift, offending_rows, details)
SELECT 'data_quality.quarantined_movements',
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'WARN' END,
       NULL, NULL, NULL, count(*),
       jsonb_build_object(
         'sample', (SELECT jsonb_agg(row_to_json(q))
                      FROM (SELECT idmovement, datemovement, timecreation, idconcept, import
                              FROM staging.movement_quarantine LIMIT 10) q)
       )
  FROM staging.movement_quarantine;

-- ---------------------------------------------------------------------------
-- C10: volumen en 0 (directiva 2026-06-04) — PV piernas y carry deben ser 0
--      para TODOS los afiliados al cutover. El histórico queda en
--      wallet_movement; no genera bloques ni rangos.
-- ---------------------------------------------------------------------------
INSERT INTO staging.reconcile_results (check_name, status, source_value, target_value, drift, offending_rows)
SELECT 'tree.volume_reset_zero',
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
       NULL, NULL, NULL, count(*)
  FROM mlm.affiliate
 WHERE left_pv_lifetime <> 0 OR right_pv_lifetime <> 0
    OR left_pv_current  <> 0 OR right_pv_current  <> 0
    OR left_carry       <> 0 OR right_carry       <> 0;

-- ---------------------------------------------------------------------------
-- C11: rango preservado — todo vicionario con rango legacy debe tener
--      current_rank_id = staging.rank_map(new_rank_id), baseline = puntos
--      del rango, y sus rangos heredados registrados (source='legacy').
-- ---------------------------------------------------------------------------
INSERT INTO staging.reconcile_results (check_name, status, source_value, target_value, drift, offending_rows, details)
SELECT 'rank.preserved_via_map',
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
       NULL, NULL, NULL, count(*),
       jsonb_build_object('sample', (
         SELECT jsonb_agg(row_to_json(x)) FROM (
           SELECT a.legacy_id_vicionario, v.idrank AS legacy_rank,
                  a.current_rank_id, rm.new_rank_id AS expected
             FROM mlm.affiliate a
             JOIN staging.vicionario v ON v.idvicionario = a.legacy_id_vicionario
             LEFT JOIN staging.rank_map rm ON rm.legacy_id_rank = v.idrank
            WHERE v.idrank IS NOT NULL
              AND a.current_rank_id IS DISTINCT FROM rm.new_rank_id
            LIMIT 10) x))
  FROM mlm.affiliate a
  JOIN staging.vicionario v ON v.idvicionario = a.legacy_id_vicionario
  LEFT JOIN staging.rank_map rm ON rm.legacy_id_rank = v.idrank
 WHERE v.idrank IS NOT NULL
   AND a.current_rank_id IS DISTINCT FROM rm.new_rank_id;

INSERT INTO staging.reconcile_results (check_name, status, source_value, target_value, drift, offending_rows)
SELECT 'rank.legacy_achievements_seeded',
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
       NULL, NULL, NULL, count(*)
  FROM mlm.affiliate a
  JOIN mlm.rank cr ON cr.id = a.current_rank_id
 WHERE a.rank_points_baseline <> cr.required_points
    OR NOT EXISTS (
         SELECT 1 FROM mlm.affiliate_rank_achieved x
          WHERE x.affiliate_id = a.id AND x.rank_id = a.current_rank_id
            AND x.source = 'legacy' AND x.bonus_amount_usd = 0);

-- ---------------------------------------------------------------------------
-- Final summary
-- ---------------------------------------------------------------------------
\echo '======================================================================'
\echo 'RECONCILIATION SUMMARY'
\echo '======================================================================'
SELECT check_name, status, drift, offending_rows
  FROM staging.reconcile_results
 ORDER BY CASE status WHEN 'FAIL' THEN 1 WHEN 'WARN' THEN 2 ELSE 3 END, check_name;

\echo ''
\echo 'Failures (must be zero before cutover):'
SELECT check_name, drift, offending_rows, details
  FROM staging.reconcile_results
 WHERE status = 'FAIL';

-- Exit non-zero if any FAIL — script can be wrapped in CI/cron
DO $$
DECLARE v_fails int;
BEGIN
  SELECT count(*) INTO v_fails FROM staging.reconcile_results WHERE status = 'FAIL';
  IF v_fails > 0 THEN
    RAISE EXCEPTION 'Reconciliation FAILED: % checks did not pass. Cutover blocked.', v_fails;
  END IF;
END $$;

\echo 'All FAIL checks clear. Cutover may proceed (review WARNs separately).'
