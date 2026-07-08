// Streams v2 del cierre de período (ADR-0015/0016/0017/0018):
//
//	R2 yield      — 25% anual / 12, cadencia mensual, gate "1 directo ACTIVO
//	                a cada lado" re-verificado por período. T1 sólo.
//	R3 puntos     — acumulados por bloque pagado (post-θ), convertidos a USD
//	                en cadencia. T1 + T2 + T3.
//	Rangos        — bono one-time fijo al cruzar hito de puntos-por-pierna.
//	                T1 sólo. Inserta affiliate_rank_achieved (append-only).
//	Referido      — gen-1: % de cada compra del patrocinado directo
//	                (fundador 10%; no-fundador referral_rate). Gate R2.
//	Regalía       — gen-2: royalty_rate (5%) de cada compra de la 2ª
//	                generación de patrocinio. T1 sólo.
//
// Todos entran a projected ANTES de θ — el sello T1 escala parejo.
// Disponibilidad: todos los movimientos usan available_at =
// mlm.fn_bonus_available_at(posted_at) (liquidación mensual + 1 mes + 1 día).
package bonusengine

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

// V2Streams agrupa los candidatos de los streams no-binarios del período.
type V2Streams struct {
	Yield    []streamEntry
	Points   []pointsEntry
	Ranks    []rankEntry
	Referral []streamEntry
	Royalty  []streamEntry
}

type streamEntry struct {
	AffiliateID int64
	Gross       decimal.Decimal
	ExtRef      string
}

type pointsEntry struct {
	AffiliateID int64
	Gross       decimal.Decimal // post T2/T3, pre-θ
	PackageID   int64           // paquete propio (T2 accounting)
	ExtRef      string
}

// rankEntry es una CUOTA de bono de rango vencida y pendiente de pago.
// (Mitigación B: el ascenso programa N cuotas; cada cierre paga las que
// vencen, × θ de su período.)
type rankEntry struct {
	InstallmentID int64
	AffiliateID   int64
	RankID        int16
	Gross         decimal.Decimal
	ExtRef        string
}

// ProjectedTotal suma todos los gross de los streams (entran a θ).
func (v *V2Streams) ProjectedTotal() decimal.Decimal {
	t := decimal.Zero
	for _, e := range v.Yield {
		t = t.Add(e.Gross)
	}
	for _, e := range v.Points {
		t = t.Add(e.Gross)
	}
	for _, e := range v.Ranks {
		t = t.Add(e.Gross)
	}
	for _, e := range v.Referral {
		t = t.Add(e.Gross)
	}
	for _, e := range v.Royalty {
		t = t.Add(e.Gross)
	}
	return t
}

// periodIndex = posición ordinal del período (1-based) por period_start.
// Determina las cadencias (yield/puntos) de forma determinística.
func periodIndex(ctx context.Context, tx pgx.Tx, periodID int64) (int, error) {
	var idx int
	err := tx.QueryRow(ctx, `
		SELECT count(*)::int
		  FROM mlm.binary_period b
		 WHERE b.period_start <= (SELECT period_start FROM mlm.binary_period WHERE id = $1)`,
		periodID).Scan(&idx)
	return idx, err
}

// directGateSQL: EXISTS de un patrocinado directo ACTIVO en la pierna $leg
// del afiliado a. Con directs_active_required, el directo además debe tener
// recompra fresca (payout_state.last_purchase_at >= cutoff).
// Descendientes de a vía closure (index-backed) en vez de `d.path <@ a.path`
// (seq scan). distance > 0 excluye self. La detección de pierna sigue path-based.
const directGateSQL = `
	EXISTS (
		SELECT 1
		  FROM mlm.affiliate d
		  JOIN mlm.affiliate_closure dc
		    ON dc.ancestor_id = a.id AND dc.descendant_id = d.id AND dc.distance > 0
		  LEFT JOIN mlm.affiliate_payout_state dps ON dps.affiliate_id = d.id
		 WHERE d.sponsor_id = a.id
		   AND d.status = 'active'
		   AND substring(ltree2text(subpath(d.path, a.depth + 1, 1)) from 1 for 1) = %s
		   AND EXISTS (SELECT 1 FROM mlm.affiliate_package dap
		                WHERE dap.affiliate_id = d.id AND dap.status = 'active')
		   AND (NOT $%d OR (dps.last_purchase_at IS NOT NULL AND dps.last_purchase_at >= $%d))
	)`

