package payments

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/rs/zerolog"
	stripe "github.com/stripe/stripe-go/v85"
	"github.com/vicionpower/vp-engine/internal/networkintel"
)

const maxWebhookBody = int64(1 << 18) // 256 KiB

// idTokenHeader es el header por el que el BFF reenvía el id token Cognito crudo
// para que el backend re-verifique la identidad (defensa en profundidad, H-2).
const idTokenHeader = "X-VP-Id-Token"

// Handler expone los endpoints HTTP del servicio de pagos.
type Handler struct {
	store            *Store
	gw               *StripeGateway
	log              zerolog.Logger
	serviceToken     string
	adminEmails      []string
	superAdminEmails []string // subconjunto con rol "super_admin" (acceso total)
	companyRoot      int64
	httpClient       *http.Client

	// verifier re-verifica el id token Cognito reenviado por el BFF. nil ⇒ no hay
	// verificación disponible (sólo el fallback por query/body, con warning).
	verifier IdentityVerifier
	// requireVerified: si true, el header X-VP-Id-Token es obligatorio en los
	// handlers que portan identidad (modo estricto tras el rollout de los BFFs).
	requireVerified bool

	// kyc: presignado S3 para subida de documentos KYC. nil ⇒ endpoints KYC
	// responden 503 kyc-unconfigured.
	kyc *KYCS3

	// kycocr: filtro OCR de pasaportes (OpenRouter visión). nil/deshabilitado ⇒
	// los pasaportes quedan in_review para revisión manual.
	kycocr *KYCOCR

	// cognitoAdmin: enable/disable de login en Cognito al banear/desbanear.
	// nil ⇒ el efecto Cognito se omite (solo se aplica el flag en mlm.person).
	cognitoAdmin *CognitoAdmin

	// Recuperación de carritos abandonados: origen público del link "reanudar
	// pago" y URL de éxito (para el caso "ya pagado"). El HMAC del token de
	// resume usa serviceToken como clave.
	resumeBaseURL string
	successURL    string
}

// SetCognitoAdmin inyecta el cliente de administración de Cognito. nil ⇒ el
// banear/desbanear no deshabilita el login (solo el flag de DB).
func (h *Handler) SetCognitoAdmin(c *CognitoAdmin) { h.cognitoAdmin = c }

