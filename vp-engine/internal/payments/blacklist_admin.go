package payments

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// Gestión de la lista negra desde el panel admin. Banear = agregar a
// mlm.blacklist (bloquea futuros registros) + deshabilitar la cuenta viva si
// existe (mlm.person.status=suspended + Cognito AdminDisableUser). Desbanear =
// quitar de la lista + rehabilitar la cuenta.

// BlacklistRow es una fila de la lista negra para el panel.
type BlacklistRow struct {
	ID         int64  `json:"id"`
	Fullname   string `json:"fullname"`
	Email      string `json:"email"`
	Phone      string `json:"phone"`
	Birthdate  string `json:"birthdate"` // YYYY-MM-DD o ""
	Motive     string `json:"motive"`
	Source     string `json:"source"`
	CreatedAt  string `json:"created_at"`
	HasAccount bool   `json:"has_active_account"`
}

// ListBlacklist devuelve filas paginadas + total. q filtra por email/teléfono/
// nombre (ILIKE sobre las columnas crudas).
func (s *Store) ListBlacklist(ctx context.Context, q string, limit, offset int) ([]BlacklistRow, int64, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	if offset < 0 {
		offset = 0
	}
	q = strings.TrimSpace(q)

	var total int64
	if err := s.db.QueryRow(ctx, `
		SELECT count(*) FROM mlm.blacklist b
		 WHERE ($1='' OR b.email ILIKE '%'||$1||'%' OR b.phone ILIKE '%'||$1||'%' OR b.fullname ILIKE '%'||$1||'%')
	`, q).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count blacklist: %w", err)
	}

	rows, err := s.db.Query(ctx, `
		SELECT b.id,
		       COALESCE(b.fullname,''), COALESCE(b.email,''), COALESCE(b.phone,''),
		       COALESCE(to_char(b.birthdate,'YYYY-MM-DD'),''),
		       COALESCE(b.motive,''), COALESCE(b.source,''),
		       to_char(b.created_at,'YYYY-MM-DD HH24:MI'),
		       (b.email_norm IS NOT NULL
		         AND EXISTS (SELECT 1 FROM mlm.person p WHERE lower(p.email)=b.email_norm)) AS has_account
		  FROM mlm.blacklist b
		 WHERE ($1='' OR b.email ILIKE '%'||$1||'%' OR b.phone ILIKE '%'||$1||'%' OR b.fullname ILIKE '%'||$1||'%')
		 ORDER BY b.created_at DESC, b.id DESC
		 LIMIT $2 OFFSET $3
	`, q, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("list blacklist: %w", err)
	}
	defer rows.Close()

	out := []BlacklistRow{}
	for rows.Next() {
		var b BlacklistRow
		if err := rows.Scan(&b.ID, &b.Fullname, &b.Email, &b.Phone, &b.Birthdate,
			&b.Motive, &b.Source, &b.CreatedAt, &b.HasAccount); err != nil {
			return nil, 0, fmt.Errorf("scan blacklist: %w", err)
		}
		out = append(out, b)
	}
	return out, total, rows.Err()
}

// AddBlacklist inserta una entrada normalizando con las funciones SQL. Devuelve
// el id nuevo. birthdate vacío ⇒ NULL. source='admin_panel'.
func (s *Store) AddBlacklist(ctx context.Context, fullname, email, phone, birthdate, motive string) (int64, error) {
	var id int64
	err := s.db.QueryRow(ctx, `
		INSERT INTO mlm.blacklist
		    (fullname, birthdate, email, phone, email_norm, phone_last10, name_norm, motive, source)
		VALUES
		    (NULLIF($1,''), NULLIF($4,'')::date, NULLIF($2,''), NULLIF($3,''),
		     mlm.norm_email($2), mlm.norm_phone10($3), mlm.norm_name($1), NULLIF($5,''), 'admin_panel')
		RETURNING id
	`, fullname, email, phone, birthdate, motive).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("add blacklist: %w", err)
	}
	return id, nil
}

// RemoveBlacklistByID borra una fila por id y devuelve (email_norm de la fila
// borrada, filas borradas). email vacío si no había fila.
func (s *Store) RemoveBlacklistByID(ctx context.Context, id int64) (string, int64, error) {
	var email string
	err := s.db.QueryRow(ctx,
		`DELETE FROM mlm.blacklist WHERE id=$1 RETURNING COALESCE(email_norm,'')`, id).Scan(&email)
	if err != nil {
		if strings.Contains(err.Error(), "no rows") {
			return "", 0, nil
		}
		return "", 0, fmt.Errorf("remove blacklist by id: %w", err)
	}
	return email, 1, nil
}

// RemoveBlacklistByEmail borra TODAS las filas que casen por email_norm.
func (s *Store) RemoveBlacklistByEmail(ctx context.Context, email string) (int64, error) {
	tag, err := s.db.Exec(ctx,
		`DELETE FROM mlm.blacklist WHERE email_norm IS NOT NULL AND email_norm = mlm.norm_email($1)`, email)
	if err != nil {
		return 0, fmt.Errorf("remove blacklist by email: %w", err)
	}
	return tag.RowsAffected(), nil
}

// PersonIDByEmail devuelve el id de mlm.person por email (exists=false si no hay).
func (s *Store) PersonIDByEmail(ctx context.Context, email string) (int64, bool, error) {
	var id int64
	err := s.db.QueryRow(ctx,
		`SELECT id FROM mlm.person WHERE lower(email)=lower($1) LIMIT 1`, email).Scan(&id)
	if err != nil {
		if strings.Contains(err.Error(), "no rows") {
			return 0, false, nil
		}
		return 0, false, fmt.Errorf("person by email: %w", err)
	}
	return id, true, nil
}

