package payments

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Uses the exact reporting migration and a runtime role that can read only its
// three approved views. Every row/provider fact is synthetic and local.
func TestAdminSalesSourceGuardPostgres(t *testing.T) {
	if testing.Short() {
		t.Skip("isolated PostgreSQL testcontainer")
	}
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if _, err := pool.Exec(ctx, recoveredStripeTestFixture+`
 CREATE ROLE synthetic_sales_source_reader LOGIN NOINHERIT PASSWORD 'synthetic-source-reader-only';
 GRANT USAGE ON SCHEMA payments TO synthetic_sales_source_reader;`); err != nil {
		t.Fatal(err)
	}
	cfg := pool.Config().Copy()
	cfg.ConnConfig.User, cfg.ConnConfig.Password = "synthetic_sales_source_reader", "synthetic-source-reader-only"
	cfg.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	reader, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	store := NewStore(reader)
	t.Run("no reporting retains legacy source selection", func(t *testing.T) {
		if present, err := store.hasAdminSales(ctx); err != nil || present {
			t.Fatal("ordinary recovered/operational source selection changed", present, err)
		}
	})
	t.Run("one reporting artifact must not enable legacy fallback", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `CREATE TABLE payments.sales_import_batch(id uuid)`); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if _, err := pool.Exec(ctx, `DROP TABLE payments.sales_import_batch`); err != nil {
				t.Fatal(err)
			}
		}()
		if present, err := store.hasAdminSales(ctx); err == nil || present {
			t.Fatal("partial reporting revived an older source", present, err)
		}
	})
	for _, name := range []string{"70_stable_identity_bindings.sql", "74_nowpayments_membership_review.sql", "75_nowpayments_webhook_capture.sql", "77_nowpayments_included_pricing.sql", "79_nowpayments_operational_orders.sql", "87_admin_sales_reporting.sql"} {
		data, err := os.ReadFile(filepath.Join(findRepoRoot(t), "_meta", "migration", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(data)); err != nil {
			t.Fatal(name, err)
		}
	}
	if _, err := pool.Exec(ctx, consolidatedSalesFixture+`
 GRANT SELECT ON payments.v_admin_sales,payments.v_admin_sales_source,
 payments.v_admin_sales_import_batch TO synthetic_sales_source_reader;`); err != nil {
		t.Fatal(err)
	}
	var rawAccess bool
	if err := pool.QueryRow(ctx, `SELECT has_table_privilege('synthetic_sales_source_reader','payments.sales_import_batch','SELECT')
 OR has_table_privilege('synthetic_sales_source_reader','payments.sales_import_row','SELECT')
 OR has_table_privilege('synthetic_sales_source_reader','payments.admin_sales_source','SELECT')`).Scan(&rawAccess); err != nil || rawAccess {
		t.Fatal("source guard unexpectedly requires raw import access", rawAccess, err)
	}
	checkComplete := func(t *testing.T) {
		t.Helper()
		if present, err := store.hasAdminSales(ctx); err != nil || !present {
			t.Fatal("complete reviewed reporting rejected under view-only role", present, err)
		}
	}
	checkBroken := func(t *testing.T) {
		t.Helper()
		if present, err := store.hasAdminSales(ctx); err == nil || present {
			t.Fatal("incomplete reporting allowed an older source fallback", present, err)
		}
		if _, err := store.GetAdminFinance(ctx); err == nil {
			t.Error("finance silently fell back to superseded canonical/operational totals")
		}
		if _, err := store.AdminSummary(ctx); err == nil {
			t.Error("admin summary silently fell back to superseded totals")
		}
		if _, _, err := store.ListUsers(ctx, "", 25, 0); err == nil {
			t.Error("users silently fell back to superseded purchases")
		}
	}
	var before string
	if err := pool.QueryRow(ctx, consolidatedImmutableSnapshot).Scan(&before); err != nil {
		t.Fatal(err)
	}
	checkComplete(t)
	for _, relation := range []struct{ kind, name string }{
		{"TABLE", "sales_import_batch"}, {"TABLE", "sales_import_row"}, {"TABLE", "admin_sales_source"},
		{"VIEW", "v_admin_sales"}, {"VIEW", "v_admin_sales_source"}, {"VIEW", "v_admin_sales_import_batch"},
	} {
		t.Run("missing "+relation.name, func(t *testing.T) {
			// Static internal identifiers only; never derived from request input.
			if _, err := pool.Exec(ctx, fmt.Sprintf("ALTER %s payments.%s RENAME TO source_guard_saved", relation.kind, relation.name)); err != nil {
				t.Fatal(err)
			}
			defer func() {
				if _, err := pool.Exec(ctx, fmt.Sprintf("ALTER %s payments.source_guard_saved RENAME TO %s", relation.kind, relation.name)); err != nil {
					t.Fatal(err)
				}
				checkComplete(t)
			}()
			checkBroken(t)
		})
	}
	t.Run("empty active source", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `DELETE FROM payments.admin_sales_source`); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if _, err := pool.Exec(ctx, `INSERT INTO payments.admin_sales_source(provider,active_batch_id)
 VALUES('stripe','87000000-0000-4000-8000-000000000001')`); err != nil {
				t.Fatal(err)
			}
			checkComplete(t)
		}()
		checkBroken(t)
	})
	for _, variant := range []struct{ name, selectSQL string }{
		{"unreviewed batch", `SELECT id,file_sha256,source_name,source_extracted_at,imported_at,row_count,gross_minor,refunded_minor,fee_minor,statement,controls,'rejected'::text AS status FROM payments.sales_import_batch`},
		{"missing active batch", `SELECT id,file_sha256,source_name,source_extracted_at,imported_at,row_count,gross_minor,refunded_minor,fee_minor,statement,controls,status FROM payments.sales_import_batch WHERE false`},
	} {
		t.Run(variant.name, func(t *testing.T) {
			var original string
			if err := pool.QueryRow(ctx, `SELECT pg_get_viewdef('payments.v_admin_sales_import_batch'::regclass,true)`).Scan(&original); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `CREATE OR REPLACE VIEW payments.v_admin_sales_import_batch AS `+variant.selectSQL); err != nil {
				t.Fatal(err)
			}
			defer func() {
				if _, err := pool.Exec(ctx, `CREATE OR REPLACE VIEW payments.v_admin_sales_import_batch AS `+original); err != nil {
					t.Fatal(err)
				}
				checkComplete(t)
			}()
			checkBroken(t)
		})
	}
	for _, variant := range []struct{ name, selectSQL string }{
		{"non-Stripe source", `SELECT 'other'::text AS provider,active_batch_id,activated_at FROM payments.admin_sales_source`},
		{"duplicate source", `SELECT provider,active_batch_id,activated_at FROM payments.admin_sales_source UNION ALL SELECT provider,active_batch_id,activated_at FROM payments.admin_sales_source`},
	} {
		t.Run(variant.name, func(t *testing.T) {
			var original string
			if err := pool.QueryRow(ctx, `SELECT pg_get_viewdef('payments.v_admin_sales_source'::regclass,true)`).Scan(&original); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `CREATE OR REPLACE VIEW payments.v_admin_sales_source AS `+variant.selectSQL); err != nil {
				t.Fatal(err)
			}
			defer func() {
				if _, err := pool.Exec(ctx, `CREATE OR REPLACE VIEW payments.v_admin_sales_source AS `+original); err != nil {
					t.Fatal(err)
				}
				checkComplete(t)
			}()
			checkBroken(t)
		})
	}
	t.Run("source view permission failure", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `REVOKE SELECT ON payments.v_admin_sales_source FROM synthetic_sales_source_reader`); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if _, err := pool.Exec(ctx, `GRANT SELECT ON payments.v_admin_sales_source TO synthetic_sales_source_reader`); err != nil {
				t.Fatal(err)
			}
			checkComplete(t)
		}()
		checkBroken(t)
	})
	var after string
	if err := pool.QueryRow(ctx, consolidatedImmutableSnapshot).Scan(&after); err != nil || after != before {
		t.Fatal("guard reads changed canonical finance, identity or tree", err)
	}
}
