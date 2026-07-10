package supportkb

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Document es el documento canónico de la KB (Postgres = fuente de verdad).
type Document struct {
	ID         string // vacío ⇒ insert (la DB genera el uuid)
	Titulo     string
	Categoria  string
	Lang       string // default "es"
	RolVisible string // public | member | admin (default member)
	Body       string
}

// UpsertDocument guarda el documento y regenera sus chunks en UNA transacción:
// el doc nunca queda con chunks a medias. El chunking corre aquí (no en el
// indexer) para que kb_chunks siempre refleje el body actual; el indexer solo
// decide QUÉ re-embeber comparando checksums vía el trigger de updated_at.
// Devuelve el id del documento.
func UpsertDocument(ctx context.Context, pool *pgxpool.Pool, d Document) (string, error) {
	if d.Lang == "" {
		d.Lang = "es"
	}
	if d.RolVisible == "" {
		d.RolVisible = "member"
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)

	var docID string
	if d.ID == "" {
		err = tx.QueryRow(ctx, `
			INSERT INTO support.kb_documents (titulo, categoria, lang, rol_visible, body)
			VALUES ($1, $2, $3, $4::support.kb_visibility, $5)
			RETURNING id`, d.Titulo, d.Categoria, d.Lang, d.RolVisible, d.Body).Scan(&docID)
	} else {
		docID = d.ID
		var found bool
		err = tx.QueryRow(ctx, `
			UPDATE support.kb_documents
			SET titulo = $2, categoria = $3, lang = $4,
			    rol_visible = $5::support.kb_visibility, body = $6,
			    version = version + 1, activo = true
			WHERE id = $1
			RETURNING true`, docID, d.Titulo, d.Categoria, d.Lang, d.RolVisible, d.Body).Scan(&found)
	}
	if err != nil {
		return "", fmt.Errorf("upsert kb_document: %w", err)
	}

	// Regenerar chunks: delete+insert es lo simple y correcto — el checksum
	// por chunk hace que el indexer solo re-embeba los que cambiaron de
	// contenido... solo si el id se conserva. Como regeneramos ids, TODO doc
	// editado se re-embebe completo. Aceptado: los docs son pequeños y la
	// edición es poco frecuente; la simplicidad gana.
	if _, err := tx.Exec(ctx, `DELETE FROM support.kb_chunks WHERE doc_id = $1`, docID); err != nil {
		return "", err
	}
	for _, c := range ChunkBody(d.Body) {
		if _, err := tx.Exec(ctx, `
			INSERT INTO support.kb_chunks (doc_id, ord, texto, checksum)
			VALUES ($1, $2, $3, $4)`, docID, c.Ord, c.Texto, c.Checksum); err != nil {
			return "", fmt.Errorf("insert kb_chunk ord=%d: %w", c.Ord, err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return docID, nil
}

// DeactivateDocument marca el doc como inactivo; el indexer purga sus puntos
// de Qdrant en la siguiente pasada.
func DeactivateDocument(ctx context.Context, pool *pgxpool.Pool, docID string) error {
	_, err := pool.Exec(ctx, `
		UPDATE support.kb_documents SET activo = false WHERE id = $1`, docID)
	return err
}
