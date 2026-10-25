package payments

import (
	"context"
	"crypto/subtle"
	"net/http"
	"strings"
)

// idTokenHeader es el header por el que el BFF reenvía el id token Cognito crudo
// para que el backend re-verifique la identidad (defensa en profundidad, H-2).
const idTokenHeader = "X-VP-Id-Token"

// actAsHeader: un super_admin autenticado solicita "ver como" otro usuario
// (impersonación de solo lectura desde el panel admin) enviando el email objetivo.
const actAsHeader = "X-VP-Act-As"

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

func (h *Handler) svcAuth(w http.ResponseWriter, r *http.Request) bool {
	// An unconfigured handler must never authenticate an absent credential.
	if strings.TrimSpace(h.serviceToken) == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-VP-Service-Token")), []byte(h.serviceToken)) != 1 {
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
	if identity, exists := r.Context().Value(budgetIdentityKey{}).(verifiedBudgetIdentity); exists && raw != "" && identity.token == raw && strings.TrimSpace(identity.email) != "" {
		return identity.email, true
	}
	if raw == "" || h.verifier == nil {
		return "", false
	}
	v, err := h.verifier.VerifyEmail(r.Context(), raw)
	if err != nil {
		h.log.Warn().Err(err).Msg("id token verification failed")
		return "", false
	}
	email = strings.ToLower(strings.TrimSpace(v))
	return email, email != ""
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

// effectiveIdentity resuelve la identidad REAL (token verificado) y, cuando un
// super_admin lo solicita vía X-VP-Act-As en una request de LECTURA (GET), la
// identidad EFECTIVA para los gates de datos del panel. Reglas:
//   - Sin act-as ⇒ efectiva = real.
//   - Con act-as pero el real NO es super_admin ⇒ se ignora (efectiva = real).
//   - Con act-as, real super_admin, método != GET ⇒ 403 impersonation_read_only.
//   - Con act-as, real super_admin, GET ⇒ efectiva = objetivo (auditoría).
//
// La AUTORIZACIÓN a impersonar se decide con la identidad REAL, nunca la efectiva.
func (h *Handler) effectiveIdentity(w http.ResponseWriter, r *http.Request, claimedEmail string) (real, effective string, ok bool) {
	real, ok = h.resolveIdentity(w, r, claimedEmail)
	if !ok {
		return "", "", false
	}
	actAs := strings.ToLower(strings.TrimSpace(r.Header.Get(actAsHeader)))
	if actAs == "" {
		return real, real, true
	}
	if !h.isSuperAdmin(real) {
		h.log.Warn().Str("real", real).Str("act_as", actAs).Str("path", r.URL.Path).Msg("act-as ignorado: el llamante no es super_admin")
		return real, real, true
	}
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusForbidden, "impersonation_read_only")
		return "", "", false
	}
	h.log.Info().Str("real", real).Str("act_as", actAs).Str("path", r.URL.Path).Msg("impersonación (ver como)")
	return real, actAs, true
}

// requireAdmin valida token de servicio + identidad verificada (o fallback) +
// que el email resultante sea admin.
func (h *Handler) requireAdmin(w http.ResponseWriter, r *http.Request) (string, bool) {
	return h.requireAdminIdentity(w, r, r.URL.Query().Get("email"))
}

// Body-only legacy callers use the same role, ban and impersonation checks.
func (h *Handler) requireAdminIdentity(w http.ResponseWriter, r *http.Request, claimedEmail string) (string, bool) {
	if !h.svcAuth(w, r) {
		return "", false
	}
	_, eff, ok := h.effectiveIdentity(w, r, claimedEmail)
	if !ok {
		return "", false
	}
	if h.rejectIfSuspended(r.Context(), w, eff) {
		return "", false
	}
	admin, err := h.isAdminEmail(r.Context(), eff)
	if err != nil {
		h.log.Error().Err(err).Msg("is_admin")
		writeErr(w, http.StatusInternalServerError, "internal")
		return "", false
	}
	if !admin {
		writeErr(w, http.StatusForbidden, "not_admin")
		return "", false
	}
	return eff, true
}
