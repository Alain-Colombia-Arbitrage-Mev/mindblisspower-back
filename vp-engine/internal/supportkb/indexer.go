package supportkb

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
)

// Indexer sincroniza support.kb_chunks → Qdrant. Idempotente y resumible:
// el estado vive en Postgres (embedded_at/embed_model por chunk), así que un
// crash a mitad de batch solo re-embebe ese batch.
type Indexer struct {
	pool   *pgxpool.Pool
	emb    *Embedder
	qd     *Qdrant
	batch  int
	logger zerolog.Logger
}

func NewIndexer(pool *pgxpool.Pool, emb *Embedder, qd *Qdrant, batch int, logger zerolog.Logger) *Indexer {
	return &Indexer{pool: pool, emb: emb, qd: qd, batch: batch, logger: logger}
}

type pendingChunk struct {
	ID         string
	DocID      string
	Ord        int
	Texto      string
	Titulo     string
	Categoria  string
	Lang       string
	RolVisible string
	Version    int
}

// RunOnce procesa una pasada completa: purga docs desactivados y embebe todos
// los chunks pendientes. Devuelve cuántos chunks indexó.
func (ix *Indexer) RunOnce(ctx context.Context) (int, error) {
	if err := ix.purgeInactive(ctx); err != nil {
		return 0, fmt.Errorf("purge docs inactivos: %w", err)
	}

	total := 0
	for {
		n, err := ix.indexBatch(ctx)
		if err != nil {
			return total, err
		}
		total += n
		if n < ix.batch { // no queda cola
			return total, nil
		}
	}
}

// Rebuild recrea la colección desde cero y re-embebe TODO (cambio de modelo,
// corrupción, o primer deploy). Postgres es la fuente: nada se pierde.
func (ix *Indexer) Rebuild(ctx context.Context) (int, error) {
	ix.logger.Warn().Str("model", EmbedModel).Int("dims", EmbedDims).Msg("REBUILD: recreando colección Qdrant")
	if err := ix.qd.DropCollection(ctx); err != nil {
		return 0, err
	}
	if err := ix.qd.EnsureCollection(ctx); err != nil {
		return 0, err
	}
	// Marcar todo como pendiente.
	if _, err := ix.pool.Exec(ctx, `UPDATE support.kb_chunks SET embedded_at = NULL`); err != nil {
		return 0, err
	}
	return ix.RunOnce(ctx)
}

// indexBatch toma hasta `batch` chunks pendientes, los embebe y los upserta.
func (ix *Indexer) indexBatch(ctx context.Context) (int, error) {
	rows, err := ix.pool.Query(ctx, `
		SELECT c.id, c.doc_id, c.ord, c.texto,
		       d.titulo, d.categoria, d.lang, d.rol_visible::text, d.version
		FROM support.kb_chunks c
		JOIN support.kb_documents d ON d.id = c.doc_id
		WHERE d.activo
		  AND (c.embedded_at IS NULL OR c.updated_at > c.embedded_at)
		ORDER BY c.updated_at
		LIMIT $1`, ix.batch)
	if err != nil {
		return 0, err
	}
	chunks, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (pendingChunk, error) {
		var c pendingChunk
		err := row.Scan(&c.ID, &c.DocID, &c.Ord, &c.Texto,
			&c.Titulo, &c.Categoria, &c.Lang, &c.RolVisible, &c.Version)
		return c, err
	})
	if err != nil {
		return 0, err
	}
	if len(chunks) == 0 {
		return 0, nil
	}

	// El título del doc va prepend en el texto embebido: da contexto al chunk
	// sin depender de que el chunker lo haya incluido.
	texts := make([]string, len(chunks))
	for i, c := range chunks {
		texts[i] = c.Titulo + "\n" + c.Texto
	}
	vecs, err := ix.emb.EmbedPassages(ctx, texts)
	if err != nil {
		return 0, fmt.Errorf("embed batch: %w", err)
	}

	points := make([]Point, len(chunks))
	for i, c := range chunks {
		points[i] = Point{
			ID:     c.ID,
			Vector: vecs[i],
			Payload: map[string]any{
				"doc_id":      c.DocID,
				"ord":         c.Ord,
				"titulo":      c.Titulo,
				"categoria":   c.Categoria,
				"lang":        c.Lang,
				"rol_visible": c.RolVisible,
				"version":     c.Version,
				"texto":       c.Texto,
				"embed_model": EmbedModel,
			},
		}
	}
	if err := ix.qd.Upsert(ctx, points); err != nil {
		return 0, fmt.Errorf("qdrant upsert: %w", err)
	}

	// Marcar indexados. now() > updated_at de estos chunks; si alguien editó
	// el chunk ENTRE el SELECT y este UPDATE, updated_at quedará > embedded_at
	// solo si el trigger corrió después — ventana mínima aceptada (la próxima
	// edición lo recoge; el índice es derivado, no crítico).
	ids := make([]string, len(chunks))
	for i, c := range chunks {
		ids[i] = c.ID
	}
	if _, err := ix.pool.Exec(ctx, `
		UPDATE support.kb_chunks
		SET embedded_at = now(), embed_model = $2
		WHERE id = ANY($1)`, ids, EmbedModel); err != nil {
		return 0, err
	}

	ix.logger.Info().Int("chunks", len(chunks)).Msg("batch indexado")
	return len(chunks), nil
}

// purgeInactive elimina de Qdrant los puntos de documentos desactivados y
// resetea su embedded_at (si se reactivan, se re-embeben).
func (ix *Indexer) purgeInactive(ctx context.Context) error {
	rows, err := ix.pool.Query(ctx, `
		SELECT DISTINCT d.id
		FROM support.kb_documents d
		JOIN support.kb_chunks c ON c.doc_id = d.id
		WHERE NOT d.activo AND c.embedded_at IS NOT NULL`)
	if err != nil {
		return err
	}
	docIDs, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	for _, id := range docIDs {
		if err := ix.qd.DeleteByDoc(ctx, id); err != nil {
			return err
		}
		if _, err := ix.pool.Exec(ctx, `
			UPDATE support.kb_chunks SET embedded_at = NULL, embed_model = NULL
			WHERE doc_id = $1`, id); err != nil {
			return err
		}
		ix.logger.Info().Str("doc_id", id).Msg("doc inactivo purgado de Qdrant")
	}
	return nil
}

// Loop corre RunOnce cada interval hasta que el contexto muera. Un error de
// pasada se loguea y se reintenta al siguiente tick — el indexer nunca cae
// por un fallo transitorio de OpenRouter/Qdrant.
func (ix *Indexer) Loop(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if n, err := ix.RunOnce(ctx); err != nil {
			ix.logger.Error().Err(err).Msg("pasada de indexación falló (reintenta al próximo tick)")
		} else if n > 0 {
			ix.logger.Info().Int("chunks", n).Msg("pasada completa")
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
