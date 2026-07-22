package bonusengine

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/shopspring/decimal"
)

// PeriodSnapshot es el resultado inmutable del cierre.
type PeriodSnapshot struct {
	PeriodID          int64
	InflowsTotal      decimal.Decimal
	EventsCount       int
	CandidatesCount   int
	ProjectedOutflows decimal.Decimal
	Theta             decimal.Decimal
	TotalPaid         decimal.Decimal
}

// CloseBinaryPeriod implementa el algoritmo de _meta/binary_spec.md.
//
// Idempotente: re-correr sobre un período cerrado retorna el snapshot existente.
// Concurrencia: pg_advisory_xact_lock sobre period_id (la 2da llamada espera
// dentro de la tx; al recibir el lock, comprueba que sigue 'open' y aborta si no).
func (e *Engine) CloseBinaryPeriod(ctx context.Context, periodID int64) error {
	timer := prometheus.NewTimer(e.closeRunDuration)
	defer timer.ObserveDuration()
	log := e.log.With().Int64("period_id", periodID).Logger()

	// 0. Idempotencia: snapshot si ya está closed
	var status string
	if err := e.db.QueryRow(ctx,
		"SELECT status FROM mlm.binary_period WHERE id = $1", periodID).Scan(&status); err != nil {
		return fmt.Errorf("load period: %w", err)
	}
	if status == "closed" {
		log.Info().Msg("period already closed; no-op")
		return nil
	}
	if status != "open" {
		return fmt.Errorf("%w: status=%s", ErrPeriodNotOpen, status)
	}

	tx, err := e.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) // safe after Commit

	// Advisory lock per-period; waits for any concurrent close to finish.
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", periodID); err != nil {
		return fmt.Errorf("advisory lock: %w", err)
	}
	// Re-check status under lock
	if err := tx.QueryRow(ctx,
		"SELECT status FROM mlm.binary_period WHERE id = $1 FOR UPDATE", periodID).Scan(&status); err != nil {
		return err
	}
	if status == "closed" {
		return nil
	}
	if status != "open" {
		return fmt.Errorf("%w: status=%s under lock", ErrConcurrentClose, status)
	}

	plan, err := LoadActivePlanConfig(ctx, tx)
	if err != nil {
		return err
	}

	if _, err := tx.Exec(ctx,
		"UPDATE mlm.binary_period SET status='closing' WHERE id=$1", periodID); err != nil {
		return fmt.Errorf("set closing: %w", err)
	}

	// Cargar period_start/end + sumar inflows.
	var pStart, pEnd time.Time
	if err := tx.QueryRow(ctx,
		"SELECT period_start, period_end FROM mlm.binary_period WHERE id=$1",
		periodID).Scan(&pStart, &pEnd); err != nil {
		return err
	}
	var inflows decimal.Decimal
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(wm.amount), 0)
		  FROM mlm.wallet_movement wm
		  JOIN mlm.concept c ON c.id = wm.concept_id
		 WHERE c.kind = 'package_purchase'
		   AND wm.posted_at >= $1 AND wm.posted_at < $2`,
		pStart, pEnd).Scan(&inflows); err != nil {
		return fmt.Errorf("sum inflows: %w", err)
	}
	log.Info().Str("inflows", inflows.String()).Msg("inflows frozen")

	candidates, eventsCount, err := EnumerateCandidates(ctx, tx, periodID, plan)
	if err != nil {
		return fmt.Errorf("enumerate candidates: %w", err)
	}
	e.candidatesCounter.Add(float64(len(candidates)))
	log.Info().Int("events", eventsCount).Int("candidates", len(candidates)).Msg("enumerated")

	projected := decimal.Zero
	binaryByAff := make(map[int64]decimal.Decimal, len(candidates))
	for _, c := range candidates {
		projected = projected.Add(c.GrossAmount)
		binaryByAff[c.AffiliateID] = binaryByAff[c.AffiliateID].Add(c.GrossAmount)
	}

	// Streams v2 (ADR-0015..0018): yield, puntos, rangos, referido, regalía.
	// TODOS entran a projected antes de θ — el sello T1 escala parejo.
	v2, err := ComputeV2Streams(ctx, tx, plan, periodID, pStart, pEnd, binaryByAff)
	if err != nil {
		return fmt.Errorf("enumerate v2 streams: %w", err)
	}
	projected = projected.Add(v2.ProjectedTotal())
	log.Info().
		Int("yield", len(v2.Yield)).Int("points", len(v2.Points)).
		Int("ranks", len(v2.Ranks)).Int("referral", len(v2.Referral)).
		Int("royalty", len(v2.Royalty)).Msg("v2 streams enumerated")

	theta := ComputeTheta(plan.TreasuryAlpha, inflows, projected)
	thetaF, _ := theta.Float64()
	e.thetaGauge.Set(thetaF)
	log.Info().Str("projected", projected.String()).Str("theta", theta.String()).Msg("theta computed")

	// Concept ID de binary_bonus
	var binaryConceptID int
	if err := tx.QueryRow(ctx,
		"SELECT id FROM mlm.concept WHERE kind='binary_bonus' AND active LIMIT 1").
		Scan(&binaryConceptID); err != nil {
		return fmt.Errorf("load binary_bonus concept: %w", err)
	}

	totalPaid := decimal.Zero
	postedAt := pEnd                 // todos los pagos del período al instante de cierre lógico
	walletCache := map[int64]int64{} // caché wallet USD por afiliado
	retWallets := map[int64]int64{}  // caché wallet USD-RET por afiliado (separado del USD)

	for _, c := range candidates {
		net := c.GrossAmount.Mul(theta).RoundDown(2)
		// ADR-0013 R1 modo P-C (reduce): el moroso cobra reducido. El resto
		// queda en tesorería. P-A (skip) ya se filtró en la enumeración.
		if !c.R1Qualified && plan.PauseMode == "reduce" {
			net = net.Mul(plan.PauseReductionFactor).RoundDown(2)
		}
		if net.Sign() <= 0 {
			continue
		}
		extRef := fmt.Sprintf("binary:%d:%d:%d", periodID, c.AffiliateID, c.SourceEventID)

		// 1. transaction
		var txnID string
		err := tx.QueryRow(ctx, `
			INSERT INTO mlm.transaction (external_ref, description, status, posted_at)
			VALUES ($1, $2, 'pending', $3)
			ON CONFLICT (external_ref) DO UPDATE SET description = EXCLUDED.description
			RETURNING id`,
			extRef, fmt.Sprintf("binary bonus period=%d", periodID), postedAt).Scan(&txnID)
		if err != nil {
			return fmt.Errorf("upsert txn (%s): %w", extRef, err)
		}

		// 2. wallet_movement — ruteo 401k: toRet va al plan, toWd al billetera.
		pct, err := pctToPlanFor(ctx, tx, c.AffiliateID, "binary_bonus")
		if err != nil {
			return fmt.Errorf("pctToPlanFor (%s): %w", extRef, err)
		}
		toRet, toWd := routeSplit(net, pct)
		if err := postRetirementContribution(ctx, tx, c.AffiliateID, toRet, extRef, postedAt, plan.RetirementAge, retWallets); err != nil {
			return fmt.Errorf("retirement contribution (%s): %w", extRef, err)
		}
		if toWd.Sign() > 0 {
			walletID, ok := walletCache[c.AffiliateID]
			if !ok {
				if err := tx.QueryRow(ctx, `
					SELECT w.id FROM mlm.wallet w
					  JOIN mlm.asset s ON s.id = w.asset_id
					 WHERE w.affiliate_id = $1 AND s.symbol = 'USD'
					 LIMIT 1`, c.AffiliateID).Scan(&walletID); err != nil {
					return fmt.Errorf("wallet for affiliate %d: %w", c.AffiliateID, err)
				}
				walletCache[c.AffiliateID] = walletID
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO mlm.wallet_movement
				  (transaction_id, wallet_id, affiliate_id, concept_id,
				   vicionario_package_id, amount, posted_at, available_at)
				VALUES ($1, $2, $3, $4, $5, $6, $7, mlm.fn_bonus_available_at($7))`,
				txnID, walletID, c.AffiliateID, binaryConceptID,
				c.AffiliatePackageID, toWd, postedAt); err != nil {
				return fmt.Errorf("insert wallet_movement: %w", err)
			}
		}

		// 3. binary_block_payment (los triggers T2/T3 validan caps)
		if _, err := tx.Exec(ctx, `
			INSERT INTO mlm.binary_block_payment
			  (binary_period_id, plan_config_id, affiliate_id, source_event_id,
			   blocks, gross_amount, theta_applied, net_amount,
			   cap_daily_reduction, cap_package_reduction,
			   transaction_id, posted_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
			ON CONFLICT (affiliate_id, binary_period_id, source_event_id, posted_at) DO NOTHING`,
			periodID, plan.ID, c.AffiliateID, c.SourceEventID,
			c.NewBlocks, c.GrossAmount, theta, net,
			c.CapDailyReduction, c.CapPackageReduction, txnID, postedAt); err != nil {
			return fmt.Errorf("insert block_payment: %w", err)
		}

		// 4. binary_node_state
		if _, err := tx.Exec(ctx, `
			INSERT INTO mlm.binary_node_state
			  (affiliate_id, binary_period_id, blocks_paid_left, blocks_paid_right,
			   paid_today_amount, paid_today_date, paid_period_amount, qualified, updated_at)
			VALUES ($1, $2,
			        CASE WHEN $3='L' THEN $4 ELSE 0 END,
			        CASE WHEN $3='R' THEN $4 ELSE 0 END,
			        $5, ($6 AT TIME ZONE 'America/Bogota')::date, $5, true, now())
			ON CONFLICT (affiliate_id, binary_period_id) DO UPDATE SET
			  blocks_paid_left  = mlm.binary_node_state.blocks_paid_left  + EXCLUDED.blocks_paid_left,
			  blocks_paid_right = mlm.binary_node_state.blocks_paid_right + EXCLUDED.blocks_paid_right,
			  paid_today_amount = mlm.binary_node_state.paid_today_amount + EXCLUDED.paid_today_amount,
			  paid_today_date   = EXCLUDED.paid_today_date,
			  paid_period_amount= mlm.binary_node_state.paid_period_amount + EXCLUDED.paid_today_amount,
			  qualified         = true,
			  updated_at        = now()`,
			c.AffiliateID, periodID, c.Side, c.NewBlocks, net, postedAt); err != nil {
			return fmt.Errorf("upsert node_state: %w", err)
		}

		// 5. package_cap_state (trigger T2)
		if _, err := tx.Exec(ctx,
			"UPDATE mlm.package_cap_state SET paid_total = paid_total + $1 WHERE affiliate_package_id = $2",
			net, c.AffiliatePackageID); err != nil {
			return fmt.Errorf("update package_cap: %w", err)
		}

		// 6. transaction → posted (validación pair-balance dispara aquí; binary
		//    es factor=+1 unpaired, pasa)
		if _, err := tx.Exec(ctx,
			"UPDATE mlm.transaction SET status='posted' WHERE id=$1", txnID); err != nil {
			return fmt.Errorf("post txn: %w", err)
		}

		totalPaid = totalPaid.Add(net)
		netF, _ := net.Float64()
		e.payoutsTotalUSD.Add(netF)
	}

	// Pagar streams v2 (yield, conversión de puntos, rangos, referido,
	// regalía) con el MISMO θ del período. PayV2Streams paga sobre el
	// snapshot de puntos previo a este período y resetea points_accrued=0.
	v2Paid, err := PayV2Streams(ctx, tx, plan, periodID, v2, theta, postedAt)
	if err != nil {
		return fmt.Errorf("pay v2 streams: %w", err)
	}
	totalPaid = totalPaid.Add(v2Paid)
	v2PaidF, _ := v2Paid.Float64()
	e.payoutsTotalUSD.Add(v2PaidF)
	log.Info().Str("v2_paid", v2Paid.String()).Msg("v2 streams paid")

	// R3 — acumular los puntos de ESTE período DESPUÉS del pago+reset, para
	// que no los borre el reset. Se difieren al siguiente ciclo (H2: antes
	// se acumulaban antes del reset y el período de cadencia perdía sus
	// propios puntos).
	if err := AccruePoints(ctx, tx, plan, candidates, theta); err != nil {
		return fmt.Errorf("accrue points: %w", err)
	}

	// Snapshot de cierre
	if _, err := tx.Exec(ctx, `
		UPDATE mlm.binary_period
		   SET status='closed',
		       inflows_total=$2, events_count=$3, candidates_count=$4,
		       projected_outflows=$5, theta=$6, total_paid=$7,
		       closed_at=now()
		 WHERE id=$1`,
		periodID, inflows, eventsCount, len(candidates),
		projected, theta, totalPaid); err != nil {
		return fmt.Errorf("close period: %w", err)
	}

	// Carry decay (función definida en schema_payouts_v1.1.sql §5)
	if _, err := tx.Exec(ctx, "SELECT mlm.fn_expire_carry($1)", periodID); err != nil {
		return fmt.Errorf("expire carry: %w", err)
	}

	// T1 paranoia post-cálculo (la fn ya está en schema_payouts.sql)
	var t1Status string
	var t1Paid, t1Max decimal.Decimal
	if err := tx.QueryRow(ctx,
		"SELECT status, total_paid, max_allowed FROM mlm.fn_verify_period_solvency($1)",
		periodID).Scan(&t1Status, &t1Paid, &t1Max); err != nil {
		return fmt.Errorf("verify solvency: %w", err)
	}
	if t1Status != "OK" {
		e.solvencyBreaches.Inc()
		return fmt.Errorf("%w: paid=%s max=%s", ErrSolvencyBreach, t1Paid, t1Max)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}

	// NATS publish (fail-soft; el cierre ya commiteó)
	if e.nats != nil {
		payload := []byte(fmt.Sprintf(
			`{"period_id":%d,"total_paid":"%s","theta":"%s","inflows":"%s"}`,
			periodID, totalPaid.String(), theta.String(), inflows.String()))
		if err := e.nats.Publish("payouts.binary.closed", payload); err != nil {
			log.Warn().Err(err).Msg("publish close event failed")
		}
	}

	log.Info().
		Str("inflows", inflows.String()).
		Str("total_paid", totalPaid.String()).
		Str("theta", theta.String()).
		Int("payments", len(candidates)).
		Msg("binary period closed")
	return nil
}
