package supportkb

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const defaultFalkorGraph = "support_kb"

// FalkorDB mantiene memoria de relaciones para GraphRAG. Es un índice
// DERIVADO: Qdrant/Postgres siguen siendo suficientes para responder si el
// grafo no está disponible.
type FalkorDB struct {
	graph     string
	timeoutMS int64
	client    *redis.Client
}

func NewFalkorDB(rawURL, graph string, timeout time.Duration) (*FalkorDB, error) {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return nil, nil
	}
	opt, err := redis.ParseURL(rawURL)
	if err != nil {
		return nil, fmt.Errorf("parse FALKORDB_URL: %w", err)
	}
	if graph = strings.TrimSpace(graph); graph == "" {
		graph = defaultFalkorGraph
	}
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	return &FalkorDB{
		graph:     graph,
		timeoutMS: timeout.Milliseconds(),
		client:    redis.NewClient(opt),
	}, nil
}

func (f *FalkorDB) Enabled() bool {
	return f != nil && f.client != nil && f.graph != ""
}

func (f *FalkorDB) Close() error {
	if !f.Enabled() {
		return nil
	}
	return f.client.Close()
}

func (f *FalkorDB) Ping(ctx context.Context) error {
	if !f.Enabled() {
		return nil
	}
	return f.client.Ping(ctx).Err()
}

func (f *FalkorDB) DeleteGraph(ctx context.Context) error {
	if !f.Enabled() {
		return nil
	}
	err := f.client.Do(ctx, "GRAPH.DELETE", f.graph).Err()
	if err != nil && strings.Contains(strings.ToLower(err.Error()), "not found") {
		return nil
	}
	return err
}

func (f *FalkorDB) DeleteDoc(ctx context.Context, docID string) error {
	if !f.Enabled() || strings.TrimSpace(docID) == "" {
		return nil
	}
	query := cypherWithParams(map[string]any{"doc_id": docID}, `
		MATCH (d:Document {id: $doc_id})
		OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:Chunk)
		DETACH DELETE d, c`)
	_, err := f.graphQuery(ctx, false, query)
	return err
}

func (f *FalkorDB) SyncChunk(ctx context.Context, c pendingChunk) error {
	if !f.Enabled() {
		return nil
	}
	query := cypherWithParams(map[string]any{
		"doc_id":      c.DocID,
		"chunk_id":    c.ID,
		"title":       c.Titulo,
		"category":    c.Categoria,
		"lang":        c.Lang,
		"role":        c.RolVisible,
		"version":     c.Version,
		"ord":         c.Ord,
		"text":        c.Texto,
		"embed_model": EmbedModel,
	}, `
		MERGE (d:Document {id: $doc_id})
		SET d.title = $title,
		    d.category = $category,
		    d.lang = $lang,
		    d.rol_visible = $role,
		    d.version = $version,
		    d.active = true
		MERGE (c:Chunk {id: $chunk_id})
		SET c.doc_id = $doc_id,
		    c.ord = $ord,
		    c.text = $text,
		    c.category = $category,
		    c.lang = $lang,
		    c.rol_visible = $role,
		    c.embed_model = $embed_model
		MERGE (cat:Category {name: $category})
		MERGE (d)-[:HAS_CHUNK]->(c)
		MERGE (d)-[:IN_CATEGORY]->(cat)
		MERGE (c)-[:IN_CATEGORY]->(cat)`)
	_, err := f.graphQuery(ctx, false, query)
	return err
}

