package bonusengine

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

// cdROIConceptID = concepto 1006 'ROI diario CD' (seed schema_payouts_v1.3).
const cdROIConceptID = 1006

// CDROIResult resume un run de devengo diario de ROI sobre CDs activos.
type CDROIResult struct {
	CDsProcessed int
	Posted       int             // movimientos de ROI posteados
	Matured      int             // CDs que llegaron a matures_at
	TotalUSD     decimal.Decimal // ROI bruto devengado en el run
}

// cdAccrualRow: estado mínimo de un CD activo para devengar.
type cdAccrualRow struct {
	id, affID   int64
	principal   decimal.Decimal
	startDate   time.Time
	maturesDate time.Time
	lastAccrual *time.Time
	baseRate    decimal.Decimal
	qualRate    decimal.Decimal
	qualifies   bool
}

// AccrueCDROIDaily devenga el ROI diario de todos los investment_cd activos.
// Por cada CD acredita  principal × tasa/365 × días_desde_último_devengo,  con
// tasa = qualified_annual_rate si v_cd_qualification.qualifies_uplift (1 directo
// activo a cada lado con CD de tier ≥), si no base_annual_rate. El movimiento se
// postea con concept=1006 y available_at = matures_at — o sea el ROI queda
// BLOQUEADO hasta vencer el CD (365 días). Idempotente por external_ref
// "cdroi:<cd_id>:<fecha_corte>". Marca el CD 'matured' al llegar a matures_at.
//
// Corre aunque el cierre binario esté apagado (es el mecanismo de ROI de la red).
func (e *Engine) AccrueCDROIDaily(ctx context.Context) (CDROIResult, error) {
	start := time.Now()
	defer func() { e.roiRunDuration.Observe(time.Since(start).Seconds()) }()

	var res CDROIResult
	res.TotalUSD = decimal.Zero

	tx, err := e.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return res, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // safe tras Commit

	// "Hoy" en la zona de negocio (consistente con available_at/liquidación).
	var today time.Time
	if err := tx.QueryRow(ctx, `SELECT (now() AT TIME ZONE $1)::date`, e.tz).Scan(&today); err != nil {
		return res, fmt.Errorf("today: %w", err)
	}

	// start_at/matures_at son timestamptz: un `::date` pelado los resuelve en el
	// TimeZone de la SESIÓN (UTC, shared/db.pool), no en la zona de negocio, y
	// restarlos contra `today` (zona de negocio) desfasa `days` en un día durante
	// la franja en que ambas fechas divergen. Se castean en la misma zona que
	// `today`. last_accrual_date ya es `date` — no depende de la sesión.
	rows, err := tx.Query(ctx, `
		SELECT cd.id, cd.affiliate_id, cd.principal_usd,
		       (cd.start_at   AT TIME ZONE $1)::date,
		       (cd.matures_at AT TIME ZONE $1)::date,
		       cd.last_accrual_date,
		       t.base_annual_rate, t.qualified_annual_rate,
		       COALESCE(q.qualifies_uplift, false)
		  FROM mlm.investment_cd cd
		  JOIN mlm.cd_roi_tier t ON t.id = cd.roi_tier_id
		  LEFT JOIN mlm.v_cd_qualification q ON q.investment_cd_id = cd.id
		 WHERE cd.status = 'active'
		 ORDER BY cd.id`, e.tz)
	if err != nil {
		return res, fmt.Errorf("query active CDs: %w", err)
	}
	var cds []cdAccrualRow
	for rows.Next() {
		var c cdAccrualRow
		if err := rows.Scan(&c.id, &c.affID, &c.principal, &c.startDate, &c.maturesDate,
			&c.lastAccrual, &c.baseRate, &c.qualRate, &c.qualifies); err != nil {
			rows.Close()
			return res, fmt.Errorf("scan cd: %w", err)
		}
		cds = append(cds, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return res, err
	}

	wallets := map[int64]int64{}
	for _, c := range cds {
		res.CDsProcessed++

		// Fecha de corte = min(hoy, vencimiento). El ROI nunca devenga más allá del CD.
		cutoff := today
		if c.maturesDate.Before(cutoff) {
			cutoff = c.maturesDate
		}
		lastDate := c.startDate
		if c.lastAccrual != nil {
			lastDate = *c.lastAccrual
		}
		days := int(cutoff.Sub(lastDate).Hours() / 24)

		if days > 0 {
			rate := c.baseRate
			if c.qualifies {
				rate = c.qualRate
			}
			// ROI bruto del tramo = principal × tasa_anual / 365 × días.
			gross := c.principal.Mul(rate).Div(decimal.NewFromInt(365)).
				Mul(decimal.NewFromInt(int64(days))).RoundDown(2)
			if gross.Sign() > 0 {
				walletID, werr := e.ensureUSDWallet(ctx, tx, c.affID, wallets)
				if werr != nil {
					return res, werr
				}
				extRef := fmt.Sprintf("cdroi:%d:%s", c.id, cutoff.Format("2006-01-02"))
				posted, perr := e.postCDROI(ctx, tx, walletID, c.affID, gross, c.maturesDate, extRef)
				if perr != nil {
					return res, perr
				}
				if posted {
					res.Posted++
					res.TotalUSD = res.TotalUSD.Add(gross)
					// Read model del CD: acumular ROI + avanzar corte + sellar calificación.
					if _, err := tx.Exec(ctx, `
						UPDATE mlm.investment_cd
						   SET roi_accrued_usd = roi_accrued_usd + $2,
						       last_accrual_date = $3,
						       qualified_since = COALESCE(qualified_since, CASE WHEN $4 THEN now() END)
						 WHERE id = $1`, c.id, gross, cutoff, c.qualifies); err != nil {
						return res, fmt.Errorf("update cd %d: %w", c.id, err)
					}
				}
			}
		}

		// Vencimiento: si llegó a matures_at, cerrar el devengo.
		if !today.Before(c.maturesDate) {
			ct, err := tx.Exec(ctx, `UPDATE mlm.investment_cd SET status='matured', closed_at=now() WHERE id=$1 AND status='active'`, c.id)
			if err != nil {
				return res, fmt.Errorf("mature cd %d: %w", c.id, err)
			}
			if ct.RowsAffected() > 0 {
				res.Matured++
			}
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return res, fmt.Errorf("commit: %w", err)
	}
	e.lastROIRun.SetToCurrentTime()
	e.payoutsTotalUSD.Add(must(res.TotalUSD))
	return res, nil
}

// postCDROI postea un movimiento de ROI (concept 1006) con available_at = matures
// (bloqueado hasta vencer). Idempotente por external_ref: si la transacción ya
// existe devuelve false (ya posteado) sin duplicar. Devuelve true si posteó.
func (e *Engine) postCDROI(ctx context.Context, tx pgx.Tx, walletID, affID int64, amount decimal.Decimal, matures time.Time, extRef string) (bool, error) {
	var txnID string
	err := tx.QueryRow(ctx, `
		INSERT INTO mlm.transaction (external_ref, description, status, posted_at)
		VALUES ($1, $2, 'posted', now())
		ON CONFLICT (external_ref) DO NOTHING
		RETURNING id`, extRef, "ROI diario CD").Scan(&txnID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil // ya posteado en una corrida previa (idempotente)
	}
	if err != nil {
		return false, fmt.Errorf("upsert txn %s: %w", extRef, err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO mlm.wallet_movement
		  (transaction_id, wallet_id, affiliate_id, concept_id, amount, posted_at, available_at)
		VALUES ($1, $2, $3, $4, $5, now(), $6::date)
	`, txnID, walletID, affID, cdROIConceptID, amount, matures); err != nil {
		return false, fmt.Errorf("insert roi movement %s: %w", extRef, err)
	}
	return true, nil
}

// ensureUSDWallet resuelve (cacheado) la wallet USD del afiliado; la crea si no
// existe (ledger interno). address es un placeholder determinístico.
func (e *Engine) ensureUSDWallet(ctx context.Context, tx pgx.Tx, affID int64, cache map[int64]int64) (int64, error) {
	if id, ok := cache[affID]; ok {
		return id, nil
	}
	var walletID int64
	err := tx.QueryRow(ctx, `
		SELECT w.id FROM mlm.wallet w JOIN mlm.asset s ON s.id = w.asset_id
		 WHERE w.affiliate_id = $1 AND s.symbol='USD' LIMIT 1`, affID).Scan(&walletID)
	if errors.Is(err, pgx.ErrNoRows) {
		addr := fmt.Sprintf("ledger:%d", affID)
		if err := tx.QueryRow(ctx, `
			INSERT INTO mlm.wallet (affiliate_id, asset_id, address, balance)
			SELECT $1, (SELECT id FROM mlm.asset WHERE symbol='USD' LIMIT 1), $2, 0
			RETURNING id`, affID, addr).Scan(&walletID); err != nil {
			return 0, fmt.Errorf("create usd wallet aff %d: %w", affID, err)
		}
	} else if err != nil {
		return 0, fmt.Errorf("usd wallet aff %d: %w", affID, err)
	}
	cache[affID] = walletID
	return walletID, nil
}

// must convierte un decimal a float64 para el contador Prometheus (best-effort).
func must(d decimal.Decimal) float64 {
	f, _ := d.Float64()
	return f
}
