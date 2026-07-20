package payments

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/vicionpower/vp-engine/internal/withdrawals"
)

// TTLs de caché para lecturas calientes.
const (
	financeCacheTTL        = 20 * time.Second
	solvencyCacheTTL       = 20 * time.Second
	memberCacheTTL         = 15 * time.Second
	sustainabilityCacheTTL = time.Hour
)

// MoneyflowRow es un agregado del ledger por tipo de concepto (kind).
type MoneyflowRow struct {
	Kind     string `json:"kind"`      // binary_bonus | roi | r2_yield | rank_bonus | royalty | withdrawal | package_purchase | platform_fee | ...
	TotalUSD string `json:"total_usd"` // SUM(amount * factor) — neto con signo del concepto
	Count    int64  `json:"count"`
}

// AdminFinance es el tablero financiero de la red: todo el dinero en un vistazo.
type AdminFinance struct {
	// Entrante (caja real vía nuestro checkout Stripe).
	InflowsUSD string `json:"inflows_usd"` // Σ(amount+fee) de compras paid|activated
	PacksPaid  int64  `json:"packs_paid"`  // # de packs pagados
	FeesUSD    string `json:"fees_usd"`    // Σ del 1% de manejo

	// Distribuido a la red (ledger).
	CommissionsDistributedUSD string `json:"commissions_distributed_usd"` // Σ créditos a miembros (todos los bonos)
	PendingPayoutUSD          string `json:"pending_payout_usd"`          // balance vivo en wallets (lo que se debe, no retirado)
	MaturingUSD               string `json:"maturing_usd"`                // créditos aún no madurados (no retirables)

	// Rangos.
	RanksAchieved int64  `json:"ranks_achieved"`  // # de hitos de rango alcanzados
	RanksBonusUSD string `json:"ranks_bonus_usd"` // Σ neto pagado por rangos

	// Retiros.
	WithdrawalsPaidUSD    string `json:"withdrawals_paid_usd"`    // BRUTO pagado (lo que se debitó al afiliado)
	WithdrawalsPendingUSD string `json:"withdrawals_pending_usd"` // solicitados|aprobados sin pagar

	// Ingreso por comisión de retiro (4%): Σ fee_usd de retiros PAGADOS. El
	// afiliado se debita el bruto pero solo el neto sale de caja; el fee se
	// queda en la empresa (ver migración 49) y es INGRESO, no un simple resto.
	WithdrawalFeeIncomeUSD string `json:"withdrawal_fee_income_usd"`

	// Dinero de la empresa (retenido) ≈ entrante − comisiones − retiros pagados (NETO).
	TreasuryUSD string `json:"treasury_usd"`

	// Desglose del flujo por concepto.
	Moneyflow []MoneyflowRow `json:"moneyflow"`
}

