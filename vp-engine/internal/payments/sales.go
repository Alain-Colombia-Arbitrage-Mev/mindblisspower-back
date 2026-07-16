package payments

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// SalesRow es el desglose de ventas de un paquete (tier de precio del producto
// Stripe PACK MINDBLISS) en el período consultado.
type SalesRow struct {
	PackageID  int64  `json:"package_id"`
	Name       string `json:"name"`
	AmountUSD  string `json:"amount_usd"`
	Created    int64  `json:"created"`
	Paid       int64  `json:"paid"`
	Activated  int64  `json:"activated"`
	RevenueUSD string `json:"revenue_usd"` // suma de intents activados
}

// SalesReport agrega ventas por paquete desde `from`. Revenue = solo intents
// ACTIVADOS (dinero confirmado por webhook + paquete colocado).
func (s *Store) SalesReport(ctx context.Context, from time.Time) ([]SalesRow, error) {
	rows, err := s.reader().Query(ctx, `
		SELECT pk.id, pk.name, pk.amount_usd::text,
		       count(*) FILTER (WHERE pi.status = 'created'),
		       count(*) FILTER (WHERE pi.status = 'paid'),
		       count(*) FILTER (WHERE pi.status = 'activated'),
		       COALESCE(sum(pi.amount_usd) FILTER (WHERE pi.status = 'activated'), 0)::text
		  FROM payments.purchase_intent pi
		  JOIN mlm.package pk ON pk.id = pi.package_id
		 WHERE pi.created_at >= $1
		 GROUP BY pk.id, pk.name, pk.amount_usd
		 ORDER BY pk.amount_usd`, from)
	if err != nil {
		return nil, fmt.Errorf("sales report: %w", err)
	}
	defer rows.Close()

	out := []SalesRow{}
	for rows.Next() {
		var r SalesRow
		if err := rows.Scan(&r.PackageID, &r.Name, &r.AmountUSD, &r.Created, &r.Paid, &r.Activated, &r.RevenueUSD); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// DBSalesTotal es el agregado interno (fuente de verdad) de intents ACTIVADOS
// desde una fecha. GrossCents = sum(total_cents) e incluye el 1% de activación,
// para ser comparable 1:1 con el bruto de Stripe.
type DBSalesTotal struct {
	Count      int64 `json:"count"`
	GrossCents int64 `json:"gross_cents"`
}

// SalesTotalsSince agrega los intents ACTIVADOS desde `from` (cuenta + bruto en
// centavos) para conciliar contra Stripe.
func (s *Store) SalesTotalsSince(ctx context.Context, from time.Time) (DBSalesTotal, error) {
	var t DBSalesTotal
	err := s.reader().QueryRow(ctx, `
		SELECT count(*), COALESCE(sum(total_cents), 0)
		  FROM payments.purchase_intent
		 WHERE status = 'activated' AND created_at >= $1`, from).Scan(&t.Count, &t.GrossCents)
	if err != nil {
		return DBSalesTotal{}, fmt.Errorf("sales totals: %w", err)
	}
	return t, nil
}

// handleAdminSalesReconcile: GET /api/admin/sales/reconcile?days=30 — compara el
// bruto interno (DB, fuente de verdad) contra Stripe (Search API filtrado por
// packmindbliss=true). Un delta ≠ 0 delata ventas fuera de la app (Payment
// Links) o intents no activados. Todo en centavos; delta = stripe − db.
func (h *Handler) handleAdminSalesReconcile(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	days := atoiDefault(r.URL.Query().Get("days"), 30)
	if days < 1 || days > 365 {
		days = 30
	}
	from := time.Now().UTC().AddDate(0, 0, -days)

	db, err := h.store.SalesTotalsSince(r.Context(), from)
	if err != nil {
		h.log.Error().Err(err).Msg("reconcile: db totals")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	st, err := h.gw.SearchSalesSince(from)
	if err != nil {
		h.log.Error().Err(err).Msg("reconcile: stripe search")
		writeErr(w, http.StatusBadGateway, "stripe_error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"from":              from.Format("2006-01-02"),
		"days":              days,
		"db":                db,
		"stripe":            st,
		"delta_count":       st.Count - db.Count,
		"delta_gross_cents": st.GrossCents - db.GrossCents,
		"reconciled":        st.Count == db.Count && st.GrossCents == db.GrossCents,
		"since":             time.Now().UTC().Format(time.RFC3339),
	})
}

// handleAdminSalesReport: GET /api/admin/sales/report?days=30 — desglose de
// ventas por paquete para el panel admin.
func (h *Handler) handleAdminSalesReport(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	days := atoiDefault(r.URL.Query().Get("days"), 30)
	if days < 1 || days > 365 {
		days = 30
	}
	from := time.Now().UTC().AddDate(0, 0, -days)
	report, err := h.store.SalesReport(r.Context(), from)
	if err != nil {
		h.log.Error().Err(err).Msg("sales report")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"from":  from.Format("2006-01-02"),
		"days":  days,
		"rows":  report,
		"since": time.Now().UTC().Format(time.RFC3339),
	})
}

// handleRegistrationEvent: POST /api/events/registration — el BFF lo invoca
// (token de servicio) al confirmarse un registro Cognito; publica
// `member.registered` en el stream vp:events para el feed del panel admin.
// Best-effort por diseño: el registro del usuario NUNCA depende de esto.
func (h *Handler) handleRegistrationEvent(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	var req struct {
		Email string `json:"email"`
		Name  string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Email) == "" {
		writeErr(w, http.StatusBadRequest, "email_required")
		return
	}
	h.store.cache.PublishEvent(r.Context(), "member.registered", map[string]any{
		"email": strings.ToLower(strings.TrimSpace(req.Email)),
		"name":  strings.TrimSpace(req.Name),
	})
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
