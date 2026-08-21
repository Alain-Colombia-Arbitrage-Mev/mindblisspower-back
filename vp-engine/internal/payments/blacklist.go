package payments

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// IsBlacklisted consulta la lista negra de registro (mlm.is_blacklisted): email o
// teléfono coinciden, o nombre + fecha de nacimiento. birth vacío => solo
// email/phone. Devuelve el error para que el caller falle cerrado.
func (s *Store) IsBlacklisted(ctx context.Context, email, phone, name, birth string) (bool, error) {
	var birthArg any
	if b := strings.TrimSpace(birth); b != "" {
		if t, err := time.Parse("2006-01-02", b); err == nil {
			birthArg = t
		}
	}
	var banned bool
	err := s.reader().QueryRow(ctx,
		`SELECT mlm.is_blacklisted($1,$2,$3,$4::date)`,
		strings.TrimSpace(email), strings.TrimSpace(phone), strings.TrimSpace(name), birthArg,
	).Scan(&banned)
	if err != nil {
		return false, fmt.Errorf("is_blacklisted: %w", err)
	}
	return banned, nil
}

// handleRegistrationPrecheck: POST /api/registration/precheck — el BFF de registro
// lo invoca (token de servicio) ANTES del SignUp Cognito. Si el candidato está en
// la lista negra devuelve {"blacklisted":true} y el front muestra el popup de
// baneo. Ante error de infra falla cerrado: no se crea una cuenta sin poder
// validar blacklist.
func (h *Handler) handleRegistrationPrecheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	var req struct {
		Email     string `json:"email"`
		Phone     string `json:"phone"`
		Name      string `json:"name"`
		BirthDate string `json:"birth_date"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request")
		return
	}
	banned, err := h.store.IsBlacklisted(r.Context(), req.Email, req.Phone, req.Name, req.BirthDate)
	if err != nil {
		h.log.Error().Err(err).Msg("registration precheck")
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"blacklisted": false, "error": "precheck_unavailable"})
		return
	}
	if banned {
		h.log.Warn().Str("email", strings.ToLower(strings.TrimSpace(req.Email))).Msg("registro bloqueado: lista negra")
	}
	writeJSON(w, http.StatusOK, map[string]bool{"blacklisted": banned})
}
