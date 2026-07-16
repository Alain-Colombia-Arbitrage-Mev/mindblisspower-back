package payments

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// NOTA de dominio: los tickets viven aquí (vp-payments) porque este servicio ya
// concentra el panel admin (users/withdrawals/finance) y su auth. Cuando el bot
// de soporte (vp-support) gane el handoff a Chatwoot, evaluar moverlos allá.

// Ticket es una solicitud de soporte de un miembro.
type Ticket struct {
	ID         int64  `json:"id"`
	Email      string `json:"email"`
	Subject    string `json:"subject"`
	Body       string `json:"body"`
	Status     string `json:"status"` // open | answered | closed
	Answer     string `json:"answer,omitempty"`
	AnsweredBy string `json:"answered_by,omitempty"`
	AnsweredAt string `json:"answered_at,omitempty"`
	CreatedAt  string `json:"created_at"`
}

// CreateTicket abre un ticket a nombre del miembro (lo invoca el BFF del
// growth-hub con la identidad del miembro autenticado).
func (s *Store) CreateTicket(ctx context.Context, email, subject, body string) (int64, error) {
	var id int64
	err := s.db.QueryRow(ctx, `
		INSERT INTO support.ticket (email, subject, body)
		VALUES (lower($1), $2, $3) RETURNING id`,
		strings.TrimSpace(email), strings.TrimSpace(subject), strings.TrimSpace(body)).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("create ticket: %w", err)
	}
	s.cache.PublishEvent(ctx, "ticket.opened", map[string]any{"id": id, "email": email, "subject": subject})
	return id, nil
}

// ListTickets pagina tickets (filtro por status; "" = todos).
func (s *Store) ListTickets(ctx context.Context, status string, limit, offset int) ([]Ticket, int64, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	var total int64
	if err := s.reader().QueryRow(ctx, `
		SELECT count(*) FROM support.ticket WHERE ($1 = '' OR status = $1)`, status).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count tickets: %w", err)
	}
	rows, err := s.reader().Query(ctx, `
		SELECT id, email, subject, body, status,
		       COALESCE(answer,''), COALESCE(answered_by,''),
		       COALESCE(to_char(answered_at,'YYYY-MM-DD"T"HH24:MI:SSZ'),''),
		       to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SSZ')
		  FROM support.ticket
		 WHERE ($1 = '' OR status = $1)
		 ORDER BY created_at DESC
		 LIMIT $2 OFFSET $3`, status, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("list tickets: %w", err)
	}
	defer rows.Close()
	out := []Ticket{}
	for rows.Next() {
		var t Ticket
		if err := rows.Scan(&t.ID, &t.Email, &t.Subject, &t.Body, &t.Status,
			&t.Answer, &t.AnsweredBy, &t.AnsweredAt, &t.CreatedAt); err != nil {
			return nil, 0, fmt.Errorf("scan ticket: %w", err)
		}
		out = append(out, t)
	}
	return out, total, rows.Err()
}

// ReplyTicket registra la respuesta del admin y marca answered.
func (s *Store) ReplyTicket(ctx context.Context, id int64, answer, adminEmail string) (Ticket, error) {
	var t Ticket
	err := s.db.QueryRow(ctx, `
		UPDATE support.ticket
		   SET answer = $2, answered_by = lower($3), answered_at = now(), status = 'answered'
		 WHERE id = $1
		 RETURNING id, email, subject, body, status, COALESCE(answer,''),
		           COALESCE(answered_by,''),
		           COALESCE(to_char(answered_at,'YYYY-MM-DD"T"HH24:MI:SSZ'),''),
		           to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SSZ')`,
		id, strings.TrimSpace(answer), adminEmail).
		Scan(&t.ID, &t.Email, &t.Subject, &t.Body, &t.Status, &t.Answer, &t.AnsweredBy, &t.AnsweredAt, &t.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Ticket{}, fmt.Errorf("ticket %d no existe", id)
	}
	if err != nil {
		return Ticket{}, fmt.Errorf("reply ticket: %w", err)
	}
	return t, nil
}

// SetTicketStatus cierra o reabre un ticket.
func (s *Store) SetTicketStatus(ctx context.Context, id int64, status string) error {
	ct, err := s.db.Exec(ctx, `UPDATE support.ticket SET status = $2 WHERE id = $1`, id, status)
	if err != nil {
		return fmt.Errorf("set ticket status: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return fmt.Errorf("ticket %d no existe", id)
	}
	return nil
}

// --- Handlers ----------------------------------------------------------------

// handleAdminTickets: GET /api/admin/tickets?status=&limit=&offset=
func (h *Handler) handleAdminTickets(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	status := r.URL.Query().Get("status")
	if status != "" && status != "open" && status != "answered" && status != "closed" {
		writeErr(w, http.StatusBadRequest, "invalid_status")
		return
	}
	tickets, total, err := h.store.ListTickets(r.Context(),
		status, atoiDefault(r.URL.Query().Get("limit"), 25), atoiDefault(r.URL.Query().Get("offset"), 0))
	if err != nil {
		h.log.Error().Err(err).Msg("list tickets")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tickets": tickets, "total": total})
}

// handleAdminTicketAction: POST /api/admin/tickets/action
// {id, action: reply|close|reopen, answer?, notify?}
func (h *Handler) handleAdminTicketAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	adminEmail, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	var req struct {
		ID     int64  `json:"id"`
		Action string `json:"action"`
		Answer string `json:"answer"`
		Notify bool   `json:"notify"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid_request")
		return
	}
	switch req.Action {
	case "reply":
		if strings.TrimSpace(req.Answer) == "" {
			writeErr(w, http.StatusBadRequest, "answer_required")
			return
		}
		t, err := h.store.ReplyTicket(r.Context(), req.ID, req.Answer, adminEmail)
		if err != nil {
			h.log.Error().Err(err).Msg("reply ticket")
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
		// Notificación por correo al miembro (best-effort, nunca bloquea).
		if req.Notify {
			go func(t Ticket) {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				if err := h.store.SendEmail(ctx, []string{t.Email},
					"Re: "+t.Subject,
					"Hola,\n\nTu ticket #"+fmt.Sprint(t.ID)+" fue respondido:\n\n"+t.Answer+"\n\n— Equipo Mindbliss Power"); err != nil {
					h.log.Warn().Err(err).Int64("ticket", t.ID).Msg("ticket reply email failed (non-fatal)")
				}
			}(t)
		}
		writeJSON(w, http.StatusOK, t)
	case "close", "reopen":
		status := map[string]string{"close": "closed", "reopen": "open"}[req.Action]
		if err := h.store.SetTicketStatus(r.Context(), req.ID, status); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": status})
	default:
		writeErr(w, http.StatusBadRequest, "invalid_action")
	}
}

// handleMemberTicket: POST /api/support/ticket — el BFF del growth-hub abre un
// ticket a nombre del miembro autenticado.
func (h *Handler) handleMemberTicket(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	var req struct {
		Email   string `json:"email"`
		Subject string `json:"subject"`
		Body    string `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_request")
		return
	}
	email, ok := h.resolveIdentity(w, r, req.Email)
	if !ok {
		return
	}
	if strings.TrimSpace(req.Subject) == "" || strings.TrimSpace(req.Body) == "" {
		writeErr(w, http.StatusBadRequest, "subject_and_body_required")
		return
	}
	id, err := h.store.CreateTicket(r.Context(), email, req.Subject, req.Body)
	if err != nil {
		h.log.Error().Err(err).Msg("create ticket")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "status": "open"})
}
