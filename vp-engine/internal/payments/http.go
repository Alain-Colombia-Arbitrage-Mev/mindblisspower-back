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
	"time"

	"github.com/rs/zerolog"
	stripe "github.com/stripe/stripe-go/v85"
	"github.com/vicionpower/vp-engine/internal/networkintel"
)

const maxWebhookBody = int64(1 << 18) // 256 KiB

// Handler expone los endpoints HTTP del servicio de pagos.
type Handler struct {
	store        *Store
	gw           *StripeGateway
	log          zerolog.Logger
	serviceToken string
	adminEmails  []string
	companyRoot  int64
	httpClient   *http.Client
}

func NewHandler(store *Store, gw *StripeGateway, serviceToken string, adminEmails []string, companyRoot int64, log zerolog.Logger) *Handler {
	return &Handler{
		store:        store,
		gw:           gw,
		serviceToken: serviceToken,
		adminEmails:  adminEmails,
		companyRoot:  companyRoot,
		log:          log.With().Str("component", "payments").Logger(),
		httpClient:   &http.Client{Timeout: 10 * time.Second},
	}
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
	mux.HandleFunc("/api/admin/payments", h.handleAdminPayments)
	mux.HandleFunc("/api/admin/withdrawals", h.handleAdminWithdrawals)
	mux.HandleFunc("/api/admin/withdrawals/action", h.handleAdminWithdrawalAction)
	mux.HandleFunc("/api/admin/finance", h.handleAdminFinance)
	mux.HandleFunc("/api/admin/solvency", h.handleAdminSolvency)
	mux.HandleFunc("/api/admin/plan", h.handleAdminPlan)
	mux.HandleFunc("/api/admin/plan/proposals", h.handleAdminPlanProposals)
	mux.HandleFunc("/api/admin/plan/propose", h.handleAdminPlanPropose)
	mux.HandleFunc("/api/admin/plan/decide", h.handleAdminPlanDecide)
	mux.HandleFunc("/api/admin/plan/simulate", h.handleAdminPlanSimulate)
	mux.HandleFunc("/api/admin/activity", h.handleAdminActivity)
	mux.HandleFunc("/api/admin/health/system", h.handleAdminHealthSystem)
	mux.HandleFunc("/api/admin/network/health", h.handleNetworkHealth)
	mux.HandleFunc("/api/admin/network/sustainability", h.handleNetworkSustainability)
	return h.rateLimit(mux)
}

// handleAdminActivity: feed de eventos de dominio recientes (Redis Stream).
func (h *Handler) handleAdminActivity(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	n := int64(atoiDefault(r.URL.Query().Get("limit"), 50))
	events, err := h.store.RecentActivity(r.Context(), n)
	if err != nil {
		h.log.Error().Err(err).Msg("recent activity")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": events})
}

// rateLimit: backstop por-endpoint (ventana fija 1 min) contra loops/abuso que
// saturen la DB. Generoso (la caché ya absorbe la carga normal). Nil cache o
// Redis caído ⇒ permite (no bloquea tráfico legítimo). Excluye webhook y health.
func (h *Handler) rateLimit(next http.Handler) http.Handler {
	const perPathPerMinute = 3000
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/webhooks/stripe" || r.URL.Path == "/health" {
			next.ServeHTTP(w, r)
			return
		}
		key := "rl:" + r.Method + ":" + r.URL.Path
		if !h.store.cache.allow(r.Context(), key, perPathPerMinute, time.Minute) {
			writeErr(w, http.StatusTooManyRequests, "rate_limited")
			return
		}
		next.ServeHTTP(w, r)
	})
}

type planSimulateReq struct {
	Email   string         `json:"email"`
	Changes map[string]any `json:"changes"`
}

// handleAdminPlanSimulate: proyecta θ bajo los cambios propuestos (preview del
// lock de solvencia, sin persistir nada).
func (h *Handler) handleAdminPlanSimulate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	var req planSimulateReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}
	if admin, err := h.isAdminEmail(r.Context(), req.Email); err != nil || !admin {
		writeErr(w, http.StatusForbidden, "not_admin")
		return
	}
	sim, err := h.store.SimulatePlanTheta(r.Context(), req.Changes)
	if err != nil {
		h.log.Error().Err(err).Msg("simulate plan")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, sim)
}

// handleAdminPlan: config de comisiones vigente + lista de campos editables.
func (h *Handler) handleAdminPlan(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	cfg, err := h.store.GetActivePlanConfig(r.Context())
	if err != nil {
		h.log.Error().Err(err).Msg("active plan")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	editable := make([]string, 0, len(planEditableFields))
	for _, f := range planEditableFields {
		editable = append(editable, f.Key)
	}
	writeJSON(w, http.StatusOK, map[string]any{"config": cfg, "editable": editable, "bounds": planBounds})
}

func (h *Handler) handleAdminPlanProposals(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	items, err := h.store.ListPlanProposals(r.Context())
	if err != nil {
		h.log.Error().Err(err).Msg("list proposals")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"proposals": items})
}

