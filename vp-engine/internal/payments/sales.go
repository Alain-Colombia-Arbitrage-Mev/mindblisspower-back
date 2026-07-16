package payments

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
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

// SalesReport agrega ventas por paquete (solo membresías MindBliss: la fuente es
// payments.purchase_intent, que únicamente contiene checkouts del PACK MINDBLISS)
// desde `from`.
//   - Created  = total de intents iniciados en el período.
//   - Paid     = intents con dinero recibido (paid_at IS NOT NULL, excluye
//     reembolsados). NOTA: antes filtraba por status='paid', pero ese
//     estado es transitorio dentro de la tx de activación (created→
//     paid→activated) y casi nunca queda persistido → la columna daba
//     0 aunque hubiera ventas. paid_at es la señal correcta.
//   - Activated= intents colocados en el árbol (status='activated').
//   - Revenue  = suma de amount_usd de lo efectivamente cobrado (paid_at not null,
//     sin reembolsos), incluye pagos aún sin colocar (needs_placement).
func (s *Store) SalesReport(ctx context.Context, from time.Time) ([]SalesRow, error) {
	rows, err := s.reader().Query(ctx, `
		SELECT pk.id, pk.name, pk.amount_usd::text,
		       count(*),
		       count(*) FILTER (WHERE pi.paid_at IS NOT NULL AND pi.status <> 'refunded' AND pi.stripe_present IS DISTINCT FROM false),
		       count(*) FILTER (WHERE pi.status = 'activated' AND pi.stripe_present IS DISTINCT FROM false),
		       COALESCE(sum(pi.amount_usd) FILTER (WHERE pi.paid_at IS NOT NULL AND pi.status <> 'refunded' AND pi.stripe_present IS DISTINCT FROM false), 0)::text
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

// SalesTransaction es una venta individual de membresía MindBliss para el
// reporte de transacciones del panel. Fuente: payments.purchase_intent (solo
// checkouts del PACK MINDBLISS), unido a mlm.package (nombre del plan) y
// mlm.person (identidad del pagador). Otros productos de Stripe NO aparecen aquí
// porque nunca generan un purchase_intent.
type SalesTransaction struct {
	ID           string `json:"id"`
	CreatedAt    string `json:"created_at"`
	Email        string `json:"email"`
	Name         string `json:"name"`
	Plan         string `json:"plan"`
	AmountUSD    string `json:"amount_usd"`
	FeeUSD       string `json:"fee_usd"`
	TotalUSD     string `json:"total_usd"`
	Status       string `json:"status"`
	Reference    string `json:"reference"` // stripe_payment_intent_id
	PaidAt       string `json:"paid_at"`
	ActivatedAt  string `json:"activated_at"`
	AffiliateID  *int64 `json:"affiliate_id"`   // colocación en el árbol (null = sin colocar)
	StripeVerify *bool  `json:"stripe_present"` // verificación Stripe live (null = sin verificar)
}

// SalesTransactions lista las ventas individuales de membresías desde `from`,
// con filtro opcional por status y búsqueda por email (user_id). Paginado.
func (s *Store) SalesTransactions(ctx context.Context, from time.Time, status, q string, limit, offset int) ([]SalesTransaction, int64, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	if offset < 0 {
		offset = 0
	}
	var total int64
	if err := s.reader().QueryRow(ctx, `
		SELECT count(*)
		  FROM payments.purchase_intent pi
		  JOIN mlm.package pk ON pk.id = pi.package_id
		 WHERE pi.created_at >= $1
		   AND ($2 = '' OR pi.status = $2)
		   AND ($3 = '' OR lower(pi.user_id) ILIKE '%'||lower($3)||'%')
	`, from, status, q).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count sales transactions: %w", err)
	}
	rows, err := s.reader().Query(ctx, `
		SELECT pi.id::text,
		       to_char(pi.created_at,'YYYY-MM-DD"T"HH24:MI:SSZ'),
		       pi.user_id,
		       COALESCE((SELECT trim(p.first_name||' '||p.last_name) FROM mlm.person p WHERE p.id = pi.person_id), ''),
		       pk.name,
		       pi.amount_usd::text, pi.fee_usd::text, (pi.amount_usd + pi.fee_usd)::text,
		       pi.status, COALESCE(pi.stripe_payment_intent_id, ''),
		       COALESCE(to_char(pi.paid_at,'YYYY-MM-DD"T"HH24:MI:SSZ'), ''),
		       COALESCE(to_char(pi.activated_at,'YYYY-MM-DD"T"HH24:MI:SSZ'), ''),
		       pi.affiliate_id, pi.stripe_present
		  FROM payments.purchase_intent pi
		  JOIN mlm.package pk ON pk.id = pi.package_id
		 WHERE pi.created_at >= $1
		   AND ($2 = '' OR pi.status = $2)
		   AND ($3 = '' OR lower(pi.user_id) ILIKE '%'||lower($3)||'%')
		 ORDER BY pi.created_at DESC
		 LIMIT $4 OFFSET $5
	`, from, status, q, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("list sales transactions: %w", err)
	}
	defer rows.Close()
	out := []SalesTransaction{}
	for rows.Next() {
		var t SalesTransaction
		if err := rows.Scan(&t.ID, &t.CreatedAt, &t.Email, &t.Name, &t.Plan,
			&t.AmountUSD, &t.FeeUSD, &t.TotalUSD, &t.Status, &t.Reference, &t.PaidAt,
			&t.ActivatedAt, &t.AffiliateID, &t.StripeVerify); err != nil {
			return nil, 0, err
		}
		out = append(out, t)
	}
	return out, total, rows.Err()
}

// handleAdminSalesTransactions: GET /api/admin/sales/transactions?days=30&status=&q=&limit=&offset=
// — detalle de ventas individuales de membresías para el panel (quién pagó, plan,
// monto, estado, referencia). Solo membresías MindBliss (ver SalesTransactions).
func (h *Handler) handleAdminSalesTransactions(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	qv := r.URL.Query()
	days := atoiDefault(qv.Get("days"), 30)
	if days < 1 || days > 365 {
		days = 30
	}
	status := strings.TrimSpace(qv.Get("status"))
	switch status {
	case "", "created", "paid", "activated", "needs_placement", "failed", "expired", "refunded":
	default:
		status = "" // status desconocido ⇒ sin filtro (no error)
	}
	q := strings.TrimSpace(qv.Get("q"))
	limit := atoiDefault(qv.Get("limit"), 25)
	offset := atoiDefault(qv.Get("offset"), 0)
	from := time.Now().UTC().AddDate(0, 0, -days)

	txns, total, err := h.store.SalesTransactions(r.Context(), from, status, q, limit, offset)
	if err != nil {
		h.log.Error().Err(err).Msg("sales transactions")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"from":   from.Format("2006-01-02"),
		"days":   days,
		"rows":   txns,
		"total":  total,
		"limit":  limit,
		"offset": offset,
		"since":  time.Now().UTC().Format(time.RFC3339),
	})
}

// VerifyTransactionStripe consulta un intent contra Stripe live y PERSISTE el
// resultado en stripe_present (true/false). Ids no consultables (sin pi_) dejan
// stripe_present sin tocar. Devuelve la presencia y el status actual del intent.
func (s *Store) VerifyTransactionStripe(ctx context.Context, gw *StripeGateway, intentID string) (PaymentIntentPresence, string, error) {
	var piID, status string
	err := s.reader().QueryRow(ctx,
		`SELECT COALESCE(stripe_payment_intent_id, ''), status FROM payments.purchase_intent WHERE id = $1::uuid`,
		intentID).Scan(&piID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return PIPresenceUnknown, "", ErrIntentNotFound
	}
	if err != nil {
		return PIPresenceUnknown, "", fmt.Errorf("verify: load intent: %w", err)
	}
	presence, err := gw.VerifyPaymentIntent(piID)
	if err != nil {
		return PIPresenceUnknown, status, err
	}
	if presence != PIPresenceUnknown {
		if _, uerr := s.db.Exec(ctx,
			`UPDATE payments.purchase_intent SET stripe_present = $2, updated_at = now() WHERE id = $1::uuid`,
			intentID, presence == PIPresent); uerr != nil {
			return presence, status, fmt.Errorf("verify: persist: %w", uerr)
		}
	}
	return presence, status, nil
}

// handleAdminSalesVerify: GET /api/admin/sales/verify?id=<intent> — verifica una
// venta contra Stripe live y persiste el resultado. Lo usa el detalle/timeline
// del panel para marcar "✓ verificada" / "✗ no encontrada (posible prueba)".
func (h *Handler) handleAdminSalesVerify(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if id == "" {
		writeErr(w, http.StatusBadRequest, "id_required")
		return
	}
	if h.gw == nil {
		writeErr(w, http.StatusServiceUnavailable, "stripe_unavailable")
		return
	}
	presence, status, err := h.store.VerifyTransactionStripe(r.Context(), h.gw, id)
	if errors.Is(err, ErrIntentNotFound) {
		writeErr(w, http.StatusNotFound, "not_found")
		return
	}
	if err != nil {
		h.log.Error().Err(err).Str("intent", id).Msg("sales verify")
		writeErr(w, http.StatusBadGateway, "stripe_error")
		return
	}
	presenceStr := "unknown"
	switch presence {
	case PIPresent:
		presenceStr = "present"
	case PIMissing:
		presenceStr = "missing"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":       id,
		"status":   status,
		"verified": presence != PIPresenceUnknown,
		"present":  presence == PIPresent,
		"presence": presenceStr,
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
