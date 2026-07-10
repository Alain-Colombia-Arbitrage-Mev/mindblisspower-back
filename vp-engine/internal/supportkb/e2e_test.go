package supportkb

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
)

// E2E contra Postgres dev + Qdrant local REALES, con OpenRouter mockeado
// (embeddings determinísticos por keyword — sin gastar API ni exponer la key).
//
// Pre-req:
//   docker compose -f dev/docker-compose.yml up -d && bash dev/apply-schema.sh
//   docker run -d --rm --name kb-test-qdrant -p 127.0.0.1:6333:6333 qdrant/qdrant:v1.15.1
// Run:
//   KB_E2E_DATABASE_URL=postgres://postgres:devpass@localhost:55432/vicionpower \
//   KB_E2E_QDRANT_URL=http://localhost:6333 go test ./internal/supportkb/ -run TestE2E -v
func TestE2E_IndexAndSearch(t *testing.T) {
	dbURL := os.Getenv("KB_E2E_DATABASE_URL")
	qdURL := os.Getenv("KB_E2E_QDRANT_URL")
	if dbURL == "" || qdURL == "" {
		t.Skip("KB_E2E_DATABASE_URL / KB_E2E_QDRANT_URL no definidos; e2e omitido")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// --- Mock OpenRouter: vector según keyword, dims reales (1024) ----------
	// "retiro" → eje 0, "rango" → eje 1, resto → eje 2. Así la query sobre
	// retiros SOLO se acerca (coseno) a los chunks que hablan de retiros.
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Model string   `json:"model"`
			Input []string `json:"input"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		if req.Model != EmbedModel {
			http.Error(w, "modelo inesperado: "+req.Model, 400)
			return
		}
		type item struct {
			Index     int       `json:"index"`
			Embedding []float32 `json:"embedding"`
		}
		out := struct {
			Data []item `json:"data"`
		}{}
		for i, txt := range req.Input {
			// El cliente DEBE haber puesto el prefijo e5.
			if !strings.HasPrefix(txt, "passage: ") && !strings.HasPrefix(txt, "query: ") {
				http.Error(w, "input sin prefijo e5: "+txt[:min(40, len(txt))], 400)
				return
			}
			vec := make([]float32, EmbedDims)
			low := strings.ToLower(txt)
			switch {
			case strings.Contains(low, "retiro"):
				vec[0] = 1
			case strings.Contains(low, "rango"):
				vec[1] = 1
			default:
				vec[2] = 1
			}
			out.Data = append(out.Data, item{Index: i, Embedding: vec})
		}
		json.NewEncoder(w).Encode(out)
	}))
	defer mock.Close()

	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("conectar dev DB: %v", err)
	}
	defer pool.Close()

	// Estado limpio en ambos lados (colección de test aparte).
	if _, err := pool.Exec(ctx, `DELETE FROM support.kb_documents`); err != nil {
		t.Fatalf("limpiar kb_documents: %v", err)
	}
	emb := NewEmbedder("test-key", mock.URL)
	qd := NewQdrant(qdURL, "", "kb_e2e_test")
	_ = qd.DropCollection(ctx)
	if err := qd.EnsureCollection(ctx); err != nil {
		t.Fatalf("EnsureCollection: %v", err)
	}
	defer qd.DropCollection(ctx)

	// --- 1. Alta de documentos vía el mismo camino que usará la app ---------
	memberDoc, err := UpsertDocument(ctx, pool, Document{
		Titulo: "Política de retiros", Categoria: "retiros",
		Body: "# Retiros\n\nLos retiros se solicitan desde la wallet USD y se pagan el día 1 del mes.",
	})
	if err != nil {
		t.Fatalf("UpsertDocument member: %v", err)
	}
	adminDoc, err := UpsertDocument(ctx, pool, Document{
		Titulo: "Runbook interno de retiros", Categoria: "retiros", RolVisible: "admin",
		Body: "# Retiros (interno)\n\nPara aprobar retiros usar el panel four-eyes.",
	})
	if err != nil {
		t.Fatalf("UpsertDocument admin: %v", err)
	}

	// --- 2. Indexación ------------------------------------------------------
	ix := NewIndexer(pool, emb, qd, 128, zerolog.Nop())
	n, err := ix.RunOnce(ctx)
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if n < 2 {
		t.Fatalf("esperaba ≥2 chunks indexados, got %d", n)
	}
	var pending int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM support.kb_chunks
		WHERE embedded_at IS NULL OR updated_at > embedded_at`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 0 {
		t.Fatalf("quedaron %d chunks pendientes tras RunOnce", pending)
	}

	// --- 3. Búsqueda como MEMBER: encuentra retiros, NO ve el doc admin -----
	sr := NewSearcher(emb, qd)
	hits, err := sr.Search(ctx, "¿cómo hago un retiro?", SearchOpts{
		Visibility: VisibilityFor("member"), TopK: 5,
	})
	if err != nil {
		t.Fatalf("Search member: %v", err)
	}
	if len(hits) == 0 {
		t.Fatal("member no obtuvo hits")
	}
	for _, h := range hits {
		if h.DocID == adminDoc {
			t.Fatalf("FUGA: member recibió chunk del doc admin (%s)", h.Titulo)
		}
	}
	if hits[0].DocID != memberDoc {
		t.Fatalf("top hit no es la política de retiros: %q", hits[0].Titulo)
	}

	// Como ADMIN sí aparece el runbook.
	hits, err = sr.Search(ctx, "¿cómo hago un retiro?", SearchOpts{
		Visibility: VisibilityFor("admin"), TopK: 5,
	})
	if err != nil {
		t.Fatalf("Search admin: %v", err)
	}
	seenAdmin := false
	for _, h := range hits {
		if h.DocID == adminDoc {
			seenAdmin = true
		}
	}
	if !seenAdmin {
		t.Fatal("admin no vio el runbook interno")
	}

	// --- 4. Desactivar doc ⇒ purga de Qdrant en la siguiente pasada ---------
	if err := DeactivateDocument(ctx, pool, memberDoc); err != nil {
		t.Fatal(err)
	}
	if _, err := ix.RunOnce(ctx); err != nil {
		t.Fatalf("RunOnce post-deactivate: %v", err)
	}
	hits, err = sr.Search(ctx, "¿cómo hago un retiro?", SearchOpts{
		Visibility: VisibilityFor("member"), TopK: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, h := range hits {
		if h.DocID == memberDoc {
			t.Fatalf("doc desactivado sigue en el índice: %q", h.Titulo)
		}
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
