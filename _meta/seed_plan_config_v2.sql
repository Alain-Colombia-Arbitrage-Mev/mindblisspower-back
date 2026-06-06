-- =============================================================================
-- VicionPower — Seed de plan_config v2-candados
-- Config recomendada (docs/plan_integral_vicionpower.md §7, snapshot
-- 2026-05-14) + carrera de rangos activa (tabla real 2026-06-04).
--
-- Pre-req:
--   1. schema_mlm.sql ... schema_payouts_v1.1.sql aplicados.
--   2. schema_payouts_v1.2.sql + schema_ranks.sql aplicados.
--   3. seed_plan_config_v1.sql YA aplicado (v2 cierra v1).
--
-- Uso:
--   psql -U migrator -d vicionpower -v admin_id=<person_id> -f seed_plan_config_v2.sql
-- =============================================================================

\if :{?admin_id}
\else
  \echo 'ERROR: variable admin_id no provista. Usar: psql -v admin_id=<id> ...'
  \quit
\endif

BEGIN;

-- NOTA: psql NO interpola :variables dentro de $$...$$ (seed v1 tiene ese
-- bug latente). Se pasa vía GUC de transacción:
SELECT set_config('app.seed_admin_id', :'admin_id', true);

DO $$
DECLARE v_admin bigint := current_setting('app.seed_admin_id')::bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM mlm.person WHERE id = v_admin AND is_admin = true) THEN
    RAISE EXCEPTION 'admin_id=% no existe o no tiene is_admin=true', v_admin;
  END IF;
END $$;

-- Bypass del trigger de approval — autorizado SOLO para el seed inicial.
SET LOCAL app.bypass_approval = 'on';

-- Cerrar la vigencia de v1 en el instante en que arranca v2
UPDATE mlm.plan_config
   SET effective_to = now()
 WHERE version_label = 'v1-conservative'
   AND effective_to IS NULL;

INSERT INTO mlm.plan_config (
  version_label, effective_from, effective_to,
  -- binario base (ADR-0012)
  block_size, bonus_per_block, depth_cap,
  daily_cap_factor, lifetime_cap_factor, treasury_alpha,
  carry_decay_days, qualified_directs_left, qualified_directs_right,
  -- T3 sin rangos (ADR-0014)
  period_cap_factor,
  -- R1 recompra (ADR-0013, modo P-C)
  depth_repurchase_enabled, repurchase_threshold, purchase_stale_periods,
  pause_mode, pause_reduction_factor, paused_carry_decay_periods,
  renewal_cost_factor,
  -- R2 yield (ADR-0015)
  yield_enabled, yield_annual_rate, yield_cadence_periods,
  capital_lock_periods,
  -- R3 puntos (ADR-0016)
  points_enabled, points_per_block, points_dollars_per_point, points_cadence_periods,
  -- Carrera de rangos (ADR-0017) + Mitigación B (cuotas, 2026-06-05)
  ranks_enabled, rank_installments, rank_installment_cadence,
  -- Regalía gen-2 + referido + fundadores (spec 2026-06-04)
  royalty_enabled, royalty_rate, royalty_generation,
  referral_rate,
  founder_enrollment_open, founder_referral_rate, founder_binary_matched_rate,
  -- CD + jubilación + liquidación
  cd_lock_days, cd_qualified_directs, cd_same_tier_required,
  directs_active_required,
  retirement_age, retirement_early_penalty,
  settlement_available_lag,
  created_by_person_id, approval_request_id, notes
) VALUES (
  'v2-candados',
  now(), NULL,
  500,       -- B: tamaño de bloque
  10.00,     -- r: bonus por bloque (USD)
  10,        -- D: depth_cap
  3.0,       -- K_user (fallback legacy; period_cap_factor manda)
  2.0,       -- K_pkg: lifetime cap × paquete
  0.45,      -- alpha
  14,        -- carry decay (días)
  1, 1,      -- Q_L / Q_R
  0.50,      -- T3 = 0.5 × paquete por período (ADR-0014)
  true, 10, 4,            -- R1: enabled, threshold 10 niveles, stale 4 períodos
  'reduce', 0.50, 4,      -- P-C reduce 50% (ganador del sweep), decay carry 4
  0.10,                   -- renovación = 10% del paquete activo
  true, 0.25, 4,          -- R2: yield 25% anual, cadencia mensual
  52,                     -- lock capital 12 meses (semanas)
  true, 1.00, 1.00, 4,    -- R3: 1 pt/bloque, $1/pt, cadencia mensual
  true, 4, 4,             -- carrera activa; bonos en 4 cuotas mensuales (θ 0.48→1.00)
  true, 0.05, 2,          -- regalía: 5% de compras de la 2ª generación
  0,                      -- referido base (no-fundador): definir; fundador usa 10%
  true, 0.10, 0.10,       -- fundadores: ventana abierta, 10% referido + 10% matched
  365, 2, true,           -- CD: lock 365d, 2 directos tier ≥ propio
  true,                   -- uplift exige directos ACTIVOS (re-verificado por período)
  65, 0.10,               -- jubilación: permanencia 65 años, penalidad 10%
  interval '1 month 1 day', -- retirable 1 mes + 1 día tras cierre de mes
  :admin_id,
  NULL,
  'v2-candados: ADR-0013 (R1 P-C), ADR-0014 (T3 proporcional), ADR-0015 '
  || '(R2 yield + lock 12m), ADR-0016 (R3 puntos), ADR-0017 (carrera 14 '
  || 'rangos, bonos fijos, T1 sólo). Bypass autorizado para el seed; cambios '
  || 'subsiguientes pasan por approval_request (ADR 0010).'
)
ON CONFLICT (version_label) DO NOTHING;

-- Verificar que quedó exactamente uno vigente
DO $$
DECLARE v_count integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM mlm.plan_config
   WHERE effective_to IS NULL OR effective_to > now();
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Estado inconsistente: % plan_config vigentes (esperado 1)', v_count;
  END IF;
END $$;

-- Log de auditoría
INSERT INTO audit.activity_log (
  actor_user_id, action, entity_type, entity_id, after_data, occurred_at
)
SELECT
  (SELECT user_id FROM mlm.person WHERE id = :admin_id),
  'plan_config.seed',
  'plan_config',
  pc.id::text,
  to_jsonb(pc),
  now()
FROM mlm.plan_config pc
WHERE pc.version_label = 'v2-candados';

COMMIT;

\echo ''
\echo 'plan_config v2-candados insertado. Verificar:'
\echo '  SELECT * FROM mlm.plan_config WHERE version_label = ''v2-candados'';'
