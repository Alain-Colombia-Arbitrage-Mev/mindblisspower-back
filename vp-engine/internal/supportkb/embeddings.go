package supportkb

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Embedder llama al endpoint de embeddings de OpenRouter (API compatible
// OpenAI) con el modelo FIJO multilingual-e5-large. Los prefijos e5 van
// cableados aquí — sin "passage: "/"query: " el recall del modelo se degrada
// en silencio, así que ningún caller debe poder omitirlos.
type Embedder struct {
	apiKey string
	url    string
	http   *http.Client
}

func NewEmbedder(apiKey, url string) *Embedder {
	return &Embedder{
		apiKey: apiKey,
		url:    url,
		http:   &http.Client{Timeout: 60 * time.Second},
	}
}

type embRequest struct {
	Model string   `json:"model"`
	Input []string `json:"input"`
}

type embResponse struct {
	Data []struct {
		Index     int       `json:"index"`
		Embedding []float32 `json:"embedding"`
	} `json:"data"`
	Usage struct {
		TotalTokens int `json:"total_tokens"`
	} `json:"usage"`
}

// EmbedPassages vectoriza chunks de documentos (prefijo "passage: ").
func (e *Embedder) EmbedPassages(ctx context.Context, texts []string) ([][]float32, error) {
	pref := make([]string, len(texts))
	for i, t := range texts {
		pref[i] = "passage: " + t
	}
	return e.embed(ctx, pref)
}

// EmbedQuery vectoriza la pregunta del usuario (prefijo "query: ").
func (e *Embedder) EmbedQuery(ctx context.Context, q string) ([]float32, error) {
	vecs, err := e.embed(ctx, []string{"query: " + q})
	if err != nil {
		return nil, err
	}
	return vecs[0], nil
}

// embed hace la llamada con retry exponencial en 429/5xx (3 intentos).
func (e *Embedder) embed(ctx context.Context, texts []string) ([][]float32, error) {
	body, err := json.Marshal(embRequest{Model: EmbedModel, Input: texts})
	if err != nil {
		return nil, err
	}

	var lastErr error
	for attempt, wait := 0, time.Second; attempt < 3; attempt, wait = attempt+1, wait*4 {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(wait):
			}
		}

		req, rerr := http.NewRequestWithContext(ctx, http.MethodPost, e.url, bytes.NewReader(body))
		if rerr != nil {
			return nil, rerr
		}
		req.Header.Set("Authorization", "Bearer "+e.apiKey)
		req.Header.Set("Content-Type", "application/json")

		resp, derr := e.http.Do(req)
		if derr != nil {
			lastErr = derr
			continue
		}

		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			lastErr = fmt.Errorf("openrouter embeddings: status %d (intento %d)", resp.StatusCode, attempt+1)
			continue
		}
		if resp.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
			resp.Body.Close()
			return nil, fmt.Errorf("openrouter embeddings: status %d: %s", resp.StatusCode, b)
		}

		var out embResponse
		err := json.NewDecoder(resp.Body).Decode(&out)
		resp.Body.Close()
		if err != nil {
			return nil, err
		}
		if len(out.Data) != len(texts) {
			return nil, fmt.Errorf("openrouter devolvió %d embeddings para %d textos", len(out.Data), len(texts))
		}

		vecs := make([][]float32, len(texts))
		for _, d := range out.Data {
			if len(d.Embedding) != EmbedDims {
				// Un modelo distinto respondió (¿fallback de OpenRouter?):
				// abortar antes de corromper el índice con dims incompatibles.
				return nil, fmt.Errorf("embedding con %d dims, esperaba %d — modelo incorrecto", len(d.Embedding), EmbedDims)
			}
			vecs[d.Index] = d.Embedding
		}
		return vecs, nil
	}
	return nil, fmt.Errorf("openrouter embeddings agotó reintentos: %w", lastErr)
}
