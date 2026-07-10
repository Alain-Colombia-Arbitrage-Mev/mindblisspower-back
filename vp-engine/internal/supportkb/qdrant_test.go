package supportkb

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// collectionInfo arma la respuesta GET /collections/<n> con las dims dadas.
func collectionInfo(dims int) map[string]any {
	return map[string]any{
		"result": map[string]any{
			"config": map[string]any{
				"params": map[string]any{
					"vectors": map[string]any{"size": dims},
				},
			},
		},
	}
}

func TestEnsureCollection_Carrera409EsBenigna(t *testing.T) {
	// Simula al perdedor de la carrera de boot: el primer GET dice "no existe",
	// el PUT devuelve 409 (el otro proceso la creó en medio), el re-GET la ve
	// con dims correctas. EnsureCollection debe devolver nil, no error.
	gets := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/collections/kb":
			gets++
			if gets == 1 {
				http.NotFound(w, r)
				return
			}
			json.NewEncoder(w).Encode(collectionInfo(EmbedDims))
		case r.Method == http.MethodPut && r.URL.Path == "/collections/kb":
			w.WriteHeader(http.StatusConflict)
			json.NewEncoder(w).Encode(map[string]any{"status": map[string]any{"error": "Collection `kb` already exists!"}})
		default:
			t.Errorf("request inesperado tras el 409: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	qd := NewQdrant(srv.URL, "", "kb")
	if err := qd.EnsureCollection(context.Background()); err != nil {
		t.Fatalf("409 de carrera debía ser benigno, got: %v", err)
	}
	if gets != 2 {
		t.Fatalf("esperaba re-GET de validación tras el 409, gets=%d", gets)
	}
}

func TestEnsureCollection_DimsIncorrectasExigeRebuild(t *testing.T) {
	// Colección existente con dims de otro modelo ⇒ error que exige --rebuild,
	// tanto en el camino directo como tras un 409.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(collectionInfo(768))
	}))
	defer srv.Close()

	qd := NewQdrant(srv.URL, "", "kb")
	err := qd.EnsureCollection(context.Background())
	if err == nil || !strings.Contains(err.Error(), "--rebuild") {
		t.Fatalf("dims incorrectas debía exigir --rebuild, got: %v", err)
	}
}
