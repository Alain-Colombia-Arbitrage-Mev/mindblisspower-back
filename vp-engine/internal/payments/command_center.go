package payments

// command_center.go — Centro de Mando (growth-hub /dashboard/command-center).
//
// Sirve exactamente el contrato que consume el frontend:
//   GET  /api/admin/command-center/summary        → KPIs financieros + red
//   GET  /api/admin/command-center/alerts         → alertas activas (mlm.alert_event)
//   POST /api/admin/command-center/alerts/{id}/ack → reconocer una alerta
//
// La salud (/command-center/health) NO vive aquí: el BFF la reutiliza desde
// /api/admin/network/health y la remodela. Esto evita duplicar el análisis
// determinístico del asesor AI.

import (
	"net/http"
	"strconv"
)

// ── Summary ────────────────────────────────────────────────────────────────

// ccSummary es el shape que consume shapeSummary() del frontend: kpis planos,
// companyFund en la raíz y network con conteos/volúmenes por pierna.
type ccSummary struct {
	KPIs        ccKPIs    `json:"kpis"`
	CompanyFund float64   `json:"companyFund"`
	Network     ccNetwork `json:"network"`
}

type ccKPIs struct {
	Inflows       float64 `json:"inflows"`
	BonusOutflows float64 `json:"bonusOutflows"`
	Margin        float64 `json:"margin"`
	Withdrawals   float64 `json:"withdrawals"`
}

type ccNetwork struct {
	ActiveMembers int     `json:"activeMembers"`
	TotalMembers  int     `json:"totalMembers"`
	LeftVolume    float64 `json:"leftVolume"`
	RightVolume   float64 `json:"rightVolume"`
}

// handleCommandCenterSummary: KPIs financieros reales (GetAdminFinance) +
// conteos y volúmenes de red (BuildNetworkMetrics). Ambas consultas son
// cache-aside; margen = ingresos − bonos distribuidos.
func (h *Handler) handleCommandCenterSummary(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	ctx := r.Context()

	fin, err := h.store.GetAdminFinance(ctx)
	if err != nil {
		h.log.Error().Err(err).Msg("cc summary: admin finance")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	m, _, err := h.store.BuildNetworkMetrics(ctx)
	if err != nil {
		h.log.Error().Err(err).Msg("cc summary: network metrics")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}

	inflows := parseFloatOr0(fin.InflowsUSD)
	bonus := parseFloatOr0(fin.CommissionsDistributedUSD)
	writeJSON(w, http.StatusOK, ccSummary{
		KPIs: ccKPIs{
			Inflows:       inflows,
			BonusOutflows: bonus,
			Margin:        inflows - bonus,
			Withdrawals:   parseFloatOr0(fin.WithdrawalsPaidUSD),
		},
		CompanyFund: parseFloatOr0(fin.TreasuryUSD),
		Network: ccNetwork{
			ActiveMembers: m.ActiveMembers,
			TotalMembers:  m.TotalMembers,
			LeftVolume:    m.LeftVolume,
			RightVolume:   m.RightVolume,
		},
	})
}

// ── Alerts ─────────────────────────────────────────────────────────────────

// ccAlert es el shape que consume sortAlerts()/AlertsSection del frontend.
// severity ya es info|warning|critical en mlm.alert_event (coincide con el UI).
type ccAlert struct {
	ID       int64  `json:"id"`
	Signal   string `json:"signal"`
	Severity string `json:"severity"`
	Detail   string `json:"detail"`
	Status   string `json:"status"`
}

// handleCommandCenterAlerts: alertas no resueltas (open + acknowledged), más
// recientes primero. El generador de alertas (evaluador) es Sub-proyecto 2 y
// aún no puebla la tabla; el UI degrada a "Sin alertas activas".
func (h *Handler) handleCommandCenterAlerts(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	rows, err := h.store.db.Query(r.Context(), `
		SELECT id, signal, severity, detail, status
		  FROM mlm.alert_event
		 WHERE status <> 'resolved'
		 ORDER BY created_at DESC
		 LIMIT 100`)
	if err != nil {
		h.log.Error().Err(err).Msg("cc alerts query")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	defer rows.Close()

	alerts := make([]ccAlert, 0)
	for rows.Next() {
		var a ccAlert
		if err := rows.Scan(&a.ID, &a.Signal, &a.Severity, &a.Detail, &a.Status); err != nil {
			h.log.Error().Err(err).Msg("cc alerts scan")
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
		alerts = append(alerts, a)
	}
	if err := rows.Err(); err != nil {
		h.log.Error().Err(err).Msg("cc alerts rows")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"alerts": alerts})
}

// handleCommandCenterAlertAck: marca una alerta OPEN como acknowledged y
// registra al admin (por email → mlm.person.id) y el timestamp.
func (h *Handler) handleCommandCenterAlertAck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	email, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_id")
		return
	}

	ct, err := h.store.db.Exec(r.Context(), `
		UPDATE mlm.alert_event
		   SET status          = 'acknowledged',
		       acknowledged_at = now(),
		       acknowledged_by = (SELECT id FROM mlm.person WHERE lower(email) = lower($2) LIMIT 1),
		       updated_at      = now()
		 WHERE id = $1 AND status = 'open'`, id, email)
	if err != nil {
		h.log.Error().Err(err).Msg("cc alert ack")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "updated": ct.RowsAffected()})
}

// parseFloatOr0 convierte un string decimal a float64; "" o valor malformado → 0.
// Los strings de finanzas pueden estar vacíos antes de cerrar el primer período.
func parseFloatOr0(s string) float64 {
	if s == "" {
		return 0
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return v
}
