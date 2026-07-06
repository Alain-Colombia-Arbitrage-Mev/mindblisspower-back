-- 36_monthly_settlement_report.sql — Función de reporte: agrega wallet_movement
-- del mes en mlm.monthly_settlement (gross = retirement + withdrawable).
-- Idempotente: borra las filas del mes antes de re-insertar.
-- El ruteo real (debit 1007 / crédito bonus) lo hace el motor (retirement.go)
-- al postear; esta función sólo lee y agrega para reporte. Usar amount * c.factor
-- para obtener el valor económico positivo en ambas direcciones:
--   concept 1007 (factor +1): amount +50 * +1 = +50 → to_retirement_usd  (factor flipped by migration 37)
--   bonus kinds (factor +1): amount +50 * +1 = +50 → net_available_usd
BEGIN;

CREATE OR REPLACE FUNCTION mlm.fn_rebuild_monthly_settlement(p_month date)
RETURNS integer LANGUAGE sql AS $$
  WITH del AS (
    DELETE FROM mlm.monthly_settlement
     WHERE settlement_month = date_trunc('month', p_month)::date
    RETURNING 1
  ),
  bonuses AS (
    SELECT wm.affiliate_id,
           COALESCE(SUM(wm.amount * c.factor) FILTER (WHERE c.id = 1007), 0)                                                                              AS to_ret,
           COALESCE(SUM(wm.amount * c.factor) FILTER (WHERE c.kind IN ('binary_bonus','direct_bonus','r2_yield','r3_points','rank_bonus','royalty')), 0)    AS to_wd
      FROM mlm.wallet_movement wm
      JOIN mlm.concept c ON c.id = wm.concept_id
     WHERE date_trunc('month', wm.posted_at)::date = date_trunc('month', p_month)::date
       AND (c.id = 1007 OR c.kind IN ('binary_bonus','direct_bonus','r2_yield','r3_points','rank_bonus','royalty'))
     GROUP BY wm.affiliate_id
  ),
  ins AS (
    INSERT INTO mlm.monthly_settlement
      (settlement_month, affiliate_id, gross_accrued_usd, to_retirement_usd, net_available_usd, available_at)
    SELECT
      date_trunc('month', p_month)::date,
      affiliate_id,
      to_ret + to_wd,
      to_ret,
      to_wd,
      mlm.fn_bonus_available_at(
        (date_trunc('month', p_month) + interval '1 month - 1 day')::timestamptz
      )::date
      FROM bonuses
     WHERE to_ret + to_wd > 0
    RETURNING 1
  )
  SELECT count(*)::integer FROM ins;
$$;

COMMIT;

\echo '=== 36_monthly_settlement_report.sql aplicado ==='
