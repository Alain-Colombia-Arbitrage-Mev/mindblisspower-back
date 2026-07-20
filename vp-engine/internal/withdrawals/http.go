package withdrawals

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
)

const idTokenHeader = "X-VP-Id-Token"

// maxJSONBody acota el body de las peticiones JSON (paridad con
// internal/payments: json.NewDecoder(io.LimitReader(r.Body, 1<<16))).
const maxJSONBody = int64(1 << 16) // 64 KiB

// IdentityVerifier re-verifica el id token Cognito que reenvía el BFF. Se define
// aquí (no se importa de payments) para evitar un ciclo de imports: main inyecta
// payments.NewCognitoVerifier, que satisface esta interfaz estructuralmente.
type IdentityVerifier interface {
	VerifyEmail(ctx context.Context, rawToken string) (string, error)
}

// StoreAPI es la superficie del Store que consumen los handlers HTTP. Existe
// como interfaz para que la capa HTTP sea testeable sin Postgres; el único
// implementador de producción es *Store.
type StoreAPI interface {
	RequestWithdrawalWithBMP(ctx context.Context, email, amountStr, bankInfo, bmpEmail string, v BMPVerification) (WithdrawalResult, error)
	ListWithdrawals(ctx context.Context, status string, limit, offset int) ([]AdminWithdrawal, int64, error)
	SetWithdrawalStatus(ctx context.Context, id int64, status, adminEmail string) error
	IsAdmin(ctx context.Context, email string) (bool, error)
	PersonSuspendedByEmail(ctx context.Context, email string) (bool, error)
	EmailByWithdrawalID(ctx context.Context, id int64) (string, error)
	RefreshBMPVerification(ctx context.Context, id int64, v BMPVerification) error

	// Vínculo de email BMP alterno con aprobación admin (Task 11).
	RequestBMPLink(ctx context.Context, memberEmail, bmpEmail, ip string, v BMPVerification) (int64, error)
	ListPendingBMPLinks(ctx context.Context, limit, offset int) ([]BMPLink, int64, error)
	ReviewBMPLink(ctx context.Context, id int64, approve bool, adminEmail, note string) error
	ApprovedBMPEmail(ctx context.Context, memberEmail string) (string, error)
}

var _ StoreAPI = (*Store)(nil)

type Handler struct {
	store            StoreAPI
	log              zerolog.Logger
	serviceToken     string
	adminEmails      []string
	superAdminEmails []string // subconjunto con rol "super_admin" (acceso total)

	verifier        IdentityVerifier
	requireVerified bool

	// bmp verifica la cuenta BMP del afiliado. nil ⇒ verificación deshabilitada:
	// todo se comporta como 'unavailable' (fail-open al solicitar).
	bmp *BMPClient
}

func NewHandler(store StoreAPI, serviceToken string, adminEmails []string, log zerolog.Logger) *Handler {
	return &Handler{
		store:        store,
		serviceToken: serviceToken,
		adminEmails:  adminEmails,
		log:          log.With().Str("component", "withdrawals").Logger(),
	}
}

func (h *Handler) SetIdentityVerifier(v IdentityVerifier, strict bool) {
	h.verifier = v
	h.requireVerified = strict
}

// SetSuperAdmins define los emails con rol super_admin (acceso total). Son
// automáticamente admins también. Paridad con payments.Handler.SetSuperAdmins.
func (h *Handler) SetSuperAdmins(emails []string) { h.superAdminEmails = emails }

// SetBMPClient inyecta el cliente BMP. nil ⇒ verificación deshabilitada
// (todo se comporta como 'unavailable', fail-open al solicitar).
func (h *Handler) SetBMPClient(c *BMPClient) { h.bmp = c }