type planProposeReq struct {
	Email   string         `json:"email"`
	Changes map[string]any `json:"changes"`
	Reason  string         `json:"reason"`
}

func (h *Handler) handleAdminPlanPropose(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	var req planProposeReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}
	if admin, err := h.isAdminEmail(r.Context(), req.Email); err != nil || !admin {
		writeErr(w, http.StatusForbidden, "not_admin")
		return
	}
	id, err := h.store.ProposePlanChange(r.Context(), req.Email, req.Changes, req.Reason)
	if err != nil {
		if errors.Is(err, ErrPlanFieldNotEditable) || errors.Is(err, ErrPlanFieldOutOfBounds) {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		h.log.Error().Err(err).Msg("propose plan change")
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	h.log.Info().Int64("request_id", id).Str("by", req.Email).Msg("plan change proposed")
	writeJSON(w, http.StatusOK, map[string]any{"request_id": id, "status": "pending"})
}

type planDecideReq struct {
	Email   string `json:"email"`
	ID      int64  `json:"id"`
	Approve bool   `json:"approve"`
	Reason  string `json:"reason"`
}

func (h *Handler) handleAdminPlanDecide(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	var req planDecideReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}
	if admin, err := h.isAdminEmail(r.Context(), req.Email); err != nil || !admin {
		writeErr(w, http.StatusForbidden, "not_admin")
		return
	}
	if req.ID <= 0 {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	status, err := h.store.DecidePlanProposal(r.Context(), req.Email, req.ID, req.Approve, req.Reason)
	if err != nil {
		switch {
		case errors.Is(err, ErrApproverIsInitiator):
			writeErr(w, http.StatusForbidden, "approver_is_initiator")
		case errors.Is(err, ErrProposalNotPending):
			writeErr(w, http.StatusConflict, "not_pending")
		case errors.Is(err, ErrSolvencyLock):
			writeErr(w, http.StatusConflict, err.Error())
		default:
			h.log.Error().Err(err).Msg("decide plan proposal")
			writeErr(w, http.StatusInternalServerError, "internal")
		}
		return
	}
	h.log.Info().Int64("request_id", req.ID).Bool("approve", req.Approve).Str("status", status).Str("by", req.Email).Msg("plan proposal decided")
	writeJSON(w, http.StatusOK, map[string]string{"status": status})
}

// handleAdminFinance: tablero financiero de la red (entrante, distribuido,
// pendiente, rangos, tesorería, moneyflow).
func (h *Handler) handleAdminFinance(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	fin, err := h.store.GetAdminFinance(r.Context())
	if err != nil {
		h.log.Error().Err(err).Msg("admin finance")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, fin)
}

// handleAdminHealthSystem: NOC de infra + negocio + alertas. Read-only, degrada
// elegante (HTTP 200 siempre; checks fallidos => status down/unknown con detail).
func (h *Handler) handleAdminHealthSystem(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	siblings := map[string]string{
		"web":         env("HEALTH_WEB_URL", "http://127.0.0.1:3000/"),
		"vp-engine":   env("HEALTH_ENGINE_URL", "http://127.0.0.1:9090/health"),
		"vp-payments": env("HEALTH_PAYMENTS_URL", "http://127.0.0.1:9095/health"),
	}
	sh := h.store.GetSystemHealth(r.Context(), siblings)
	writeJSON(w, http.StatusOK, sh)
}

// handleNetworkHealth: snapshot de salud de la red (métricas reales → asesor AI
// determinístico). Devuelve analysis, metrics y rank_exposure.
func (h *Handler) handleNetworkHealth(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	m, rx, err := h.store.BuildNetworkMetrics(r.Context())
	if err != nil {
		h.log.Error().Err(err).Msg("build network metrics")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	m.RankLiabilityRatio = rx.ExposureRatio
	req := networkintel.AnalysisRequest{Metrics: m}
	resp := networkintel.DeterministicAnalysis(req)
	writeJSON(w, http.StatusOK, map[string]any{
		"analysis":     resp,
		"metrics":      m,
		"rank_exposure": rx,
	})
}

// handleNetworkSustainability: veredicto de sostenibilidad en tres escenarios
// (live, modesto, estres). El live es siempre fresco; los proyectados se
// cachean ~1h porque el simulador Monte Carlo es O(n²) (~12 s sin cache).
func (h *Handler) handleNetworkSustainability(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	ctx := r.Context()

	// ── Live (cheap — siempre fresco) ────────────────────────────────────────
	m, rx, err := h.store.BuildNetworkMetrics(ctx)
	if err != nil {
		h.log.Error().Err(err).Msg("sustainability: build network metrics")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	m.RankLiabilityRatio = rx.ExposureRatio
	liveVerdict := analyzeViaEngine(ctx, h.store.EngineURL, networkintel.AnalysisRequest{Metrics: m}, h.httpClient)

	// ── Projected (expensive — cached) ───────────────────────────────────────
	type projectedEntry struct {
		Scenario   string                    `json:"scenario"`
		Simulation ScenarioResult            `json:"simulation"`
		Analysis   networkintel.AnalysisResponse `json:"analysis"`
	}
	var projected []projectedEntry

	var projectedError string
	const projCacheKey = "sustainability:proj"
	if !h.store.cache.get(ctx, projCacheKey, &projected) {
		// Cache miss: run Monte Carlo scenarios (expensive).
		scenarios, serr := h.store.RunSustainabilityScenarios(ctx)
		if serr != nil {
			h.log.Error().Err(serr).Msg("sustainability: run scenarios (degraded — returning live only)")
			projected = []projectedEntry{}
			projectedError = serr.Error()
		} else {
			projected = make([]projectedEntry, 0, len(scenarios))
			for _, sc := range scenarios {
				// Build projected metrics from live, overriding WorstTheta with
				// the simulated value for this scenario.
				pm := m
				pm.WorstTheta = sc.WorstTheta
				verdict := analyzeViaEngine(ctx, h.store.EngineURL, networkintel.AnalysisRequest{Metrics: pm}, h.httpClient)
				projected = append(projected, projectedEntry{
					Scenario:   sc.Name,
					Simulation: sc,
					Analysis:   verdict,
				})
			}
			h.store.cache.set(ctx, projCacheKey, projected, sustainabilityCacheTTL)
		}
	}

	resp := map[string]any{
		"live": map[string]any{
			"metrics":  m,
			"analysis": liveVerdict,
		},
		"projected": projected,
	}
	if projectedError != "" {
		resp["projected_error"] = projectedError
	}
	writeJSON(w, http.StatusOK, resp)
}

// handleAdminSolvency: monitor de salud (θ histórico + período vigente + alerta
// de "árbol por romperse").
func (h *Handler) handleAdminSolvency(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	sv, err := h.store.GetSolvency(r.Context())
	if err != nil {
		h.log.Error().Err(err).Msg("admin solvency")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, sv)
}

func (h *Handler) handleAdminPayments(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	status := r.URL.Query().Get("status")
	q := r.URL.Query().Get("q")
	limit := atoiDefault(r.URL.Query().Get("limit"), 25)
	offset := atoiDefault(r.URL.Query().Get("offset"), 0)
	items, total, err := h.store.ListPayments(r.Context(), status, q, limit, offset)
	if err != nil {
		h.log.Error().Err(err).Msg("list payments")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"payments": items, "total": total, "limit": limit, "offset": offset})
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
	Ref       string `json:"ref"`   // código de referido (?ref=CODE) → sponsor para colocar
	Name      string `json:"name"`  // nombre del token (para auto-provisión de mlm.person)
	Phone     string `json:"phone"` // teléfono del token (E.164)
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

	// Auto-provisión: usuario nuevo de Cognito sin fila en RDS → crear mlm.person
	// (idempotente) para que el checkout pueda proceder. La colocación en el árbol
	// la hace la activación.
	if _, err := h.store.EnsurePerson(ctx, req.Email, req.Name, req.Phone); err != nil {
		h.log.Error().Err(err).Str("email", req.Email).Msg("ensure person")
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

	// Sponsor: el del afiliado existente; si es comprador nuevo (sin sponsor) y
	// vino con ?ref=CODE, resolvemos el código de referido → afiliado referidor.
	sponsor := buyer.SponsorAffiliateID
	if sponsor == nil && req.Ref != "" {
		if s, rerr := h.store.ResolveSponsorByCode(ctx, req.Ref); rerr == nil && s != nil {
			sponsor = s
		}
	}
	// Sin sponsor (sin ?ref ni afiliado previo) → root de empresa (la activación
	// derrama bajo él). Así nadie queda huérfano y el pago nunca se bloquea.
	if sponsor == nil && h.companyRoot > 0 {
		cr := h.companyRoot
		sponsor = &cr
	}

	intentID, err := h.store.CreatePurchaseIntent(ctx, PurchaseIntent{
		UserID:             req.Email, // traceability: identificador externo del comprador
		PersonID:           buyer.PersonID,
		AffiliateID:        buyer.AffiliateID,
		SponsorAffiliateID: sponsor,
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
