package payments

import (
	"context"
	"net/http"
	"strings"
)

// Salud de acceso (OTP): el panel admin necesita ver QUÉ usuarios tienen
// problemas para recibir el código y el estado de acceso de uno puntual.

// AccessHelpTicket es un ticket de "ayuda de acceso" (subconjunto de support.ticket).
type AccessHelpTicket struct {
	ID        int64  `json:"id"`
	Email     string `json:"email"`
	Status    string `json:"status"`
	CreatedAt string `json:"created_at"`
}

// AccessHelpSummary lista los tickets de ayuda de acceso más recientes y cuántos
// están abiertos (los usuarios que NO reciben el código y pidieron ayuda).
func (s *Store) AccessHelpSummary(ctx context.Context, limit int) (open int64, recent []AccessHelpTicket, err error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	if err = s.reader().QueryRow(ctx, `
		SELECT count(*) FROM support.ticket
		 WHERE subject LIKE 'Ayuda de acceso%' AND status = 'open'`).Scan(&open); err != nil {
		return 0, nil, err
	}
	rows, err := s.reader().Query(ctx, `
		SELECT id, email, status, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SSZ')
		  FROM support.ticket
		 WHERE subject LIKE 'Ayuda de acceso%'
		 ORDER BY created_at DESC
		 LIMIT $1`, limit)
	if err != nil {
		return 0, nil, err
	}
	defer rows.Close()
	recent = []AccessHelpTicket{}
	for rows.Next() {
		var t AccessHelpTicket
		if err = rows.Scan(&t.ID, &t.Email, &t.Status, &t.CreatedAt); err != nil {
			return 0, nil, err
		}
		recent = append(recent, t)
	}
	return open, recent, rows.Err()
}

// IsActiveAffiliate: true si el email corresponde a un afiliado ACTIVO en la DB.
func (s *Store) IsActiveAffiliate(ctx context.Context, email string) (bool, error) {
	var ok bool
	err := s.reader().QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM mlm.person p
			  JOIN mlm.affiliate a ON a.person_id = p.id
			 WHERE lower(p.email) = $1 AND a.status = 'active')`, strings.ToLower(strings.TrimSpace(email))).Scan(&ok)
	return ok, err
}

// handleAdminOtpHealth: GET /api/admin/otp-health — resumen para el panel.
func (h *Handler) handleAdminOtpHealth(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	open, recent, err := h.store.AccessHelpSummary(r.Context(), 20)
	if err != nil {
		h.log.Error().Err(err).Msg("otp health summary")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"access_help_open": open,
		"recent":           recent,
	})
}

// handleAdminOtpCheck: GET /api/admin/otp-check?target=email — estado de acceso
// de UN usuario: existe en Cognito, confirmado, habilitado, y si es afiliado
// activo (legacy sin cuenta digital). Responde "por qué no le llega el código".
func (h *Handler) handleAdminOtpCheck(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	email := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("target")))
	if email == "" || !strings.Contains(email, "@") {
		writeErr(w, http.StatusBadRequest, "invalid_target")
		return
	}

	var access CognitoUserAccessStatus
	if h.cognitoAdmin != nil {
		var cerr error
		access, cerr = h.cognitoAdmin.GetUserAccessStatus(r.Context(), email)
		if cerr != nil {
			h.log.Warn().Err(cerr).Str("email", email).Msg("otp check: cognito status")
		}
	}

	// ¿Es afiliado activo en la DB? (miembro legacy sin/con Cognito).
	isActiveAffiliate, _ := h.store.IsActiveAffiliate(r.Context(), email)

	// Diagnóstico legible del problema más probable.
	diagnosis := "ok"
	switch {
	case !access.Exists && isActiveAffiliate:
		diagnosis = "legacy_sin_cognito" // afiliado activo pero nunca creó acceso digital
	case !access.Exists:
		diagnosis = "no_registrado"
	case access.Status != "CONFIRMED":
		diagnosis = "sin_confirmar" // registró pero no confirmó → OTP de login no se envía
	case !access.Enabled:
		diagnosis = "deshabilitado"
	case !access.EmailVerified:
		diagnosis = "email_sin_validar"
	case !access.PhoneLinked:
		diagnosis = "telefono_no_vinculado"
	case !access.PhoneVerified:
		diagnosis = "telefono_sin_validar"
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"email":             email,
		"cognito_exists":    access.Exists,
		"cognito_confirmed": access.Exists && access.Status == "CONFIRMED",
		"cognito_enabled":   access.Enabled,
		"cognito_status":    access.Status,
		"email_verified":    access.EmailVerified,
		"phone_linked":      access.PhoneLinked,
		"phone_verified":    access.PhoneVerified,
		"phone_destination": maskPhoneNumber(access.PhoneNumber),
		"active_affiliate":  isActiveAffiliate,
		"diagnosis":         diagnosis,
	})
}
