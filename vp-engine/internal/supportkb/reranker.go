package supportkb

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const rerankDocMaxChars = 12_000

// Reranker llama al endpoint /rerank de OpenRouter. Es una capa de precisión:
// Qdrant recupera candidatos rápido, el reranker decide el orden final.
type Reranker struct {
	apiKey string
	url    string
	model  string
	http   *http.Client
}

func NewReranker(apiKey, url, model string) *Reranker {
	return &Reranker{
		apiKey: apiKey,
		url:    url,
		model:  model,
		http:   &http.Client{Timeout: 30 * time.Second},
	}
}

type rerankRequest struct {
	Model     string         `json:"model"`
	Query     string         `json:"query"`
	Documents []rerankDoc    `json:"documents"`
	TopN      int            `json:"top_n"`
	Provider  map[string]any `json:"provider,omitempty"`
}

type rerankDoc struct {
	Text string `json:"text"`
}

type rerankResponse struct {
	Model   string `json:"model"`
	Results []struct {
		Index          int     `json:"index"`
		RelevanceScore float64 `json:"relevance_score"`
	} `json:"results"`
}

func (r *Reranker) Enabled() bool {
	return r != nil && r.apiKey != "" && r.url != "" && r.model != ""
}

func (r *Reranker) RerankHits(ctx context.Context, query string, hits []Hit, topN int) ([]Hit, error) {
	if !r.Enabled() || len(hits) == 0 {
		return limitHits(hits, topN), nil
	}
	if topN <= 0 || topN > len(hits) {
		topN = len(hits)
	}

	docs := make([]rerankDoc, len(hits))
	for i, h := range hits {
		docs[i] = rerankDoc{Text: rerankText(h)}
	}
	body, err := json.Marshal(rerankRequest{
		Model:     r.model,
		Query:     strings.TrimSpace(query),
		Documents: docs,
		TopN:      topN,
		Provider:  map[string]any{"allow_fallbacks": true},
	})
	if err != nil {
		return nil, err
	}

	var lastErr error
	for attempt, wait := 0, time.Second; attempt < 2; attempt, wait = attempt+1, wait*2 {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(wait):
			}
		}

		req, rerr := http.NewRequestWithContext(ctx, http.MethodPost, r.url, bytes.NewReader(body))
		if rerr != nil {
			return nil, rerr
		}
		req.Header.Set("Authorization", "Bearer "+r.apiKey)
		req.Header.Set("Content-Type", "application/json")

		resp, derr := r.http.Do(req)
		if derr != nil {
			lastErr = derr
			continue
		}
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			lastErr = fmt.Errorf("openrouter rerank: status %d", resp.StatusCode)
			continue
		}
		if resp.StatusCode != http.StatusOK {
			eb, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
			resp.Body.Close()
			return nil, fmt.Errorf("openrouter rerank: status %d: %s", resp.StatusCode, eb)
		}

		var out rerankResponse
		err := json.NewDecoder(resp.Body).Decode(&out)
		resp.Body.Close()
		if err != nil {
			return nil, err
		}

		ranked := make([]Hit, 0, minInt(topN, len(out.Results)))
		seen := make(map[int]bool, len(out.Results))
		for _, rr := range out.Results {
			if rr.Index < 0 || rr.Index >= len(hits) || seen[rr.Index] {
				continue
			}
			seen[rr.Index] = true
			h := hits[rr.Index]
			h.VectorScore = h.Score
			h.RerankScore = rr.RelevanceScore
			h.Score = rr.RelevanceScore
			ranked = append(ranked, h)
			if len(ranked) >= topN {
				break
			}
		}
		if len(ranked) == 0 {
			return limitHits(hits, topN), nil
		}
		return ranked, nil
	}
	return nil, fmt.Errorf("openrouter rerank agotó reintentos: %w", lastErr)
}

func rerankText(h Hit) string {
	var b strings.Builder
	if h.Titulo != "" {
		b.WriteString("Titulo: ")
		b.WriteString(h.Titulo)
		b.WriteByte('\n')
	}
	if h.Categoria != "" {
		b.WriteString("Categoria: ")
		b.WriteString(h.Categoria)
		b.WriteByte('\n')
	}
	b.WriteString("Contenido:\n")
	b.WriteString(h.Texto)
	out := b.String()
	if len(out) > rerankDocMaxChars {
		out = out[:rerankDocMaxChars]
	}
	return out
}

func limitHits(hits []Hit, topN int) []Hit {
	if topN <= 0 || len(hits) <= topN {
		return hits
	}
	return hits[:topN]
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