func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/api/payments/withdraw", h.handleWithdraw)
	mux.HandleFunc("/api/payments/bmp-status", h.handleBMPStatus)
	mux.HandleFunc("/api/admin/withdrawals", h.handleAdminWithdrawals)
	mux.HandleFunc("/api/admin/withdrawals/action", h.handleAdminWithdrawalAction)
	mux.HandleFunc("/api/payments/bmp-link", h.handleBMPLinkRequest)
	mux.HandleFunc("/api/admin/bmp-links", h.handleAdminBMPLinks)
	mux.HandleFunc("/api/admin/bmp-links/action", h.handleAdminBMPLinkAction)
	return mux
}

func (h *Handler) svcAuth(w http.ResponseWriter, r *http.Request) bool {
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-VP-Service-Token")), []byte(h.serviceToken)) != 1 {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return false
	}
	return true
}

func (h *Handler) verifiedEmail(r *http.Request) (string, bool) {
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

// resolveIdentity devuelve el email autoritativo. Header presente e inválido ⇒
// fail-closed. Header ausente con requireVerified ⇒ 401.
func (h *Handler) resolveIdentity(w http.ResponseWriter, r *http.Request, claimedEmail string) (string, bool) {
	claimed := strings.ToLower(strings.TrimSpace(claimedEmail))

	if strings.TrimSpace(r.Header.Get(idTokenHeader)) != "" {
		verified, ok := h.verifiedEmail(r)
		if !ok {
			writeErr(w, http.StatusUnauthorized, "invalid_id_token")
			return "", false
		}
		if claimed != "" && claimed != verified {
			h.log.Warn().Str("claimed", claimed).Str("verified", verified).Msg("identity mismatch")
			writeErr(w, http.StatusForbidden, "identity_mismatch")
			return "", false
		}
		return verified, true
	}
	if h.requireVerified {
		writeErr(w, http.StatusUnauthorized, "id_token_required")
		return "", false
	}
	if claimed == "" {
		writeErr(w, http.StatusBadRequest, "email_required")
		return "", false
	}
	h.log.Warn().Str("email", claimed).Msg("unverified-identity fallback")
	return claimed, true
}

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
// es is_admin en mlm.person (admins concedidos desde el panel, migración 47).
// Paridad exacta con payments.Handler.isAdminEmail: el error de la consulta se
// propaga para que el caller falle cerrado con 500 (nunca "no es admin").
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

type withdrawReq struct {
	Email    string `json:"email"`
	Amount   string `json:"amount"`    // USD, p.ej. "150.00"
	BankInfo string `json:"bank_info"` // banco/cuenta/titular (texto que verá ops)
}

func (h *Handler) handleWithdraw(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	var req withdrawReq
	if err := json.NewDecoder(io.LimitReader(r.Body, maxJSONBody)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}
	email, ok := h.resolveIdentity(w, r, req.Email)
	if !ok {
		return
	}
	// Validación de forma ANTES de tocar la base: un bank_info vacío persistiría
	// una solicitud impagable, y un amount vacío se reportaría como
	// "min_withdrawal" (engañoso). Paridad con payments.handleWithdraw.
	if req.Amount == "" || len(req.BankInfo) < 6 {
		writeErr(w, http.StatusBadRequest, "missing amount or bank_info")
		return
	}
	// D10 al SOLICITAR: FAIL-OPEN, deliberadamente al revés que al pagar. Una
	// solicitud no mueve dinero — queda pendiente de un admin y se vuelve a
	// verificar (esa vez fail-closed) al pagar. Así que un error de infra se
	// loguea y se deja pasar: negarle registrar la solicitud a un miembro limpio
	// porque la base tosió es peor que dejar entrar una solicitud que igual será
	// bloqueada aguas abajo.
	if susp, serr := h.store.PersonSuspendedByEmail(r.Context(), email); serr != nil {
		h.log.Error().Err(serr).Str("email", email).Msg("chequeo de suspensión (fail-open)")
	} else if susp {
		h.log.Warn().Str("email", email).Msg("solicitud de retiro bloqueada: cuenta suspendida")
		writeErr(w, http.StatusForbidden, "account_suspended")
		return
	}

	// Verificación BMP al solicitar: FAIL-OPEN, por la misma razón que el chequeo
	// de suspensión de arriba. Si BMP no responde, la solicitud se registra igual
	// marcada 'unavailable' y se re-verifica (fail-closed) al pagar. Una caída de
	// un tercero no debe congelar la experiencia del afiliado.
	bmpEmail := h.bmpEmailFor(r, email)
	verification := BMPVerification{BlockReason: BlockUnavailable, CheckedAt: time.Now().UTC()}
	if h.bmp != nil && h.bmp.Enabled() {
		if v, verr := h.bmp.VerifyUser(r.Context(), bmpEmail); verr != nil {
			h.logBMPError(verr)
		} else {
			verification = v
		}
	}

	res, err := h.store.RequestWithdrawalWithBMP(r.Context(), email, req.Amount, req.BankInfo, bmpEmail, verification)
	switch {
	case errors.Is(err, ErrMinWithdrawal):
		writeErr(w, http.StatusBadRequest, "min_withdrawal")
	case errors.Is(err, ErrInsufficient):
		writeErr(w, http.StatusBadRequest, "insufficient_balance")
	case errors.Is(err, ErrNoWallet):
		writeErr(w, http.StatusBadRequest, "no_balance")
	case err != nil:
		h.log.Error().Err(err).Msg("request withdrawal")
		writeErr(w, http.StatusInternalServerError, "internal")
	default:
		// Rastro de auditoría: toda solicitud de dinero queda logueada.
		h.log.Info().Int64("withdrawal_id", res.ID).Str("email", email).Msg("withdrawal requested")
		writeJSON(w, http.StatusOK, res)
	}
}

// handleBMPStatus consulta el estado BMP del email de sesión. FAIL-OPEN: si BMP
// no responde devuelve 200 con available:false y el modal deja continuar; la
// solicitud queda marcada 'unavailable' y se re-verifica (fail-closed) al pagar.
//
// available distingue "BMP contestó" de "no sabemos": el frontend NO debe leer
// can_withdraw:false como un bloqueo cuando available es false.
func (h *Handler) handleBMPStatus(w http.ResponseWriter, r *http.Request) {
	if !h.svcAuth(w, r) {
		return
	}
	email, ok := h.resolveIdentity(w, r, r.URL.Query().Get("email"))
	if !ok {
		return
	}
	if h.bmp == nil || !h.bmp.Enabled() {
		writeJSON(w, http.StatusOK, map[string]any{
			"available": false, "can_withdraw": false, "block_reason": BlockUnavailable,
		})
		return
	}

	bmpEmail := h.bmpEmailFor(r, email)
	v, err := h.bmp.VerifyUser(r.Context(), bmpEmail)
	if err != nil {
		h.logBMPError(err)
		writeJSON(w, http.StatusOK, map[string]any{
			"available": false, "can_withdraw": false, "block_reason": BlockUnavailable,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"available":    true,
		"can_withdraw": v.CanWithdraw,
		"block_reason": v.BlockReason,
		"bmp_email":    bmpEmail,
	})
}

// logBMPError distingue el fallo de NUESTRAS credenciales del resto: un 401/403
// significa que el Client-Secret venció o fue revocado, y eso bloquea la
// verificación de TODOS los afiliados. No puede pasar en silencio.
//
// La distinción se hace con errors.Is sobre el centinela ErrBMPAuth, no
// parseando el mensaje: el texto del error es formato, no contrato.
func (h *Handler) logBMPError(err error) {
	if errors.Is(err, ErrBMPAuth) {
		h.log.Error().Err(err).Msg("BMP AUTH FAILED — revisar Client-Id/Client-Secret; bloquea todos los pagos")
		return
	}
	if strings.Contains(err.Error(), "status 429") {
		h.log.Warn().Err(err).Msg("BMP rate limited")
		return
	}
	h.log.Warn().Err(err).Msg("BMP unavailable")
}

// bmpEmailFor devuelve el correo con el que se debe verificar en BMP: el
// vínculo alterno APROBADO si existe, o el de sesión.
//
// El guard de store nil mantiene utilizables los tests de handler que no montan
// base de datos (ver bmp_status_test.go).
//
// Un error al consultar el vínculo degrada al email de sesión en vez de fallar:
// esta ruta es fail-open igual que el resto de la verificación al solicitar, y
// el candado fail-closed al pagar vuelve a resolver el email (ver
// Store.EmailByWithdrawalID) sobre el valor ya persistido en la fila.
func (h *Handler) bmpEmailFor(r *http.Request, sessionEmail string) string {
	if h == nil || h.store == nil {
		return sessionEmail
	}
	linked, err := h.store.ApprovedBMPEmail(r.Context(), sessionEmail)
	if err != nil {
		h.log.Error().Err(err).Msg("approved bmp email")
		return sessionEmail
	}
	if linked != "" {
		return linked
	}
	return sessionEmail
}

type bmpLinkReq struct {
	Email    string `json:"email"`
	BMPEmail string `json:"bmp_email"`
}

// handleBMPLinkRequest: el miembro solicita vincular un email BMP alterno. Se
// verifica contra BMP PRIMERO — no se encola un email que BMP no reconoce,
// porque llenaría de basura la cola que un humano tiene que revisar.
//
// A diferencia del resto de la verificación al solicitar, acá NO hay fail-open:
// si BMP no responde no podemos saber si el correo existe, y encolar a ciegas es
// exactamente lo que este endpoint evita.
func (h *Handler) handleBMPLinkRequest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	var req bmpLinkReq
	if err := json.NewDecoder(io.LimitReader(r.Body, maxJSONBody)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}
	email, ok := h.resolveIdentity(w, r, req.Email)
	if !ok {
		return
	}
	if strings.TrimSpace(req.BMPEmail) == "" {
		writeErr(w, http.StatusBadRequest, "bmp_email_required")
		return
	}
	if h.bmp == nil || !h.bmp.Enabled() {
		writeErr(w, http.StatusServiceUnavailable, "bmp_unavailable")
		return
	}
	v, verr := h.bmp.VerifyUser(r.Context(), req.BMPEmail)
	if verr != nil {
		h.logBMPError(verr)
		writeErr(w, http.StatusServiceUnavailable, "bmp_unavailable")
		return
	}

	id, err := h.store.RequestBMPLink(r.Context(), email, req.BMPEmail, clientIP(r), v)
	switch {
	case errors.Is(err, ErrLinkPending):
		writeErr(w, http.StatusConflict, "link_already_pending")
	case errors.Is(err, ErrBMPEmailUnknown):
		writeErr(w, http.StatusBadRequest, "bmp_email_unknown")
	case errors.Is(err, ErrNoWallet):
		writeErr(w, http.StatusBadRequest, "no_affiliate")
	case err != nil:
		h.log.Error().Err(err).Msg("request bmp link")
		writeErr(w, http.StatusInternalServerError, "internal")
	default:
		// Rastro de auditoría: toda solicitud de vínculo queda logueada.
		h.log.Info().Int64("bmp_link_id", id).Str("email", email).Msg("bmp link requested")
		writeJSON(w, http.StatusOK, map[string]any{"id": id, "status": "pending_admin"})
	}
}

func (h *Handler) handleAdminBMPLinks(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	q := r.URL.Query()
	limit := atoiDefault(q.Get("limit"), 25)
	offset := atoiDefault(q.Get("offset"), 0)
	items, total, err := h.store.ListPendingBMPLinks(r.Context(), limit, offset)
	if err != nil {
		h.log.Error().Err(err).Msg("list bmp links")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": items, "total": total, "limit": limit, "offset": offset,
	})
}

