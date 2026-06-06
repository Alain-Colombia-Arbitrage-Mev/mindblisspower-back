package bonusengine

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

// PlanConfig en memoria (snapshot del row vigente al cierre).
// Incluye los candados v1.2 (ADR-0013/0014/0015/0016) y los streams v1.3
// (ADR-0017/0018): rangos, regalía, referido, fundadores.
type PlanConfig struct {
	ID                int64
	BlockSize         int
	BonusPerBlock     decimal.Decimal
	DepthCap          int
	DailyCapFactor    decimal.Decimal
	LifetimeCapFactor decimal.Decimal
	TreasuryAlpha     decimal.Decimal
	CarryDecayDays    int
	QualifiedDirectsL int
	QualifiedDirectsR int

	// T3 proporcional al paquete (ADR-0014). 0 = fallback legacy
	// DailyCapFactor × rank.bonus_amount_usd.
	PeriodCapFactor decimal.Decimal

	// R1 — recompra (ADR-0013). Modos: skip (P-A) | carry (P-B) | reduce (P-C).
	DepthRepurchaseEnabled  bool
	RepurchaseThreshold     int
	PurchaseStalePeriods    int
	PauseMode               string
	PauseReductionFactor    decimal.Decimal
	PausedCarryDecayPeriods int
	RenewalCostFactor       decimal.Decimal

	// R2 — yield (ADR-0015)
	YieldEnabled        bool
	YieldAnnualRate     decimal.Decimal
	YieldCadencePeriods int
	CapitalLockPeriods  int

	// R3 — puntos (ADR-0016)
	PointsEnabled         bool
	PointsPerBlock        decimal.Decimal
	PointsDollarsPerPoint decimal.Decimal
	PointsCadencePeriods  int

	// Carrera de rangos (ADR-0017/0018). Mitigación B (2026-06-05): el bono
	// se paga en RankInstallments cuotas cada RankInstallmentCadence
	// períodos (semanas); el hito se marca al cruzar.
	RanksEnabled           bool
	RankInstallments       int
	RankInstallmentCadence int

	// Regalía gen-2 + referido (ADR-0018)
	RoyaltyEnabled    bool
	RoyaltyRate       decimal.Decimal
	RoyaltyGeneration int
	ReferralRate      decimal.Decimal

	// Fundadores (ADR-0018)
	FounderEnrollmentOpen    bool
	FounderReferralRate      decimal.Decimal
	FounderBinaryMatchedRate decimal.Decimal

	// Gate re-verificado: el uplift R2/CD exige directos ACTIVOS por período.
	DirectsActiveRequired bool
}

// Candidate = un pago potencial para un (ancestro, evento_fuente).
type Candidate struct {
	AffiliateID         int64
	SourceEventID       int64
	AffiliatePackageID  int64
	Side                string // 'L' | 'R'
	NewBlocks           int
	GrossAmount         decimal.Decimal // post-caps, pre-theta
	CapDailyReduction   decimal.Decimal
	CapPackageReduction decimal.Decimal
	// R1 (ADR-0013): false si el ancestro no calificaba al enumerar. Con
	// pause_mode='reduce' (P-C) el cierre paga net × PauseReductionFactor;
	// con 'skip' (P-A) el candidato ni se emite.
	R1Qualified bool
}

