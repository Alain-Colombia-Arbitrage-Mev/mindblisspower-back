package supportkb

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestReranker_ReordenaHitsYConservaVectorScore(t *testing.T) {
	var gotModel string
	var gotTopN int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer key" {
			t.Fatalf("authorization header incorrecto: %q", r.Header.Get("Authorization"))
		}
		var req rerankRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatal(err)
		}
		gotModel = req.Model
		gotTopN = req.TopN
		if len(req.Documents) != 2 {
			t.Fatalf("esperaba 2 docs, got %d", len(req.Documents))
		}
		json.NewEncoder(w).Encode(rerankResponse{
			Results: []struct {
				Index          int     `json:"index"`
				RelevanceScore float64 `json:"relevance_score"`
			}{
				{Index: 1, RelevanceScore: 0.98},
				{Index: 0, RelevanceScore: 0.12},
			},
		})
	}))
	defer srv.Close()

	r := NewReranker("key", srv.URL, "cohere/rerank-4-pro")
	hits, err := r.RerankHits(context.Background(), "retiros", []Hit{
		{ChunkID: "a", Titulo: "A", Texto: "menos relevante", Score: 0.90},
		{ChunkID: "b", Titulo: "B", Texto: "más relevante", Score: 0.50},
	}, 2)
	if err != nil {
		t.Fatal(err)
	}
	if gotModel != "cohere/rerank-4-pro" || gotTopN != 2 {
		t.Fatalf("request incorrecto: model=%q top_n=%d", gotModel, gotTopN)
	}
	if hits[0].ChunkID != "b" {
		t.Fatalf("rerank no reordenó: %+v", hits)
	}
	if hits[0].Score != 0.98 || hits[0].RerankScore != 0.98 || hits[0].VectorScore != 0.50 {
		t.Fatalf("scores incorrectos: %+v", hits[0])
	}
}

func TestReranker_FallbackSiRespuestaSinResultados(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode(rerankResponse{})
	}))
	defer srv.Close()

	r := NewReranker("key", srv.URL, "cohere/rerank-4-pro")
	hits, err := r.RerankHits(context.Background(), "retiros", []Hit{
		{ChunkID: "a", Score: 0.90},
		{ChunkID: "b", Score: 0.50},
	}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 || hits[0].ChunkID != "a" {
		t.Fatalf("fallback debía conservar orden vectorial limitado: %+v", hits)
	}
}