type bmpLinkActionReq struct {
	Email  string `json:"email"`
	ID     int64  `json:"id"`
	Action string `json:"action"` // approve | reject
	Note   string `json:"note"`
}

func (h *Handler) handleAdminBMPLinkAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	// Body antes de identidad, mismo criterio que handleAdminWithdrawalAction:
	// growth-hub manda el email sólo en el body, vicion-admin en ambos.
	var req bmpLinkActionReq
	if err := json.NewDecoder(io.LimitReader(r.Body, maxJSONBody)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}
	claimed := strings.TrimSpace(req.Email)
	if claimed == "" {
		claimed = r.URL.Query().Get("email")
	}
	adminEmail, ok := h.resolveIdentity(w, r, claimed)
	if !ok {
		return
	}
	admin, err := h.isAdminEmail(r.Context(), adminEmail)
	if err != nil {
		h.log.Error().Err(err).Msg("is_admin")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	if !admin {
		writeErr(w, http.StatusForbidden, "not_admin")
		return
	}
	if (req.Action != "approve" && req.Action != "reject") || req.ID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid_action")
		return
	}
	if err := h.store.ReviewBMPLink(r.Context(), req.ID, req.Action == "approve", adminEmail, req.Note); err != nil {
		// Que el vínculo ya no esté pendiente es una condición de carrera entre
		// dos admins, no una falla: 409 con un motivo accionable.
		if errors.Is(err, ErrLinkNotPending) {
			h.log.Warn().Err(err).Int64("bmp_link_id", req.ID).Msg("bmp link review rejected")
			writeErr(w, http.StatusConflict, "review_rejected")
			return
		}
		h.log.Error().Err(err).Int64("bmp_link_id", req.ID).Msg("review bmp link")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	// Rastro four-eyes: qué vínculo, a qué estado y quién lo movió.
	h.log.Info().Int64("bmp_link_id", req.ID).Str("action", req.Action).Str("by", adminEmail).
		Msg("admin bmp link action")
	writeJSON(w, http.StatusOK, map[string]string{"status": req.Action})
}

