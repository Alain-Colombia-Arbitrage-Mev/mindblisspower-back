package bonusengine

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

// pgContainer arranca Timescale + extensions y aplica los 3 schemas + el patch.
// Se reusa entre tests del mismo paquete vía sync.Once para amortizar el costo.
func pgContainer(t *testing.T) (*pgxpool.Pool, func()) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	req := testcontainers.ContainerRequest{
		Image: "timescale/timescaledb:latest-pg17",
		Env: map[string]string{
			"POSTGRES_PASSWORD":  "test",
			"POSTGRES_DB":        "vicionpower_test",
			"POSTGRES_USER":      "postgres",
		},
		ExposedPorts: []string{"5432/tcp"},
		WaitingFor: wait.ForLog("database system is ready to accept connections").
			WithOccurrence(2).WithStartupTimeout(2 * time.Minute),
	}
	c, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: req, Started: true,
	})
	if err != nil {
		t.Fatalf("start container: %v", err)
	}
	host, _ := c.Host(ctx)
	port, _ := c.MappedPort(ctx, "5432")
	dsn := fmt.Sprintf("postgres://postgres:test@%s:%s/vicionpower_test?sslmode=disable",
		host, port.Port())

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		_ = c.Terminate(ctx)
		t.Fatalf("connect: %v", err)
	}

	// Roles cluster-level que los schemas asumen creados por el bootstrap
	// (00-init.sql / deployment).
	for _, r := range []string{"engine_write", "engine_read"} {
		if _, err := pool.Exec(ctx,
			fmt.Sprintf(`DO $$ BEGIN CREATE ROLE %s NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`, r)); err != nil {
			_ = c.Terminate(ctx)
			t.Fatalf("create role %s: %v", r, err)
		}
	}

	// Buscar dir del proyecto subiendo desde cwd.
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

// applySchema ejecuta un archivo de schema. Si el archivo tiene un preludio
// antes de su primer BEGIN; (p.ej. ALTER TYPE ... ADD VALUE en v1.2/v1.3),
// lo ejecuta en un Exec separado: un valor de enum nuevo no puede usarse en
// la misma transacción (implícita) que lo creó.
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

// stripPsqlMeta elimina metacomandos psql (líneas que empiezan con '\':
// \echo, \timing, \if, \set...) que pgx no entiende. Los archivos _meta/*.sql
// se escriben para psql; aquí los aplicamos por driver.
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

func newTestEngine(pool *pgxpool.Pool) *Engine {
	// nil NATS en tests; CloseBinaryPeriod tolera nats nil
	logger := zerolog.New(os.Stderr).Level(zerolog.WarnLevel)
	return New(pool, nil, logger)
}

// seedMinimalTree crea una raíz con dos hijos (L y R) y los catalogs mínimos
// para que un cierre pueda correr. Devuelve los affiliate_id de root, L, R.
func seedMinimalTree(t *testing.T, ctx context.Context, pool *pgxpool.Pool) (root, leftID, rightID int64) {
	t.Helper()

	// Catalogs
	_, err := pool.Exec(ctx, `
		INSERT INTO mlm.country (id, iso2, name_es, name_en) VALUES (1, 'CO', 'Colombia', 'Colombia');
		INSERT INTO mlm.asset (id, symbol, name, is_fiat, decimals) VALUES (1, 'USD', 'US Dollar', true, 2);
		INSERT INTO mlm.concept (id, kind, name_es, name_en, factor, requires_pair, active) VALUES
		  (1, 'package_purchase', 'Compra paquete', 'Package purchase', -1, true, true),
		  (11, 'binary_bonus',    'Bono binario',  'Binary bonus',     1, false, true);
		-- mlm.rank ya viene sembrado con los 14 reales (schema_ranks.sql);
		-- rank id 1 = BRONZE (bonus $100), usado como current_rank_id abajo.
		INSERT INTO mlm.package (id, name, amount_usd, pv, type) VALUES
		  (1, 'Basic', 1000, 500, 'enrollment');
	`)
	if err != nil {
		t.Fatalf("catalogs seed: %v", err)
	}

	// 3 personas + affiliates (root, L, R)
	for i := 1; i <= 3; i++ {
		_, err = pool.Exec(ctx, `
			INSERT INTO mlm.person (first_name, last_name, email, phone_number, status)
			VALUES ($1, $2, $3, '0000000000', 'active')`,
			fmt.Sprintf("p%d", i), "test", fmt.Sprintf("p%d@t.local", i))
		if err != nil {
			t.Fatalf("person seed: %v", err)
		}
	}

	// Root sin parent
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.affiliate (person_id, parent_id, position, status, current_rank_id, path, depth)
		VALUES (1, NULL, NULL, 'active', 1, '1', 0)
		RETURNING id`).Scan(&root); err != nil {
		t.Fatalf("root: %v", err)
	}

	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.affiliate (person_id, parent_id, position, status, current_rank_id, path, depth)
		VALUES (2, $1, 'L', 'active', 1, $2::ltree, 1)
		RETURNING id`, root, fmt.Sprintf("%d.L_2", root)).Scan(&leftID); err != nil {
		t.Fatalf("left: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.affiliate (person_id, parent_id, position, status, current_rank_id, path, depth)
		VALUES (3, $1, 'R', 'active', 1, $2::ltree, 1)
		RETURNING id`, root, fmt.Sprintf("%d.R_3", root)).Scan(&rightID); err != nil {
		t.Fatalf("right: %v", err)
	}

	// Wallet USD para root (es quien recibe los bonos como ancestor)
	_, err = pool.Exec(ctx, `
		INSERT INTO mlm.wallet (affiliate_id, asset_id, address, balance) VALUES ($1, 1, 'root-usd', 0)`, root)
	if err != nil {
		t.Fatalf("wallet root: %v", err)
	}

	// Plan config v1 (bypass approval for test)
	_, err = pool.Exec(ctx, `
		BEGIN;
		SET LOCAL app.bypass_approval = 'on';
		INSERT INTO mlm.plan_config (
		  version_label, effective_from, block_size, bonus_per_block, depth_cap,
		  daily_cap_factor, lifetime_cap_factor, treasury_alpha, carry_decay_days,
		  qualified_directs_left, qualified_directs_right, created_by_person_id)
		VALUES ('v1-test', now(), 100, 10.00, 10, 3.0, 2.0, 0.45, 14, 0, 0, 1);
		COMMIT;`)
	if err != nil {
		t.Fatalf("plan_config: %v", err)
	}

	return root, leftID, rightID
}