// GetAdminFinance arma el tablero financiero agregando ledger + compras + rangos.
func (s *Store) GetAdminFinance(ctx context.Context) (AdminFinance, error) {
	var f AdminFinance
	if s.cache.get(ctx, "fin:admin", &f) {
		return f, nil
	}

	// Entrante real (nuestro endpoint Stripe). Excluye cargos no verificados en
	// Stripe live (stripe_present=false, p.ej. pruebas) para no inflar ingresos.
	if err := s.reader().QueryRow(ctx, `
		SELECT COALESCE(SUM(amount_usd + fee_usd),0)::text,
		       COALESCE(count(*),0),
		       COALESCE(SUM(fee_usd),0)::text
		  FROM payments.purchase_intent
		 WHERE status IN ('paid','activated') AND stripe_present IS DISTINCT FROM false
	`).Scan(&f.InflowsUSD, &f.PacksPaid, &f.FeesUSD); err != nil {
		return f, fmt.Errorf("inflows: %w", err)
	}

	// Distribuido / pendiente (ledger). SOLO bonos/ROI a miembros: se EXCLUYEN
	// inflows y fees (package_purchase/platform_fee/inter_platform).
	if err := s.reader().QueryRow(ctx, `
		SELECT
		  COALESCE(SUM(wm.amount) FILTER (WHERE wm.amount > 0),0)::text,                                   -- distribuido (créditos)
		  COALESCE(SUM(wm.amount) FILTER (WHERE NOT wm.is_frozen),0)::text,                                -- balance vivo (neto)
		  COALESCE(SUM(wm.amount) FILTER (WHERE NOT wm.is_frozen AND wm.amount > 0 AND wm.available_at > current_date),0)::text -- madurando
		  FROM mlm.wallet_movement wm
		  JOIN mlm.concept c ON c.id = wm.concept_id
		 WHERE `+withdrawals.ExcludedKindsPredicate+`
	`).Scan(&f.CommissionsDistributedUSD, &f.PendingPayoutUSD, &f.MaturingUSD); err != nil {
		return f, fmt.Errorf("ledger totals: %w", err)
	}

	// Rangos alcanzados + dinero pagado por rangos.
	if err := s.reader().QueryRow(ctx, `
		SELECT COALESCE(count(*),0), COALESCE(SUM(net_amount_usd),0)::text
		  FROM mlm.affiliate_rank_achieved
	`).Scan(&f.RanksAchieved, &f.RanksBonusUSD); err != nil {
		return f, fmt.Errorf("ranks: %w", err)
	}

	// Retiros. WithdrawalsPaidUSD es el BRUTO (amount_usd): lo que se debitó de
	// la wallet del afiliado — coincide con el asiento contable 1013. El fee
	// (ingreso de la empresa) se reporta aparte en WithdrawalFeeIncomeUSD.
	if err := s.reader().QueryRow(ctx, `
		SELECT
		  COALESCE(SUM(amount_usd) FILTER (WHERE status='paid'),0)::text,
		  COALESCE(SUM(amount_usd) FILTER (WHERE status IN ('requested','approved')),0)::text,
		  COALESCE(SUM(fee_usd) FILTER (WHERE status='paid'),0)::text
		  FROM mlm.withdrawal_request
	`).Scan(&f.WithdrawalsPaidUSD, &f.WithdrawalsPendingUSD, &f.WithdrawalFeeIncomeUSD); err != nil {
		return f, fmt.Errorf("withdrawals: %w", err)
	}

	// Tesorería ≈ entrante − comisiones distribuidas − retiros pagados EN NETO.
	//
	// El afiliado solicita el BRUTO (amount_usd) y se le debita el bruto de su
	// wallet interna, pero de la CAJA REAL de la empresa solo sale el NETO
	// (net_usd = amount_usd - fee_usd): el fee (4%) nunca sale, se queda como
	// ingreso de la empresa. Restar amount_usd aquí subestima la tesorería en
	// exactamente Σfee_usd (ver WithdrawalFeeIncomeUSD arriba).
	//
	// COALESCE(net_usd, amount_usd): net_usd es NULL solo para filas insertadas
	// por un binario viejo durante la ventana de deploy de la migración 49
	// (fee_usd/net_usd nacen NULL, sin default — no hay backfill retroactivo
	// para ellas). Ante esa incertidumbre asumimos que no se cobró fee (neto =
	// bruto), igual que el criterio ya usado por el backfill histórico de la
	// migración: nunca inventamos un fee que no conste. Los retiros históricos
	// anteriores al fee (backfill de la migración 49) ya tienen net_usd =
	// amount_usd explícito, así que el COALESCE es un no-op para ellos.
	if err := s.reader().QueryRow(ctx, `
		SELECT (
		  (SELECT COALESCE(SUM(amount_usd+fee_usd),0) FROM payments.purchase_intent WHERE status IN ('paid','activated') AND stripe_present IS DISTINCT FROM false)
		  - (SELECT COALESCE(SUM(wm.amount),0) FROM mlm.wallet_movement wm JOIN mlm.concept c ON c.id=wm.concept_id
		      WHERE wm.amount > 0 AND `+withdrawals.ExcludedKindsPredicate+`)
		  - (SELECT COALESCE(SUM(COALESCE(net_usd, amount_usd)),0) FROM mlm.withdrawal_request WHERE status='paid')
		)::text
	`).Scan(&f.TreasuryUSD); err != nil {
		return f, fmt.Errorf("treasury: %w", err)
	}

	// Moneyflow por concepto (neto con signo del concepto).
	rows, err := s.reader().Query(ctx, `
		SELECT c.kind::text,
		       COALESCE(SUM(wm.amount * c.factor),0)::text,
		       count(*)
		  FROM mlm.wallet_movement wm
		  JOIN mlm.concept c ON c.id = wm.concept_id
		 GROUP BY c.kind
		 ORDER BY SUM(ABS(wm.amount)) DESC
	`)
	if err != nil {
		return f, fmt.Errorf("moneyflow: %w", err)
	}
	defer rows.Close()
	f.Moneyflow = []MoneyflowRow{}
	for rows.Next() {
		var m MoneyflowRow
		if err := rows.Scan(&m.Kind, &m.TotalUSD, &m.Count); err != nil {
			return f, err
		}
		f.Moneyflow = append(f.Moneyflow, m)
	}
	if err := rows.Err(); err != nil {
		return f, err
	}
	s.cache.set(ctx, "fin:admin", f, financeCacheTTL)
	return f, nil
}