// clientIP extrae la IP del solicitante para la auditoría del vínculo.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i > 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return ""
	}
	return host
}

func (h *Handler) handleAdminWithdrawals(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	q := r.URL.Query()
	limit := atoiDefault(q.Get("limit"), 25)
	offset := atoiDefault(q.Get("offset"), 0)
	items, total, err := h.store.ListWithdrawals(r.Context(), q.Get("status"), limit, offset)
	if err != nil {
		h.log.Error().Err(err).Msg("list withdrawals")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	// CONTRATO CONGELADO: la clave DEBE llamarse "withdrawals" (además de total/
	// limit/offset). Dos paneles en producción leen d.withdrawals — renombrarla
	// les devuelve 200 con lista vacía y ningún error visible.
	// Cubierto por TestAdminWithdrawalsResponseShape.
	writeJSON(w, http.StatusOK, map[string]any{
		"withdrawals": items, "total": total, "limit": limit, "offset": offset,
	})
}

type withdrawalActionReq struct {
	Email  string `json:"email"`
	ID     int64  `json:"id"`
	Action string `json:"action"` // approve|reject|pay|cancel
}

var actionToStatus = map[string]string{
	"approve": "approved",
	"reject":  "rejected",
	"pay":     "paid",
	"cancel":  "cancelled",
}

func (h *Handler) handleAdminWithdrawalAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	// El body se decodifica ANTES de resolver identidad: growth-hub manda el
	// email SÓLO en el body (sin query param). vicion-admin manda los dos, de
	// ahí el respaldo por query.
	var req withdrawalActionReq
	if err := json.NewDecoder(io.LimitReader(r.Body, maxJSONBody)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}
	claimed := strings.TrimSpace(req.Email)
	if claimed == "" {
		claimed = r.URL.Query().Get("email")
	}
	adminEmail, ok := h.resolveIdentity(w, r, claimed)
	if !ok {
		return
	}
	admin, err := h.isAdminEmail(r.Context(), adminEmail)
	if err != nil {
		h.log.Error().Err(err).Msg("is_admin")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	if !admin {
		writeErr(w, http.StatusForbidden, "not_admin")
		return
	}
	status := actionToStatus[req.Action]
	if status == "" || req.ID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid_action")
		return
	}
	// Al PAGAR se re-verifica contra BMP y se persiste el resultado, para que el
	// candado de admin.go (assertBMPFresh) evalúe datos frescos en vez de la
	// verificación del día de la solicitud.
	//
	// Ocurre acá, ANTES de SetWithdrawalStatus, precisamente para que la llamada
	// HTTP al tercero quede fuera de la transacción de Postgres del pago.
	//
	// Si BMP no responde NO se refresca nada: la verificación vieja queda y el
	// candado la rechaza por vencida (o por no elegible). El error se loguea, no
	// se propaga — el rechazo lo emite el candado, que es el único lugar donde
	// vive la regla.
	if status == "paid" && h.bmp != nil && h.bmp.Enabled() {
		email, eerr := h.store.EmailByWithdrawalID(r.Context(), req.ID)
		if eerr != nil {
			h.log.Error().Err(eerr).Int64("withdrawal_id", req.ID).Msg("resolver email para re-chequeo BMP")
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
		if v, verr := h.bmp.VerifyUser(r.Context(), email); verr != nil {
			h.logBMPError(verr)
		} else if rerr := h.store.RefreshBMPVerification(r.Context(), req.ID, v); rerr != nil {
			h.log.Error().Err(rerr).Int64("withdrawal_id", req.ID).Msg("persistir re-chequeo BMP")
		}
	}

	if err := h.store.SetWithdrawalStatus(r.Context(), req.ID, status, adminEmail); err != nil {
		// Sólo una transición inválida es culpa del cliente (409). Cualquier otro
		// error (Postgres caído, etc.) es 500: reportarlo como "transición
		// rechazada" le mentiría al admin sobre el estado del dinero.
		if errors.Is(err, ErrInvalidTransition) {
			h.log.Warn().Err(err).Int64("withdrawal_id", req.ID).Str("action", req.Action).
				Msg("withdrawal transition rejected")
			writeErr(w, http.StatusConflict, "transition_rejected")
			return
		}
		// El candado D10 bloqueó el pago: es una decisión de política, NO una
		// falla. Devolverlo como 500 le diría al admin "reintentá, se cayó algo"
		// cuando la respuesta correcta es "este retiro no se paga hasta resolver
		// el baneo". El dinero queda frenado en ambos casos; lo que cambia es
		// que el admin sepa por qué.
		if errors.Is(err, ErrSuspended) {
			h.log.Warn().Int64("withdrawal_id", req.ID).Str("by", adminEmail).
				Msg("pago bloqueado: cuenta suspendida/baneada")
			writeErr(w, http.StatusForbidden, "account_suspended")
			return
		}
		// El candado BMP bloqueó el pago. Mismo criterio que ErrSuspended: es
		// política, no falla, así que 409 con un motivo que el admin pueda
		// accionar (pedirle al afiliado que complete su cuenta BMP / reintentar
		// para refrescar la verificación) en vez de un 500 que diría "se cayó
		// algo, reintentá".
		if errors.Is(err, ErrBMPNotEligible) {
			h.log.Warn().Int64("withdrawal_id", req.ID).Str("by", adminEmail).
				Msg("pago bloqueado: cuenta BMP no habilitada")
			writeErr(w, http.StatusConflict, "bmp_not_eligible")
			return
		}
		if errors.Is(err, ErrBMPStale) {
			h.log.Warn().Int64("withdrawal_id", req.ID).Str("by", adminEmail).
				Msg("pago bloqueado: verificación BMP vencida")
			writeErr(w, http.StatusConflict, "bmp_verification_stale")
			return
		}
		h.log.Error().Err(err).Int64("withdrawal_id", req.ID).Str("action", req.Action).
			Msg("withdrawal action")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	// Rastro four-eyes: qué retiro, a qué estado y quién lo movió.
	h.log.Info().Int64("withdrawal_id", req.ID).Str("status", status).Str("by", adminEmail).
		Msg("admin withdrawal action")
	writeJSON(w, http.StatusOK, map[string]string{"status": status})
}

func atoiDefault(s string, def int) int {
	if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil {
		return n
	}
	return def
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}
