package payments

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type banQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

// BanCandidate describe las señales disponibles para evaluar acceso. Email y
// teléfono son identificadores fuertes; nombre exacto normalizado permite vetos
// operativos cuando el admin decide bloquear una identidad por nombre.
type BanCandidate struct {
	Email     string
	Phone     string
	Name      string
	BirthDate string
}

// BanDecision es la decisión normalizada del motor de baneo.
type BanDecision struct {
	Blocked bool
	Reason  string
}

func parseBanBirthDate(birth string) any {
	var birthArg any
	if b := strings.TrimSpace(birth); b != "" {
		if t, err := time.Parse("2006-01-02", b); err == nil {
			birthArg = t
		}
	}
	return birthArg
}

// BanDecisionFor consulta de forma unificada el veto operativo:
//   - mlm.person.blacklisted/status por email autenticado,
//   - mlm.blacklist por email_norm, phone_last10,
//   - mlm.blacklist por nombre exacto normalizado; si la fila blacklist tiene
//     birthdate, exige que el candidato también coincida con esa fecha.
//
// Si el candidato trae solo email, se enriquecen teléfono/nombre/fecha desde
// mlm.person para que un ban por nombre también bloquee sesiones existentes.
func (s *Store) BanDecisionFor(ctx context.Context, c BanCandidate) (BanDecision, error) {
	return banDecisionFor(ctx, s.reader(), c)
}

func banDecisionFor(ctx context.Context, q banQuerier, c BanCandidate) (BanDecision, error) {
	var reason string
	err := q.QueryRow(ctx, `
		WITH input AS (
		  SELECT mlm.norm_email($1) AS email_norm,
		         mlm.norm_phone10($2) AS phone_last10,
		         mlm.norm_name($3) AS name_norm,
		         $4::date AS birthdate
		),
		account AS (
		  SELECT p.id,
		         mlm.norm_email(p.email) AS email_norm,
		         mlm.norm_phone10(p.phone_number) AS phone_last10,
		         mlm.norm_name(p.first_name || ' ' || p.last_name) AS name_norm,
		         p.birthday AS birthdate,
		         (COALESCE(p.blacklisted,false)
		           OR p.status::text IN ('suspended','banned','deleted')
		           OR EXISTS (
		              SELECT 1
		                FROM mlm.affiliate a
		               WHERE a.person_id = p.id
		                 AND a.status::text IN ('suspended','banned','deleted')
		           )) AS suspended
		    FROM mlm.person p
		    JOIN input i ON i.email_norm IS NOT NULL AND mlm.norm_email(p.email) = i.email_norm
		   LIMIT 1
		),
		candidate AS (
		  SELECT COALESCE(i.email_norm, a.email_norm) AS email_norm,
		         COALESCE(i.phone_last10, a.phone_last10) AS phone_last10,
		         COALESCE(i.name_norm, a.name_norm) AS name_norm,
		         COALESCE(i.birthdate, a.birthdate) AS birthdate
		    FROM input i
		    LEFT JOIN account a ON true
		),
		blacklist_match AS (
		  SELECT CASE
		           WHEN c.email_norm IS NOT NULL AND b.email_norm = c.email_norm THEN 'blacklist_email'
		           WHEN c.phone_last10 IS NOT NULL AND b.phone_last10 = c.phone_last10 THEN 'blacklist_phone'
		           WHEN c.name_norm IS NOT NULL AND b.name_norm = c.name_norm THEN 'blacklist_name'
		           ELSE 'blacklist'
		         END AS reason
		    FROM mlm.blacklist b
		    CROSS JOIN candidate c
		   WHERE (c.email_norm IS NOT NULL AND b.email_norm = c.email_norm)
		      OR (c.phone_last10 IS NOT NULL AND b.phone_last10 = c.phone_last10)
		      OR (c.name_norm IS NOT NULL AND b.name_norm = c.name_norm
		          AND (b.birthdate IS NULL OR (c.birthdate IS NOT NULL AND b.birthdate = c.birthdate)))
		   ORDER BY CASE
		              WHEN c.email_norm IS NOT NULL AND b.email_norm = c.email_norm THEN 1
		              WHEN c.phone_last10 IS NOT NULL AND b.phone_last10 = c.phone_last10 THEN 2
		              ELSE 3
		            END
		   LIMIT 1
		)
		SELECT COALESCE(
		         (SELECT 'account_suspended' FROM account WHERE suspended LIMIT 1),
		         (SELECT reason FROM blacklist_match LIMIT 1),
		         ''
		       )
	`, strings.TrimSpace(c.Email), strings.TrimSpace(c.Phone), strings.TrimSpace(c.Name), parseBanBirthDate(c.BirthDate)).Scan(&reason)
	if err != nil {
		return BanDecision{}, fmt.Errorf("ban decision: %w", err)
	}
	reason = strings.TrimSpace(reason)
	return BanDecision{Blocked: reason != "", Reason: reason}, nil
}