// RecentActivity devuelve el feed de eventos de dominio recientes (Redis Stream).
func (s *Store) RecentActivity(ctx context.Context, n int64) ([]DomainEvent, error) {
	if n <= 0 || n > 200 {
		n = 50
	}
	return s.cache.RecentEvents(ctx, n)
}

// SolvencyPeriod es una fila de la vista de solvencia (v_period_solvency).
type SolvencyPeriod struct {
	PeriodID         int64   `json:"period_id"`
	PeriodStart      string  `json:"period_start"`
	PeriodEnd        string  `json:"period_end"`
	Status           string  `json:"status"` // open | closing | closed | aborted
	InflowsUSD       string  `json:"inflows_usd"`
	ProjectedUSD     string  `json:"projected_outflows_usd"`
	Theta            *string `json:"theta,omitempty"` // null si no cerrado
	TotalPaidUSD     *string `json:"total_paid_usd,omitempty"`
	MaxPayoutUSD     string  `json:"max_payout_allowed_usd"`
	SolvencyStatus   string  `json:"solvency_status"` // pending | OK | BREACH
	PayoutPctInflows *string `json:"payout_pct_of_inflow,omitempty"`
}

// Solvency es el monitor de salud de la red: ¿el árbol está por romperse?
type Solvency struct {
	Health        string           `json:"health"`         // OK | WARN | BREACH | UNKNOWN
	Alert         string           `json:"alert"`          // mensaje legible para el admin
	TreasuryAlpha string           `json:"treasury_alpha"` // α vigente (ej 0.45)
	Current       *SolvencyPeriod  `json:"current"`        // período abierto/más reciente
	Recent        []SolvencyPeriod `json:"recent"`         // últimos cerrados (tendencia de θ)
}