// PersonSuspendedByEmail: ¿la persona está baneada/suspendida? false si no existe.
func (s *Store) PersonSuspendedByEmail(ctx context.Context, email string) (bool, error) {
	var suspended bool
	err := s.db.QueryRow(ctx,
		`SELECT COALESCE(blacklisted,false) OR status='suspended'
		   FROM mlm.person WHERE lower(email)=lower($1) LIMIT 1`, email).Scan(&suspended)
	if err != nil {
		if strings.Contains(err.Error(), "no rows") {
			return false, nil
		}
		return false, fmt.Errorf("person suspended: %w", err)
	}
	return suspended, nil
}

// applyAccountBan aplica el efecto "cuenta activa" al banear/desbanear por email:
// mlm.person.status (SetBlocked) + Cognito enable/disable. Devuelve si había una
// persona en la DB que se tocó. El efecto Cognito es best-effort (se loguea).
func (h *Handler) applyAccountBan(ctx context.Context, email string, banned bool) bool {
	email = strings.TrimSpace(email)
	if email == "" {
		return false
	}
	affected := false
	if pid, exists, err := h.store.PersonIDByEmail(ctx, email); err != nil {
		h.log.Error().Err(err).Str("email", email).Msg("blacklist: person lookup")
	} else if exists {
		if err := h.store.SetBlocked(ctx, pid, banned); err != nil {
			h.log.Error().Err(err).Int64("person_id", pid).Msg("blacklist: set blocked")
		} else {
			affected = true
		}
	}
	if h.cognitoAdmin != nil {
		if _, err := h.cognitoAdmin.SetEnabled(ctx, email, !banned); err != nil {
			h.log.Error().Err(err).Str("email", email).Msg("blacklist: cognito set enabled")
		}
	}
	return affected
}

// rejectIfSuspended escribe 403 account_suspended y devuelve true si la persona
// (por email) está baneada/suspendida — no puede comprar ni retirar ("congelar
// wallet"). Ante error de infra: fail-open (loguea y deja continuar).
func (h *Handler) rejectIfSuspended(ctx context.Context, w http.ResponseWriter, email string) bool {
	susp, err := h.store.PersonSuspendedByEmail(ctx, email)
	if err != nil {
		h.log.Error().Err(err).Str("email", email).Msg("suspended check (fail-open)")
		return false
	}
	if susp {
		writeErr(w, http.StatusForbidden, "account_suspended")
		return true
	}
	return false
}

// handleAdminBlacklist: GET lista paginada / POST agrega (banear).
func (h *Handler) handleAdminBlacklist(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		q := r.URL.Query().Get("q")
		limit := atoiDefault(r.URL.Query().Get("limit"), 25)
		offset := atoiDefault(r.URL.Query().Get("offset"), 0)
		rows, total, err := h.store.ListBlacklist(r.Context(), q, limit, offset)
		if err != nil {
			h.log.Error().Err(err).Msg("list blacklist")
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"rows": rows, "total": total, "limit": limit, "offset": offset})
	case http.MethodPost:
		var req struct {
			Fullname  string `json:"fullname"`
			Email     string `json:"email"`
			Phone     string `json:"phone"`
			Birthdate string `json:"birthdate"`
			Motive    string `json:"motive"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid_json")
			return
		}
		req.Email = strings.ToLower(strings.TrimSpace(req.Email))
		req.Phone = strings.TrimSpace(req.Phone)
		req.Fullname = strings.TrimSpace(req.Fullname)
		req.Birthdate = strings.TrimSpace(req.Birthdate)
		// Requiere un identificador fuerte: email o teléfono (o nombre+fecha).
		if req.Email == "" && req.Phone == "" && !(req.Fullname != "" && req.Birthdate != "") {
			writeErr(w, http.StatusBadRequest, "need_email_phone_or_name_birth")
			return
		}
		id, err := h.store.AddBlacklist(r.Context(), req.Fullname, req.Email, req.Phone, req.Birthdate, req.Motive)
		if err != nil {
			h.log.Error().Err(err).Msg("add blacklist")
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
		accountDisabled := false
		if req.Email != "" {
			accountDisabled = h.applyAccountBan(r.Context(), req.Email, true)
		}
		h.log.Info().Int64("id", id).Str("email", req.Email).Msg("blacklist: added")
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": id, "account_disabled": accountDisabled})
	default:
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
	}
}

// handleAdminBlacklistRemove: POST {id} (una fila) o {email} (todas las
// coincidencias) — desbanear. Rehabilita la cuenta viva si existe.
func (h *Handler) handleAdminBlacklistRemove(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	var req struct {
		ID    int64  `json:"id"`
		Email string `json:"email"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	if req.ID <= 0 && req.Email == "" {
		writeErr(w, http.StatusBadRequest, "need_id_or_email")
		return
	}

	var removed int64
	email := req.Email
	if req.ID > 0 {
		delEmail, n, err := h.store.RemoveBlacklistByID(r.Context(), req.ID)
		if err != nil {
			h.log.Error().Err(err).Msg("remove blacklist by id")
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
		removed = n
		if email == "" {
			email = delEmail
		}
	} else {
		n, err := h.store.RemoveBlacklistByEmail(r.Context(), req.Email)
		if err != nil {
			h.log.Error().Err(err).Msg("remove blacklist by email")
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
		removed = n
	}

	accountEnabled := false
	if email != "" {
		accountEnabled = h.applyAccountBan(r.Context(), email, false)
	}
	h.log.Info().Int64("removed", removed).Str("email", email).Msg("blacklist: removed")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "removed": removed, "account_enabled": accountEnabled})
}
