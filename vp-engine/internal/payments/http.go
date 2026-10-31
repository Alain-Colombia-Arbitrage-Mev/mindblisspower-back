package payments

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/rs/zerolog"
	"github.com/vicionpower/vp-engine/internal/networkintel"
)

// Handler expone los endpoints HTTP del servicio de pagos.
type Handler struct {
	store            *Store
	gw               *StripeGateway
	nowMemberships   *nowPaymentsMemberships
	nowCapture       *nowPaymentsCapture
	nowJobs          *nowOperationalJobRunner
	nowReady         func(context.Context) error
	log              zerolog.Logger
	serviceToken     string
	adminEmails      []string
	superAdminEmails []string // subconjunto con rol "super_admin" (acceso total)
	companyRoot      int64
	httpClient       *http.Client

	stripeCheckoutEnabled bool

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

	// Motor de soporte IA (vp-support + Qdrant/OpenRouter). Auto-draft no envia
	// correo; auto-reply queda opt-in por env para evitar respuestas no auditadas.
	supportAIURL       string
	supportAIToken     string
	supportAIAutoDraft bool
	supportAIAutoReply bool

	// Webhooks de Twilio para agente de voz y WhatsApp. Las llamadas entran por
	// rutas publicas especificas y se autentican con X-Twilio-Signature.
	twilioAuthToken       string
	twilioWebhookBaseURL  string
	twilioVerifySignature bool
	voiceAgentMaxTurns    int
	voiceSayLanguage      string
	voiceGatherLanguage   string
	voiceGatherTimeoutSec int
	voiceAgentMode        string
	pipecatStreamURL      string
	pipecatStreamSecret   string

	// comms: comunicados masivos (campañas de email). sender nil ⇒ endpoints
	// /api/admin/comms/* y /api/comms/unsubscribe responden 503 comms_disabled.
	comms struct {
		sender       *CommsSender
		maxAudience  int
		maxPerDay    int
		maxTestSends int
		unsubSecret  []byte
	}
}

// SetCognitoAdmin inyecta el cliente de administración de Cognito. nil ⇒ el
// banear/desbanear no deshabilita el login (solo el flag de DB).
func (h *Handler) SetCognitoAdmin(c *CognitoAdmin) { h.cognitoAdmin = c }

// SetStripeCheckoutEnabled configures new-session admission once at startup.
// It never disables webhook verification, historical reads or NOWPayments.
func (h *Handler) SetStripeCheckoutEnabled(enabled bool) {
	h.stripeCheckoutEnabled = enabled
	if h.gw != nil {
		h.gw.checkoutEnabled = enabled
	}
}

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