// GetSolvency lee v_period_solvency y deriva un semáforo de salud. La proyección
// continua del período abierto (shadow close en vivo) es la Capa 2; aquí se
// expone θ histórico real + el período vigente con su techo de pago (α×inflows).
func (s *Store) GetSolvency(ctx context.Context) (Solvency, error) {
	var out Solvency
	if s.cache.get(ctx, "solvency", &out) {
		return out, nil
	}
	out.Health = "UNKNOWN"
	out.Recent = []SolvencyPeriod{}

	// α vigente del plan activo.
	_ = s.reader().QueryRow(ctx, `
		SELECT treasury_alpha::text FROM mlm.plan_config
		 WHERE effective_from <= now() AND (effective_to IS NULL OR effective_to > now())
		 ORDER BY effective_from DESC LIMIT 1
	`).Scan(&out.TreasuryAlpha)
	if out.TreasuryAlpha == "" {
		out.TreasuryAlpha = "0.45"
	}

	scan := func(sql string, args ...any) (*SolvencyPeriod, error) {
		var p SolvencyPeriod
		err := s.reader().QueryRow(ctx, sql, args...).Scan(
			&p.PeriodID, &p.PeriodStart, &p.PeriodEnd, &p.Status,
			&p.InflowsUSD, &p.ProjectedUSD, &p.Theta, &p.TotalPaidUSD,
			&p.MaxPayoutUSD, &p.SolvencyStatus, &p.PayoutPctInflows)
		if err != nil {
			return nil, err
		}
		return &p, nil
	}

	const cols = `
		id,
		to_char(period_start,'YYYY-MM-DD"T"HH24:MI:SSZ'),
		to_char(period_end,'YYYY-MM-DD"T"HH24:MI:SSZ'),
		status::text,
		COALESCE(inflows_total,0)::text,
		COALESCE(projected_outflows,0)::text,
		theta::text,
		total_paid::text,
		COALESCE(max_payout_allowed,0)::text,
		solvency_status,
		payout_pct_of_inflow::text`

	// Período vigente: el más reciente. Para un período ABIERTO la vista deja
	// inflows_total en NULL (se congela al cerrar) → computamos inflows EN VIVO
	// del ledger (package_purchase en la ventana) y el techo α×inflows vigente.
	cur, err := scan(`
		SELECT bp.id,
		       to_char(bp.period_start,'YYYY-MM-DD"T"HH24:MI:SSZ'),
		       to_char(bp.period_end,'YYYY-MM-DD"T"HH24:MI:SSZ'),
		       bp.status::text,
		       COALESCE(bp.inflows_total, live.inflows, 0)::text,
		       COALESCE(bp.projected_outflows,0)::text,
		       bp.theta::text,
		       bp.total_paid::text,
		       (pc.treasury_alpha * COALESCE(bp.inflows_total, live.inflows, 0))::text,
		       CASE WHEN bp.total_paid IS NULL THEN 'pending'
		            WHEN bp.total_paid <= pc.treasury_alpha * COALESCE(bp.inflows_total,0) + 0.01 THEN 'OK'
		            ELSE 'BREACH' END,
		       CASE WHEN COALESCE(bp.inflows_total, live.inflows, 0) > 0 AND bp.total_paid IS NOT NULL
		            THEN ROUND(100.0 * bp.total_paid / COALESCE(bp.inflows_total, live.inflows), 2)::text
		            ELSE NULL END
		  FROM mlm.binary_period bp
		  JOIN mlm.plan_config pc ON pc.id = bp.plan_config_id
		  LEFT JOIN LATERAL (
		    SELECT SUM(wm.amount) AS inflows
		      FROM mlm.wallet_movement wm JOIN mlm.concept c ON c.id = wm.concept_id
		     WHERE c.kind = 'package_purchase'
		       AND wm.posted_at >= bp.period_start AND wm.posted_at < bp.period_end) live ON true
		 ORDER BY bp.period_start DESC LIMIT 1`)
	if err == nil {
		out.Current = cur
	}

	// Tendencia: últimos 8 cerrados.
	rows, err := s.reader().Query(ctx, `SELECT `+cols+`
		FROM mlm.v_period_solvency WHERE status='closed'
		ORDER BY period_start DESC LIMIT 8`)
	if err != nil {
		return out, fmt.Errorf("solvency recent: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var p SolvencyPeriod
		if err := rows.Scan(&p.PeriodID, &p.PeriodStart, &p.PeriodEnd, &p.Status,
			&p.InflowsUSD, &p.ProjectedUSD, &p.Theta, &p.TotalPaidUSD,
			&p.MaxPayoutUSD, &p.SolvencyStatus, &p.PayoutPctInflows); err != nil {
			return out, err
		}
		out.Recent = append(out.Recent, p)
	}
	if err := rows.Err(); err != nil {
		return out, err
	}

	// Semáforo de salud:
	//   BREACH  → algún período cerrado superó α×inflows (T1 roto: no debería pasar).
	//   WARN    → θ < 0.60 en el último cerrado (throttle alto: red tensionada).
	//   OK      → θ ≥ 0.60 o sin throttle.
	out.Health = "OK"
	out.Alert = "Red estable: los pagos caben en el techo α×inflows."
	for _, p := range out.Recent {
		if p.SolvencyStatus == "BREACH" {
			out.Health = "BREACH"
			out.Alert = fmt.Sprintf("¡T1 ROTO en período %d! Pagos > α×inflows. Revisar de inmediato.", p.PeriodID)
			s.cache.set(ctx, "solvency", out, solvencyCacheTTL)
			return out, nil
		}
	}
	if len(out.Recent) > 0 && out.Recent[0].Theta != nil {
		if t, perr := strconv.ParseFloat(*out.Recent[0].Theta, 64); perr == nil && t < 0.60 {
			out.Health = "WARN"
			out.Alert = fmt.Sprintf("θ=%.4f en el último cierre: la red está tensionada (throttle alto). El árbol no quiebra (T1 protege) pero los bonos se prorratean fuerte.", t)
		}
	}
	if len(out.Recent) == 0 {
		out.Health = "UNKNOWN"
		out.Alert = "Aún no hay períodos cerrados. θ se calculará en el primer cierre."
	}
	s.cache.set(ctx, "solvency", out, solvencyCacheTTL)
	return out, nil
}
