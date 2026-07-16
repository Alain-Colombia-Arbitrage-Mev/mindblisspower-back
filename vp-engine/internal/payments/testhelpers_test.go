package payments

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

// pgContainer arranca Postgres (Timescale pg17) y aplica el schema mlm + el de
// payments. Requiere Docker (igual que los tests del motor). Sin Docker, estos
// tests fallan al arrancar — correrlos en CI/staging.
func pgContainer(t *testing.T) (*pgxpool.Pool, func()) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	req := testcontainers.ContainerRequest{
		Image: "timescale/timescaledb:latest-pg17",
		Env: map[string]string{
			"POSTGRES_PASSWORD": "test",
			"POSTGRES_DB":       "vicionpower_test",
			"POSTGRES_USER":     "postgres",
		},
		ExposedPorts: []string{"5432/tcp"},
		WaitingFor: wait.ForLog("database system is ready to accept connections").
			WithOccurrence(2).WithStartupTimeout(2 * time.Minute),
	}
	c, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: req, Started: true,
	})
	if err != nil {
		t.Fatalf("start container (¿Docker corriendo?): %v", err)
	}
	host, _ := c.Host(ctx)
	port, _ := c.MappedPort(ctx, "5432")
	dsn := fmt.Sprintf("postgres://postgres:test@%s:%s/vicionpower_test?sslmode=disable", host, port.Port())

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		_ = c.Terminate(ctx)
		t.Fatalf("connect: %v", err)
	}

	for _, r := range []string{"engine_write", "engine_read"} {
		if _, err := pool.Exec(ctx,
			fmt.Sprintf(`DO $$ BEGIN CREATE ROLE %s NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`, r)); err != nil {
			_ = c.Terminate(ctx)
			t.Fatalf("create role %s: %v", r, err)
		}
	}

	root := findRepoRoot(t)
	for _, f := range []string{
		"_meta/schema_mlm.sql",
		"_meta/schema_governance.sql",
		"_meta/migration/05_timescaledb.sql",
		"_meta/schema_payouts.sql",
		"_meta/schema_payouts_v1.1.sql",
		"_meta/schema_payouts_v1.2.sql",
		"_meta/schema_ranks.sql",
		"_meta/schema_payouts_v1.3.sql",
		"_meta/migration/30_payments.sql",
		"_meta/migration/41_kyc_documents.sql",
		"_meta/migration/44_receipt_and_verify.sql",
		"_meta/migration/45_cart_reminders.sql",
		"_meta/migration/46_kyc_ocr.sql",
	} {
		b, err := os.ReadFile(filepath.Join(root, f))
		if err != nil {
			t.Fatalf("read %s: %v", f, err)
		}
		if err := applySchema(ctx, pool, stripPsqlMeta(string(b))); err != nil {
			t.Fatalf("apply %s: %v", f, err)
		}
	}

	cleanup := func() {
		pool.Close()
		shutCtx, sc := context.WithTimeout(context.Background(), 30*time.Second)
		defer sc()
		_ = c.Terminate(shutCtx)
	}
	return pool, cleanup
}

func applySchema(ctx context.Context, pool *pgxpool.Pool, sql string) error {
	if i := strings.Index(sql, "\nBEGIN;"); i > 0 {
		prelude := sql[:i]
		if strings.TrimSpace(prelude) != "" {
			if _, err := pool.Exec(ctx, prelude); err != nil {
				return fmt.Errorf("prelude: %w", err)
			}
		}
		sql = sql[i:]
	}
	_, err := pool.Exec(ctx, sql)
	return err
}

func stripPsqlMeta(sql string) string {
	lines := strings.Split(sql, "\n")
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		if strings.HasPrefix(strings.TrimSpace(l), `\`) {
			continue
		}
		out = append(out, l)
	}
	return strings.Join(out, "\n")
}

func findRepoRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for cur := wd; cur != filepath.Dir(cur); cur = filepath.Dir(cur) {
		if _, err := os.Stat(filepath.Join(cur, "_meta", "schema_mlm.sql")); err == nil {
			return cur
		}
	}
	t.Fatal("could not find repo root with _meta/schema_mlm.sql")
	return ""
}
