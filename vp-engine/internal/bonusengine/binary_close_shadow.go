package bonusengine

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

// CloseBinaryPeriodShadow corre los pasos 1-7 del cierre canónico (carga
// plan_config, suma inflows, enumera candidates, computa theta) pero escribe
// el resultado a mlm.binary_block_payment_shadow en lugar de la tabla canónica.
//
// NO toca:
//   - mlm.wallet_movement (no postea pagos reales)
//   - mlm.binary_period (no cambia status)
//   - mlm.binary_node_state (no acumula counters reales)
//   - mlm.package_cap_state
//
// Diseño: corre en una transacción que se ROLLBACK al final salvo por los
// inserts a binary_block_payment_shadow (idempotentes via shadow_run_id).
//
// Uso esperado: 30 días pre-cutover, comparar diariamente con
// mlm.v_shadow_diff. Cero divergencias > $0.01 = OK para cutover.
func (e *Engine) CloseBinaryPeriodShadow(ctx context.Context, periodID int64, shadowRunID int64, engineVersion string) (*PeriodSnapshot, error) {
	log := e.log.With().Int64("period_id", periodID).Int64("shadow_run_id", shadowRunID).Logger()

	tx, err := e.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	plan, err := LoadActivePlanConfig(ctx, tx)
	if err != nil {
		return nil, err
	}

	var pStart, pEnd interface{}
	if err := tx.QueryRow(ctx,
		"SELECT period_start, period_end FROM mlm.binary_period WHERE id=$1",
		periodID).Scan(&pStart, &pEnd); err != nil {
		return nil, err
	}
	var inflows decimal.Decimal
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(wm.amount), 0)
		  FROM mlm.wallet_movement wm
		  JOIN mlm.concept c ON c.id = wm.concept_id
		 WHERE c.kind = 'package_purchase'
		   AND wm.posted_at >= $1 AND wm.posted_at < $2`,
		pStart, pEnd).Scan(&inflows); err != nil {
		return nil, err
	}

	candidates, eventsCount, err := EnumerateCandidates(ctx, tx, periodID, plan)
	if err != nil {
		return nil, err
	}

	projected := decimal.Zero
	for _, c := range candidates {
		projected = projected.Add(c.GrossAmount)
	}
	theta := ComputeTheta(plan.TreasuryAlpha, inflows, projected)

	// Cerrar la tx read-only; abrir una RW solo para los inserts shadow.
	_ = tx.Rollback(ctx)

	tx2, err := e.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("begin shadow write tx: %w", err)
	}
	defer tx2.Rollback(ctx)

	totalPaid := decimal.Zero
	for _, c := range candidates {
		net := c.GrossAmount.Mul(theta).Round(2)
		if net.Sign() <= 0 {
			continue
		}
		_, err := tx2.Exec(ctx, `
			INSERT INTO mlm.binary_block_payment_shadow
			  (binary_period_id, plan_config_id, affiliate_id, source_event_id,
			   blocks, gross_amount, theta_applied, net_amount,
			   cap_daily_reduction, cap_package_reduction, transaction_id,
			   posted_at, shadow_run_id, shadow_engine_version)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, $11, $12, $13)
			ON CONFLICT DO NOTHING`,
			periodID, plan.ID, c.AffiliateID, c.SourceEventID,
			c.NewBlocks, c.GrossAmount, theta, net,
			c.CapDailyReduction, c.CapPackageReduction, pEnd,
			shadowRunID, engineVersion)
		if err != nil {
			return nil, fmt.Errorf("insert shadow payment: %w", err)
		}
		totalPaid = totalPaid.Add(net)
	}

	if err := tx2.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit shadow: %w", err)
	}

	snapshot := &PeriodSnapshot{
		PeriodID:          periodID,
		InflowsTotal:      inflows,
		EventsCount:       eventsCount,
		CandidatesCount:   len(candidates),
		ProjectedOutflows: projected,
		Theta:             theta,
		TotalPaid:         totalPaid,
	}
	log.Info().
		Str("inflows", inflows.String()).
		Str("total_paid", totalPaid.String()).
		Str("theta", theta.String()).
		Msg("shadow run completed")
	return snapshot, nil
}
