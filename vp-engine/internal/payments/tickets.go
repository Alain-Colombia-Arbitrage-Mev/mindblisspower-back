package payments

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// NOTA de dominio: los tickets viven aquí (vp-payments) porque este servicio ya
// concentra el panel admin (users/withdrawals/finance) y su auth. Cuando el bot
// de soporte (vp-support) gane el handoff a Chatwoot, evaluar moverlos allá.

var (
	ErrNoSupportAgent        = errors.New("no active support agent available")
	ErrNotSupportRequest     = errors.New("not a support request")
	ErrSupportAIUnconfigured = errors.New("support ai unconfigured")
	ErrAIDraftNotReady       = errors.New("ai draft not ready")
)

// Ticket es una solicitud de soporte de un miembro.
type Ticket struct {
	ID               int64           `json:"id"`
	Email            string          `json:"email"`
	Subject          string          `json:"subject"`
	Body             string          `json:"body"`
	Status           string          `json:"status"` // open | answered | closed
	Priority         string          `json:"priority"`
	Category         string          `json:"category"`
	Source           string          `json:"source"`
	AssignedTo       string          `json:"assigned_to,omitempty"`
	AssignedAt       string          `json:"assigned_at,omitempty"`
	ProblemSummary   string          `json:"problem_summary,omitempty"`
	AISupportRequest bool            `json:"ai_support_request"`
	AIFilterReason   string          `json:"ai_filter_reason,omitempty"`
	AIDraftAnswer    string          `json:"ai_draft_answer,omitempty"`
	AIDraftStatus    string          `json:"ai_draft_status,omitempty"`
	AIDraftedAt      string          `json:"ai_drafted_at,omitempty"`
	AISources        json.RawMessage `json:"ai_sources,omitempty"`
	LastAIError      string          `json:"last_ai_error,omitempty"`
	InboundMessageID string          `json:"inbound_message_id,omitempty"`
	Answer           string          `json:"answer,omitempty"`
	AnsweredBy       string          `json:"answered_by,omitempty"`
	AnsweredAt       string          `json:"answered_at,omitempty"`
	CreatedAt        string          `json:"created_at"`
}

type TicketTriage struct {
	SupportRequest bool   `json:"support_request"`
	Category       string `json:"category"`
	Priority       string `json:"priority"`
	ProblemSummary string `json:"problem_summary"`
	Reason         string `json:"reason"`
}

type SupportAgent struct {
	Email          string   `json:"email"`
	Name           string   `json:"name"`
	Active         bool     `json:"active"`
	Specialties    []string `json:"specialties"`
	MaxOpenTickets int      `json:"max_open_tickets"`
	OpenTickets    int      `json:"open_tickets"`
	SortOrder      int      `json:"sort_order"`
	CreatedAt      string   `json:"created_at,omitempty"`
	UpdatedAt      string   `json:"updated_at,omitempty"`
}

const ticketSelectColumns = `
	id, email, subject, body, status,
	COALESCE(priority,'normal'), COALESCE(category,'general'), COALESCE(source,'member'),
	COALESCE(assigned_to,''),
	COALESCE(to_char(assigned_at,'YYYY-MM-DD"T"HH24:MI:SSZ'),''),
	COALESCE(problem_summary,''),
	COALESCE(ai_support_request,false), COALESCE(ai_filter_reason,''), COALESCE(ai_draft_answer,''),
	COALESCE(ai_draft_status,'none'),
	COALESCE(to_char(ai_drafted_at,'YYYY-MM-DD"T"HH24:MI:SSZ'),''),
	COALESCE(ai_sources,'[]'::jsonb), COALESCE(last_ai_error,''), COALESCE(inbound_message_id,''),
	COALESCE(answer,''), COALESCE(answered_by,''),
	COALESCE(to_char(answered_at,'YYYY-MM-DD"T"HH24:MI:SSZ'),''),
	to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SSZ')`

type ticketScanner interface {
	Scan(dest ...any) error
}

func scanTicket(row ticketScanner) (Ticket, error) {
	var t Ticket
	var sources []byte
	if err := row.Scan(&t.ID, &t.Email, &t.Subject, &t.Body, &t.Status,
		&t.Priority, &t.Category, &t.Source, &t.AssignedTo, &t.AssignedAt,
		&t.ProblemSummary, &t.AISupportRequest, &t.AIFilterReason, &t.AIDraftAnswer,
		&t.AIDraftStatus, &t.AIDraftedAt, &sources, &t.LastAIError, &t.InboundMessageID,
		&t.Answer, &t.AnsweredBy, &t.AnsweredAt, &t.CreatedAt); err != nil {
		return Ticket{}, err
	}
	if len(sources) == 0 || !json.Valid(sources) {
		sources = []byte("[]")
	}
	t.AISources = append(json.RawMessage(nil), sources...)
	return t, nil
}

// CreateTicket abre un ticket a nombre del miembro (lo invoca el BFF del
// growth-hub con la identidad del miembro autenticado).
func (s *Store) CreateTicket(ctx context.Context, email, subject, body string) (int64, error) {
	t, err := s.CreateTicketWithSource(ctx, email, subject, body, "member", "")
	if err != nil {
		return 0, err
	}
	return t.ID, nil
}

