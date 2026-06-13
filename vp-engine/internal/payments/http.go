package payments

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/rs/zerolog"
	stripe "github.com/stripe/stripe-go/v85"
)

const maxWebhookBody = int64(1 << 18) // 256 KiB

// Handler expone los endpoints HTTP del servicio de pagos.
type Handler struct {
	store        *Store
	gw           *StripeGateway
	log          zerolog.Logger
	serviceToken string
	adminEmails  []string
}

func NewHandler(store *Store, gw *StripeGateway, serviceToken string, adminEmails []string, log zerolog.Logger) *Handler {
	return &Handler{store: store, gw: gw, serviceToken: serviceToken, adminEmails: adminEmails, log: log.With().Str("component", "payments").Logger()}
}

// isAdminEmail: true si el email está en el allowlist por env o es is_admin en mlm.person.
func (h *Handler) isAdminEmail(ctx context.Context, email string) (bool, error) {
	for _, a := range h.adminEmails {
		if strings.EqualFold(strings.TrimSpace(a), strings.TrimSpace(email)) {
			return true, nil
		}
	}
	return h.store.IsAdmin(ctx, email)
}

// Routes monta el mux del servicio.
func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/api/payments/checkout", h.handleCheckout)
	mux.HandleFunc("/api/payments/me", h.handleMe)
	mux.HandleFunc("/api/member/referral", h.handleMemberReferral)
	mux.HandleFunc("/api/payments/withdraw", h.handleWithdraw)
	mux.HandleFunc("/api/webhooks/stripe", h.handleWebhook)
	mux.HandleFunc("/api/admin/check", h.handleAdminCheck)
	mux.HandleFunc("/api/admin/users", h.handleAdminUsers)
	mux.HandleFunc("/api/admin/summary", h.handleAdminSummary)
	mux.HandleFunc("/api/admin/block", h.handleAdminBlock)
	mux.HandleFunc("/api/admin/withdrawals", h.handleAdminWithdrawals)
	mux.HandleFunc("/api/admin/withdrawals/action", h.handleAdminWithdrawalAction)
	return mux
}

func (h *Handler) handleAdminWithdrawals(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	status := r.URL.Query().Get("status")
	limit := atoiDefault(r.URL.Query().Get("limit"), 25)
	offset := atoiDefault(r.URL.Query().Get("offset"), 0)
	items, total, err := h.store.ListWithdrawals(r.Context(), status, limit, offset)
	if err != nil {
		h.log.Error().Err(err).Msg("list withdrawals")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"withdrawals": items, "total": total, "limit": limit, "offset": offset})
}

type adminWdActionReq struct {
	Email  string `json:"email"`
	ID     int64  `json:"id"`
	Action string `json:"action"` // approve|reject|pay|cancel
}

func (h *Handler) handleAdminWithdrawalAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	var req adminWdActionReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}
	admin, err := h.isAdminEmail(r.Context(), req.Email)
	if err != nil || !admin {
		writeErr(w, http.StatusForbidden, "not_admin")
		return
	}
	status := map[string]string{"approve": "approved", "reject": "rejected", "pay": "paid", "cancel": "cancelled"}[req.Action]
	if status == "" || req.ID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid_action")
		return
	}
	if err := h.store.SetWithdrawalStatus(r.Context(), req.ID, status, req.Email); err != nil {
		h.log.Error().Err(err).Msg("withdrawal action")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	h.log.Info().Int64("withdrawal_id", req.ID).Str("status", status).Str("by", req.Email).Msg("admin withdrawal action")
	writeJSON(w, http.StatusOK, map[string]string{"status": status})
}

// svcAuth valida el token de servicio (compartido con el BFF). Devuelve false
// y responde 401 si no coincide.
func (h *Handler) svcAuth(w http.ResponseWriter, r *http.Request) bool {
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-VP-Service-Token")), []byte(h.serviceToken)) != 1 {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return false
	}
	return true
}

