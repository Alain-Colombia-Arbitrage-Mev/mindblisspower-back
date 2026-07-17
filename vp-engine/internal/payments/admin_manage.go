package payments

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// Gestión de administradores (solo super_admin). El super_admin (allowlist por
// env, p. ej. devfidubit) puede conceder o revocar el rol admin a otras personas
// (mlm.person.is_admin). Guards: no puede auto-revocarse ni revocar a un
// super_admin del env (esos son el candado raíz).

// AdminEntry es un administrador para el panel de gestión.
type AdminEntry struct {
	Email     string `json:"email"`
	Name      string `json:"name"`
	Role      string `json:"role"`      // "super_admin" | "admin"
	Source    string `json:"source"`    // "db" (mlm.person.is_admin) | "env" (allowlist)
	Protected bool   `json:"protected"` // no se puede revocar desde el panel
}

// ListDBAdmins devuelve las personas con is_admin=true.
func (s *Store) ListDBAdmins(ctx context.Context) ([]AdminEntry, error) {
	rows, err := s.reader().Query(ctx, `
		SELECT email, trim(coalesce(first_name,'')||' '||coalesce(last_name,''))
		  FROM mlm.person
		 WHERE is_admin IS TRUE
		 ORDER BY email`)
	if err != nil {
		return nil, fmt.Errorf("list db admins: %w", err)
	}
	defer rows.Close()
	out := []AdminEntry{}
	for rows.Next() {
		var e AdminEntry
		if err := rows.Scan(&e.Email, &e.Name); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// SetAdminFlag concede (grant=true) o revoca el rol admin en mlm.person.
// Devuelve filas afectadas (0 ⇒ la persona no existe).
func (s *Store) SetAdminFlag(ctx context.Context, email string, grant bool) (int64, error) {
	tag, err := s.db.Exec(ctx,
		`UPDATE mlm.person SET is_admin = $2, updated_at = now() WHERE lower(email) = lower($1)`,
		strings.TrimSpace(email), grant)
	if err != nil {
		return 0, fmt.Errorf("set admin flag: %w", err)
	}
	return tag.RowsAffected(), nil
}

// requireSuperAdmin exige token de servicio + identidad + rol super_admin.
func (h *Handler) requireSuperAdmin(w http.ResponseWriter, r *http.Request) (string, bool) {
	if !h.svcAuth(w, r) {
		return "", false
	}
	email, ok := h.resolveIdentity(w, r, r.URL.Query().Get("email"))
	if !ok {
		return "", false
	}
	if !h.isSuperAdmin(email) {
		writeErr(w, http.StatusForbidden, "not_super_admin")
		return "", false
	}
	return email, true
}

// handleAdminAdmins: GET /api/admin/admins — lista de administradores (super_admin).
// Une los admins de DB (is_admin) con los del allowlist por env.
func (h *Handler) handleAdminAdmins(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	caller, ok := h.requireSuperAdmin(w, r)
	if !ok {
		return
	}
	dbAdmins, err := h.store.ListDBAdmins(r.Context())
	if err != nil {
		h.log.Error().Err(err).Msg("list admins")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	out := []AdminEntry{}
	seen := map[string]bool{}
	add := func(e AdminEntry) {
		key := strings.ToLower(e.Email)
		if seen[key] {
			return
		}
		seen[key] = true
		if h.isSuperAdmin(e.Email) {
			e.Role = "super_admin"
		} else if e.Role == "" {
			e.Role = "admin"
		}
		// Protegidos: super-admins del env y el propio solicitante.
		e.Protected = h.isSuperAdmin(e.Email) || e.Source == "env" || strings.EqualFold(e.Email, caller)
		out = append(out, e)
	}
	for _, a := range dbAdmins {
		a.Source = "db"
		add(a)
	}
	for _, e := range h.superAdminEmails {
		add(AdminEntry{Email: e, Name: "", Role: "super_admin", Source: "env"})
	}
	for _, e := range h.adminEmails {
		add(AdminEntry{Email: e, Name: "", Role: "admin", Source: "env"})
	}
	writeJSON(w, http.StatusOK, map[string]any{"admins": out})
}

type adminRoleReq struct {
	Email  string `json:"email"`  // solicitante (super_admin)
	Target string `json:"target"` // email a conceder/revocar
	Grant  bool   `json:"grant"`  // true=conceder admin, false=banear/revocar
}

// handleAdminAdminRole: POST /api/admin/admins/role — concede/revoca admin.
func (h *Handler) handleAdminAdminRole(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	var req adminRoleReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}
	caller, ok := h.resolveIdentity(w, r, req.Email)
	if !ok {
		return
	}
	if !h.isSuperAdmin(caller) {
		writeErr(w, http.StatusForbidden, "not_super_admin")
		return
	}
	target := strings.ToLower(strings.TrimSpace(req.Target))
	if target == "" || !strings.Contains(target, "@") {
		writeErr(w, http.StatusBadRequest, "invalid_target")
		return
	}
	// Guards: no auto-modificarse ni tocar a un super_admin del env.
	if strings.EqualFold(target, caller) {
		writeErr(w, http.StatusForbidden, "cannot_modify_self")
		return
	}
	if h.isSuperAdmin(target) {
		writeErr(w, http.StatusForbidden, "cannot_modify_super_admin")
		return
	}
	n, err := h.store.SetAdminFlag(r.Context(), target, req.Grant)
	if err != nil {
		h.log.Error().Err(err).Msg("set admin flag")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	if n == 0 {
		writeErr(w, http.StatusNotFound, "person_not_found")
		return
	}
	h.log.Info().Str("by", caller).Str("target", target).Bool("grant", req.Grant).Msg("admin role changed")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "target": target, "is_admin": req.Grant})
}
