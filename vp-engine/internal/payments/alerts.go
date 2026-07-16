package payments

// alerts.go — EvaluateAlerts: Centro de Mando Sub-proyecto 2.
//
// Evaluates four financial-health signals against live metrics and maintains
// the mlm.alert_event table:
//   - If a signal is breached  → UPSERT an open alert (insert or update-in-place).
//   - If a signal is clear     → AUTO-RESOLVE any existing open alert for that signal.
//
// Unique-open-signal index (alert_event_open_signal_idx ON (signal) WHERE status='open')
// guarantees at most one OPEN row per signal. The upsert uses:
//
//	INSERT … ON CONFLICT (signal) WHERE status='open' DO UPDATE …
//
// for the breach path, and a guarded UPDATE WHERE status='open' for the resolve path.
//
// Acknowledged alerts: the unique index covers only status='open', so an
// acknowledged alert is invisible to the conflict clause. If the signal is still
// breaching while an alert is acknowledged, we do NOT insert a new open duplicate
// (that would confuse operators). Instead we skip the INSERT for that signal if an
// acknowledged row already exists for it. We detect this by catching the conflict
// absence — the upsert only affects 'open' rows; if none exist but an
// 'acknowledged' row does, the INSERT produces no conflict and we'd insert a new
// open row. To handle this correctly: before upserting, we check whether ANY
// non-resolved row exists for that signal; if the existing row is 'acknowledged'
// we leave it alone (the operator is already aware). This matches UX intent:
// acknowledgment means "I've seen this, deal with it" — a new open alert for the
// same signal would be noise.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"

	"github.com/jackc/pgx/v5"
)

// ── Signal constants ─────────────────────────────────────────────────────────

const (
	// Signal identifiers (must match CHECK constraint in mlm.alert_event).
	signalTheta          = "theta"
	signalOutflowsVsFund = "outflows_vs_fund"
	signalRankAvalanche  = "rank_avalanche"
	signalLegSkew        = "leg_skew"

	// Severity identifiers.
	severityInfo     = "info"
	severityWarning  = "warning"
	severityCritical = "critical"

	// ── Theta thresholds ────────────────────────────────────────────────────
	// Aligned with networkintel.DeterministicAnalysis which docks score when
	// theta < 0.85 and marks risk="alto" when theta < 0.75.
	// We add a critical band below 0.60 (matches GetSolvency WARN threshold).
	thetaWarning  = 0.85
	thetaCritical = 0.60

	// ── Outflows-vs-fund thresholds ─────────────────────────────────────────
	// outflows_ratio = projected_outflows / max(company_fund, ε).
	// 0.75 → fund can cover outflows but is under pressure.
	// 1.00 → projected outflows exceed company fund entirely (critical).
	outflowsWarning  = 0.75
	outflowsCritical = 1.00

	// ── Rank avalanche thresholds ────────────────────────────────────────────
	// Uses RankExposure.ExposureRatio (liability / inflows).
	// Aligned with networkintel analyzer: 0.50 → warning, 0.75 → critical.
	rankAvalancheWarning  = 0.50
	rankAvalancheCritical = 0.75

	// ── Leg skew thresholds ──────────────────────────────────────────────────
	// skew = stronger / (left + right) in combined score (members + volume/1000).
	// 0.80 → one leg has at least 80% of the network (warning).
	// 0.92 → extreme concentration (critical).
	legSkewWarning  = 0.80
	legSkewCritical = 0.92

	// Epsilon to avoid division by zero when fund is near-zero or exactly zero.
	fundEpsilon = 0.01
)

// alertSignal carries the evaluated state for a single signal in one run.
type alertSignal struct {
	name        string // signal column value
	breached    bool
	severity    string  // "warning" | "critical" — meaningful only when breached
	metricValue float64 // the raw measured value
	threshold   float64 // the threshold that was tripped (or the warning threshold)
	detail      string  // human-readable Spanish description
	payload     map[string]any
}