// requireAdmin valida token de servicio + que el email sea admin.
func (h *Handler) requireAdmin(w http.ResponseWriter, r *http.Request) (string, bool) {
	if !h.svcAuth(w, r) {
		return "", false
	}
	email := r.URL.Query().Get("email")
	if email == "" {
		writeErr(w, http.StatusBadRequest, "missing email")
		return "", false
	}
	admin, err := h.isAdminEmail(r.Context(), email)
	if err != nil {
		h.log.Error().Err(err).Msg("is_admin")
		writeErr(w, http.StatusInternalServerError, "internal")
		return "", false
	}
	if !admin {
		writeErr(w, http.StatusForbidden, "not_admin")
		return "", false
	}
	return email, true
}

func (h *Handler) handleAdminCheck(w http.ResponseWriter, r *http.Request) {
	if !h.svcAuth(w, r) {
		return
	}
	email := r.URL.Query().Get("email")
	admin, err := h.isAdminEmail(r.Context(), email)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"is_admin": admin})
}

func (h *Handler) handleAdminUsers(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	q := r.URL.Query().Get("q")
	limit := atoiDefault(r.URL.Query().Get("limit"), 25)
	offset := atoiDefault(r.URL.Query().Get("offset"), 0)
	users, total, err := h.store.ListUsers(r.Context(), q, limit, offset)
	if err != nil {
		h.log.Error().Err(err).Msg("list users")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": users, "total": total, "limit": limit, "offset": offset})
}

func (h *Handler) handleAdminSummary(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	sum, err := h.store.AdminSummary(r.Context())
	if err != nil {
		h.log.Error().Err(err).Msg("admin summary")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, sum)
}

type adminBlockReq struct {
	Email    string `json:"email"`
	PersonID int64  `json:"person_id"`
	Blocked  bool   `json:"blocked"`
}

func (h *Handler) handleAdminBlock(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	var req adminBlockReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}
	admin, err := h.isAdminEmail(r.Context(), req.Email)
	if err != nil || !admin {
		writeErr(w, http.StatusForbidden, "not_admin")
		return
	}
	if req.PersonID <= 0 {
		writeErr(w, http.StatusBadRequest, "missing person_id")
		return
	}
	if err := h.store.SetBlocked(r.Context(), req.PersonID, req.Blocked); err != nil {
		h.log.Error().Err(err).Msg("set blocked")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	h.log.Info().Int64("person_id", req.PersonID).Bool("blocked", req.Blocked).Str("by", req.Email).Msg("admin block toggle")
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true, "blocked": req.Blocked})
}

func atoiDefault(s string, def int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	return n
}

type withdrawRequest struct {
	Email    string `json:"email"`
	Amount   string `json:"amount"`    // USD, p.ej. "150.00"
	BankInfo string `json:"bank_info"` // banco/cuenta/titular (texto que verá ops)
}

// handleWithdraw crea una solicitud de retiro (pendiente de aprobación admin).
func (h *Handler) handleWithdraw(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-VP-Service-Token")), []byte(h.serviceToken)) != 1 {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req withdrawRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}
	if req.Email == "" || req.Amount == "" || len(req.BankInfo) < 6 {
		writeErr(w, http.StatusBadRequest, "missing email, amount or bank_info")
		return
	}

	res, err := h.store.RequestWithdrawal(r.Context(), req.Email, req.Amount, req.BankInfo)
	switch {
	case errors.Is(err, ErrMinWithdrawal):
		writeErr(w, http.StatusBadRequest, "min_withdrawal")
		return
	case errors.Is(err, ErrInsufficient):
		writeErr(w, http.StatusBadRequest, "insufficient_balance")
		return
	case errors.Is(err, ErrNoWallet):
		writeErr(w, http.StatusBadRequest, "no_balance")
		return
	case err != nil:
		h.log.Error().Err(err).Msg("request withdrawal")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	h.log.Info().Int64("withdrawal_id", res.ID).Str("email", req.Email).Msg("withdrawal requested")
	writeJSON(w, http.StatusOK, res)
}

// handleMe devuelve los pagos + posición + comisiones del miembro. Lo llama el
// BFF Next (token de servicio) pasando el email autenticado por Cognito.
// handleMemberReferral devuelve el código de referido real del miembro (por email).
func (h *Handler) handleMemberReferral(w http.ResponseWriter, r *http.Request) {
	if !h.svcAuth(w, r) {
		return
	}
	email := r.URL.Query().Get("email")
	if email == "" {
		writeErr(w, http.StatusBadRequest, "missing email")
		return
	}
	name, code, err := h.store.GetMemberContext(r.Context(), email)
	if err != nil {
		h.log.Error().Err(err).Msg("member context")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"referral_code": code, "name": name})
}

