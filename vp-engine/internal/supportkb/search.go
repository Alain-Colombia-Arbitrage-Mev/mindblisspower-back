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
	emb              *Embedder
	qd               *Qdrant
	reranker         *Reranker
	graph            *FalkorDB
	rerankCandidates int
	graphExpand      int
	rerankTopK       int
}

func NewSearcher(emb *Embedder, qd *Qdrant) *Searcher {
	return &Searcher{emb: emb, qd: qd, rerankCandidates: 20, graphExpand: 8}
}

func (s *Searcher) SetReranker(r *Reranker, candidates, topK int) {
	s.reranker = r
	if candidates > 0 {
		s.rerankCandidates = candidates
	}
	if topK > 0 {
		s.rerankTopK = topK
	}
}

func (s *Searcher) SetGraph(graph *FalkorDB, expand int) {
	s.graph = graph
	if expand > 0 {
		s.graphExpand = expand
	}
}

// SearchOpts filtra la búsqueda. Visibility se deriva del ROL AUTENTICADO del
// usuario (Cognito), jamás de input del cliente.
type SearchOpts struct {
	Visibility []string // valores de rol_visible permitidos para este usuario
	Lang       string   // "" ⇒ sin filtro
	Categoria  string   // "" ⇒ sin filtro
	TopK       int      // default 5
	CandidateK int      // candidatos vectoriales antes de grafo/rerank; 0 ⇒ automático
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
	ChunkID     string  `json:"chunk_id"`
	DocID       string  `json:"doc_id"`
	Titulo      string  `json:"titulo"`
	Categoria   string  `json:"categoria"`
	Ord         int     `json:"ord"`
	Texto       string  `json:"texto"`
	Score       float64 `json:"score"`                  // score final: rerank si aplica, vector si no
	VectorScore float64 `json:"vector_score,omitempty"` // score original de Qdrant
	RerankScore float64 `json:"rerank_score,omitempty"` // score de OpenRouter Rerank
	GraphScore  float64 `json:"graph_score,omitempty"`  // 1 si vino por expansion de FalkorDB
}

func (s *Searcher) Search(ctx context.Context, query string, opts SearchOpts) ([]Hit, error) {
	if len(opts.Visibility) == 0 {
		return nil, fmt.Errorf("SearchOpts.Visibility requerido (usar VisibilityFor)")
	}
	if opts.TopK <= 0 {
		opts.TopK = 5
	}
	candidateK := opts.CandidateK
	if candidateK <= 0 {
		candidateK = opts.TopK
		if s.reranker != nil && s.reranker.Enabled() && s.rerankCandidates > candidateK {
			candidateK = s.rerankCandidates
		}
	}
	if candidateK < opts.TopK {
		candidateK = opts.TopK
	}

	vec, err := s.emb.EmbedQuery(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("embed query: %w", err)
	}
	vectorOpts := opts
	vectorOpts.TopK = candidateK
	hits, err := s.qd.Search(ctx, vec, vectorOpts)
	if err != nil {
		return nil, err
	}
	hits = dedupeHits(hits)

	if s.graph != nil && s.graph.Enabled() && s.graphExpand > 0 && len(hits) > 0 {
		related, err := s.graph.RelatedChunks(ctx, hits, opts, s.graphExpand)
		if err == nil && len(related) > 0 {
			hits = dedupeHits(append(hits, related...))
		}
	}

	if s.reranker != nil && s.reranker.Enabled() && len(hits) > 1 {
		topK := opts.TopK
		if s.rerankTopK > 0 {
			topK = minInt(topK, s.rerankTopK)
		}
		reranked, err := s.reranker.RerankHits(ctx, query, hits, topK)
		if err == nil {
			return reranked, nil
		}
	}
	return limitHits(hits, opts.TopK), nil
}

func dedupeHits(hits []Hit) []Hit {
	seen := make(map[string]bool, len(hits))
	out := hits[:0]
	for _, h := range hits {
		if h.ChunkID == "" {
			continue
		}
		if seen[h.ChunkID] {
			continue
		}
		seen[h.ChunkID] = true
		out = append(out, h)
	}
	return out
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
		h := Hit{ChunkID: r.ID, Score: r.Score, VectorScore: r.Score}
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
