package supportkb

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
)

// IdentityVerifier re-verifica el id token Cognito que reenvía el BFF
// (X-VP-Id-Token) — misma defensa en profundidad H-2 que vp-payments.
// Interfaz local para no acoplar supportkb al paquete payments; en main se
// inyecta payments.NewCognitoVerifier, que la satisface.
type IdentityVerifier interface {
	VerifyEmail(ctx context.Context, rawToken string) (string, error)
}

// Handler expone la API HTTP de la KB y el bot. Auth en dos capas:
//  1. X-VP-Service-Token: shared secret con el BFF (toda ruta salvo /health).
//  2. X-VP-Id-Token: identidad del usuario final, verificada server-side si
//     hay verifier; el ROL (admin/member) se deriva del email verificado
//     contra la allowlist — jamás de un claim que mande el cliente.
type Handler struct {
	pool        *pgxpool.Pool
	searcher    *Searcher
	bot         *Bot
	serviceTok  string
	adminEmails map[string]bool
	verifier    IdentityVerifier
	requireID   bool
	logger      zerolog.Logger
}

func NewHandler(pool *pgxpool.Pool, searcher *Searcher, bot *Bot, serviceTok string, adminEmails []string, logger zerolog.Logger) *Handler {
	adm := make(map[string]bool, len(adminEmails))
	for _, e := range adminEmails {
		adm[strings.ToLower(e)] = true
	}
	return &Handler{
		pool:        pool,
		searcher:    searcher,
		bot:         bot,
		serviceTok:  serviceTok,
		adminEmails: adm,
		logger:      logger,
	}
}

// SetIdentityVerifier habilita la verificación del id token. require=true ⇒
// sin token verificable no hay identidad (fail-closed).
func (h *Handler) SetIdentityVerifier(v IdentityVerifier, require bool) {
	h.verifier = v
	h.requireID = require
}

func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	// Miembros y admins (el rol scopea la visibilidad server-side).
	mux.Handle("POST /api/support/kb/search", h.auth(false, h.handleSearch))
	mux.Handle("POST /api/support/chat", h.auth(false, h.handleChat))

	// Solo admin: gestión de documentos.
	mux.Handle("POST /api/support/kb/docs", h.auth(true, h.handleUpsertDoc))
	mux.Handle("GET /api/support/kb/docs", h.auth(true, h.handleListDocs))
	mux.Handle("DELETE /api/support/kb/docs/{id}", h.auth(true, h.handleDeactivateDoc))

	return mux
}

type ctxKey int

const roleKey ctxKey = 1

// auth valida service token + identidad y deriva el rol. adminOnly corta a
// no-admins con 403.
func (h *Handler) auth(adminOnly bool, next func(http.ResponseWriter, *http.Request)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-VP-Service-Token") != h.serviceTok {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "service token inválido"})
			return
		}

		email := ""
		if h.verifier != nil {
			if raw := r.Header.Get("X-VP-Id-Token"); raw != "" {
				verified, err := h.verifier.VerifyEmail(r.Context(), raw)
				if err != nil {
					writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "id token inválido"})
					return
				}
				email = verified
			} else if h.requireID {
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "id token requerido"})
				return
			}
		}
		// Fallback (modo no estricto, backward-compatible con el BFF): el
		// email sin verificar solo ESCALA privilegios hasta member, nunca admin.
		verified := email != ""
		if !verified {
			email = strings.ToLower(r.Header.Get("X-VP-User-Email"))
		}

		role := "public"
		switch {
		case email != "" && h.adminEmails[email] && verified:
			role = "admin"
		case email != "":
			role = "member"
		}

		if adminOnly && role != "admin" {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "requiere admin"})
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), roleKey, role)))
	})
}

func roleFrom(r *http.Request) string {
	if v, ok := r.Context().Value(roleKey).(string); ok {
		return v
	}
	return "public"
}

// --- Handlers ----------------------------------------------------------------