func (h *Handler) handleMe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-VP-Service-Token")), []byte(h.serviceToken)) != 1 {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	email := r.URL.Query().Get("email")
	if email == "" {
		writeErr(w, http.StatusBadRequest, "missing email")
		return
	}
	summary, err := h.store.GetMemberSummary(r.Context(), email)
	if errors.Is(err, ErrBuyerNotFound) {
		writeErr(w, http.StatusNotFound, "buyer_not_found")
		return
	}
	if err != nil {
		h.log.Error().Err(err).Msg("member summary")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

// ── Checkout ────────────────────────────────────────────────────────────────

type checkoutRequest struct {
	Email     string `json:"email"`
	PackageID int    `json:"package_id"`
}

type checkoutResponse struct {
	URL       string `json:"url"`
	SessionID string `json:"session_id"`
	TotalUSD  string `json:"total_usd"`
	FeeUSD    string `json:"fee_usd"`
}

// handleCheckout crea una sesión de Checkout. Lo llama el BFF Next (que ya
// validó la sesión Cognito) con el token de servicio + el user_id autenticado.
func (h *Handler) handleCheckout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	// Auth servicio-a-servicio (no Cognito aquí; el BFF ya autenticó al usuario).
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-VP-Service-Token")), []byte(h.serviceToken)) != 1 {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req checkoutRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}
	if req.Email == "" || req.PackageID <= 0 {
		writeErr(w, http.StatusBadRequest, "missing email or package_id")
		return
	}

	ctx := r.Context()
	pack, err := h.store.LookupPack(ctx, req.PackageID)
	if errors.Is(err, ErrPackNotFound) {
		writeErr(w, http.StatusNotFound, "package_not_found")
		return
	}
	if err != nil {
		h.log.Error().Err(err).Msg("lookup pack")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}

	buyer, err := h.store.ResolveBuyer(ctx, req.Email)
	if errors.Is(err, ErrBuyerNotFound) {
		writeErr(w, http.StatusNotFound, "buyer_not_found")
		return
	}
	if err != nil {
		h.log.Error().Err(err).Msg("resolve buyer")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}

	intentID, err := h.store.CreatePurchaseIntent(ctx, PurchaseIntent{
		UserID:             req.Email, // traceability: identificador externo del comprador
		PersonID:           buyer.PersonID,
		AffiliateID:        buyer.AffiliateID,
		SponsorAffiliateID: buyer.SponsorAffiliateID,
		PackageID:          pack.ID,
		PV:                 pack.PV,
		AmountUSD:          pack.AmountUSD,
		FeeUSD:             pack.FeeUSD(),
		TotalCents:         pack.TotalCents(),
		Currency:           "usd",
	})
	if err != nil {
		h.log.Error().Err(err).Msg("create purchase intent")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}

	meta := map[string]string{
		"purchase_intent_id": intentID,
		"email":              req.Email,
		"person_id":          strconv.FormatInt(buyer.PersonID, 10),
		"package_id":         strconv.Itoa(pack.ID),
		"pv":                 strconv.Itoa(pack.PV),
	}
	url, sessionID, err := h.gw.CreateCheckout(pack, intentID, meta)
	if err != nil {
		h.log.Error().Err(err).Str("intent", intentID).Msg("stripe checkout create")
		writeErr(w, http.StatusBadGateway, "stripe_error")
		return
	}
	if err := h.store.AttachSession(ctx, intentID, sessionID); err != nil {
		h.log.Error().Err(err).Msg("attach session")
		// La sesión ya existe en Stripe; no abortamos. El webhook resuelve por session_id.
	}

	writeJSON(w, http.StatusOK, checkoutResponse{
		URL: url, SessionID: sessionID,
		TotalUSD: pack.TotalUSD().StringFixed(2), FeeUSD: pack.FeeUSD().StringFixed(2),
	})
}