// ComputeV2Streams enumera todos los streams no-binarios del período.
// binaryByAff = gross binario por afiliado (para el T3 compartido de puntos).
func ComputeV2Streams(
	ctx context.Context, tx pgx.Tx, plan *PlanConfig,
	periodID int64, pStart, pEnd time.Time,
	binaryByAff map[int64]decimal.Decimal,
) (*V2Streams, error) {
	out := &V2Streams{}

	idx, err := periodIndex(ctx, tx, periodID)
	if err != nil {
		return nil, fmt.Errorf("period index: %w", err)
	}
	staleCutoff := pEnd.AddDate(0, 0, -7*max(plan.PurchaseStalePeriods, 1))
	gateActive := plan.DirectsActiveRequired && plan.DepthRepurchaseEnabled && plan.PurchaseStalePeriods > 0

	// ---- R2 yield (cadencia) -------------------------------------------
	if plan.YieldEnabled && plan.YieldCadencePeriods > 0 && idx%plan.YieldCadencePeriods == 0 {
		q := fmt.Sprintf(`
			SELECT a.id, p.amount_usd
			  FROM mlm.affiliate a
			  JOIN LATERAL (
			        SELECT ap.id, ap.package_id FROM mlm.affiliate_package ap
			         WHERE ap.affiliate_id = a.id AND ap.status = 'active'
			         ORDER BY ap.id LIMIT 1) ap ON true
			  JOIN mlm.package p ON p.id = ap.package_id
			 WHERE a.status = 'active'
			   AND a.parent_id IS NOT NULL
			   AND `+directGateSQL+`
			   AND `+directGateSQL+`
			 ORDER BY a.id`,
			"'L'", 1, 2, "'R'", 1, 2)
		rows, err := tx.Query(ctx, q, gateActive, staleCutoff)
		if err != nil {
			return nil, fmt.Errorf("yield candidates: %w", err)
		}
		monthly := plan.YieldAnnualRate.Div(decimal.NewFromInt(12))
		for rows.Next() {
			var affID int64
			var pkgAmount decimal.Decimal
			if err := rows.Scan(&affID, &pkgAmount); err != nil {
				rows.Close()
				return nil, err
			}
			gross := pkgAmount.Mul(monthly).RoundDown(2)
			if gross.Sign() > 0 {
				out.Yield = append(out.Yield, streamEntry{
					AffiliateID: affID,
					Gross:       gross,
					ExtRef:      fmt.Sprintf("r2:%d:%d", periodID, affID),
				})
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}

	// ---- R3 puntos (cadencia, T2+T3 pre-θ) -----------------------------
	if plan.PointsEnabled && plan.PointsCadencePeriods > 0 && idx%plan.PointsCadencePeriods == 0 {
		rows, err := tx.Query(ctx, `
			SELECT ps.affiliate_id, ps.points_accrued,
			       COALESCE(ap.id, 0), COALESCE(p.amount_usd, 0),
			       COALESCE(r.bonus_amount_usd, 100)
			  FROM mlm.affiliate_payout_state ps
			  JOIN mlm.affiliate a ON a.id = ps.affiliate_id AND a.status = 'active'
			  LEFT JOIN LATERAL (
			        SELECT ap2.id, ap2.package_id FROM mlm.affiliate_package ap2
			         WHERE ap2.affiliate_id = a.id AND ap2.status = 'active'
			         ORDER BY ap2.id LIMIT 1) ap ON true
			  LEFT JOIN mlm.package p ON p.id = ap.package_id
			  LEFT JOIN mlm.rank r ON r.id = a.current_rank_id
			 WHERE ps.points_accrued > 0
			 ORDER BY ps.affiliate_id`)
		if err != nil {
			return nil, fmt.Errorf("points candidates: %w", err)
		}
		// Materializar primero: remainingPackageCap no puede correr con el
		// cursor abierto (pgx "conn busy").
		type ptsRow struct {
			affID, pkgID         int64
			pts, pkgAmt, rankBns decimal.Decimal
		}
		var ptsRows []ptsRow
		for rows.Next() {
			var r ptsRow
			if err := rows.Scan(&r.affID, &r.pts, &r.pkgID, &r.pkgAmt, &r.rankBns); err != nil {
				rows.Close()
				return nil, err
			}
			ptsRows = append(ptsRows, r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		for _, r := range ptsRows {
			affID, pkgID := r.affID, r.pkgID
			pts, pkgAmount, rankBonus := r.pts, r.pkgAmt, r.rankBns
			if pkgID == 0 {
				continue // sin paquete activo, no cobra puntos (T2 no definible)
			}
			gross := pts.Mul(plan.PointsDollarsPerPoint).RoundDown(2)

			// T3 compartido con el binario del período.
			var periodCap decimal.Decimal
			if plan.PeriodCapFactor.Sign() > 0 {
				periodCap = plan.PeriodCapFactor.Mul(pkgAmount)
			} else {
				periodCap = plan.DailyCapFactor.Mul(rankBonus)
			}
			t3Rem := periodCap.Sub(binaryByAff[affID])
			if t3Rem.Sign() < 0 {
				t3Rem = decimal.Zero
			}
			if gross.GreaterThan(t3Rem) {
				gross = t3Rem
			}
			// T2 — cap lifetime del paquete propio.
			pkgRem, err := remainingPackageCap(ctx, tx, pkgID)
			if err != nil {
				return nil, err
			}
			if gross.GreaterThan(pkgRem) {
				gross = pkgRem
			}
			if gross.Sign() <= 0 {
				continue
			}
			out.Points = append(out.Points, pointsEntry{
				AffiliateID: affID,
				Gross:       gross,
				PackageID:   pkgID,
				ExtRef:      fmt.Sprintf("r3:%d:%d", periodID, affID),
			})
		}
	}

	// ---- Carrera de rangos (one-time + cuotas, T1 sólo) -----------------
	if plan.RanksEnabled {
		// 1) Ascensos recién calificados: registrar el hito YA (append-only;
		//    el pago vive en las cuotas) y programar las N cuotas. La primera
		//    vence en ESTE cierre.
		type pending struct {
			affID            int64
			rankID           int16
			gross, ptsL, ptsR decimal.Decimal
		}
		rows, err := tx.Query(ctx, `
			SELECT a.id, r.id, r.bonus_amount_usd,
			       (a.left_pv_lifetime  + a.rank_points_baseline)::numeric,
			       (a.right_pv_lifetime + a.rank_points_baseline)::numeric
			  FROM mlm.affiliate a
			  JOIN mlm.rank r
			    ON LEAST(a.left_pv_lifetime, a.right_pv_lifetime)
			       + a.rank_points_baseline >= r.required_points
			 WHERE a.status = 'active'
			   AND NOT EXISTS (
			         SELECT 1 FROM mlm.affiliate_rank_achieved x
			          WHERE x.affiliate_id = a.id AND x.rank_id = r.id)
			 ORDER BY a.id, r.required_points`)
		if err != nil {
			return nil, fmt.Errorf("rank candidates: %w", err)
		}
		var pendings []pending
		for rows.Next() {
			var p pending
			if err := rows.Scan(&p.affID, &p.rankID, &p.gross, &p.ptsL, &p.ptsR); err != nil {
				rows.Close()
				return nil, err
			}
			pendings = append(pendings, p)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}

		nInst := max(plan.RankInstallments, 1)
		cadence := max(plan.RankInstallmentCadence, 1)
		for _, p := range pendings {
			// Hito alcanzado (trigger sincroniza current_rank_id). El neto
			// queda en 0 aquí: la verdad de pago vive en las cuotas.
			if _, err := tx.Exec(ctx, `
				INSERT INTO mlm.affiliate_rank_achieved
				  (affiliate_id, rank_id, achieved_at, source, binary_period_id,
				   points_left_at, points_right_at, bonus_amount_usd,
				   theta_applied, net_amount_usd, transaction_id)
				VALUES ($1, $2, $3, 'earned', $4, $5, $6, $7, NULL, 0, NULL)
				ON CONFLICT (affiliate_id, rank_id) DO NOTHING`,
				p.affID, p.rankID, pEnd, periodID, p.ptsL, p.ptsR, p.gross); err != nil {
				return nil, fmt.Errorf("insert rank_achieved: %w", err)
			}
			// N cuotas iguales (la última lleva el remanente exacto).
			per := p.gross.Div(decimal.NewFromInt(int64(nInst))).RoundDown(2)
			acc := decimal.Zero
			for i := 1; i <= nInst; i++ {
				amt := per
				if i == nInst {
					amt = p.gross.Sub(acc)
				}
				acc = acc.Add(per)
				if amt.Sign() <= 0 {
					continue
				}
				due := pEnd.AddDate(0, 0, 7*cadence*(i-1))
				if _, err := tx.Exec(ctx, `
					INSERT INTO mlm.rank_bonus_installment
					  (affiliate_id, rank_id, installment_no, amount_usd, due_at)
					VALUES ($1, $2, $3, $4, $5::date)
					ON CONFLICT (affiliate_id, rank_id, installment_no) DO NOTHING`,
					p.affID, p.rankID, i, amt, due); err != nil {
					return nil, fmt.Errorf("insert installment: %w", err)
				}
			}
		}

		// 2) Cuotas vencidas y no pagadas (incluye las primeras de hoy):
		//    entran a projected/θ de ESTE período.
		rows, err = tx.Query(ctx, `
			SELECT id, affiliate_id, rank_id, amount_usd
			  FROM mlm.rank_bonus_installment
			 WHERE paid_at IS NULL AND due_at <= $1::date
			 ORDER BY id`, pEnd)
		if err != nil {
			return nil, fmt.Errorf("due installments: %w", err)
		}
		for rows.Next() {
			var e rankEntry
			if err := rows.Scan(&e.InstallmentID, &e.AffiliateID, &e.RankID, &e.Gross); err != nil {
				rows.Close()
				return nil, err
			}
			e.ExtRef = fmt.Sprintf("rankinst:%d:%d", periodID, e.InstallmentID)
			out.Ranks = append(out.Ranks, e)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}

	// ---- Referido gen-1 + regalía gen-2 sobre compras del período -------
	refOn := plan.FounderReferralRate.Sign() > 0 || plan.ReferralRate.Sign() > 0
	royOn := plan.RoyaltyEnabled && plan.RoyaltyRate.Sign() > 0
	if refOn || royOn {
		q := fmt.Sprintf(`
			SELECT wm.id, wm.amount,
			       a.id, a.is_founder,
			       (`+directGateSQL+` AND `+directGateSQL+`) AS sponsor_gate,
			       COALESCE(g2.id, 0), COALESCE(g2.status = 'active', false)
			  FROM mlm.wallet_movement wm
			  JOIN mlm.concept c ON c.id = wm.concept_id AND c.kind = 'package_purchase'
			  JOIN mlm.affiliate buyer ON buyer.id = wm.affiliate_id
			  JOIN mlm.affiliate a ON a.id = buyer.sponsor_id AND a.status = 'active'
			                       AND a.parent_id IS NOT NULL
			  LEFT JOIN mlm.affiliate g2 ON g2.id = a.sponsor_id AND g2.parent_id IS NOT NULL
			 WHERE wm.posted_at >= $3 AND wm.posted_at < $4
			   AND wm.amount > 0
			 ORDER BY wm.posted_at, wm.id`,
			"'L'", 1, 2, "'R'", 1, 2)
		rows, err := tx.Query(ctx, q, gateActive, staleCutoff, pStart, pEnd)
		if err != nil {
			return nil, fmt.Errorf("referral/royalty candidates: %w", err)
		}
		for rows.Next() {
			var movID, spID, g2ID int64
			var amount decimal.Decimal
			var isFounder, gate, g2Active bool
			if err := rows.Scan(&movID, &amount, &spID, &isFounder, &gate, &g2ID, &g2Active); err != nil {
				rows.Close()
				return nil, err
			}
			if refOn && gate {
				rate := plan.ReferralRate
				if isFounder {
					rate = plan.FounderReferralRate
				}
				gross := amount.Mul(rate).RoundDown(2)
				if gross.Sign() > 0 {
					out.Referral = append(out.Referral, streamEntry{
						AffiliateID: spID,
						Gross:       gross,
						ExtRef:      fmt.Sprintf("ref:%d:%d", periodID, movID),
					})
				}
			}
			if royOn && g2ID != 0 && g2Active {
				gross := amount.Mul(plan.RoyaltyRate).RoundDown(2)
				if gross.Sign() > 0 {
					out.Royalty = append(out.Royalty, streamEntry{
						AffiliateID: g2ID,
						Gross:       gross,
						ExtRef:      fmt.Sprintf("roy:%d:%d", periodID, movID),
					})
				}
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}

	return out, nil
}

// conceptIDByKind: lookup de concepto activo por kind (kinds únicos v1.3).
func conceptIDByKind(ctx context.Context, tx pgx.Tx, kind string) (int, error) {
	var id int
	err := tx.QueryRow(ctx,
		"SELECT id FROM mlm.concept WHERE kind = $1 AND active ORDER BY id DESC LIMIT 1",
		kind).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("concept kind=%s: %w", kind, err)
	}
	return id, nil
}

// referralConceptID: 1012 'Bono referido directo' (kind=direct_bonus se
// comparte con conceptos legacy migrados → id explícito del seed v1.2).
const referralConceptID = 1012

// postStreamPayment postea un pago de stream: rutea la porción a jubilación
// (concept 1007 → wallet USD-RET, CRÉDITO positivo), y postea el remanente
// retirable como movimiento en la wallet USD (available_at = fn_bonus_available_at).
// walletCache = caché de IDs de wallets USD; retWallets = caché SEPARADO para
// wallets USD-RET (ambos son mapas affiliateID→walletID en memoria del período).
// Devuelve el transaction id, o "" si toWd==0 (todo fue a jubilación — I1 fix).
func postStreamPayment(
	ctx context.Context, tx pgx.Tx,
	conceptID int, conceptKind string, affiliateID int64, net decimal.Decimal,
	extRef, description string, postedAt time.Time, retirementAge int,
	walletCache map[int64]int64,
	retWallets map[int64]int64,
) (string, error) {
	// Ruteo 401k: parte del net va a jubilación (USD-RET), el resto retirable (USD).
	pct, err := pctToPlanFor(ctx, tx, affiliateID, conceptKind)
	if err != nil {
		return "", err
	}
	toRet, toWd := routeSplit(net, pct)
	if err := postRetirementContribution(ctx, tx, affiliateID, toRet, extRef, postedAt, retirementAge, retWallets); err != nil {
		return "", err
	}
	// I1: cuando todo el net fue a jubilación no hay monto retirable. El movimiento
	// :ret ya fue posteado en USD-RET; no crear una transaction USD vacía.
	// Los callers (pay/Points) ignoran el id; Ranks lo guarda sólo si != "".
	if toWd.Sign() <= 0 {
		return "", nil
	}

	var txnID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO mlm.transaction (external_ref, description, status, posted_at)
		VALUES ($1, $2, 'pending', $3)
		ON CONFLICT (external_ref) DO UPDATE SET description = EXCLUDED.description
		RETURNING id`, extRef, description, postedAt).Scan(&txnID); err != nil {
		return "", fmt.Errorf("upsert txn (%s): %w", extRef, err)
	}
	walletID, ok := walletCache[affiliateID]
	if !ok {
		if err := tx.QueryRow(ctx, `
			SELECT w.id FROM mlm.wallet w JOIN mlm.asset s ON s.id = w.asset_id
			 WHERE w.affiliate_id = $1 AND s.symbol = 'USD' LIMIT 1`, affiliateID).Scan(&walletID); err != nil {
			return "", fmt.Errorf("wallet for affiliate %d: %w", affiliateID, err)
		}
		walletCache[affiliateID] = walletID
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO mlm.wallet_movement (transaction_id, wallet_id, affiliate_id, concept_id, amount, posted_at, available_at)
		VALUES ($1, $2, $3, $4, $5, $6, mlm.fn_bonus_available_at($6))`,
		txnID, walletID, affiliateID, conceptID, toWd, postedAt); err != nil {
		return "", fmt.Errorf("insert movement (%s): %w", extRef, err)
	}
	if _, err := tx.Exec(ctx, "UPDATE mlm.transaction SET status='posted' WHERE id=$1", txnID); err != nil {
		return "", fmt.Errorf("post txn (%s): %w", extRef, err)
	}
	return txnID, nil
}

// PayV2Streams aplica θ y postea todos los streams. Devuelve el total neto.
// Efectos colaterales:
//   - Rangos: INSERT affiliate_rank_achieved (trigger sincroniza current_rank_id).
//   - Puntos: package_cap_state += net (T2) y payout_state.points_accrued = 0.
func PayV2Streams(
	ctx context.Context, tx pgx.Tx, plan *PlanConfig,
	periodID int64, v2 *V2Streams, theta decimal.Decimal, postedAt time.Time,
) (decimal.Decimal, error) {
	total := decimal.Zero
	wallets := map[int64]int64{}    // caché wallet USD por afiliado
	retWallets := map[int64]int64{} // caché wallet USD-RET por afiliado (separado)

	pay := func(conceptID int, conceptKind string, e streamEntry, desc string) error {
		net := e.Gross.Mul(theta).RoundDown(2)
		if net.Sign() <= 0 {
			return nil
		}
		if _, err := postStreamPayment(ctx, tx, conceptID, conceptKind, e.AffiliateID, net,
			e.ExtRef, desc, postedAt, plan.RetirementAge, wallets, retWallets); err != nil {
			return err
		}
		total = total.Add(net)
		return nil
	}

	if len(v2.Yield) > 0 {
		cid, err := conceptIDByKind(ctx, tx, "r2_yield")
		if err != nil {
			return total, err
		}
		for _, e := range v2.Yield {
			if err := pay(cid, "r2_yield", e, fmt.Sprintf("R2 yield period=%d", periodID)); err != nil {
				return total, err
			}
		}
	}

	if len(v2.Points) > 0 {
		cid, err := conceptIDByKind(ctx, tx, "r3_points")
		if err != nil {
			return total, err
		}
		for _, e := range v2.Points {
			net := e.Gross.Mul(theta).RoundDown(2)
			if net.Sign() <= 0 {
				continue
			}
			if _, err := postStreamPayment(ctx, tx, cid, "r3_points", e.AffiliateID, net,
				e.ExtRef, fmt.Sprintf("R3 points period=%d", periodID), postedAt, plan.RetirementAge, wallets, retWallets); err != nil {
				return total, err
			}
			// T2 accounting del paquete propio.
			if _, err := tx.Exec(ctx,
				"UPDATE mlm.package_cap_state SET paid_total = paid_total + $1 WHERE affiliate_package_id = $2",
				net, e.PackageID); err != nil {
				return total, fmt.Errorf("points package_cap: %w", err)
			}
			// Reset de puntos convertidos (los caps destruyen el exceso,
			// mismo contrato que el simulador).
			if _, err := tx.Exec(ctx, `
				UPDATE mlm.affiliate_payout_state
				   SET points_accrued = 0, last_points_period_id = $2, updated_at = now()
				 WHERE affiliate_id = $1`, e.AffiliateID, periodID); err != nil {
				return total, fmt.Errorf("points reset: %w", err)
			}
			total = total.Add(net)
		}
	}

	if len(v2.Ranks) > 0 {
		cid, err := conceptIDByKind(ctx, tx, "rank_bonus")
		if err != nil {
			return total, err
		}
		for _, e := range v2.Ranks {
			// Cada cuota se liquida al θ de SU período, sin reintentos
			// (θ=0 ⇒ cuota saldada en $0 — mismo contrato que el bono único).
			net := e.Gross.Mul(theta).RoundDown(2)
			var txnID *string
			if net.Sign() > 0 {
				id, err := postStreamPayment(ctx, tx, cid, "rank_bonus", e.AffiliateID, net,
					e.ExtRef, fmt.Sprintf("rank installment period=%d rank=%d", periodID, e.RankID),
					postedAt, plan.RetirementAge, wallets, retWallets)
				if err != nil {
					return total, err
				}
				// id=="" cuando toWd==0 (todo a jubilación); la cuota sigue saldada
				// pero la FK transaction_id queda NULL (el :ret txn lleva el movimiento).
				if id != "" {
					txnID = &id
				}
				total = total.Add(net)
			}
			if _, err := tx.Exec(ctx, `
				UPDATE mlm.rank_bonus_installment
				   SET paid_at = $2, theta_applied = $3, net_amount_usd = $4,
				       binary_period_id = $5, transaction_id = $6
				 WHERE id = $1`,
				e.InstallmentID, postedAt, theta, net, periodID, txnID); err != nil {
				return total, fmt.Errorf("settle installment %d: %w", e.InstallmentID, err)
			}
		}
	}

	if len(v2.Referral) > 0 {
		for _, e := range v2.Referral {
			if err := pay(referralConceptID, "direct_bonus", e, fmt.Sprintf("referral period=%d", periodID)); err != nil {
				return total, err
			}
		}
	}

	if len(v2.Royalty) > 0 {
		cid, err := conceptIDByKind(ctx, tx, "royalty")
		if err != nil {
			return total, err
		}
		for _, e := range v2.Royalty {
			if err := pay(cid, "royalty", e, fmt.Sprintf("royalty period=%d", periodID)); err != nil {
				return total, err
			}
		}
	}

	return total, nil
}

// AccruePoints registra los puntos R3 generados por los bloques binarios
// realmente pagados (bloques efectivos = floor(NewBlocks × θ)).
func AccruePoints(
	ctx context.Context, tx pgx.Tx, plan *PlanConfig,
	candidates []Candidate, theta decimal.Decimal,
) error {
	if !plan.PointsEnabled {
		return nil
	}
	accrued := map[int64]decimal.Decimal{}
	for _, c := range candidates {
		eff := decimal.NewFromInt(int64(c.NewBlocks)).Mul(theta).Floor()
		if eff.Sign() <= 0 {
			continue
		}
		accrued[c.AffiliateID] = accrued[c.AffiliateID].Add(eff.Mul(plan.PointsPerBlock))
	}
	for affID, pts := range accrued {
		if _, err := tx.Exec(ctx, `
			INSERT INTO mlm.affiliate_payout_state (affiliate_id, points_accrued, updated_at)
			VALUES ($1, $2, now())
			ON CONFLICT (affiliate_id) DO UPDATE
			  SET points_accrued = mlm.affiliate_payout_state.points_accrued + EXCLUDED.points_accrued,
			      updated_at = now()`, affID, pts); err != nil {
			return fmt.Errorf("accrue points aff=%d: %w", affID, err)
		}
	}
	return nil
}