func (s *Store) CreateTicketWithSource(ctx context.Context, email, subject, body, source, inboundMessageID string) (Ticket, error) {
	email = normalizeTicketEmail(email)
	subject = cleanTicketField(subject, 160)
	body = cleanTicketText(body, 5000)
	source = normalizeTicketSource(source)
	inboundMessageID = cleanTicketField(inboundMessageID, 220)
	if email == "" || !strings.Contains(email, "@") {
		return Ticket{}, fmt.Errorf("email inválido")
	}
	if subject == "" || body == "" {
		return Ticket{}, fmt.Errorf("subject/body requeridos")
	}

	triage := classifySupportTicket(subject, body)
	if source == "access_help" {
		triage.SupportRequest = true
		triage.Category = "access"
		triage.Priority = "high"
		triage.Reason = "support:access_help"
		if triage.ProblemSummary == "" {
			triage.ProblemSummary = "Usuario no recibe codigo de acceso por email o SMS."
		}
	}

	row := s.db.QueryRow(ctx, `
		INSERT INTO support.ticket (
			email, subject, body, source, inbound_message_id,
			priority, category, problem_summary,
			ai_support_request, ai_filter_reason, ai_draft_status
		)
		VALUES (lower($1), $2, $3, $4, NULLIF($5,''),
			$6, $7, $8, $9, $10, 'none')
		ON CONFLICT DO NOTHING
		RETURNING `+ticketSelectColumns,
		email, subject, body, source, inboundMessageID,
		triage.Priority, triage.Category, triage.ProblemSummary,
		triage.SupportRequest, triage.Reason)
	t, err := scanTicket(row)
	if errors.Is(err, pgx.ErrNoRows) && inboundMessageID != "" {
		t, err = s.GetTicketByInboundMessageID(ctx, inboundMessageID)
	}
	if err != nil {
		return Ticket{}, fmt.Errorf("create ticket: %w", err)
	}
	s.cache.PublishEvent(ctx, "ticket.opened", map[string]any{
		"id": t.ID, "email": t.Email, "subject": t.Subject,
		"priority": t.Priority, "category": t.Category, "source": t.Source,
	})
	return t, nil
}