// ── Webhook ──────────────────────────────────────────────────────────────────

func (h *Handler) handleWebhook(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxWebhookBody)
	payload, err := io.ReadAll(r.Body)
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "read_body")
		return
	}

	event, err := h.gw.ConstructEvent(payload, r.Header.Get("Stripe-Signature"))
	if err != nil {
		h.log.Warn().Err(err).Msg("webhook signature verification failed")
		writeErr(w, http.StatusBadRequest, "invalid_signature")
		return
	}

	// Audit (best-effort): registra el evento. No es un gate — la idempotencia
	// real vive en el ledger (external_ref), así que re-procesar es seguro.
	if dup, derr := h.store.EventSeen(r.Context(), event.ID, string(event.Type)); derr != nil {
		h.log.Warn().Err(derr).Str("event", event.ID).Msg("record stripe_event")
	} else if dup {
		h.log.Info().Str("event", event.ID).Str("type", string(event.Type)).Msg("duplicate event (reprocessing, downstream idempotent)")
	}

	switch event.Type {
	case "checkout.session.completed", "checkout.session.async_payment_succeeded":
		if err := h.handlePaid(r.Context(), event); err != nil {
			// 500 ⇒ Stripe reintenta con backoff. Seguro: todo el flujo es idempotente.
			h.log.Error().Err(err).Str("event", event.ID).Msg("process paid event")
			writeErr(w, http.StatusInternalServerError, "processing_error")
			return
		}
	case "checkout.session.async_payment_failed", "payment_intent.payment_failed":
		h.log.Info().Str("event", event.ID).Str("type", string(event.Type)).Msg("payment failed/expired")
	default:
		h.log.Debug().Str("type", string(event.Type)).Msg("unhandled event type")
	}

	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"received":true}`))
}

func (h *Handler) handlePaid(ctx context.Context, event stripe.Event) error {
	var cs stripe.CheckoutSession
	if err := json.Unmarshal(event.Data.Raw, &cs); err != nil {
		return err
	}
	// `payment` mode async (crypto/ACH) puede llegar como completed con
	// payment_status 'unpaid' → solo activar cuando esté pagado.
	if cs.PaymentStatus != stripe.CheckoutSessionPaymentStatusPaid {
		h.log.Info().Str("session", cs.ID).Str("payment_status", string(cs.PaymentStatus)).Msg("session not yet paid; waiting for async_payment_succeeded")
		return nil
	}

	piID := ""
	if cs.PaymentIntent != nil {
		piID = cs.PaymentIntent.ID
	}
	if piID == "" {
		piID = "sess:" + cs.ID // fallback de idempotencia si no llegó el payment_intent
	}

	// Activación atómica e idempotente (marca pagado + coloca + liga paquete + PV).
	res, err := h.store.ActivatePaidPurchase(ctx, cs.ID, piID)
	if errors.Is(err, ErrIntentNotFound) {
		// Sesión desconocida (creada fuera de este servicio). No reintentar.
		h.log.Warn().Str("session", cs.ID).Msg("paid session has no purchase_intent; skipping")
		return nil
	}
	if err != nil {
		return err // 500 → Stripe reintenta; todo el flujo es idempotente
	}

	switch res.Status {
	case "activated":
		h.log.Info().Str("session", cs.ID).Str("pi", piID).Int64("affiliate_id", res.AffiliateID).Msg("payment confirmed → package activated")
	case "needs_placement":
		// Pago OK pero sin sponsor para colocar: requiere acción de ops/sponsor.
		h.log.Warn().Str("session", cs.ID).Str("pi", piID).Msg("paid but NEEDS MANUAL PLACEMENT (no sponsor)")
	case "replay":
		h.log.Info().Str("session", cs.ID).Msg("activation replay (already activated)")
	}
	// Nota: el asiento contable (capital + 1% platform_fee en wallet_movement)
	// queda diferido y se concilia aparte (ver docs). No bloquea la activación.
	return nil
}

// ── helpers ──────────────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}