// LoadActivePlanConfig devuelve el plan vigente al momento de la llamada.
func LoadActivePlanConfig(ctx context.Context, q pgx.Tx) (*PlanConfig, error) {
	const query = `
		SELECT id, block_size, bonus_per_block, depth_cap,
		       daily_cap_factor, lifetime_cap_factor, treasury_alpha,
		       carry_decay_days, qualified_directs_left, qualified_directs_right,
		       period_cap_factor,
		       depth_repurchase_enabled, repurchase_threshold,
		       purchase_stale_periods, pause_mode, pause_reduction_factor,
		       paused_carry_decay_periods, renewal_cost_factor,
		       yield_enabled, yield_annual_rate, yield_cadence_periods,
		       capital_lock_periods,
		       points_enabled, points_per_block, points_dollars_per_point,
		       points_cadence_periods,
		       ranks_enabled, rank_installments, rank_installment_cadence,
		       royalty_enabled, royalty_rate, royalty_generation, referral_rate,
		       founder_enrollment_open, founder_referral_rate,
		       founder_binary_matched_rate,
		       directs_active_required
		  FROM mlm.plan_config
		 WHERE effective_from <= now()
		   AND (effective_to IS NULL OR effective_to > now())
		 ORDER BY effective_from DESC
		 LIMIT 1`
	pc := &PlanConfig{}
	err := q.QueryRow(ctx, query).Scan(
		&pc.ID, &pc.BlockSize, &pc.BonusPerBlock, &pc.DepthCap,
		&pc.DailyCapFactor, &pc.LifetimeCapFactor, &pc.TreasuryAlpha,
		&pc.CarryDecayDays, &pc.QualifiedDirectsL, &pc.QualifiedDirectsR,
		&pc.PeriodCapFactor,
		&pc.DepthRepurchaseEnabled, &pc.RepurchaseThreshold,
		&pc.PurchaseStalePeriods, &pc.PauseMode, &pc.PauseReductionFactor,
		&pc.PausedCarryDecayPeriods, &pc.RenewalCostFactor,
		&pc.YieldEnabled, &pc.YieldAnnualRate, &pc.YieldCadencePeriods,
		&pc.CapitalLockPeriods,
		&pc.PointsEnabled, &pc.PointsPerBlock, &pc.PointsDollarsPerPoint,
		&pc.PointsCadencePeriods,
		&pc.RanksEnabled, &pc.RankInstallments, &pc.RankInstallmentCadence,
		&pc.RoyaltyEnabled, &pc.RoyaltyRate, &pc.RoyaltyGeneration, &pc.ReferralRate,
		&pc.FounderEnrollmentOpen, &pc.FounderReferralRate,
		&pc.FounderBinaryMatchedRate,
		&pc.DirectsActiveRequired)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrNoActivePlanConfig
		}
		return nil, fmt.Errorf("load plan_config: %w", err)
	}
	// P-B (carry) requiere la liberación en el flujo de compra — no está
	// implementado en el cierre de producción. P-C es el modo recomendado
	// (ADR-0015 candado D). Fail-fast antes de pagar mal.
	if pc.DepthRepurchaseEnabled && pc.PauseMode == "carry" {
		return nil, fmt.Errorf("plan_config: pause_mode='carry' (P-B) no implementado en el cierre de producción; usar 'reduce' (P-C, recomendado) o 'skip'")
	}
	return pc, nil
}

