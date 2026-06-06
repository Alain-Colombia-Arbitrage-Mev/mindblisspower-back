-- Payouts queries — bonusengine module. Ver _meta/schema_payouts.sql.

-- name: GetActivePlanConfig :one
-- Devuelve el plan_config vigente en una fecha dada (incluye candados v1.2
-- y streams v1.3: R1/R2/R3, rangos, regalía, fundadores, CD, liquidación).
SELECT id, version_label, block_size, bonus_per_block, depth_cap,
       daily_cap_factor, lifetime_cap_factor, treasury_alpha,
       carry_decay_days, qualified_directs_left, qualified_directs_right,
       period_cap_factor,
       depth_repurchase_enabled, repurchase_threshold, purchase_stale_periods,
       pause_mode, pause_reduction_factor, paused_carry_decay_periods,
       renewal_cost_factor,
       yield_enabled, yield_annual_rate, yield_cadence_periods,
       capital_lock_periods,
       points_enabled, points_per_block, points_dollars_per_point,
       points_cadence_periods,
       ranks_enabled,
       royalty_enabled, royalty_rate, royalty_generation,
       referral_rate,
       founder_enrollment_open, founder_referral_rate, founder_binary_matched_rate,
       cd_lock_days, cd_qualified_directs, cd_same_tier_required,
       directs_active_required,
       retirement_age, retirement_early_penalty,
       settlement_available_lag
  FROM mlm.plan_config
 WHERE effective_from <= @at_time
   AND (effective_to IS NULL OR effective_to > @at_time)
 ORDER BY effective_from DESC LIMIT 1;

-- name: GetPendingRankAchievements :many
-- Carrera de rangos (ADR-0017/0018): ascensos calificados aún no otorgados.
-- Espejo inline de mlm.fn_pending_rank_achievements() (sqlc no resuelve
-- columnas de funciones SRF de usuario). Mantener en sync con
-- _meta/schema_ranks.sql §3. El cierre los paga × θ (T1 sólo) e inserta
-- affiliate_rank_achieved.
SELECT a.id                                                     AS affiliate_id,
       r.id                                                     AS rank_id,
       r.bonus_amount_usd,
       (a.left_pv_lifetime  + a.rank_points_baseline)::numeric  AS points_left,
       (a.right_pv_lifetime + a.rank_points_baseline)::numeric  AS points_right
  FROM mlm.affiliate a
  JOIN mlm.rank r
    ON LEAST(a.left_pv_lifetime, a.right_pv_lifetime)
       + a.rank_points_baseline >= r.required_points
 WHERE a.status = 'active'
   AND NOT EXISTS (
         SELECT 1 FROM mlm.affiliate_rank_achieved x
          WHERE x.affiliate_id = a.id AND x.rank_id = r.id)
 ORDER BY a.id, r.required_points;

-- name: InsertRankAchieved :exec
INSERT INTO mlm.affiliate_rank_achieved
  (affiliate_id, rank_id, achieved_at, source, binary_period_id,
   points_left_at, points_right_at, bonus_amount_usd, theta_applied,
   net_amount_usd, transaction_id)
VALUES (@affiliate_id, @rank_id, now(), 'earned', @binary_period_id,
        @points_left_at, @points_right_at, @bonus_amount_usd, @theta_applied,
        @net_amount_usd, @transaction_id)
ON CONFLICT (affiliate_id, rank_id) DO NOTHING;

-- name: GetPayoutState :one
SELECT affiliate_id, max_downline_depth, last_depth_threshold_crossed,
       last_purchase_at, paused_carry, points_accrued,
       last_yield_period_id, last_points_period_id
  FROM mlm.affiliate_payout_state
 WHERE affiliate_id = @affiliate_id;

-- name: UpsertPayoutStatePoints :exec
INSERT INTO mlm.affiliate_payout_state (affiliate_id, points_accrued, updated_at)
VALUES (@affiliate_id, @points_accrued, now())
ON CONFLICT (affiliate_id) DO UPDATE
  SET points_accrued = EXCLUDED.points_accrued, updated_at = now();

-- name: GetBinaryPeriod :one
SELECT id, plan_config_id, period_start, period_end, status,
       inflows_total, theta, total_paid, closed_at
  FROM mlm.binary_period
 WHERE id = @id;

-- name: SetPeriodStatus :exec
UPDATE mlm.binary_period SET status = @status WHERE id = @id;