// IsBlacklisted mantiene la firma histórica del precheck de registro.
func (s *Store) IsBlacklisted(ctx context.Context, email, phone, name, birth string) (bool, error) {
	decision, err := s.BanDecisionFor(ctx, BanCandidate{
		Email: email, Phone: phone, Name: name, BirthDate: birth,
	})
	if err != nil {
		return false, err
	}
	return decision.Blocked, nil
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
		Email        string `json:"email"`
		Phone        string `json:"phone"`
		Name         string `json:"name"`
		BirthDate    string `json:"birth_date"`
		ReferralCode string `json:"referral_code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request")
		return
	}
	decision, err := h.store.BanDecisionFor(r.Context(), BanCandidate{
		Email: req.Email, Phone: req.Phone, Name: req.Name, BirthDate: req.BirthDate,
	})
	if err != nil {
		h.log.Error().Err(err).Msg("registration precheck")
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"blacklisted": false, "error": "precheck_unavailable"})
		return
	}
	if decision.Blocked {
		h.log.Warn().
			Str("email", strings.ToLower(strings.TrimSpace(req.Email))).
			Str("reason", decision.Reason).
			Msg("registro bloqueado: motor de baneo")
		writeJSON(w, http.StatusOK, map[string]any{"blacklisted": true, "reason": decision.Reason})
		return
	}

	resp := map[string]any{"blacklisted": false, "reason": ""}
	if code := strings.TrimSpace(req.ReferralCode); code != "" {
		sponsor, err := h.store.ResolveSponsorByCode(r.Context(), code)
		if err != nil {
			h.log.Error().Err(err).Str("email", strings.ToLower(strings.TrimSpace(req.Email))).Msg("registration referral")
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{
				"blacklisted": false,
				"error":       "referral_precheck_unavailable",
			})
			return
		}
		if sponsor == nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"blacklisted": false,
				"error":       "invalid_referral_code",
			})
			return
		}
		resp["referral_valid"] = true
		resp["referral_code"] = code
		resp["sponsor_affiliate_id"] = *sponsor
	}
	writeJSON(w, http.StatusOK, resp)
}

// handleRegistrationReferralAttribution persiste el referido capturado durante
// el registro una vez que el BFF ya creó el usuario Cognito. Esto evita depender
// exclusivamente de localStorage cuando el checkout ocurre en otra sesión.
func (h *Handler) handleRegistrationReferralAttribution(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	var req struct {
		Email        string `json:"email"`
		ReferralCode string `json:"referral_code"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request")
		return
	}
	if strings.TrimSpace(req.Email) == "" || strings.TrimSpace(req.ReferralCode) == "" {
		writeErr(w, http.StatusBadRequest, "email_and_referral_required")
		return
	}
	decision, err := h.store.BanDecisionFor(r.Context(), BanCandidate{Email: req.Email})
	if err != nil {
		h.log.Error().Err(err).Msg("registration referral ban decision")
		writeErr(w, http.StatusServiceUnavailable, "precheck_unavailable")
		return
	}
	if decision.Blocked {
		writeErr(w, http.StatusForbidden, "blacklisted")
		return
	}
	referral, err := h.store.RecordRegistrationReferral(r.Context(), req.Email, req.ReferralCode)
	if errors.Is(err, ErrInvalidReferralCode) {
		writeErr(w, http.StatusBadRequest, "invalid_referral_code")
		return
	}
	if err != nil {
		h.log.Error().Err(err).Str("email", strings.ToLower(strings.TrimSpace(req.Email))).Msg("record registration referral")
		writeErr(w, http.StatusServiceUnavailable, "referral_unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":               "ok",
		"referral_code":        referral.Code,
		"sponsor_affiliate_id": referral.SponsorAffiliateID,
	})
}
