package payments

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// The blacklist is an email-only dynamic veto. Adding/removing an entry never
// changes independent person flags, account/affiliate statuses or Cognito.
var errInvalidBlacklistEmail = errors.New("invalid blacklist email")

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

// AddBlacklist keeps its legacy signature, but name/phone/birthdate no longer
// create blocking identifiers. Only a valid normalized email is persisted.
func (s *Store) AddBlacklist(ctx context.Context, fullname, email, phone, birthdate, motive string) (int64, error) {
	id, err := insertBlacklistEmail(ctx, s.db, email, motive)
	if err != nil {
		return 0, err
	}
	s.treeReads.invalidate()
	return id, nil
}

func insertBlacklistEmail(ctx context.Context, q banQuerier, email, motive string) (int64, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if !validVerifiedReferralEmail(email) {
		return 0, errInvalidBlacklistEmail
	}
	var id int64
	err := q.QueryRow(ctx, `
		INSERT INTO mlm.blacklist
		    (email, email_norm, motive, source)
		VALUES
		    ($1, mlm.norm_email($1), NULLIF($2,''), 'admin_panel')
		RETURNING id
	`, email, motive).Scan(&id)
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
	s.treeReads.invalidate()
	return email, 1, nil
}

// RemoveBlacklistByEmail borra TODAS las filas que casen por email_norm.
func (s *Store) RemoveBlacklistByEmail(ctx context.Context, email string) (int64, error) {
	tag, err := s.db.Exec(ctx,
		`DELETE FROM mlm.blacklist WHERE email_norm IS NOT NULL AND email_norm = mlm.norm_email($1)`, email)
	if err != nil {
		return 0, fmt.Errorf("remove blacklist by email: %w", err)
	}
	s.treeReads.invalidate()
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

// PersonSuspendedByEmail: ¿la cuenta está baneada/suspendida? Usa el motor
// unificado: email directo, señales guardadas en mlm.person y blacklist por
// nombre exacto si aplica.
func (s *Store) PersonSuspendedByEmail(ctx context.Context, email string) (bool, error) {
	decision, err := s.BanDecisionFor(ctx, BanCandidate{Email: email})
	if err != nil {
		return false, fmt.Errorf("person suspended: %w", err)
	}
	return decision.Blocked, nil
}

// rejectIfSuspended escribe 403 account_suspended y devuelve true si la cuenta
// está baneada/suspendida. Ante error de infra falla cerrado: no se permite
// operar sin validar el estado de acceso.
func (h *Handler) rejectIfSuspended(ctx context.Context, w http.ResponseWriter, email string) bool {
	return h.rejectIfBanned(ctx, w, BanCandidate{Email: email})
}

func (h *Handler) rejectIfBanned(ctx context.Context, w http.ResponseWriter, c BanCandidate) bool {
	if h.store == nil || h.store.db == nil {
		return false
	}
	decision, err := h.store.BanDecisionFor(ctx, c)
	if err != nil {
		h.log.Error().Err(err).Str("email", c.Email).Msg("ban engine check")
		writeErr(w, http.StatusServiceUnavailable, "account_status_unavailable")
		return true
	}
	if decision.Blocked {
		h.log.Warn().Str("email", strings.ToLower(strings.TrimSpace(c.Email))).Str("reason", decision.Reason).Msg("request blocked by ban engine")
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
			Email  string `json:"email"`
			Motive string `json:"motive"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid_json")
			return
		}
		req.Email = strings.ToLower(strings.TrimSpace(req.Email))
		if !validVerifiedReferralEmail(req.Email) {
			writeErr(w, http.StatusBadRequest, "invalid_blacklist_email")
			return
		}
		id, err := h.store.AddBlacklist(r.Context(), "", req.Email, "", "", req.Motive)
		if err != nil {
			h.log.Error().Err(err).Msg("add blacklist")
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
		h.log.Info().Int64("id", id).Str("email", req.Email).Msg("blacklist: added")
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": id, "account_disabled": false})
	default:
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
	}
}

// handleAdminBlacklistRemove: POST {id} (una fila) o {email} (todas las
// coincidencias). Independent account/affiliate restrictions remain untouched.
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

	h.log.Info().Int64("removed", removed).Str("email", email).Msg("blacklist: removed")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "removed": removed, "account_enabled": false})
}