-- name: ClosePeriod :exec
UPDATE mlm.binary_period
   SET status            = 'closed',
       inflows_total     = @inflows_total,
       events_count      = @events_count,
       candidates_count  = @candidates_count,
       projected_outflows = @projected_outflows,
       theta             = @theta,
       total_paid        = @total_paid,
       closed_at         = now()
 WHERE id = @id;

-- name: SumInflowsForPeriod :one
-- Inflows = compras de paquete dentro del período.
SELECT COALESCE(SUM(wm.amount), 0)::numeric AS total
  FROM mlm.wallet_movement wm
  JOIN mlm.concept c ON c.id = wm.concept_id
 WHERE c.kind = 'package_purchase'
   AND wm.posted_at >= @period_start
   AND wm.posted_at < @period_end;

-- name: GetTreeEventsForPeriod :many
SELECT id, affiliate_id, kind, pv_delta_left, pv_delta_right, payload, occurred_at
  FROM mlm.tree_event
 WHERE occurred_at >= @period_start AND occurred_at < @period_end
   AND kind = 'pv_credit'
 ORDER BY occurred_at;

-- name: GetAncestorsLimit :many
-- Ancestors via ltree path, ordenados por depth ASC, hasta depth_cap niveles.
WITH descendant AS (
  SELECT path, depth FROM mlm.affiliate WHERE id = @affiliate_id
)
SELECT a.id, a.path, a.depth, a.left_pv_current, a.right_pv_current,
       a.current_rank_id, a.status
  FROM mlm.affiliate a, descendant d
 WHERE a.path @> d.path AND a.id <> @affiliate_id
 ORDER BY a.depth ASC
 LIMIT @max_depth;

-- name: InsertBlockPayment :one
-- Triggers fn_enforce_daily_cap dispara si daily_cap excedido.
INSERT INTO mlm.binary_block_payment (
  binary_period_id, plan_config_id, affiliate_id, source_event_id,
  blocks, gross_amount, theta_applied, net_amount,
  cap_daily_reduction, cap_package_reduction,
  transaction_id, posted_at
) VALUES (
  @binary_period_id, @plan_config_id, @affiliate_id, @source_event_id,
  @blocks, @gross_amount, @theta_applied, @net_amount,
  @cap_daily_reduction, @cap_package_reduction,
  @transaction_id, @posted_at
)
RETURNING id;

-- name: UpsertNodeState :exec
INSERT INTO mlm.binary_node_state (
  affiliate_id, binary_period_id,
  blocks_paid_left, blocks_paid_right,
  carry_left, carry_right, carry_started_at,
  paid_today_amount, paid_today_date, paid_period_amount
) VALUES (
  @affiliate_id, @binary_period_id,
  @blocks_paid_left, @blocks_paid_right,
  @carry_left, @carry_right, @carry_started_at,
  @paid_today_amount, @paid_today_date, @paid_period_amount
)
ON CONFLICT (affiliate_id, binary_period_id) DO UPDATE SET
  blocks_paid_left   = mlm.binary_node_state.blocks_paid_left  + EXCLUDED.blocks_paid_left,
  blocks_paid_right  = mlm.binary_node_state.blocks_paid_right + EXCLUDED.blocks_paid_right,
  carry_left         = EXCLUDED.carry_left,
  carry_right        = EXCLUDED.carry_right,
  carry_started_at   = EXCLUDED.carry_started_at,
  paid_today_amount  = CASE WHEN mlm.binary_node_state.paid_today_date = EXCLUDED.paid_today_date
                            THEN mlm.binary_node_state.paid_today_amount + EXCLUDED.paid_today_amount
                            ELSE EXCLUDED.paid_today_amount END,
  paid_today_date    = EXCLUDED.paid_today_date,
  paid_period_amount = mlm.binary_node_state.paid_period_amount + EXCLUDED.paid_period_amount,
  updated_at         = now();

-- name: IncrementPackageCap :exec
-- Trigger fn_enforce_package_cap rechaza si excede cap_total.
UPDATE mlm.package_cap_state
   SET paid_total = paid_total + @increment
 WHERE affiliate_package_id = @affiliate_package_id;

-- name: ExpireCarry :exec
UPDATE mlm.binary_node_state
   SET carry_left = 0, carry_right = 0, carry_started_at = NULL
 WHERE carry_started_at IS NOT NULL AND carry_started_at < @cutoff;

-- name: AcquireLock :exec
-- Advisory lock por period_id para serializar cierres concurrentes.
SELECT pg_advisory_xact_lock(@period_id);
