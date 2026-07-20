package withdrawals

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/rs/zerolog"
)

const idTokenHeader = "X-VP-Id-Token"

// IdentityVerifier re-verifica el id token Cognito que reenvía el BFF. Se define
// aquí (no se importa de payments) para evitar un ciclo de imports: main inyecta
// payments.NewCognitoVerifier, que satisface esta interfaz estructuralmente.
type IdentityVerifier interface {
	VerifyEmail(ctx context.Context, rawToken string) (string, error)
}

type Handler struct {
	store        *Store
	log          zerolog.Logger
	serviceToken string
	adminEmails  []string

	verifier        IdentityVerifier
	requireVerified bool
}

func NewHandler(store *Store, serviceToken string, adminEmails []string, log zerolog.Logger) *Handler {
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

func (h *Handler) isAdminEmail(email string) bool {
	for _, a := range h.adminEmails {
		if a == email {
			return true
		}
	}
	return false
}

func (h *Handler) requireAdmin(w http.ResponseWriter, r *http.Request) (string, bool) {
	if !h.svcAuth(w, r) {
		return "", false
	}
	email, ok := h.resolveIdentity(w, r, r.URL.Query().Get("email"))
	if !ok {
		return "", false
	}
	if !h.isAdminEmail(email) {
		writeErr(w, http.StatusForbidden, "not_admin")
		return "", false
	}
	return email, true
}

type withdrawReq struct {
	Email    string `json:"email"`
	Amount   string `json:"amount"`
	BankInfo string `json:"bank_info"`
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
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request")
		return
	}
	email, ok := h.resolveIdentity(w, r, req.Email)
	if !ok {
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
		writeJSON(w, http.StatusOK, res)
	}
}

func (h *Handler) handleAdminWithdrawals(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	offset, _ := strconv.Atoi(q.Get("offset"))
	items, total, err := h.store.ListWithdrawals(r.Context(), q.Get("status"), limit, offset)
	if err != nil {
		h.log.Error().Err(err).Msg("list withdrawals")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "total": total})
}

type withdrawalActionReq struct {
	ID     int64  `json:"id"`
	Action string `json:"action"`
}

var actionToStatus = map[string]string{
	"approve": "approved",
	"reject":  "rejected",
	"pay":     "paid",
	"cancel":  "cancelled",
}

func (h *Handler) handleAdminWithdrawalAction(w http.ResponseWriter, r *http.Request) {
	adminEmail, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	var req withdrawalActionReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request")
		return
	}
	status, ok := actionToStatus[req.Action]
	if !ok {
		writeErr(w, http.StatusBadRequest, "invalid_action")
		return
	}
	if err := h.store.SetWithdrawalStatus(r.Context(), req.ID, status, adminEmail); err != nil {
		h.log.Warn().Err(err).Int64("id", req.ID).Str("action", req.Action).Msg("withdrawal action rejected")
		writeErr(w, http.StatusConflict, "transition_rejected")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": status})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}
