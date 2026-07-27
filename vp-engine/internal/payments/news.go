package payments

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// News es un comunicado oficial que el miembro ve en el panel (antes venía de un
// array hardcodeado en el growth-hub, incluyendo datos bancarios OBSOLETOS: el
// negocio cobra SOLO por Stripe). Ahora se sirve desde support.news.
type News struct {
	ID        int64  `json:"id"`
	Title     string `json:"title"`
	Body      string `json:"body"`
	CreatedAt string `json:"created_at"`
}

// ListNews devuelve los comunicados publicados, más recientes primero.
func (s *Store) ListNews(ctx context.Context, limit int) ([]News, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	rows, err := s.reader().Query(ctx, `
		SELECT id, title, body,
		       to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSZ')
		  FROM support.news
		 WHERE published = true
		 ORDER BY created_at DESC
		 LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("list news: %w", err)
	}
	defer rows.Close()
	out := []News{}
	for rows.Next() {
		var n News
		if err := rows.Scan(&n.ID, &n.Title, &n.Body, &n.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan news: %w", err)
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// CreateNews publica un comunicado (lo invoca el panel admin).
func (s *Store) CreateNews(ctx context.Context, title, body string) (int64, error) {
	var id int64
	err := s.db.QueryRow(ctx, `
		INSERT INTO support.news (title, body)
		VALUES ($1, $2) RETURNING id`,
		strings.TrimSpace(title), strings.TrimSpace(body)).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("create news: %w", err)
	}
	return id, nil
}

// --- Handlers ----------------------------------------------------------------

// handleMemberNews: GET /api/member/news — comunicados para el miembro. No es
// información sensible; basta el token de servicio del BFF (svcAuth), sin resolver
// identidad.
func (h *Handler) handleMemberNews(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	news, err := h.store.ListNews(r.Context(), atoiDefault(r.URL.Query().Get("limit"), 25))
	if err != nil {
		h.log.Error().Err(err).Msg("list news")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"news": news})
}

// handleAdminNews: POST /api/admin/news {title, body} — el admin publica un
// comunicado. Gate requireAdmin (mismo patrón que los tickets).
func (h *Handler) handleAdminNews(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	var req struct {
		Title string `json:"title"`
		Body  string `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if strings.TrimSpace(req.Title) == "" || strings.TrimSpace(req.Body) == "" {
		writeErr(w, http.StatusBadRequest, "title_and_body_required")
		return
	}
	id, err := h.store.CreateNews(r.Context(), req.Title, req.Body)
	if err != nil {
		h.log.Error().Err(err).Msg("create news")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
}