// Only a trusted proxy's last forwarded hop is used as the network identity.
func clientKey(r *http.Request) string {
	// X-Forwarded-For solo se honra si la conexión viene del proxy local
	// (Caddy en loopback / red privada). Un cliente directo podría inventar un
	// XFF distinto por request y fabricar claves ilimitadas, anulando el límite
	// por-cliente (quedaría solo el backstop global).
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" && fromTrustedProxy(r.RemoteAddr) {
		if i := strings.LastIndexByte(xff, ','); i >= 0 {
			return strings.TrimSpace(xff[i+1:])
		}
		return strings.TrimSpace(xff)
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

// handleAdminFinance: tablero financiero de la red (entrante, distribuido,
// pendiente, rangos, tesorería, moneyflow).
func (h *Handler) handleAdminFinance(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	fin, err := h.store.GetAdminFinance(r.Context())
	if err != nil {
		if errors.Is(err, ErrRecoveryFinancialReview) {
			writeErr(w, http.StatusServiceUnavailable, "stripe_recovery_financial_review_required")
			return
		}
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
	m, rx, err := h.store.BuildNetworkMetrics(r.Context(), h.companyRoot)
	if err != nil {
		if errors.Is(err, ErrRecoveryFinancialReview) {
			writeErr(w, http.StatusServiceUnavailable, "stripe_recovery_financial_review_required")
			return
		}
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
	m, rx, err := h.store.BuildNetworkMetrics(ctx, h.companyRoot)
	if err != nil {
		if errors.Is(err, ErrRecoveryFinancialReview) {
			writeErr(w, http.StatusServiceUnavailable, "stripe_recovery_financial_review_required")
			return
		}
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

// svcAuth valida el token de servicio (compartido con el BFF). Devuelve false
// y responde 401 si no coincide.
// handleAuthUserExists: GET /api/auth/user-exists?email= — el BFF del login OTP
// consulta si el email existe en el pool para enrutar usuarios nuevos a registro
// (el passwordless de Cognito no envía código a inexistentes y no lo revela).
// Gated por service token: solo el BFF lo llama, y el BFF rate-limita. Si el
// cliente admin de Cognito no está configurado, responde exists=true+checked=
// false (fail-safe: el login OTP sigue su curso normal, no rompemos nada).
func (h *Handler) handleAuthUserExists(w http.ResponseWriter, r *http.Request) {
	if !h.svcAuth(w, r) {
		return
	}
	email := strings.TrimSpace(r.URL.Query().Get("email"))
	if email == "" {
		writeErr(w, http.StatusBadRequest, "missing_email")
		return
	}
	if h.cognitoAdmin == nil {
		writeJSON(w, http.StatusOK, map[string]any{"exists": true, "checked": false})
		return
	}
	// GetUserStatus además del existe: el BFF del login OTP necesita distinguir
	// CONFIRMED de UNCONFIRMED. Un usuario UNCONFIRMED existe (por eso el login
	// no lo enruta a registro) pero el passwordless de Cognito no le envía código
	// hasta confirmar → quedaba atascado. Con "confirmed" el BFF reenvía el
	// código de confirmación en vez de fallar.
	access, err := h.cognitoAdmin.GetUserAccessStatus(r.Context(), email)
	if err != nil {
		h.log.Error().Err(err).Msg("user exists check")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"exists":            access.Exists,
		"checked":           true,
		"enabled":           access.Exists && access.Enabled,
		"status":            access.Status,
		"confirmed":         access.Exists && access.Status == "CONFIRMED",
		"email_verified":    access.EmailVerified,
		"phone_linked":      access.PhoneLinked,
		"phone_verified":    access.PhoneVerified,
		"phone_destination": maskPhoneNumber(access.PhoneNumber),
	})
}

func (h *Handler) handleAdminCheck(w http.ResponseWriter, r *http.Request) {
	if !h.svcAuth(w, r) {
		return
	}
	_, email, ok := h.effectiveIdentity(w, r, r.URL.Query().Get("email"))
	if !ok {
		return
	}
	if h.rejectIfSuspended(r.Context(), w, email) {
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
	identity, ok := h.requireAdminIdentity(w, r, req.Email)
	if !ok {
		return
	}
	req.Email = identity
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

// handleMemberReferral devuelve el código de referido real del miembro (por email).
func (h *Handler) handleMemberReferral(w http.ResponseWriter, r *http.Request) {
	if !h.svcAuth(w, r) {
		return
	}
	email, ok := h.resolveIdentity(w, r, r.URL.Query().Get("email"))
	if !ok {
		return
	}
	if h.rejectIfSuspended(r.Context(), w, email) {
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

// handleMe devuelve los pagos + posición + comisiones del miembro. Lo llama el
// BFF Next (token de servicio) pasando el email autenticado por Cognito.
func (h *Handler) handleMe(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	email, ok := h.resolveIdentity(w, r, r.URL.Query().Get("email"))
	if !ok {
		return
	}
	if h.rejectIfSuspended(r.Context(), w, email) {
		return
	}
	var summary MemberSummary
	var err error
	if r.URL.Query().Get("fresh") == "1" {
		summary, err = h.store.GetMemberSummaryFresh(r.Context(), email)
	} else {
		summary, err = h.store.GetMemberSummary(r.Context(), email)
	}
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
	h.attachNOWMemberPolicy(r, &summary, email)
	writeJSON(w, http.StatusOK, summary)
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
