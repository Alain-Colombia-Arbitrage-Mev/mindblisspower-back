package networkintel

import (
	"fmt"
	"math"
	"strings"
)

func DeterministicAnalysis(req AnalysisRequest) AnalysisResponse {
	m := req.Metrics
	activeRate := ratio(float64(m.ActiveMembers), float64(m.TotalMembers))
	weakLeg := inferWeakLeg(m)
	balance := binaryBalance(m)

	score := 100
	if balance < 0.8 {
		score -= 18
	}
	if balance < 0.55 {
		score -= 12
	}
	if activeRate < 0.7 {
		score -= int(math.Round((0.7 - activeRate) * 45))
	}
	if m.WorstTheta > 0 && m.WorstTheta < 0.85 {
		score -= 22
	}
	if m.CompanyFund < 0 {
		score -= 18
	}
	if m.RankLiabilityRatio >= 0.5 {
		if m.RankLiabilityRatio >= 0.75 {
			score -= 15
		} else {
			score -= 8
		}
	}
	if score < 0 {
		score = 0
	}

	risk := "bajo"
	if score < 75 {
		risk = "medio"
	}
	if score < 55 || (m.WorstTheta > 0 && m.WorstTheta < 0.75) || m.CompanyFund < 0 {
		risk = "alto"
	}

	resp := AnalysisResponse{
		Provider:    "local-network-rules",
		Mode:        "deterministic",
		HealthScore: score,
		RiskLevel:   risk,
		WeakLeg:     weakLeg,
		Summary: fmt.Sprintf(
			"Sanidad %d/100 con riesgo %s. La pierna debil operativa es %s y la actividad estimada esta en %.0f%%.",
			score,
			risk,
			spanishLeg(weakLeg),
			activeRate*100,
		),
		Findings:    deterministicFindings(m, activeRate, balance, weakLeg),
		Actions:     deterministicActions(m, activeRate, balance, weakLeg),
		Predictions: deterministicPredictions(m, activeRate, balance, weakLeg),
	}
	return resp
}

func deterministicFindings(m NetworkMetrics, activeRate, balance float64, weakLeg string) []Finding {
	findings := []Finding{
		{
			Severity: severityFromBalance(balance),
			Area:     "balance_binario",
			Title:    "Balance de piernas",
			Detail: fmt.Sprintf(
				"Balance relativo %.0f%%. Izquierda: %d miembros / %.2f PV. Derecha: %d miembros / %.2f PV.",
				balance*100,
				m.LeftMembers,
				m.LeftVolume,
				m.RightMembers,
				m.RightVolume,
			),
		},
		{
			Severity: severityFromActiveRate(activeRate),
			Area:     "actividad",
			Title:    "Actividad de red",
			Detail:   fmt.Sprintf("%d de %d miembros estan activos.", m.ActiveMembers, m.TotalMembers),
		},
	}

	if weakLeg != "balanced" {
		findings = append(findings, Finding{
			Severity: "media",
			Area:     "pierna_debil",
			Title:    "Pierna debil detectada",
			Detail:   "Los nuevos referidos y acciones de reactivacion deben priorizar la pierna " + spanishLeg(weakLeg) + ".",
		})
	}

	if m.WorstTheta > 0 {
		severity := "normal"
		if m.WorstTheta < 0.85 {
			severity = "alta"
		}
		findings = append(findings, Finding{
			Severity: severity,
			Area:     "solvencia",
			Title:    "Theta de desembolso",
			Detail:   fmt.Sprintf("El peor theta observado/proyectado es %.4f.", m.WorstTheta),
		})
	}

	if m.CompanyFund < m.ProjectedOutflows*0.2 {
		findings = append(findings, Finding{
			Severity: "media",
			Area:     "fondo_empresa",
			Title:    "Fondo de empresa bajo presion",
			Detail:   fmt.Sprintf("Fondo %.2f frente a desembolsos proyectados %.2f.", m.CompanyFund, m.ProjectedOutflows),
		})
	}

	if m.RankLiabilityRatio >= 0.5 {
		findings = append(findings, Finding{
			Severity: sev(m.RankLiabilityRatio, 0.5, 0.75),
			Area:     "niveles",
			Title:    "Exposición de bonos de rango",
			Detail:   fmt.Sprintf("Las cuotas de rango pendientes equivalen al %.0f%% de los inflows; el bono de rango es T1-only (sin cap T2/T3), contenido solo por θ.", m.RankLiabilityRatio*100),
		})
	}

	return findings
}

