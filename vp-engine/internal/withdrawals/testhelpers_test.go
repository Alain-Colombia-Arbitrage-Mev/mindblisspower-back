package withdrawals

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
		"_meta/migration/49_withdrawal_bmp_and_fee.sql",
		"_meta/migration/50_bmp_account_link.sql",
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

// seedMemberWithBalance crea persona + afiliado + wallet USD y acredita una
// comisión MADURADA (available_at ayer) de `amount`. Devuelve affiliate_id y
// wallet_id. Los catálogos (country/asset/concept) se siembran idempotentemente
// para poder llamarlo varias veces sobre el mismo contenedor.
func seedMemberWithBalance(t *testing.T, pool *pgxpool.Pool, email, amount string) (int64, int64) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.country (id, iso2, name_es, name_en) VALUES (1,'CO','Colombia','Colombia')
		  ON CONFLICT (id) DO NOTHING;
		INSERT INTO mlm.asset (id, symbol, name, is_fiat, decimals) VALUES (1,'USD','US Dollar',true,2)
		  ON CONFLICT (id) DO NOTHING;
		INSERT INTO mlm.concept (id, kind, name_es, name_en, factor, requires_pair, active)
		  VALUES (11,'binary_bonus','Bono','Bonus',1,false,true) ON CONFLICT (id) DO NOTHING;
	`); err != nil {
		t.Fatalf("seed catálogos: %v", err)
	}
	var personID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.person (first_name, last_name, email, phone_number, status)
		VALUES ('Mem','Ber',$1,'0','active') RETURNING id`, email).Scan(&personID); err != nil {
		t.Fatalf("seed person %s: %v", email, err)
	}
	var affID, walletID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.affiliate (person_id, parent_id, position, status, path, depth)
		VALUES ($1, NULL, NULL, 'active', ''::ltree, 0) RETURNING id`, personID).Scan(&affID); err != nil {
		t.Fatalf("seed affiliate: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.wallet (affiliate_id, asset_id, address, balance)
		VALUES ($1,1,'usd-'||$1::bigint::text,0) RETURNING id`, affID).Scan(&walletID); err != nil {
		t.Fatalf("seed wallet: %v", err)
	}
	var txnID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.transaction (external_ref, description, status)
		VALUES ('seed:bonus:'||$1, 'bono test', 'posted') RETURNING id`, email).Scan(&txnID); err != nil {
		t.Fatalf("seed txn: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.wallet_movement (transaction_id, wallet_id, affiliate_id, concept_id, amount, posted_at, available_at)
		VALUES ($1,$2,$3,11,$4::numeric,now(),current_date - 1)`, txnID, walletID, affID, amount); err != nil {
		t.Fatalf("seed movement: %v", err)
	}
	return affID, walletID
}

// grantFreshBMP persiste una verificación BMP elegible y recién hecha sobre el
// retiro, que es lo que el candado fail-closed de SetWithdrawalStatus exige para
// pagar (Task 10). Los tests que ejercitan OTRA cosa (contabilidad del débito,
// four-eyes, transiciones) lo llaman para llegar al pago; los que ejercitan el
// candado en sí NO deben usarlo.
func grantFreshBMP(t *testing.T, store *Store, id int64) {
	t.Helper()
	if err := store.RefreshBMPVerification(context.Background(), id, BMPVerification{
		CanWithdraw: true, CheckedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("grantFreshBMP(%d): %v", id, err)
	}
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