func (h *Handler) handleSearch(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Query     string `json:"query"`
		Categoria string `json:"categoria"`
		TopK      int    `json:"top_k"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Query) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "query requerido"})
		return
	}
	hits, err := h.searcher.Search(r.Context(), req.Query, SearchOpts{
		Visibility: VisibilityFor(roleFrom(r)),
		Lang:       "es",
		Categoria:  req.Categoria,
		TopK:       req.TopK,
	})
	if err != nil {
		h.logger.Error().Err(err).Msg("search failed")
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "búsqueda no disponible"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"hits": hits})
}

func (h *Handler) handleChat(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Message) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "message requerido"})
		return
	}
	res, err := h.bot.Chat(r.Context(), req.Message, roleFrom(r))
	if err != nil {
		h.logger.Error().Err(err).Msg("chat failed")
		// El bot caído NUNCA deja al usuario sin salida: escalar a humano.
		writeJSON(w, http.StatusOK, ChatResult{
			Answer:   "El asistente no está disponible en este momento; te conecto con un agente.",
			Escalate: true,
		})
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (h *Handler) handleUpsertDoc(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID         string `json:"id"`
		Titulo     string `json:"titulo"`
		Categoria  string `json:"categoria"`
		Lang       string `json:"lang"`
		RolVisible string `json:"rol_visible"`
		Body       string `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil ||
		strings.TrimSpace(req.Titulo) == "" || strings.TrimSpace(req.Body) == "" || strings.TrimSpace(req.Categoria) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "titulo, categoria y body requeridos"})
		return
	}
	id, err := UpsertDocument(r.Context(), h.pool, Document{
		ID: req.ID, Titulo: req.Titulo, Categoria: req.Categoria,
		Lang: req.Lang, RolVisible: req.RolVisible, Body: req.Body,
	})
	if err != nil {
		h.logger.Error().Err(err).Msg("upsert doc failed")
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "no se pudo guardar el documento"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": id})
}

func (h *Handler) handleListDocs(w http.ResponseWriter, r *http.Request) {
	rows, err := h.pool.Query(r.Context(), `
		SELECT d.id, d.titulo, d.categoria, d.lang, d.rol_visible::text, d.version,
		       d.activo, d.updated_at,
		       count(c.id) AS chunks,
		       count(c.id) FILTER (WHERE c.embedded_at IS NOT NULL
		                             AND c.embedded_at >= c.updated_at) AS indexed
		FROM support.kb_documents d
		LEFT JOIN support.kb_chunks c ON c.doc_id = d.id
		GROUP BY d.id
		ORDER BY d.updated_at DESC`)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "query failed"})
		return
	}
	type docRow struct {
		ID         string `json:"id"`
		Titulo     string `json:"titulo"`
		Categoria  string `json:"categoria"`
		Lang       string `json:"lang"`
		RolVisible string `json:"rol_visible"`
		Version    int    `json:"version"`
		Activo     bool   `json:"activo"`
		UpdatedAt  string `json:"updated_at"`
		Chunks     int    `json:"chunks"`
		Indexed    int    `json:"indexed"` // chunks==indexed ⇒ doc al día en Qdrant
	}
	docs, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (docRow, error) {
		var d docRow
		var t time.Time
		err := row.Scan(&d.ID, &d.Titulo, &d.Categoria, &d.Lang, &d.RolVisible,
			&d.Version, &d.Activo, &t, &d.Chunks, &d.Indexed)
		d.UpdatedAt = t.UTC().Format(time.RFC3339)
		return d, err
	})
	if err != nil {
		h.logger.Error().Err(err).Msg("list docs failed")
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "scan failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"docs": docs})
}

func (h *Handler) handleDeactivateDoc(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id requerido"})
		return
	}
	if err := DeactivateDocument(r.Context(), h.pool, id); err != nil {
		h.logger.Error().Err(err).Str("doc_id", id).Msg("deactivate failed")
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "no se pudo desactivar"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deactivated"})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
