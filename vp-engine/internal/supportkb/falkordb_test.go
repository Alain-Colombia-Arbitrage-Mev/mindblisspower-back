package supportkb

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

func TestCypherWithParams_EscapaValores(t *testing.T) {
	q := cypherWithParams(map[string]any{
		"text":  "Línea 1\nO'Hara \\ soporte",
		"roles": []string{"public", "member"},
		"limit": 3,
	}, "MATCH (c) RETURN c LIMIT $limit")

	if !strings.HasPrefix(q, "CYPHER ") {
		t.Fatalf("query parametrizada esperada: %q", q)
	}
	if !strings.Contains(q, "text='Línea 1\\nO\\'Hara \\\\ soporte'") {
		t.Fatalf("texto no quedó escapado: %q", q)
	}
	if !strings.Contains(q, "roles=['public','member']") {
		t.Fatalf("lista no quedó serializada: %q", q)
	}
	if !strings.Contains(q, "limit=3") {
		t.Fatalf("entero no quedó serializado: %q", q)
	}
}

func TestGraphRows_ParseaRespuestaRedisGraph(t *testing.T) {
	raw := []any{
		[]any{"c.id", "c.doc_id", "d.title", "c.category", "c.ord", "c.text"},
		[]any{
			[]any{"chunk-1", "doc-1", "FAQ", "pagos", int64(2), []byte("texto")},
		},
		[]any{"Query internal execution time: 0.1 milliseconds"},
	}
	rows := graphRows(raw)
	if len(rows) != 1 {
		t.Fatalf("esperaba 1 fila, got %d", len(rows))
	}
	if graphString(rows[0][0]) != "chunk-1" || graphInt(rows[0][4]) != 2 || graphString(rows[0][5]) != "texto" {
		t.Fatalf("fila parseada incorrecta: %+v", rows[0])
	}
}

func TestFalkorDBE2E_SyncAndRelatedChunks(t *testing.T) {
	url := os.Getenv("KB_E2E_FALKOR_URL")
	if url == "" {
		t.Skip("KB_E2E_FALKOR_URL no definido; e2e FalkorDB omitido")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	graph, err := NewFalkorDB(url, "support_kb_e2e", 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer graph.Close()
	_ = graph.DeleteGraph(ctx)
	defer graph.DeleteGraph(context.Background())

	doc := "doc-1"
	chunks := []pendingChunk{
		{
			ID: "chunk-1", DocID: doc, Ord: 0, Titulo: "Pagos",
			Categoria: "pagos", Lang: "es", RolVisible: "member", Version: 1,
			Texto: "Como confirmar un pago exitoso.",
		},
		{
			ID: "chunk-2", DocID: doc, Ord: 1, Titulo: "Pagos",
			Categoria: "pagos", Lang: "es", RolVisible: "member", Version: 1,
			Texto: "Si el pago falla no se activa el arbol.",
		},
	}
	for _, c := range chunks {
		if err := graph.SyncChunk(ctx, c); err != nil {
			t.Fatalf("sync chunk: %v", err)
		}
	}

	related, err := graph.RelatedChunks(ctx, []Hit{{ChunkID: "chunk-1"}}, SearchOpts{
		Visibility: VisibilityFor("member"),
		Lang:       "es",
		TopK:       5,
	}, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(related) != 1 || related[0].ChunkID != "chunk-2" || related[0].GraphScore != 1 {
		t.Fatalf("related chunks incorrectos: %+v", related)
	}
}
