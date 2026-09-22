//go:build integration || !short

package payments

import (
	"context"
	"testing"
)

// Requiere Docker (testcontainers). Correr: go test ./internal/payments/ -run Integration
func TestCommsSchema_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables WHERE table_schema='comms'`).Scan(&n); err != nil {
		t.Fatalf("query: %v", err)
	}
	if n != 4 {
		t.Fatalf("comms tables = %d, want 4", n)
	}
	var ok bool
	if err := pool.QueryRow(ctx, `SELECT 'comms_campaign'::mlm.approval_operation_type IS NOT NULL`).Scan(&ok); err != nil || !ok {
		t.Fatalf("enum comms_campaign missing: %v", err)
	}
	var id int64
	err := pool.QueryRow(ctx, `INSERT INTO comms.campaign (subject, body_markdown, segment, created_by)
		VALUES ('Hola', 'Cuerpo de prueba largo', '{"status":["active"]}', 'admin@x.com') RETURNING id`).Scan(&id)
	if err != nil || id == 0 {
		t.Fatalf("insert campaign: %v", err)
	}
}