// SetCartConfig inyecta el origen público del link de reanudar pago y la URL de
// éxito, usados por el flujo de recuperación de carritos abandonados.
func (h *Handler) SetCartConfig(resumeBaseURL, successURL string) {
	h.resumeBaseURL = resumeBaseURL
	h.successURL = successURL
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

// SetIdentityVerifier inyecta el verificador de id tokens y el modo estricto.
// verifier nil deja el backend en modo fallback (sólo query/body email, con
// warning) para no romper callers durante el rollout.
func (h *Handler) SetIdentityVerifier(v IdentityVerifier, requireVerified bool) {
	h.verifier = v
	h.requireVerified = requireVerified
}

// SetSuperAdmins define los emails con rol super_admin (acceso total). Son
// automáticamente admins también.
func (h *Handler) SetSuperAdmins(emails []string) { h.superAdminEmails = emails }

// isSuperAdmin: true si el email está en el allowlist de super-admins.
func (h *Handler) isSuperAdmin(email string) bool {
	for _, a := range h.superAdminEmails {
		if strings.EqualFold(strings.TrimSpace(a), strings.TrimSpace(email)) {
			return true
		}
	}
	return false
}

// isAdminEmail: true si el email es super-admin, está en el allowlist por env, o
// es is_admin en mlm.person.
func (h *Handler) isAdminEmail(ctx context.Context, email string) (bool, error) {
	if h.isSuperAdmin(email) {
		return true, nil
	}
	for _, a := range h.adminEmails {
		if strings.EqualFold(strings.TrimSpace(a), strings.TrimSpace(email)) {
			return true, nil
		}
	}
	return h.store.IsAdmin(ctx, email)
}

// roleOf devuelve "super_admin" | "admin" | "" (para etiquetas del panel).
func (h *Handler) roleOf(ctx context.Context, email string) string {
	if h.isSuperAdmin(email) {
		return "super_admin"
	}
	if admin, _ := h.isAdminEmail(ctx, email); admin {
		return "admin"
	}
	return ""
}

// Routes monta el mux del servicio.
func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/api/payments/checkout", h.handleCheckout)
	mux.HandleFunc("/api/payments/resume", h.handleResume)
	mux.HandleFunc("/api/payments/me", h.handleMe)
	mux.HandleFunc("/api/member/referral", h.handleMemberReferral)
	mux.HandleFunc("/api/member/profile", h.handleMemberProfile)
	mux.HandleFunc("/api/member/kyc/upload-url", h.handleKYCUploadURL)
	mux.HandleFunc("/api/member/kyc/confirm", h.handleKYCConfirm)
	mux.HandleFunc("/api/member/kyc/documents", h.handleKYCDocuments)
	mux.HandleFunc("/api/payments/withdraw", h.handleWithdraw)
	mux.HandleFunc("/api/webhooks/stripe", h.handleWebhook)
	mux.HandleFunc("/api/admin/check", h.handleAdminCheck)
	mux.HandleFunc("/api/admin/users", h.handleAdminUsers)
	mux.HandleFunc("/api/admin/summary", h.handleAdminSummary)
	mux.HandleFunc("/api/admin/block", h.handleAdminBlock)
	mux.HandleFunc("/api/admin/blacklist", h.handleAdminBlacklist)
	mux.HandleFunc("/api/admin/blacklist/remove", h.handleAdminBlacklistRemove)
	mux.HandleFunc("/api/admin/admins", h.handleAdminAdmins)
	mux.HandleFunc("/api/admin/admins/role", h.handleAdminAdminRole)
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
	mux.HandleFunc("/api/admin/sales/report", h.handleAdminSalesReport)
	mux.HandleFunc("/api/admin/sales/transactions", h.handleAdminSalesTransactions)
	mux.HandleFunc("/api/admin/sales/verify", h.handleAdminSalesVerify)
	mux.HandleFunc("/api/admin/carts/remind", h.handleAdminCartRemind)
	mux.HandleFunc("/api/admin/carts/summary", h.handleAdminCartsSummary)
	mux.HandleFunc("/api/admin/sales/reconcile", h.handleAdminSalesReconcile)
	mux.HandleFunc("/api/admin/sales/sweep", h.handleAdminSalesSweep)
	mux.HandleFunc("/api/admin/tickets", h.handleAdminTickets)
	mux.HandleFunc("/api/admin/tickets/action", h.handleAdminTicketAction)
	mux.HandleFunc("/api/admin/email", h.handleAdminEmail)
	mux.HandleFunc("/api/support/ticket", h.handleMemberTicket)
	mux.HandleFunc("/api/events/registration", h.handleRegistrationEvent)
	mux.HandleFunc("/api/registration/precheck", h.handleRegistrationPrecheck)
	mux.HandleFunc("/api/admin/health/system", h.handleAdminHealthSystem)
	mux.HandleFunc("/api/admin/network/health", h.handleNetworkHealth)
	mux.HandleFunc("/api/admin/network/sustainability", h.handleNetworkSustainability)
	mux.HandleFunc("/api/admin/command-center/summary", h.handleCommandCenterSummary)
	mux.HandleFunc("/api/admin/command-center/alerts", h.handleCommandCenterAlerts)
	mux.HandleFunc("/api/admin/command-center/alerts/{id}/ack", h.handleCommandCenterAlertAck)
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

// rateLimit: dos capas (ventana fija 1 min). Antes el contador era GLOBAL por
// path (3000/min compartido entre TODOS los usuarios): con carga alta los
// usuarios legítimos se bloqueaban entre sí ("demasiados intentos").
//   - por cliente+path (240/min): "cliente" = IP real (X-Forwarded-For del
//     proxy) o, si el BFF no la reenvía, el email del query autenticado —
//     un abusivo se limita solo a sí mismo.
//   - global por path (12000/min): backstop que protege la DB ante estampidas.
//
// Nil cache o Redis caído ⇒ permite. Excluye webhook y health.
func (h *Handler) rateLimit(next http.Handler) http.Handler {
	const perClientPerMinute = 240
	const perPathPerMinute = 12000
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/webhooks/stripe" || r.URL.Path == "/health" {
			next.ServeHTTP(w, r)
			return
		}
		client := clientKey(r)
		if !h.store.cache.allow(r.Context(), "rl:c:"+client+":"+r.Method+":"+r.URL.Path, perClientPerMinute, time.Minute) ||
			!h.store.cache.allow(r.Context(), "rl:g:"+r.Method+":"+r.URL.Path, perPathPerMinute, time.Minute) {
			writeErr(w, http.StatusTooManyRequests, "rate_limited")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// clientKey identifica al cliente para rate limiting: primera IP del
// X-Forwarded-For (Caddy/BFF), o el email del query (llamadas BFF sin XFF),
// o la IP directa como último recurso.
func clientKey(r *http.Request) string {
	// X-Forwarded-For solo se honra si la conexión viene del proxy local
	// (Caddy en loopback / red privada). Un cliente directo podría inventar un
	// XFF distinto por request y fabricar claves ilimitadas, anulando el límite
	// por-cliente (quedaría solo el backstop global).
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" && fromTrustedProxy(r.RemoteAddr) {
		if i := strings.IndexByte(xff, ','); i > 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	if email := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("email"))); email != "" {
		return email
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

// fromTrustedProxy: true si la conexión entra por loopback o red privada (el
// proxy Caddy corre en el mismo host / VPC). Solo entonces el XFF es confiable.
func fromTrustedProxy(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate()
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
	email, ok := h.resolveIdentity(w, r, req.Email)
	if !ok {
		return
	}
	req.Email = email
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
	email, ok := h.resolveIdentity(w, r, req.Email)
	if !ok {
		return
	}
	req.Email = email
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
	email, ok := h.resolveIdentity(w, r, req.Email)
	if !ok {
		return
	}
	req.Email = email
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
		"analysis":      resp,
		"metrics":       m,
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
		Scenario   string                        `json:"scenario"`
		Simulation ScenarioResult                `json:"simulation"`
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
	identity, ok := h.resolveIdentity(w, r, req.Email)
	if !ok {
		return
	}
	req.Email = identity
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

// verifiedEmail lee el id token del header X-VP-Id-Token y lo re-verifica
// (firma JWKS + iss + aud==clientId + token_use==id + exp). Devuelve el email
// verificado (lowercased) y true en éxito. Devuelve ("", false) si el header
// está ausente o si la verificación falla (fail-closed cuando el header SÍ está
// presente pero es inválido — el caller distingue ese caso con headerPresent).
func (h *Handler) verifiedEmail(r *http.Request) (email string, ok bool) {
	raw := strings.TrimSpace(r.Header.Get(idTokenHeader))
	if raw == "" || h.verifier == nil {
		return "", false
	}
	v, err := h.verifier.VerifyEmail(r.Context(), raw)
	if err != nil {
		h.log.Warn().Err(err).Msg("id token verification failed")
		return "", false
	}
	return strings.ToLower(strings.TrimSpace(v)), true
}

// resolveIdentity deriva la identidad autoritativa de una request ya autenticada
// por token de servicio, combinando el id token verificado (header) con el email
// declarado por el cliente (query/body). Reglas (H-2, backward-compatible):
//
//   - Header presente + verificación OK ⇒ usa el email VERIFICADO. Si además
//     viene un email declarado que NO coincide ⇒ 403 (evita que un caller
//     asuma otra identidad que la de su token).
//   - Header presente pero inválido ⇒ 401 (fail-closed; no cae al fallback).
//   - Header ausente:
//   - requireVerified=true ⇒ 401 (modo estricto).
//   - requireVerified=false ⇒ fallback al email declarado + warning
//     ("unverified-identity fallback") para observar callers pendientes.
//
// Devuelve el email autoritativo y true si la request puede proceder; en caso
// contrario ya escribió la respuesta de error y devuelve false.
func (h *Handler) resolveIdentity(w http.ResponseWriter, r *http.Request, claimedEmail string) (string, bool) {
	claimed := strings.ToLower(strings.TrimSpace(claimedEmail))

	raw := strings.TrimSpace(r.Header.Get(idTokenHeader))
	if raw != "" {
		verified, ok := h.verifiedEmail(r)
		if !ok {
			// Header presente pero no verifica ⇒ fail-closed.
			writeErr(w, http.StatusUnauthorized, "invalid_id_token")
			return "", false
		}
		if claimed != "" && claimed != verified {
			h.log.Warn().Str("claimed", claimed).Str("verified", verified).Msg("identity mismatch: claimed email != verified id token")
			writeErr(w, http.StatusForbidden, "identity_mismatch")
			return "", false
		}
		return verified, true
	}

	// Header ausente.
	if h.requireVerified {
		writeErr(w, http.StatusUnauthorized, "id_token_required")
		return "", false
	}
	if claimed == "" {
		writeErr(w, http.StatusBadRequest, "missing email")
		return "", false
	}
	h.log.Warn().Str("email", claimed).Str("path", r.URL.Path).Msg("unverified-identity fallback (no X-VP-Id-Token)")
	return claimed, true
}

// requireAdmin valida token de servicio + identidad verificada (o fallback) +
// que el email resultante sea admin.
func (h *Handler) requireAdmin(w http.ResponseWriter, r *http.Request) (string, bool) {
	if !h.svcAuth(w, r) {
		return "", false
	}
	email, ok := h.resolveIdentity(w, r, r.URL.Query().Get("email"))
	if !ok {
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
	email, ok := h.resolveIdentity(w, r, r.URL.Query().Get("email"))
	if !ok {
		return
	}
	admin, err := h.isAdminEmail(r.Context(), email)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"is_admin": admin, "role": h.roleOf(r.Context(), email)})
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
	identity, ok := h.resolveIdentity(w, r, req.Email)
	if !ok {
		return
	}
	req.Email = identity
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
	email, ok := h.resolveIdentity(w, r, req.Email)
	if !ok {
		return
	}
	req.Email = email
	if req.Amount == "" || len(req.BankInfo) < 6 {
		writeErr(w, http.StatusBadRequest, "missing amount or bank_info")
		return
	}
	// Wallet congelada: un usuario baneado/suspendido no puede retirar.
	if h.rejectIfSuspended(r.Context(), w, req.Email) {
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
	email, ok := h.resolveIdentity(w, r, r.URL.Query().Get("email"))
	if !ok {
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
	email, ok := h.resolveIdentity(w, r, r.URL.Query().Get("email"))
	if !ok {
		return
	}
	summary, err := h.store.GetMemberSummary(r.Context(), email)
	if errors.Is(err, ErrBuyerNotFound) {
		// Usuario registrado en Cognito que aún no está provisionado en la red
		// (no ha comprado). No es un error: devolvemos un resumen vacío 200 para
		// que el perfil cargue sin un 404 en consola. El KYC/checkout crean la
		// persona cuando corresponde.
		writeJSON(w, http.StatusOK, map[string]any{
			"positioned":         false,
			"kyc_status":         "not_started",
			"wallet_balance_usd": "0.00",
			"active_packages":    0,
		})
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
	// Wallet congelada: un usuario baneado/suspendido no puede comprar.
	if h.rejectIfSuspended(ctx, w, req.Email) {
		return
	}
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
	// Guard de cuenta compartida: la cuenta Stripe la comparten varios negocios.
	// Solo activamos sesiones marcadas como "PACK MINDBLISS" (estampado en
	// CreateCheckout). Un evento ajeno que llegue aquí se ignora sin error (200)
	// para no forzar reintentos de Stripe. Defensa-en-profundidad: el flujo ya
	// rechaza sesiones sin purchase_intent, pero este gate lo hace explícito.
	if cs.Metadata[MetadataProductTag] != MetadataProductVal {
		h.log.Warn().Str("session", cs.ID).Str("event", event.ID).
			Msg("checkout.session sin marca packmindbliss; ignorando (cuenta compartida)")
		return nil
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