func (s *Store) GetTicket(ctx context.Context, id int64) (Ticket, error) {
	t, err := scanTicket(s.reader().QueryRow(ctx, `SELECT `+ticketSelectColumns+` FROM support.ticket WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Ticket{}, fmt.Errorf("ticket %d no existe", id)
	}
	if err != nil {
		return Ticket{}, fmt.Errorf("get ticket: %w", err)
	}
	return t, nil
}

func (s *Store) GetTicketByInboundMessageID(ctx context.Context, inboundMessageID string) (Ticket, error) {
	inboundMessageID = cleanTicketField(inboundMessageID, 220)
	t, err := scanTicket(s.reader().QueryRow(ctx, `
		SELECT `+ticketSelectColumns+`
		  FROM support.ticket
		 WHERE lower(inbound_message_id) = lower($1)
		 LIMIT 1`, inboundMessageID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Ticket{}, fmt.Errorf("ticket inbound_message_id no existe")
	}
	if err != nil {
		return Ticket{}, fmt.Errorf("get ticket by inbound message: %w", err)
	}
	return t, nil
}

// handleAccessHelp abre un ticket de "ayuda de acceso" SIN requerir identidad de
// miembro: lo llama el BFF del login cuando el usuario no recibe el código por
// ningún canal (email/SMS). Gated sólo por service token (el BFF lo rate-limita);
// el email es el que tecleó en el login. El asesor valida identidad y habilita el
// acceso manualmente. Así el código nunca es un dead-end para el usuario.
func (h *Handler) handleAccessHelp(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	var req struct {
		Email  string `json:"email"`
		Phone  string `json:"phone"`
		Note   string `json:"note"`
		Reason string `json:"reason"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_request")
		return
	}
	email := normalizeTicketEmail(req.Email)
	if email == "" || !strings.Contains(email, "@") {
		writeErr(w, http.StatusBadRequest, "invalid_email")
		return
	}
	body := fmt.Sprintf("El usuario no recibe el codigo de acceso por ningun canal (email/SMS).\n"+
		"Email: %s\nTelefono reportado: %s\nMotivo tecnico: %s\nNota: %s\n\n"+
		"Accion sugerida: validar identidad y habilitar el acceso manualmente.",
		email, cleanTicketField(req.Phone, 40), cleanTicketField(req.Reason, 80), cleanTicketField(req.Note, 500))
	t, err := h.store.CreateTicketWithSource(r.Context(), email, "Ayuda de acceso - no recibe codigo", body, "access_help", "")
	if err != nil {
		h.log.Error().Err(err).Msg("access help ticket")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	h.maybeDraftTicketAsync(t.ID)
	writeJSON(w, http.StatusOK, map[string]any{"id": t.ID, "status": "open", "priority": t.Priority, "category": t.Category})
}

func cleanTicketField(value string, max int) string {
	out := cleanTicketText(value, max)
	return strings.Join(strings.Fields(out), " ")
}

func cleanTicketText(value string, max int) string {
	out := strings.TrimSpace(strings.ReplaceAll(value, "\x00", ""))
	out = strings.Map(func(r rune) rune {
		switch r {
		case '\n', '\r', '\t':
			return r
		default:
			if r < 32 {
				return -1
			}
			return r
		}
	}, out)
	runes := []rune(out)
	if max > 0 && len(runes) > max {
		return string(runes[:max])
	}
	return out
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
		SELECT `+ticketSelectColumns+`
		  FROM support.ticket
		 WHERE ($1 = '' OR status = $1)
		 ORDER BY CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
		          created_at DESC
		 LIMIT $2 OFFSET $3`, status, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("list tickets: %w", err)
	}
	defer rows.Close()
	out := []Ticket{}
	for rows.Next() {
		t, err := scanTicket(rows)
		if err != nil {
			return nil, 0, fmt.Errorf("scan ticket: %w", err)
		}
		out = append(out, t)
	}
	return out, total, rows.Err()
}

// ListMemberTickets pagina los tickets de UN miembro (scoped por email). Mismo
// shape/orden que ListTickets pero WHERE lower(email)=lower($1): el miembro sólo
// ve SUS tickets (el email lo aporta el caller ya verificado, nunca del query).
func (s *Store) ListMemberTickets(ctx context.Context, email string, limit, offset int) ([]Ticket, int64, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	email = normalizeTicketEmail(email)
	var total int64
	if err := s.reader().QueryRow(ctx, `
		SELECT count(*) FROM support.ticket WHERE lower(email) = lower($1)`, email).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count member tickets: %w", err)
	}
	rows, err := s.reader().Query(ctx, `
		SELECT `+ticketSelectColumns+`
		  FROM support.ticket
		 WHERE lower(email) = lower($1)
		 ORDER BY created_at DESC
		 LIMIT $2 OFFSET $3`, email, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("list member tickets: %w", err)
	}
	defer rows.Close()
	out := []Ticket{}
	for rows.Next() {
		t, err := scanTicket(rows)
		if err != nil {
			return nil, 0, fmt.Errorf("scan member ticket: %w", err)
		}
		out = append(out, t)
	}
	return out, total, rows.Err()
}

// ReplyTicket registra la respuesta del admin y marca answered.
func (s *Store) ReplyTicket(ctx context.Context, id int64, answer, adminEmail string) (Ticket, error) {
	t, err := scanTicket(s.db.QueryRow(ctx, `
		UPDATE support.ticket
		   SET answer = $2, answered_by = lower($3), answered_at = now(), status = 'answered'
		 WHERE id = $1
		 RETURNING `+ticketSelectColumns,
		id, cleanTicketText(answer, 5000), normalizeTicketEmail(adminEmail)))
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

func (s *Store) AssignTicket(ctx context.Context, id int64, agentEmail string) (Ticket, error) {
	agentEmail = normalizeTicketEmail(agentEmail)
	if agentEmail == "" {
		return scanTicket(s.db.QueryRow(ctx, `
			UPDATE support.ticket
			   SET assigned_to = NULL, assigned_at = NULL
			 WHERE id = $1
			 RETURNING `+ticketSelectColumns, id))
	}
	var active bool
	if err := s.reader().QueryRow(ctx, `
		SELECT active FROM support.agent WHERE lower(email) = lower($1) LIMIT 1`, agentEmail).Scan(&active); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Ticket{}, ErrNoSupportAgent
		}
		return Ticket{}, fmt.Errorf("lookup support agent: %w", err)
	}
	if !active {
		return Ticket{}, ErrNoSupportAgent
	}
	t, err := scanTicket(s.db.QueryRow(ctx, `
		UPDATE support.ticket
		   SET assigned_to = lower($2), assigned_at = now()
		 WHERE id = $1
		 RETURNING `+ticketSelectColumns, id, agentEmail))
	if errors.Is(err, pgx.ErrNoRows) {
		return Ticket{}, fmt.Errorf("ticket %d no existe", id)
	}
	if err != nil {
		return Ticket{}, fmt.Errorf("assign ticket: %w", err)
	}
	return t, nil
}

func (s *Store) AutoAssignTicket(ctx context.Context, id int64) (Ticket, error) {
	t, err := scanTicket(s.db.QueryRow(ctx, `
		WITH trow AS (
		  SELECT id, category FROM support.ticket WHERE id = $1
		),
		agent_load AS (
		  SELECT a.email, a.specialties, a.max_open_tickets, a.sort_order,
		         count(t.id) FILTER (WHERE t.status = 'open') AS open_tickets
		    FROM support.agent a
		    LEFT JOIN support.ticket t ON lower(t.assigned_to) = lower(a.email)
		   WHERE a.active
		   GROUP BY a.email, a.specialties, a.max_open_tickets, a.sort_order
		),
		candidate AS (
		  SELECT al.email
		    FROM agent_load al
		    CROSS JOIN trow tr
		   WHERE al.open_tickets < al.max_open_tickets
		     AND (
		       al.specialties = ARRAY['general']::text[]
		       OR al.specialties @> ARRAY[tr.category]::text[]
		       OR al.specialties @> ARRAY['general']::text[]
		     )
		   ORDER BY CASE WHEN al.specialties @> ARRAY[tr.category]::text[] THEN 0 ELSE 1 END,
		            al.open_tickets ASC, al.sort_order ASC, al.email ASC
		   LIMIT 1
		)
		UPDATE support.ticket st
		   SET assigned_to = (SELECT email FROM candidate), assigned_at = now()
		 WHERE st.id = (SELECT id FROM trow)
		   AND EXISTS (SELECT 1 FROM candidate)
		 RETURNING `+ticketSelectColumns, id))
	if errors.Is(err, pgx.ErrNoRows) {
		var exists bool
		if qerr := s.reader().QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM support.ticket WHERE id = $1)`, id).Scan(&exists); qerr != nil {
			return Ticket{}, fmt.Errorf("auto assign ticket lookup: %w", qerr)
		}
		if !exists {
			return Ticket{}, fmt.Errorf("ticket %d no existe", id)
		}
		return Ticket{}, ErrNoSupportAgent
	}
	if err != nil {
		return Ticket{}, fmt.Errorf("auto assign ticket: %w", err)
	}
	return t, nil
}