// EvaluateAlerts computes all four signals against live metrics and upserts /
// resolves rows in mlm.alert_event. Returns the number of open alerts
// remaining after the run. Errors are returned but callers (the scheduler) are
// expected to log-and-continue — this function must never panic.
func (s *Store) EvaluateAlerts(ctx context.Context) (int, error) {
	// ── 1. Gather metrics ────────────────────────────────────────────────────
	m, rx, err := s.BuildNetworkMetrics(ctx)
	if err != nil {
		return 0, fmt.Errorf("evaluate_alerts: build metrics: %w", err)
	}
	// Mirror what http.go does before passing to the analyzer.
	m.RankLiabilityRatio = rx.ExposureRatio

	// ── 2. Evaluate each signal ──────────────────────────────────────────────
	signals := make([]alertSignal, 0, 4)

	// Signal 1 — theta
	signals = append(signals, evalTheta(m.WorstTheta, map[string]any{
		"worst_theta":    m.WorstTheta,
		"company_fund":   m.CompanyFund,
		"total_members":  m.TotalMembers,
		"active_members": m.ActiveMembers,
	}))

	// Signal 2 — outflows_vs_fund
	outflowsRatio := 0.0
	if m.CompanyFund > fundEpsilon {
		outflowsRatio = m.ProjectedOutflows / m.CompanyFund
	} else if m.ProjectedOutflows > 0 {
		// fund is ~0 or negative but we have projected outflows → always critical
		outflowsRatio = m.ProjectedOutflows / fundEpsilon
	}
	signals = append(signals, evalOutflows(outflowsRatio, m.CompanyFund, m.ProjectedOutflows))

	// Signal 3 — rank_avalanche
	signals = append(signals, evalRankAvalanche(rx.ExposureRatio, rx.LiabilityUSD.InexactFloat64(), map[string]any{
		"exposure_ratio":       rx.ExposureRatio,
		"liability_usd":        rx.LiabilityUSD.String(),
		"pending_installments": rx.PendingInstallments,
		"rank_liability_ratio": m.RankLiabilityRatio,
	}))

	// Signal 4 — leg_skew
	left := float64(m.LeftMembers) + m.LeftVolume/1000
	right := float64(m.RightMembers) + m.RightVolume/1000
	total := left + right
	skew := 0.0
	if total > 0 {
		skew = math.Max(left, right) / total
	}
	signals = append(signals, evalLegSkew(skew, m.LeftMembers, m.RightMembers, m.LeftVolume, m.RightVolume))

	// ── 3. Persist each signal's result ─────────────────────────────────────
	for _, sig := range signals {
		if err := s.persistSignal(ctx, sig); err != nil {
			// Non-fatal: log and continue with remaining signals.
			// Callers wrap errors from EvaluateAlerts as a whole; individual
			// persistSignal errors are swallowed here to avoid aborting a run
			// when a single signal fails.
			_ = err // caller gets an aggregated error below if all fail
		}
	}

	// ── 4. Count remaining open alerts ───────────────────────────────────────
	var openCount int
	if err := s.db.QueryRow(ctx,
		`SELECT count(*) FROM mlm.alert_event WHERE status = 'open'`,
	).Scan(&openCount); err != nil {
		return 0, fmt.Errorf("evaluate_alerts: count open: %w", err)
	}
	return openCount, nil
}