// EnumerateCandidates calcula los pagos binarios del período: para cada
// ancestro tocado por algún evento, bloques nuevos = floor(matched/B) −
// bloques ya pagados HISTÓRICAMENTE, con caps T3-luego-T2 (orden vinculante
// de binary_spec.md §4).
//
// Modelo (corrige 3 bugs de la versión anterior, 2026-06-05):
//   - B1: el trigger trg_apply_tree_event YA acreditó los eventos del
//     período a left/right_pv_lifetime al insertarse — NO se re-aplican
//     deltas (la versión previa doble-contaba).
//   - B2: los bloques pagados en períodos ANTERIORES se descuentan
//     (Σ binary_node_state.blocks_paid_*); la versión previa re-pagaba
//     toda la historia en cada cierre.
//   - B3: el cap T2 se cobra contra el paquete activo del ANCESTRO que
//     cobra, no contra el paquete del comprador del evento.
//   - B4: Q_L/Q_R exige dos candados cuando Q>0: hijo binario activo en la
//     pierna Y patrocinado directo activo colocado en esa pierna. Así el
//     spillover estructural no habilita pago sin actividad comercial propia.
//
// Un candidato por ancestro por período (SourceEventID = primer evento del
// período que lo tocó, para trazabilidad). Set-based: una query para el
// universo de ancestros (sin N+1).
func EnumerateCandidates(
	ctx context.Context, tx pgx.Tx, periodID int64, plan *PlanConfig,
) ([]Candidate, int, error) {

	// Conteo de eventos del período (snapshot events_count).
	var eventsCount int
	if err := tx.QueryRow(ctx, `
		SELECT count(*)
		  FROM mlm.tree_event te
		  JOIN mlm.binary_period bp ON bp.id = $1
		 WHERE te.kind = 'pv_credit'
		   AND te.occurred_at >= bp.period_start
		   AND te.occurred_at <  bp.period_end`, periodID).Scan(&eventsCount); err != nil {
		return nil, 0, fmt.Errorf("count events: %w", err)
	}
	if eventsCount == 0 {
		return nil, 0, nil
	}

	// Universo de ancestros tocados por los eventos del período, con todo lo
	// que la calificación y los caps necesitan, en una sola pasada.
	const q = `
		WITH evt AS (
			SELECT te.id, te.affiliate_id
			  FROM mlm.tree_event te
			  JOIN mlm.binary_period bp ON bp.id = $1
			 WHERE te.kind = 'pv_credit'
			   AND te.occurred_at >= bp.period_start
			   AND te.occurred_at <  bp.period_end
		), touched AS (
			SELECT anc.id AS ancestor_id, min(evt.id) AS first_event
			  FROM evt
			  JOIN mlm.affiliate self ON self.id = evt.affiliate_id
			  JOIN mlm.affiliate anc
			    ON self.path <@ anc.path
			   AND anc.id <> self.id
			   AND (self.depth - anc.depth) <= $2
			 GROUP BY anc.id
		)
		SELECT t.ancestor_id,
		       t.first_event,
		       a.status,
		       a.is_founder,
		       a.left_pv_lifetime,
		       a.right_pv_lifetime,
		       COALESCE(ap.id, 0)            AS own_pkg_id,
		       COALESCE(p.amount_usd, 0)     AS own_pkg_amount,
		       COALESCE(r.bonus_amount_usd, 100) AS rank_bonus,
		       EXISTS (SELECT 1 FROM mlm.affiliate ch
		         WHERE ch.parent_id = a.id AND ch.position = 'L' AND ch.status = 'active') AS binary_child_l,
		       EXISTS (SELECT 1 FROM mlm.affiliate ch
		         WHERE ch.parent_id = a.id AND ch.position = 'R' AND ch.status = 'active') AS binary_child_r,
		       (SELECT count(*) FROM mlm.affiliate d
		         WHERE d.sponsor_id = a.id
		           AND d.status = 'active'
		           AND d.path <@ a.path
		           AND substring(ltree2text(subpath(d.path, a.depth + 1, 1)) from 1 for 1) = 'L'
		           AND EXISTS (SELECT 1 FROM mlm.affiliate_package dap
		                        WHERE dap.affiliate_id = d.id AND dap.status = 'active')) AS sponsored_l,
		       (SELECT count(*) FROM mlm.affiliate d
		         WHERE d.sponsor_id = a.id
		           AND d.status = 'active'
		           AND d.path <@ a.path
		           AND substring(ltree2text(subpath(d.path, a.depth + 1, 1)) from 1 for 1) = 'R'
		           AND EXISTS (SELECT 1 FROM mlm.affiliate_package dap
		                        WHERE dap.affiliate_id = d.id AND dap.status = 'active')) AS sponsored_r,
		       COALESCE((SELECT sum(ns.blocks_paid_left + ns.blocks_paid_right)
		                   FROM mlm.binary_node_state ns
		                  WHERE ns.affiliate_id = a.id), 0)::bigint AS blocks_paid_hist,
		       ps.last_purchase_at
		  FROM touched t
		  JOIN mlm.affiliate a ON a.id = t.ancestor_id
		  LEFT JOIN LATERAL (
		        SELECT ap2.id, ap2.package_id
		          FROM mlm.affiliate_package ap2
		         WHERE ap2.affiliate_id = a.id AND ap2.status = 'active'
		         ORDER BY ap2.id LIMIT 1) ap ON true
		  LEFT JOIN mlm.package p  ON p.id = ap.package_id
		  LEFT JOIN mlm.rank r     ON r.id = a.current_rank_id
		  LEFT JOIN mlm.affiliate_payout_state ps ON ps.affiliate_id = a.id
		 ORDER BY t.ancestor_id`

	// Cutoff de frescura R1 (regla stale: requalificación cada N períodos
	// semanales). El depth-threshold del ADR-0013 requiere mantenimiento de
	// max_downline_depth (treewriter, pendiente); la regla operativa de
	// producción es la de staleness (plan integral §4).
	var pEnd time.Time
	if err := tx.QueryRow(ctx,
		"SELECT period_end FROM mlm.binary_period WHERE id=$1", periodID).Scan(&pEnd); err != nil {
		return nil, 0, err
	}
	r1Active := plan.DepthRepurchaseEnabled && plan.PurchaseStalePeriods > 0
	staleCutoff := pEnd.AddDate(0, 0, -7*plan.PurchaseStalePeriods)

	rows, err := tx.Query(ctx, q, periodID, plan.DepthCap)
	if err != nil {
		return nil, 0, fmt.Errorf("query touched ancestors: %w", err)
	}

	// Materializar primero: pgx no permite queries anidadas (p.ej.
	// remainingPackageCap) mientras el cursor está abierto ("conn busy").
	type ancRow struct {
		ancID, firstEvent, ownPkgID, blocksPaidHist int64
		status                                      string
		isFounder                                   bool
		pvL, pvR, ownPkgAmount, rankBonus           decimal.Decimal
		binaryChildL, binaryChildR                  bool
		sponsoredL, sponsoredR                      int
		lastPurchaseAt                              *time.Time
	}
	var ancRows []ancRow
	for rows.Next() {
		var r ancRow
		if err := rows.Scan(&r.ancID, &r.firstEvent, &r.status, &r.isFounder,
			&r.pvL, &r.pvR, &r.ownPkgID, &r.ownPkgAmount, &r.rankBonus,
			&r.binaryChildL, &r.binaryChildR, &r.sponsoredL, &r.sponsoredR,
			&r.blocksPaidHist, &r.lastPurchaseAt); err != nil {
			rows.Close()
			return nil, 0, fmt.Errorf("scan ancestor: %w", err)
		}
		ancRows = append(ancRows, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}

	candidates := make([]Candidate, 0, len(ancRows))
	blockSize := decimal.NewFromInt(int64(plan.BlockSize))

	for _, r := range ancRows {
		ancID, firstEvent, ownPkgID, blocksPaidHist := r.ancID, r.firstEvent, r.ownPkgID, r.blocksPaidHist
		status, isFounder := r.status, r.isFounder
		pvL, pvR, ownPkgAmount, rankBonus := r.pvL, r.pvR, r.ownPkgAmount, r.rankBonus
		binaryChildL, binaryChildR := r.binaryChildL, r.binaryChildR
		sponsoredL, sponsoredR := r.sponsoredL, r.sponsoredR
		lastPurchaseAt := r.lastPurchaseAt

		// Calificación (compresión): activo, con paquete activo, estructura
		// binaria viva y actividad comercial propia en ambas piernas.
		if status != "active" || ownPkgID == 0 {
			continue
		}
		if plan.QualifiedDirectsL > 0 && (!binaryChildL || sponsoredL < plan.QualifiedDirectsL) {
			continue
		}
		if plan.QualifiedDirectsR > 0 && (!binaryChildR || sponsoredR < plan.QualifiedDirectsR) {
			continue
		}

		// R1 staleness (ADR-0013). P-A skip: no se enumera. P-C reduce: se
		// enumera con R1Qualified=false y el cierre paga reducido.
		r1Qualified := true
		if r1Active {
			r1Qualified = lastPurchaseAt != nil && !lastPurchaseAt.Before(staleCutoff)
			if !r1Qualified && plan.PauseMode == "skip" {
				continue
			}
		}

		// Bloques nuevos: matched lifetime − histórico pagado.
		matched := pvL
		side := "L"
		if pvR.LessThan(pvL) {
			matched = pvR
			side = "R"
		}
		newBlocks := matched.Div(blockSize).IntPart() - blocksPaidHist
		if newBlocks <= 0 {
			continue
		}

		gross := plan.BonusPerBlock.Mul(decimal.NewFromInt(newBlocks))
		// ADR-0018 — fundadores: % del matched volume en vez de $/bloque.
		if isFounder && plan.FounderBinaryMatchedRate.Sign() > 0 {
			gross = plan.FounderBinaryMatchedRate.
				Mul(blockSize).Mul(decimal.NewFromInt(newBlocks)).RoundDown(2)
		}

		// T3 — período cap (ORDEN VINCULANTE: T3 primero). ADR-0014:
		// PeriodCapFactor × paquete propio; fallback legacy K_user × rank.
		var periodCap decimal.Decimal
		if plan.PeriodCapFactor.Sign() > 0 {
			periodCap = plan.PeriodCapFactor.Mul(ownPkgAmount)
		} else {
			periodCap = plan.DailyCapFactor.Mul(rankBonus)
		}
		capDaily := decimal.Zero
		if gross.GreaterThan(periodCap) {
			capDaily = gross.Sub(periodCap)
			gross = periodCap
		}

		// T2 — cap lifetime del paquete PROPIO del ancestro.
		pkgRem, err := remainingPackageCap(ctx, tx, ownPkgID)
		if err != nil {
			return nil, 0, err
		}
		capPkg := decimal.Zero
		if gross.GreaterThan(pkgRem) {
			capPkg = gross.Sub(pkgRem)
			gross = pkgRem
		}
		if gross.Sign() <= 0 {
			continue
		}

		candidates = append(candidates, Candidate{
			AffiliateID:         ancID,
			SourceEventID:       firstEvent,
			AffiliatePackageID:  ownPkgID,
			Side:                side,
			NewBlocks:           int(newBlocks),
			GrossAmount:         gross,
			CapDailyReduction:   capDaily,
			CapPackageReduction: capPkg,
			R1Qualified:         r1Qualified,
		})
	}

	return candidates, eventsCount, nil
}

func remainingPackageCap(ctx context.Context, tx pgx.Tx, pkgID int64) (decimal.Decimal, error) {
	if pkgID == 0 {
		return decimal.Zero, fmt.Errorf("event has no affiliate_package_id")
	}
	var cap, paid decimal.Decimal
	err := tx.QueryRow(ctx,
		"SELECT cap_total, paid_total FROM mlm.package_cap_state WHERE affiliate_package_id = $1",
		pkgID).Scan(&cap, &paid)
	if err != nil {
		if err == pgx.ErrNoRows {
			return decimal.Zero, nil // paquete sin cap state = no paga (cerrado o no inicializado)
		}
		return decimal.Zero, fmt.Errorf("load package_cap_state %d: %w", pkgID, err)
	}
	rem := cap.Sub(paid)
	if rem.Sign() < 0 {
		return decimal.Zero, nil
	}
	return rem, nil
}