const supportAgentSelectColumns = `
	a.email, COALESCE(a.name,''), a.active, COALESCE(a.specialties, ARRAY['general']::text[]),
	a.max_open_tickets,
	COALESCE(count(t.id) FILTER (WHERE t.status = 'open'), 0)::int AS open_tickets,
	a.sort_order,
	to_char(a.created_at,'YYYY-MM-DD"T"HH24:MI:SSZ'),
	to_char(a.updated_at,'YYYY-MM-DD"T"HH24:MI:SSZ')`

type supportAgentScanner interface {
	Scan(dest ...any) error
}

func scanSupportAgent(row supportAgentScanner) (SupportAgent, error) {
	var a SupportAgent
	err := row.Scan(&a.Email, &a.Name, &a.Active, &a.Specialties, &a.MaxOpenTickets,
		&a.OpenTickets, &a.SortOrder, &a.CreatedAt, &a.UpdatedAt)
	return a, err
}

func (s *Store) ListSupportAgents(ctx context.Context) ([]SupportAgent, error) {
	rows, err := s.reader().Query(ctx, `
		SELECT `+supportAgentSelectColumns+`
		  FROM support.agent a
		  LEFT JOIN support.ticket t ON lower(t.assigned_to) = lower(a.email)
		 GROUP BY a.email, a.name, a.active, a.specialties, a.max_open_tickets, a.sort_order, a.created_at, a.updated_at
		 ORDER BY a.active DESC, a.sort_order ASC, a.email ASC`)
	if err != nil {
		return nil, fmt.Errorf("list support agents: %w", err)
	}
	defer rows.Close()
	out := []SupportAgent{}
	for rows.Next() {
		a, err := scanSupportAgent(rows)
		if err != nil {
			return nil, fmt.Errorf("scan support agent: %w", err)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Store) UpsertSupportAgent(ctx context.Context, a SupportAgent) (SupportAgent, error) {
	a.Email = normalizeTicketEmail(a.Email)
	a.Name = cleanTicketField(a.Name, 120)
	a.Specialties = cleanSupportSpecialties(a.Specialties)
	if a.MaxOpenTickets <= 0 || a.MaxOpenTickets > 200 {
		a.MaxOpenTickets = 25
	}
	if a.SortOrder <= 0 {
		a.SortOrder = 100
	}
	if a.Email == "" || !strings.Contains(a.Email, "@") {
		return SupportAgent{}, fmt.Errorf("agent email inválido")
	}
	return scanSupportAgent(s.db.QueryRow(ctx, `
		WITH upserted AS (
		  INSERT INTO support.agent (email, name, active, specialties, max_open_tickets, sort_order)
		  VALUES (lower($1), $2, $3, $4, $5, $6)
		  ON CONFLICT (email) DO UPDATE
		     SET name = EXCLUDED.name,
		         active = EXCLUDED.active,
		         specialties = EXCLUDED.specialties,
		         max_open_tickets = EXCLUDED.max_open_tickets,
		         sort_order = EXCLUDED.sort_order,
		         updated_at = now()
		  RETURNING *
		)
		SELECT `+strings.ReplaceAll(supportAgentSelectColumns, "a.", "u.")+`
		  FROM upserted u
		  LEFT JOIN support.ticket t ON lower(t.assigned_to) = lower(u.email)
		 GROUP BY u.email, u.name, u.active, u.specialties, u.max_open_tickets, u.sort_order, u.created_at, u.updated_at`,
		a.Email, a.Name, a.Active, a.Specialties, a.MaxOpenTickets, a.SortOrder))
}

func (s *Store) SaveTicketAIDraft(ctx context.Context, id int64, status, answer, lastErr string, sources json.RawMessage) (Ticket, error) {
	status = normalizeAIDraftStatus(status)
	answer = cleanTicketText(answer, 5000)
	lastErr = cleanTicketField(lastErr, 500)
	if len(sources) == 0 || !json.Valid(sources) {
		sources = json.RawMessage(`[]`)
	}
	t, err := scanTicket(s.db.QueryRow(ctx, `
		UPDATE support.ticket
		   SET ai_draft_status = $2,
		       ai_draft_answer = $3,
		       ai_sources = $4::jsonb,
		       last_ai_error = $5,
		       ai_drafted_at = now()
		 WHERE id = $1
		 RETURNING `+ticketSelectColumns,
		id, status, answer, string(sources), lastErr))
	if errors.Is(err, pgx.ErrNoRows) {
		return Ticket{}, fmt.Errorf("ticket %d no existe", id)
	}
	if err != nil {
		return Ticket{}, fmt.Errorf("save ai draft: %w", err)
	}
	return t, nil
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
	agents, err := h.store.ListSupportAgents(r.Context())
	if err != nil {
		h.log.Warn().Err(err).Msg("list support agents")
		agents = []SupportAgent{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"tickets": tickets, "total": total, "agents": agents})
}

func (h *Handler) handleAdminTicketAgents(w http.ResponseWriter, r *http.Request) {
	adminEmail, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		agents, err := h.store.ListSupportAgents(r.Context())
		if err != nil {
			h.log.Error().Err(err).Msg("list support agents")
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"agents": agents})
	case http.MethodPost:
		var req struct {
			Email          string   `json:"email"`
			Name           string   `json:"name"`
			Active         *bool    `json:"active"`
			Specialties    []string `json:"specialties"`
			MaxOpenTickets int      `json:"max_open_tickets"`
			SortOrder      int      `json:"sort_order"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid_json")
			return
		}
		active := true
		if req.Active != nil {
			active = *req.Active
		}
		agent, err := h.store.UpsertSupportAgent(r.Context(), SupportAgent{
			Email:          req.Email,
			Name:           req.Name,
			Active:         active,
			Specialties:    req.Specialties,
			MaxOpenTickets: req.MaxOpenTickets,
			SortOrder:      req.SortOrder,
		})
		if err != nil {
			h.log.Error().Err(err).Str("by", adminEmail).Msg("upsert support agent")
			writeErr(w, http.StatusBadRequest, "invalid_agent")
			return
		}
		h.store.cache.PublishEvent(r.Context(), "support.agent.upserted", map[string]any{
			"email": agent.Email, "by": adminEmail, "active": agent.Active,
		})
		writeJSON(w, http.StatusOK, agent)
	default:
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
	}
}

// handleAdminTicketAction: POST /api/admin/tickets/action
// {id, action: reply|close|reopen|assign|auto_assign|draft_ai|send_ai, answer?, notify?, agent_email?}
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
		ID         int64  `json:"id"`
		Action     string `json:"action"`
		Answer     string `json:"answer"`
		Notify     bool   `json:"notify"`
		AgentEmail string `json:"agent_email"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil || req.ID <= 0 {
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
		if req.Notify {
			h.notifyTicketReply(t)
		}
		writeJSON(w, http.StatusOK, t)
	case "assign":
		t, err := h.store.AssignTicket(r.Context(), req.ID, req.AgentEmail)
		if err != nil {
			h.writeTicketActionError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, t)
	case "auto_assign":
		t, err := h.store.AutoAssignTicket(r.Context(), req.ID)
		if err != nil {
			h.writeTicketActionError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, t)
	case "draft_ai":
		t, err := h.DraftTicketAI(r.Context(), req.ID)
		if err != nil {
			h.writeTicketActionError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, t)
	case "send_ai":
		t, err := h.SendTicketAIDraft(r.Context(), req.ID, adminEmail, req.Notify)
		if err != nil {
			h.writeTicketActionError(w, err)
			return
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

func (h *Handler) writeTicketActionError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrNoSupportAgent):
		writeErr(w, http.StatusConflict, "no_support_agent")
	case errors.Is(err, ErrNotSupportRequest):
		writeErr(w, http.StatusConflict, "not_support_request")
	case errors.Is(err, ErrSupportAIUnconfigured):
		writeErr(w, http.StatusServiceUnavailable, "support_ai_unconfigured")
	case errors.Is(err, ErrAIDraftNotReady):
		writeErr(w, http.StatusConflict, "ai_draft_not_ready")
	default:
		h.log.Error().Err(err).Msg("ticket action")
		writeErr(w, http.StatusInternalServerError, "internal")
	}
}

func (h *Handler) notifyTicketReply(t Ticket) {
	go func(t Ticket) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := h.store.SendEmail(ctx, []string{t.Email},
			"Re: "+t.Subject,
			"Hola,\n\nTu ticket #"+fmt.Sprint(t.ID)+" fue respondido:\n\n"+t.Answer+"\n\n- Equipo Mindbliss Power"); err != nil {
			h.log.Warn().Err(err).Int64("ticket", t.ID).Msg("ticket reply email failed (non-fatal)")
		}
	}(t)
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
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_request")
		return
	}
	email, ok := h.resolveIdentity(w, r, req.Email)
	if !ok {
		return
	}
	if h.rejectIfSuspended(r.Context(), w, email) {
		return
	}
	if strings.TrimSpace(req.Subject) == "" || strings.TrimSpace(req.Body) == "" {
		writeErr(w, http.StatusBadRequest, "subject_and_body_required")
		return
	}
	t, err := h.store.CreateTicketWithSource(r.Context(), email, req.Subject, req.Body, "member", "")
	if err != nil {
		h.log.Error().Err(err).Msg("create ticket")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	h.maybeDraftTicketAsync(t.ID)
	writeJSON(w, http.StatusOK, map[string]any{"id": t.ID, "status": "open", "priority": t.Priority, "category": t.Category})
}

// handleMemberTickets: GET /api/support/tickets — el BFF del growth-hub lista los
// tickets del miembro autenticado. Scoped por el email VERIFICADO del id token
// (resolveIdentity), nunca por el query: un miembro sólo ve SUS tickets.
func (h *Handler) handleMemberTickets(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	email, ok := h.resolveIdentity(w, r, r.URL.Query().Get("email"))
	if !ok {
		return
	}
	if h.rejectIfSuspended(r.Context(), w, email) {
		return
	}
	tickets, total, err := h.store.ListMemberTickets(r.Context(), email,
		atoiDefault(r.URL.Query().Get("limit"), 25), atoiDefault(r.URL.Query().Get("offset"), 0))
	if err != nil {
		h.log.Error().Err(err).Msg("list member tickets")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tickets": tickets, "total": total})
}

func (h *Handler) handleSupportEmailIngest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	var req struct {
		From      string `json:"from"`
		Email     string `json:"email"`
		Subject   string `json:"subject"`
		Body      string `json:"body"`
		MessageID string `json:"message_id"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}
	email := normalizeTicketEmail(req.Email)
	if email == "" {
		email = extractEmail(req.From)
	}
	subject := cleanTicketField(req.Subject, 160)
	body := cleanTicketText(req.Body, 8000)
	if email == "" || subject == "" || body == "" {
		writeErr(w, http.StatusBadRequest, "email_subject_body_required")
		return
	}
	triage := classifySupportTicket(subject, body)
	if !triage.SupportRequest {
		h.log.Info().Str("from", email).Str("reason", triage.Reason).Msg("support email ignored by deterministic filter")
		writeJSON(w, http.StatusAccepted, map[string]any{
			"accepted": false, "support_request": false,
			"category": triage.Category, "reason": triage.Reason,
		})
		return
	}
	t, err := h.store.CreateTicketWithSource(r.Context(), email, subject, body, "email", req.MessageID)
	if err != nil {
		h.log.Error().Err(err).Msg("ingest support email")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	if h.supportAIAutoDraft && h.supportAIURL != "" && h.supportAIToken != "" {
		if drafted, derr := h.DraftTicketAI(r.Context(), t.ID); derr != nil {
			h.log.Warn().Err(derr).Int64("ticket", t.ID).Msg("support email ai draft failed")
		} else {
			t = drafted
		}
	}
	if h.supportAIAutoReply && t.AISupportRequest && t.AIDraftStatus == "drafted" && strings.TrimSpace(t.AIDraftAnswer) != "" {
		if answered, aerr := h.store.ReplyTicket(r.Context(), t.ID, t.AIDraftAnswer, "ai-support@mindblisspower.com"); aerr != nil {
			h.log.Warn().Err(aerr).Int64("ticket", t.ID).Msg("support email ai auto-reply persist failed")
		} else {
			t = answered
			h.notifyTicketReply(t)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"accepted": true, "support_request": true, "ticket": t})
}

// --- AI drafts ---------------------------------------------------------------

func (h *Handler) SetSupportAI(baseURL, serviceToken string, autoDraft, autoReply bool) {
	h.supportAIURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	h.supportAIToken = strings.TrimSpace(serviceToken)
	h.supportAIAutoDraft = autoDraft
	h.supportAIAutoReply = autoReply
}

func (h *Handler) maybeDraftTicketAsync(id int64) {
	if !h.supportAIAutoDraft || h.supportAIURL == "" || h.supportAIToken == "" {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		if _, err := h.DraftTicketAI(ctx, id); err != nil {
			h.log.Warn().Err(err).Int64("ticket", id).Msg("ticket ai draft failed")
		}
	}()
}

func (h *Handler) DraftTicketAI(ctx context.Context, id int64) (Ticket, error) {
	t, err := h.store.GetTicket(ctx, id)
	if err != nil {
		return Ticket{}, err
	}
	if !t.AISupportRequest || t.Category == "non_support" {
		saved, serr := h.store.SaveTicketAIDraft(ctx, id, "blocked", "", "filter rejected: "+t.AIFilterReason, nil)
		if serr != nil {
			h.log.Warn().Err(serr).Int64("ticket", id).Msg("save blocked ai draft")
		} else {
			t = saved
		}
		return t, ErrNotSupportRequest
	}
	if h.supportAIURL == "" || h.supportAIToken == "" {
		return t, ErrSupportAIUnconfigured
	}
	res, err := h.callSupportAI(ctx, t)
	if err != nil {
		saved, serr := h.store.SaveTicketAIDraft(ctx, id, "error", "", err.Error(), nil)
		if serr == nil {
			t = saved
		}
		return t, err
	}
	answer := cleanTicketText(res.Answer, 5000)
	if answer == "" {
		saved, serr := h.store.SaveTicketAIDraft(ctx, id, "error", "", "empty_ai_answer", res.Sources)
		if serr == nil {
			t = saved
		}
		return t, fmt.Errorf("empty ai answer")
	}
	status := "drafted"
	if res.Escalate {
		status = "escalate"
	}
	return h.store.SaveTicketAIDraft(ctx, id, status, answer, "", res.Sources)
}

func (h *Handler) SendTicketAIDraft(ctx context.Context, id int64, adminEmail string, notify bool) (Ticket, error) {
	t, err := h.store.GetTicket(ctx, id)
	if err != nil {
		return Ticket{}, err
	}
	if !t.AISupportRequest || t.Category == "non_support" {
		return t, ErrNotSupportRequest
	}
	if t.AIDraftStatus != "drafted" || strings.TrimSpace(t.AIDraftAnswer) == "" {
		return t, ErrAIDraftNotReady
	}
	answered, err := h.store.ReplyTicket(ctx, id, t.AIDraftAnswer, adminEmail)
	if err != nil {
		return Ticket{}, err
	}
	if notify {
		h.notifyTicketReply(answered)
	}
	return answered, nil
}

type supportChatResult struct {
	Answer   string          `json:"answer"`
	Sources  json.RawMessage `json:"sources"`
	Escalate bool            `json:"escalate"`
}

func (h *Handler) callSupportAI(ctx context.Context, t Ticket) (supportChatResult, error) {
	payload, err := json.Marshal(map[string]string{"message": buildSupportAIMessage(t)})
	if err != nil {
		return supportChatResult{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.supportAIURL+"/api/support/chat", bytes.NewReader(payload))
	if err != nil {
		return supportChatResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-VP-Service-Token", h.supportAIToken)
	req.Header.Set("X-VP-User-Email", t.Email)
	client := &http.Client{Timeout: 45 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return supportChatResult{}, fmt.Errorf("support ai request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return supportChatResult{}, fmt.Errorf("support ai status %d", resp.StatusCode)
	}
	var out supportChatResult
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out); err != nil {
		return supportChatResult{}, fmt.Errorf("support ai decode: %w", err)
	}
	if len(out.Sources) == 0 || !json.Valid(out.Sources) {
		out.Sources = json.RawMessage(`[]`)
	}
	return out, nil
}

func buildSupportAIMessage(t Ticket) string {
	return "Genera una respuesta corta y accionable para un ticket de soporte de Mindbliss Power. " +
		"No prometas acciones financieras ni cambios de cuenta; si requiere validacion manual, indicalo y escala.\n\n" +
		"Categoria: " + t.Category + "\nPrioridad: " + t.Priority + "\nResumen: " + t.ProblemSummary +
		"\nAsunto: " + t.Subject + "\nMensaje:\n" + t.Body
}

// --- Triage ------------------------------------------------------------------

func classifySupportTicket(subject, body string) TicketTriage {
	subject = cleanTicketField(subject, 160)
	body = cleanTicketText(body, 8000)
	text := normalizeSupportText(subject + " " + body)
	if strings.TrimSpace(text) == "" {
		return TicketTriage{SupportRequest: false, Category: "non_support", Priority: "low", Reason: "empty_message"}
	}
	category := detectTicketCategory(text)
	positive := countKeywordGroups(text, supportKeywordGroups)
	negative := countKeywords(text, nonSupportKeywords)
	if category != "general" {
		positive++
	}
	support := positive > 0
	if negative > 0 && (positive == 0 || category == "general") {
		support = false
	}
	if !support {
		return TicketTriage{
			SupportRequest: false,
			Category:       "non_support",
			Priority:       "low",
			ProblemSummary: summarizeTicketProblem(subject, body, "non_support"),
			Reason:         "filtered_non_support",
		}
	}
	priority := detectTicketPriority(text, category)
	return TicketTriage{
		SupportRequest: true,
		Category:       category,
		Priority:       priority,
		ProblemSummary: summarizeTicketProblem(subject, body, category),
		Reason:         "support:" + category,
	}
}

var supportKeywordGroups = [][]string{
	{"codigo", "otp", "sms", "2fa", "verificacion", "validar", "confirmacion", "no llega", "no recibo"},
	{"login", "acceso", "entrar", "iniciar sesion", "contrasena", "password", "clave"},
	{"telefono", "celular", "whatsapp", "linkeado", "vinculado"},
	{"pago", "comprar", "checkout", "stripe", "tarjeta", "rechazada", "fallido", "recibo", "reembolso", "refund", "chargeback", "contracargo"},
	{"kyc", "documento", "pasaporte", "identidad"},
	{"arbol", "binario", "posicion", "derrame", "referido", "referidos", "sponsor", "estructura", "red"},
	{"comision", "comisiones", "bono", "rango", "nivel", "pv", "wallet", "saldo", "retiro", "withdrawal", "bmp"},
	{"error", "404", "no carga", "no abre", "bug", "fallo", "problema", "soporte", "ayuda", "ticket"},
}

var nonSupportKeywords = []string{
	"newsletter", "unsubscribe", "desuscribir", "publicidad", "guest post", "backlink",
	"propuesta comercial", "alianza", "partnership", "vacante", "empleo", "curriculum",
	"curriculo", "hoja de vida", "prensa", "media kit", "sponsorship", "seo services",
}

var ticketCategoryKeywords = map[string][]string{
	"access":      {"codigo", "otp", "sms", "login", "acceso", "entrar", "contrasena", "password", "telefono", "celular", "validar"},
	"tree":        {"arbol", "binario", "posicion", "derrame", "referido", "referidos", "sponsor", "estructura", "red"},
	"payments":    {"pago", "checkout", "stripe", "tarjeta", "rechazada", "fallido", "recibo", "cobro", "cobrado", "reembolso", "refund", "chargeback", "contracargo"},
	"kyc":         {"kyc", "documento", "pasaporte", "identidad", "verificacion de identidad"},
	"withdrawals": {"retiro", "withdrawal", "wallet", "bmp", "cuenta bancaria", "saldo"},
	"commissions": {"comision", "comisiones", "bono", "bonificacion", "rango", "nivel", "pv"},
	"technical":   {"error", "404", "no carga", "no abre", "bug", "fallo", "pantalla", "dashboard"},
}

func detectTicketCategory(text string) string {
	for _, category := range []string{"access", "tree", "payments", "kyc", "withdrawals", "commissions", "technical"} {
		if containsAnyKeyword(text, ticketCategoryKeywords[category]) {
			return category
		}
	}
	return "general"
}

func detectTicketPriority(text, category string) string {
	if containsAnyKeyword(text, []string{"fraude", "fraud", "hack", "seguridad", "chargeback", "contracargo", "cuenta bloqueada", "baneado", "suspendido"}) {
		return "critical"
	}
	if containsAnyKeyword(text, []string{"me cobraron", "cobro", "cobrado", "pago exitoso", "ya pague", "pagado", "no aparece", "no estoy en el arbol", "no veo mi posicion", "reembolso", "refund", "retiro"}) {
		return "high"
	}
	if category == "access" && containsAnyKeyword(text, []string{"no llega", "no recibo", "otp", "codigo", "sms", "no puedo entrar", "correo falla"}) {
		return "high"
	}
	if category == "payments" || category == "tree" || category == "withdrawals" {
		return "high"
	}
	if category == "technical" && containsAnyKeyword(text, []string{"404", "no carga", "no abre"}) {
		return "normal"
	}
	return "normal"
}

func summarizeTicketProblem(subject, body, category string) string {
	joined := strings.TrimSpace(subject)
	if b := strings.TrimSpace(body); b != "" {
		if joined != "" {
			joined += " - "
		}
		joined += b
	}
	joined = strings.Join(strings.Fields(joined), " ")
	if joined == "" {
		joined = "Ticket sin detalle"
	}
	prefix := map[string]string{
		"access":      "Acceso: ",
		"payments":    "Pagos: ",
		"kyc":         "KYC: ",
		"tree":        "Arbol binario: ",
		"commissions": "Comisiones: ",
		"withdrawals": "Retiros: ",
		"technical":   "Tecnico: ",
		"non_support": "No soporte: ",
	}[category]
	return cleanTicketField(prefix+joined, 260)
}

func countKeywordGroups(text string, groups [][]string) int {
	count := 0
	for _, group := range groups {
		if containsAnyKeyword(text, group) {
			count++
		}
	}
	return count
}

func countKeywords(text string, keywords []string) int {
	count := 0
	for _, keyword := range keywords {
		if containsKeyword(text, keyword) {
			count++
		}
	}
	return count
}

func containsAnyKeyword(text string, keywords []string) bool {
	for _, keyword := range keywords {
		if containsKeyword(text, keyword) {
			return true
		}
	}
	return false
}

func containsKeyword(text, keyword string) bool {
	k := strings.TrimSpace(normalizeSupportText(keyword))
	if k == "" {
		return false
	}
	return strings.Contains(text, k)
}

func normalizeSupportText(s string) string {
	s = strings.ToLower(s)
	s = strings.NewReplacer(
		"á", "a", "é", "e", "í", "i", "ó", "o", "ú", "u", "ü", "u", "ñ", "n",
		"Á", "a", "É", "e", "Í", "i", "Ó", "o", "Ú", "u", "Ü", "u", "Ñ", "n",
	).Replace(s)
	s = strings.NewReplacer("\r", " ", "\n", " ", "\t", " ", ".", " ", ",", " ", ";", " ", ":", " ", "(", " ", ")", " ", "[", " ", "]", " ").Replace(s)
	return strings.TrimSpace(strings.Join(strings.Fields(s), " "))
}

var validTicketSources = map[string]bool{
	"member": true, "email": true, "access_help": true, "admin": true, "chatwoot": true, "ai": true,
	"voice": true, "whatsapp": true, "whatsapp_call": true,
}

func normalizeTicketSource(source string) string {
	source = strings.ToLower(strings.TrimSpace(source))
	if !validTicketSources[source] {
		return "member"
	}
	return source
}

var validTicketCategories = map[string]bool{
	"access": true, "payments": true, "kyc": true, "tree": true, "commissions": true,
	"withdrawals": true, "technical": true, "general": true, "non_support": true,
}

func cleanSupportSpecialties(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, raw := range in {
		v := strings.ToLower(strings.TrimSpace(raw))
		if !validTicketCategories[v] || v == "non_support" || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	if len(out) == 0 {
		out = append(out, "general")
	}
	return out
}

func normalizeAIDraftStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "drafted", "blocked", "escalate", "error":
		return strings.ToLower(strings.TrimSpace(status))
	default:
		return "none"
	}
}

func normalizeTicketEmail(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func extractEmail(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if addr, err := mail.ParseAddress(value); err == nil {
		return normalizeTicketEmail(addr.Address)
	}
	if i := strings.Index(value, "<"); i >= 0 {
		if j := strings.Index(value[i:], ">"); j > 0 {
			return extractEmail(value[i+1 : i+j])
		}
	}
	fields := strings.FieldsFunc(value, func(r rune) bool {
		return r == ' ' || r == ',' || r == ';'
	})
	for _, f := range fields {
		f = strings.Trim(f, "<>()\"'")
		if strings.Contains(f, "@") {
			return normalizeTicketEmail(f)
		}
	}
	return ""
}