func deterministicActions(m NetworkMetrics, activeRate, balance float64, weakLeg string) []Action {
	actions := []Action{}
	if weakLeg != "balanced" {
		actions = append(actions, Action{
			Priority: "alta",
			Title:    "Dirigir crecimiento a pierna debil",
			Detail:   "Usar derrame controlado y seguimiento de referidos para cerrar la brecha antes del siguiente cierre.",
			Target:   weakLeg,
		})
	}
	if activeRate < 0.75 {
		actions = append(actions, Action{
			Priority: "alta",
			Title:    "Reactivar miembros inactivos",
			Detail:   "Priorizar miembros sin actividad reciente porque recuperan volumen sin aumentar costo de adquisicion.",
		})
	}
	if balance < 0.65 {
		actions = append(actions, Action{
			Priority: "media",
			Title:    "Congelar promociones de la pierna fuerte",
			Detail:   "Evitar incentivar volumen adicional en la pierna fuerte hasta mejorar el ratio de balance.",
		})
	}
	if m.WorstTheta > 0 && m.WorstTheta < 0.85 {
		actions = append(actions, Action{
			Priority: "alta",
			Title:    "Revisar caps antes de desembolsar",
			Detail:   "Theta menor a 0.85 exige revisar caps, carry y calendario de pagos antes de liberar el cierre.",
		})
	}
	if len(actions) == 0 {
		actions = append(actions, Action{
			Priority: "normal",
			Title:    "Mantener cadencia operativa",
			Detail:   "La red no muestra una alerta critica. Mantener seguimiento semanal y monitoreo de pierna debil.",
		})
	}
	return actions
}

func deterministicPredictions(m NetworkMetrics, activeRate, balance float64, weakLeg string) []Prediction {
	payoutPressure := 1 - balance
	if m.WorstTheta > 0 {
		payoutPressure += math.Max(0, 0.85-m.WorstTheta)
	}
	if m.CompanyFund < 0 {
		payoutPressure += 0.3
	}
	if payoutPressure > 1 {
		payoutPressure = 1
	}

	reactivationPotential := math.Max(0, 0.85-activeRate)
	if reactivationPotential > 1 {
		reactivationPotential = 1
	}

	return []Prediction{
		{
			Label:     "Presion de pago binario",
			Horizon:   "proximo cierre",
			Direction: riskDirection(payoutPressure),
			Score:     round2(payoutPressure),
			Reason:    "Derivada de balance de piernas, theta y fondo de empresa.",
		},
		{
			Label:     "Recuperacion por reactivacion",
			Horizon:   "30 dias",
			Direction: "mejora",
			Score:     round2(reactivationPotential),
			Reason:    "Miembros inactivos pueden recuperar volumen sin crear nueva profundidad.",
		},
		{
			Label:     "Impacto de derrame dirigido",
			Horizon:   "2 cierres",
			Direction: "mejora",
			Score:     round2(1 - balance),
			Reason:    "Priorizar la pierna " + spanishLeg(weakLeg) + " reduce compresion sobre pierna debil.",
		},
	}
}

func inferWeakLeg(m NetworkMetrics) string {
	leftScore := float64(m.LeftMembers) + m.LeftVolume/1000
	rightScore := float64(m.RightMembers) + m.RightVolume/1000
	if math.Abs(leftScore-rightScore) < 0.001 {
		return "balanced"
	}
	if leftScore < rightScore {
		return "left"
	}
	return "right"
}

func binaryBalance(m NetworkMetrics) float64 {
	left := float64(m.LeftMembers) + m.LeftVolume/1000
	right := float64(m.RightMembers) + m.RightVolume/1000
	if left <= 0 && right <= 0 {
		return 1
	}
	minV := math.Min(left, right)
	maxV := math.Max(left, right)
	if maxV == 0 {
		return 1
	}
	return minV / maxV
}

func ratio(part, total float64) float64 {
	if total <= 0 {
		return 0
	}
	return part / total
}

func severityFromBalance(balance float64) string {
	if balance < 0.55 {
		return "alta"
	}
	if balance < 0.8 {
		return "media"
	}
	return "normal"
}

func severityFromActiveRate(rate float64) string {
	if rate < 0.5 {
		return "alta"
	}
	if rate < 0.75 {
		return "media"
	}
	return "normal"
}

func riskDirection(score float64) string {
	if score >= 0.65 {
		return "deterioro"
	}
	if score >= 0.35 {
		return "estable"
	}
	return "mejora"
}

func spanishLeg(leg string) string {
	switch strings.ToLower(leg) {
	case "left":
		return "izquierda"
	case "right":
		return "derecha"
	default:
		return "balanceada"
	}
}

func round2(v float64) float64 {
	return math.Round(v*100) / 100
}

// sev maps a ratio to "warn" or "critical" using two thresholds (warn, critical).
func sev(ratio, warnThreshold, criticalThreshold float64) string {
	if ratio >= criticalThreshold {
		return "alta"
	}
	return "media"
}
