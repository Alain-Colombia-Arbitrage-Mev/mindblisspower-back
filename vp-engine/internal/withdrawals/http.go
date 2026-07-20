package withdrawals

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
	RequestWithdrawal(ctx context.Context, email, amountStr, bankInfo string) (WithdrawalResult, error)
	ListWithdrawals(ctx context.Context, status string, limit, offset int) ([]AdminWithdrawal, int64, error)
	SetWithdrawalStatus(ctx context.Context, id int64, status, adminEmail string) error
	IsAdmin(ctx context.Context, email string) (bool, error)
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

func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/api/payments/withdraw", h.handleWithdraw)
	mux.HandleFunc("/api/admin/withdrawals", h.handleAdminWithdrawals)
	mux.HandleFunc("/api/admin/withdrawals/action", h.handleAdminWithdrawalAction)
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
	res, err := h.store.RequestWithdrawal(r.Context(), email, req.Amount, req.BankInfo)
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