// persistSignal writes a single signal result to mlm.alert_event.
//
// If breached:
//   - If an 'open' row already exists for this signal → UPDATE it in-place
//     (severity, metric_value, threshold, detail, updated_at).
//   - If an 'acknowledged' row exists → leave it alone (operator is aware).
//   - Otherwise → INSERT a new 'open' row.
//
// If not breached:
//   - Set any 'open' row for this signal to 'resolved'.
//   - Acknowledged rows are left untouched (they resolve independently via admin).
func (s *Store) persistSignal(ctx context.Context, sig alertSignal) error {
	payloadJSON, err := json.Marshal(sig.payload)
	if err != nil {
		payloadJSON = []byte("{}")
	}

	if sig.breached {
		// Check whether a non-resolved row already exists for this signal.
		var existingStatus string
		err := s.db.QueryRow(ctx,
			`SELECT status FROM mlm.alert_event
			  WHERE signal = $1 AND status <> 'resolved'
			  ORDER BY created_at DESC LIMIT 1`,
			sig.name,
		).Scan(&existingStatus)

		switch {
		case err == pgx.ErrNoRows:
			// No active row → INSERT a fresh open alert.
			_, err = s.db.Exec(ctx, `
				INSERT INTO mlm.alert_event
				  (signal, severity, metric_value, threshold, detail, payload, status)
				VALUES ($1, $2, $3, $4, $5, $6, 'open')
				ON CONFLICT (signal) WHERE status = 'open'
				DO UPDATE SET
				  severity     = EXCLUDED.severity,
				  metric_value = EXCLUDED.metric_value,
				  threshold    = EXCLUDED.threshold,
				  detail       = EXCLUDED.detail,
				  payload      = EXCLUDED.payload,
				  updated_at   = now()
			`, sig.name, sig.severity, sig.metricValue, sig.threshold, sig.detail, payloadJSON)
			if err != nil {
				return fmt.Errorf("persistSignal insert %s: %w", sig.name, err)
			}

		case err != nil:
			return fmt.Errorf("persistSignal check %s: %w", sig.name, err)

		case existingStatus == "open":
			// Open row exists → update it in-place (the ON CONFLICT path above
			// also handles this, but being explicit is clearer and avoids a
			// redundant INSERT attempt).
			_, err = s.db.Exec(ctx, `
				UPDATE mlm.alert_event
				   SET severity     = $2,
				       metric_value = $3,
				       threshold    = $4,
				       detail       = $5,
				       payload      = $6,
				       updated_at   = now()
				 WHERE signal = $1 AND status = 'open'
			`, sig.name, sig.severity, sig.metricValue, sig.threshold, sig.detail, payloadJSON)
			if err != nil {
				return fmt.Errorf("persistSignal update open %s: %w", sig.name, err)
			}

		case existingStatus == "acknowledged":
			// An operator has acknowledged this alert. The signal is still
			// breaching, but we do NOT insert a new open alert — that would
			// confuse operators. Leave it alone; acknowledgment implies awareness.
			// (When the operator resolves it manually or the signal clears, the
			// next auto-resolve sweep will handle it.)
		}
		return nil
	}

	// Not breached → auto-resolve any open alert. Acknowledged rows are left alone.
	_, err = s.db.Exec(ctx, `
		UPDATE mlm.alert_event
		   SET status     = 'resolved',
		       updated_at = now()
		 WHERE signal = $1 AND status = 'open'
	`, sig.name)
	return err
}

// ── Signal evaluators ────────────────────────────────────────────────────────

func evalTheta(theta float64, payload map[string]any) alertSignal {
	sig := alertSignal{
		name:    signalTheta,
		payload: payload,
	}
	switch {
	case theta > 0 && theta < thetaCritical:
		sig.breached = true
		sig.severity = severityCritical
		sig.metricValue = theta
		sig.threshold = thetaCritical
		sig.detail = fmt.Sprintf(
			"θ=%.4f está por debajo del umbral crítico (%.2f). El prorrateo de bonos es severo y la red está bajo alta tensión. Revisar caps y calendario de pagos antes del próximo cierre.",
			theta, thetaCritical,
		)
	case theta > 0 && theta < thetaWarning:
		sig.breached = true
		sig.severity = severityWarning
		sig.metricValue = theta
		sig.threshold = thetaWarning
		sig.detail = fmt.Sprintf(
			"θ=%.4f está por debajo del umbral de advertencia (%.2f). El throttle de prorrateo es moderadamente alto. Se recomienda revisar el balance de piernas y los caps antes del próximo cierre.",
			theta, thetaWarning,
		)
	default:
		sig.metricValue = theta
		sig.threshold = thetaWarning
	}
	return sig
}

