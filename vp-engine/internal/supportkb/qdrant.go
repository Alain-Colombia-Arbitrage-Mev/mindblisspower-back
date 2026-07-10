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

// Qdrant es un cliente mínimo sobre la REST API (sin SDK: son 4 endpoints y
// evita otra dependencia en go.mod). El índice es DERIVADO: cualquier
// inconsistencia se resuelve con --rebuild desde Postgres.
type Qdrant struct {
	baseURL    string
	apiKey     string
	collection string
	http       *http.Client
}

func NewQdrant(baseURL, apiKey, collection string) *Qdrant {
	return &Qdrant{
		baseURL:    baseURL,
		apiKey:     apiKey,
		collection: collection,
		http:       &http.Client{Timeout: 30 * time.Second},
	}
}

// EnsureCollection crea la colección si no existe y valida que las dims de
// una existente coincidan con EmbedDims — un mismatch significa que alguien
// cambió el modelo sin rebuild y hay que frenar en seco.
func (q *Qdrant) EnsureCollection(ctx context.Context) error {
	exists, err := q.validateDims(ctx)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}

	// No existe: crearla con payload indexes para el filtrado de alta carga
	// (filterable HNSW — la razón por la que elegimos Qdrant sobre pgvector).
	create := map[string]any{
		"vectors": map[string]any{"size": EmbedDims, "distance": "Cosine"},
	}
	if _, err := q.do(ctx, http.MethodPut, "/collections/"+q.collection, create, nil); err != nil {
		// 409 = carrera benigna al boot: otro proceso (indexer vs vp-support)
		// creó la colección entre el GET y este PUT. El ganador también crea
		// los payload indexes; aquí solo validamos dims de la ganadora.
		if strings.Contains(err.Error(), "status 409") {
			_, verr := q.validateDims(ctx)
			return verr
		}
		return fmt.Errorf("crear colección: %w", err)
	}
	for _, field := range []string{"doc_id", "categoria", "lang", "rol_visible"} {
		idx := map[string]any{"field_name": field, "field_schema": "keyword"}
		if _, err := q.do(ctx, http.MethodPut, "/collections/"+q.collection+"/index", idx, nil); err != nil {
			return fmt.Errorf("payload index %s: %w", field, err)
		}
	}
	return nil
}

// validateDims consulta la colección: (false, nil) si no existe; error si
// existe con dims distintas a las del modelo (requiere --rebuild).
func (q *Qdrant) validateDims(ctx context.Context) (bool, error) {
	var info struct {
		Result struct {
			Config struct {
				Params struct {
					Vectors struct {
						Size int `json:"size"`
					} `json:"vectors"`
				} `json:"params"`
			} `json:"config"`
		} `json:"result"`
	}
	status, err := q.do(ctx, http.MethodGet, "/collections/"+q.collection, nil, &info)
	if err != nil {
		return false, err
	}
	if status != http.StatusOK {
		return false, nil
	}
	if got := info.Result.Config.Params.Vectors.Size; got != EmbedDims {
		return true, fmt.Errorf("colección %q tiene %d dims, el modelo %s produce %d — requiere --rebuild", q.collection, got, EmbedModel, EmbedDims)
	}
	return true, nil
}

// DropCollection elimina la colección (solo para --rebuild).
func (q *Qdrant) DropCollection(ctx context.Context) error {
	_, err := q.do(ctx, http.MethodDelete, "/collections/"+q.collection, nil, nil)
	return err
}

// Point es un chunk embebido con su payload de filtrado. El texto viaja en el
// payload para que el bot responda con un solo round-trip; Postgres sigue
// siendo el canónico.
type Point struct {
	ID      string         `json:"id"` // uuid del chunk
	Vector  []float32      `json:"vector"`
	Payload map[string]any `json:"payload"`
}

func (q *Qdrant) Upsert(ctx context.Context, points []Point) error {
	if len(points) == 0 {
		return nil
	}
	body := map[string]any{"points": points}
	_, err := q.do(ctx, http.MethodPut, "/collections/"+q.collection+"/points?wait=true", body, nil)
	return err
}

// DeleteByDoc purga todos los puntos de un documento (doc desactivado).
func (q *Qdrant) DeleteByDoc(ctx context.Context, docID string) error {
	body := map[string]any{
		"filter": map[string]any{
			"must": []map[string]any{
				{"key": "doc_id", "match": map[string]any{"value": docID}},
			},
		},
	}
	_, err := q.do(ctx, http.MethodPost, "/collections/"+q.collection+"/points/delete?wait=true", body, nil)
	return err
}

func (q *Qdrant) do(ctx context.Context, method, path string, body, out any) (int, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, q.baseURL+path, rd)
	if err != nil {
		return 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if q.apiKey != "" {
		req.Header.Set("api-key", q.apiKey)
	}

	resp, err := q.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	// GET de colección inexistente devuelve 404: el caller decide.
	if resp.StatusCode == http.StatusNotFound && method == http.MethodGet {
		io.Copy(io.Discard, resp.Body)
		return resp.StatusCode, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return resp.StatusCode, fmt.Errorf("qdrant %s %s: status %d: %s", method, path, resp.StatusCode, b)
	}
	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			return resp.StatusCode, err
		}
	}
	return resp.StatusCode, nil
}