func (f *FalkorDB) RelatedChunks(ctx context.Context, seeds []Hit, opts SearchOpts, limit int) ([]Hit, error) {
	if !f.Enabled() || len(seeds) == 0 || limit <= 0 || len(opts.Visibility) == 0 {
		return nil, nil
	}
	seedIDs := make([]string, 0, len(seeds))
	seen := make(map[string]bool, len(seeds))
	for _, h := range seeds {
		if h.ChunkID == "" || seen[h.ChunkID] {
			continue
		}
		seen[h.ChunkID] = true
		seedIDs = append(seedIDs, h.ChunkID)
	}
	if len(seedIDs) == 0 {
		return nil, nil
	}

	params := map[string]any{
		"seed_ids": seedIDs,
		"roles":    opts.Visibility,
		"limit":    limit,
	}
	langFilter := ""
	if opts.Lang != "" {
		params["lang"] = opts.Lang
		langFilter = "AND c.lang = $lang"
	}
	categoryFilter := ""
	if opts.Categoria != "" {
		params["category"] = opts.Categoria
		categoryFilter = "AND c.category = $category"
	}
	query := cypherWithParams(params, `
		MATCH (seed:Chunk)
		WHERE seed.id IN $seed_ids
		MATCH (seed)<-[:HAS_CHUNK]-(d:Document)-[:HAS_CHUNK]->(c:Chunk)
		WHERE NOT (c.id IN $seed_ids)
		  AND c.rol_visible IN $roles
		  `+langFilter+`
		  `+categoryFilter+`
		RETURN c.id, c.doc_id, d.title, c.category, c.ord, c.text
		ORDER BY d.version DESC, c.ord
		LIMIT $limit`)

	raw, err := f.graphQuery(ctx, true, query)
	if err != nil {
		return nil, err
	}
	rows := graphRows(raw)
	hits := make([]Hit, 0, len(rows))
	for _, row := range rows {
		if len(row) < 6 {
			continue
		}
		chunkID := graphString(row[0])
		if chunkID == "" || seen[chunkID] {
			continue
		}
		seen[chunkID] = true
		hits = append(hits, Hit{
			ChunkID:    chunkID,
			DocID:      graphString(row[1]),
			Titulo:     graphString(row[2]),
			Categoria:  graphString(row[3]),
			Ord:        graphInt(row[4]),
			Texto:      graphString(row[5]),
			Score:      0,
			GraphScore: 1,
		})
	}
	return hits, nil
}

func (f *FalkorDB) graphQuery(ctx context.Context, readOnly bool, query string) (any, error) {
	cmd := "GRAPH.QUERY"
	if readOnly {
		cmd = "GRAPH.RO_QUERY"
	}
	return f.client.Do(ctx, cmd, f.graph, query, "TIMEOUT", f.timeoutMS).Result()
}

func cypherWithParams(params map[string]any, query string) string {
	var b strings.Builder
	if len(params) > 0 {
		b.WriteString("CYPHER ")
		keys := make([]string, 0, len(params))
		for k := range params {
			keys = append(keys, k)
		}
		sortStrings(keys)
		for _, k := range keys {
			b.WriteString(k)
			b.WriteByte('=')
			b.WriteString(cypherLiteral(params[k]))
			b.WriteByte(' ')
		}
	}
	b.WriteString(strings.TrimSpace(query))
	return b.String()
}

func cypherLiteral(v any) string {
	switch t := v.(type) {
	case string:
		return "'" + cypherEscape(t) + "'"
	case []string:
		parts := make([]string, len(t))
		for i, s := range t {
			parts[i] = "'" + cypherEscape(s) + "'"
		}
		return "[" + strings.Join(parts, ",") + "]"
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	case bool:
		if t {
			return "true"
		}
		return "false"
	default:
		return "'" + cypherEscape(fmt.Sprint(t)) + "'"
	}
}

func cypherEscape(s string) string {
	repl := strings.NewReplacer(
		`\`, `\\`,
		`'`, `\'`,
		"\r", `\r`,
		"\n", `\n`,
		"\t", `\t`,
	)
	return repl.Replace(s)
}

func graphRows(raw any) [][]any {
	top, ok := raw.([]any)
	if !ok || len(top) < 2 {
		return nil
	}
	rowVals, ok := toAnySlice(top[1])
	if !ok {
		return nil
	}
	rows := make([][]any, 0, len(rowVals))
	for _, r := range rowVals {
		row, ok := toAnySlice(r)
		if !ok {
			continue
		}
		rows = append(rows, row)
	}
	return rows
}

func toAnySlice(v any) ([]any, bool) {
	switch s := v.(type) {
	case []any:
		return s, true
	default:
		return nil, false
	}
}

func graphString(v any) string {
	switch s := v.(type) {
	case string:
		return s
	case []byte:
		return string(s)
	default:
		return fmt.Sprint(v)
	}
}

func graphInt(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	case string:
		i, _ := strconv.Atoi(n)
		return i
	case []byte:
		i, _ := strconv.Atoi(string(n))
		return i
	default:
		return 0
	}
}

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}
