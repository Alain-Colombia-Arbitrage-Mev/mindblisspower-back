package supportkb

import (
	"context"
	"fmt"
	"net/http"
)

// Searcher es el camino caliente del bot: embebe la pregunta (prefijo query:)
// y busca en Qdrant con filtros. El filtro de visibilidad es OBLIGATORIO y va
// del lado del servidor: el bot nunca decide en el prompt qué puede ver el
// usuario.
type Searcher struct {
	emb *Embedder
	qd  *Qdrant
}

func NewSearcher(emb *Embedder, qd *Qdrant) *Searcher {
	return &Searcher{emb: emb, qd: qd}
}

// SearchOpts filtra la búsqueda. Visibility se deriva del ROL AUTENTICADO del
// usuario (Cognito), jamás de input del cliente.
type SearchOpts struct {
	Visibility []string // valores de rol_visible permitidos para este usuario
	Lang       string   // "" ⇒ sin filtro
	Categoria  string   // "" ⇒ sin filtro
	TopK       int      // default 5
}

// VisibilityFor mapea el rol autenticado a los niveles de KB que puede ver.
func VisibilityFor(role string) []string {
	switch role {
	case "admin":
		return []string{"public", "member", "admin"}
	case "member":
		return []string{"public", "member"}
	default: // anónimo / no autenticado
		return []string{"public"}
	}
}

// Hit es un chunk relevante con su score de similitud coseno.
type Hit struct {
	ChunkID   string  `json:"chunk_id"`
	DocID     string  `json:"doc_id"`
	Titulo    string  `json:"titulo"`
	Categoria string  `json:"categoria"`
	Ord       int     `json:"ord"`
	Texto     string  `json:"texto"`
	Score     float64 `json:"score"`
}

func (s *Searcher) Search(ctx context.Context, query string, opts SearchOpts) ([]Hit, error) {
	if len(opts.Visibility) == 0 {
		return nil, fmt.Errorf("SearchOpts.Visibility requerido (usar VisibilityFor)")
	}
	if opts.TopK <= 0 {
		opts.TopK = 5
	}

	vec, err := s.emb.EmbedQuery(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("embed query: %w", err)
	}
	return s.qd.Search(ctx, vec, opts)
}

// Search ejecuta la búsqueda vectorial filtrada (filterable HNSW: los payload
// indexes de rol_visible/lang/categoria participan dentro del grafo).
func (q *Qdrant) Search(ctx context.Context, vector []float32, opts SearchOpts) ([]Hit, error) {
	must := []map[string]any{
		{"key": "rol_visible", "match": map[string]any{"any": opts.Visibility}},
	}
	if opts.Lang != "" {
		must = append(must, map[string]any{"key": "lang", "match": map[string]any{"value": opts.Lang}})
	}
	if opts.Categoria != "" {
		must = append(must, map[string]any{"key": "categoria", "match": map[string]any{"value": opts.Categoria}})
	}

	body := map[string]any{
		"vector":       vector,
		"limit":        opts.TopK,
		"filter":       map[string]any{"must": must},
		"with_payload": true,
	}

	var out struct {
		Result []struct {
			ID      string         `json:"id"`
			Score   float64        `json:"score"`
			Payload map[string]any `json:"payload"`
		} `json:"result"`
	}
	if _, err := q.do(ctx, http.MethodPost, "/collections/"+q.collection+"/points/search", body, &out); err != nil {
		return nil, err
	}

	hits := make([]Hit, 0, len(out.Result))
	for _, r := range out.Result {
		h := Hit{ChunkID: r.ID, Score: r.Score}
		h.DocID, _ = r.Payload["doc_id"].(string)
		h.Titulo, _ = r.Payload["titulo"].(string)
		h.Categoria, _ = r.Payload["categoria"].(string)
		h.Texto, _ = r.Payload["texto"].(string)
		if v, ok := r.Payload["ord"].(float64); ok {
			h.Ord = int(v)
		}
		hits = append(hits, h)
	}
	return hits, nil
}