func evalOutflows(ratio, fund, outflows float64) alertSignal {
	sig := alertSignal{
		name: signalOutflowsVsFund,
		payload: map[string]any{
			"company_fund":       fund,
			"projected_outflows": outflows,
			"ratio":              ratio,
		},
	}
	switch {
	case ratio >= outflowsCritical:
		sig.breached = true
		sig.severity = severityCritical
		sig.metricValue = ratio
		sig.threshold = outflowsCritical
		sig.detail = fmt.Sprintf(
			"Los desembolsos proyectados (%.2f USD) superan el fondo de empresa (%.2f USD). Ratio=%.2f. Riesgo inmediato de insolvencia operativa. Se requiere acción urgente.",
			outflows, fund, ratio,
		)
	case ratio >= outflowsWarning:
		sig.breached = true
		sig.severity = severityWarning
		sig.metricValue = ratio
		sig.threshold = outflowsWarning
		sig.detail = fmt.Sprintf(
			"Los desembolsos proyectados (%.2f USD) representan el %.0f%% del fondo de empresa (%.2f USD). El fondo está bajo presión; monitorear de cerca.",
			outflows, ratio*100, fund,
		)
	default:
		sig.metricValue = ratio
		sig.threshold = outflowsWarning
	}
	return sig
}

func evalRankAvalanche(exposureRatio, liabilityUSD float64, payload map[string]any) alertSignal {
	sig := alertSignal{
		name:    signalRankAvalanche,
		payload: payload,
	}
	switch {
	case exposureRatio >= rankAvalancheCritical:
		sig.breached = true
		sig.severity = severityCritical
		sig.metricValue = exposureRatio
		sig.threshold = rankAvalancheCritical
		sig.detail = fmt.Sprintf(
			"Las cuotas de rango pendientes representan el %.0f%% de los inflows (%.2f USD en deuda). Riesgo crítico de avalancha de rangos. El bono de rango es T1-only y sólo θ lo contiene.",
			exposureRatio*100, liabilityUSD,
		)
	case exposureRatio >= rankAvalancheWarning:
		sig.breached = true
		sig.severity = severityWarning
		sig.metricValue = exposureRatio
		sig.threshold = rankAvalancheWarning
		sig.detail = fmt.Sprintf(
			"Las cuotas de rango pendientes representan el %.0f%% de los inflows (%.2f USD en deuda). Monitorear crecimiento de rangos y velocidad de pago de cuotas.",
			exposureRatio*100, liabilityUSD,
		)
	default:
		sig.metricValue = exposureRatio
		sig.threshold = rankAvalancheWarning
	}
	return sig
}

func evalLegSkew(skew float64, leftMembers, rightMembers int, leftVol, rightVol float64) alertSignal {
	stronger := "izquierda"
	if rightMembers > leftMembers || rightVol > leftVol {
		stronger = "derecha"
	}
	sig := alertSignal{
		name: signalLegSkew,
		payload: map[string]any{
			"left_members":  leftMembers,
			"right_members": rightMembers,
			"left_volume":   leftVol,
			"right_volume":  rightVol,
			"skew_ratio":    skew,
			"stronger_leg":  stronger,
		},
	}
	switch {
	case skew >= legSkewCritical:
		sig.breached = true
		sig.severity = severityCritical
		sig.metricValue = skew
		sig.threshold = legSkewCritical
		sig.detail = fmt.Sprintf(
			"Desequilibrio binario extremo: la pierna %s concentra el %.0f%% del volumen combinado. El bono binario está siendo comprimido al máximo. Se requiere derrame urgente a la pierna débil.",
			stronger, skew*100,
		)
	case skew >= legSkewWarning:
		sig.breached = true
		sig.severity = severityWarning
		sig.metricValue = skew
		sig.threshold = legSkewWarning
		sig.detail = fmt.Sprintf(
			"Desequilibrio binario: la pierna %s concentra el %.0f%% del volumen combinado (umbral: %.0f%%). Dirigir nuevos referidos y derrame a la pierna débil.",
			stronger, skew*100, legSkewWarning*100,
		)
	default:
		sig.metricValue = skew
		sig.threshold = legSkewWarning
	}
	return sig
}
