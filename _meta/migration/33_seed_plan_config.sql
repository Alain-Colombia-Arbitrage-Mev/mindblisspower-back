-- 33_seed_plan_config.sql — Capa 3: config de comisiones baseline (v2-baseline).
-- Solo inserta si no hay ninguna config activa. Primer INSERT con bypass
-- autorizado (no existe cadena de approval aún). Valores = ADR-0012 + defaults
-- v1.3 (founders 10%/10%, royalty 5%, CD 365d). yield_enabled=false porque el
-- ROI lo da el CD (cd_roi_tier), no el R2 yield del cierre binario.
DO $$
DECLARE
  v_admin bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM mlm.plan_config
              WHERE effective_from <= now() AND (effective_to IS NULL OR effective_to > now())) THEN
    RAISE NOTICE 'plan_config activa ya existe; no se siembra.';
    RETURN;
  END IF;

  SELECT id INTO v_admin FROM mlm.person
   WHERE lower(email) = 'devfidubit@gmail.com' OR is_admin
   ORDER BY (lower(email)='devfidubit@gmail.com') DESC, id LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'no hay persona admin para created_by_person_id';
  END IF;

  PERFORM set_config('app.bypass_approval', 'on', true);  -- solo para este seed
  INSERT INTO mlm.plan_config (
    version_label, effective_from,
    block_size, bonus_per_block, depth_cap, daily_cap_factor, lifetime_cap_factor,
    treasury_alpha, carry_decay_days, qualified_directs_left, qualified_directs_right,
    period_cap_factor,
    royalty_enabled, royalty_rate, referral_rate,
    founder_enrollment_open, founder_referral_rate, founder_binary_matched_rate,
    yield_enabled, cd_lock_days, cd_qualified_directs, cd_same_tier_required,
    directs_active_required, retirement_age, retirement_early_penalty,
    created_by_person_id, notes)
  VALUES (
    'v2-baseline', now(),
    500, 10.00, 10, 3.0, 2.0,
    0.45, 14, 1, 1,
    0,
    true, 0.05, 0.05,
    true, 0.10, 0.10,
    false, 365, 2, true,
    true, 65, 0.10,
    v_admin, 'Seed baseline v2 (Capa 3) — editable por four-eyes');
  RAISE NOTICE 'plan_config v2-baseline sembrada (created_by=%).', v_admin;
END $$;
