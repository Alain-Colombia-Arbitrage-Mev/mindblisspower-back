package payments

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Exact reporting migration, synthetic source facts and a SELECT-only reader.
// No provider, production data, activation or financial job is used.
func TestMemberRecoveryActiveCSVScopePostgres(t *testing.T) {
	if testing.Short() {
		t.Skip("isolated PostgreSQL testcontainer")
	}
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	if _, err := pool.Exec(ctx, recoveredStripeTestFixture); err != nil {
		t.Fatal(err)
	}
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
 INSERT INTO mlm.person(id,first_name,last_name,email,phone_number,status) OVERRIDING SYSTEM VALUE
 VALUES(2,'Other','Owner','other-scope@example.test','0','active');
 INSERT INTO recovery.stripe_sale_identity(payment_intent_id,person_id,affiliate_id,identity_verified,catalog_verified)
 SELECT payment_intent_id,1,1,true,true FROM payments.stripe_sale WHERE payment_intent_id LIKE 'pi_sales%';
 CREATE ROLE synthetic_member_scope_reader LOGIN NOINHERIT PASSWORD 'synthetic-member-scope-only';
 GRANT USAGE ON SCHEMA mlm,payments,recovery TO synthetic_member_scope_reader;
 GRANT SELECT ON mlm.person,mlm.affiliate,mlm.rank,mlm.affiliate_package,
 payments.stripe_sale,recovery.stripe_sale_identity,
 payments.v_admin_sales,payments.v_admin_sales_source,payments.v_admin_sales_import_batch TO synthetic_member_scope_reader;`); err != nil {
		t.Fatal("synthetic owner/reporting fixture", err)
	}
	cfg := pool.Config().Copy()
	cfg.ConnConfig.User, cfg.ConnConfig.Password = "synthetic_member_scope_reader", "synthetic-member-scope-only"
	cfg.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	reader, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	store := NewStore(reader)
	var restricted bool
	if err := pool.QueryRow(ctx, `SELECT NOT has_table_privilege('synthetic_member_scope_reader','payments.sales_import_row','SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('synthetic_member_scope_reader','payments.admin_sales_source','SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('synthetic_member_scope_reader','mlm.person','INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('synthetic_member_scope_reader','mlm.wallet_movement','SELECT,INSERT,UPDATE,DELETE')`).Scan(&restricted); err != nil || !restricted {
		t.Fatal("reader fixture gained a raw import or financial permission", restricted, err)
	}
	snapshot := func() string {
		t.Helper()
		var out string
		if err := pool.QueryRow(ctx, `SELECT md5(jsonb_build_object(
 'people',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM mlm.person p),
 'affiliates',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM mlm.affiliate a),
 'intents',(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM payments.purchase_intent i),
 'packages',(SELECT jsonb_agg(to_jsonb(ap) ORDER BY id) FROM mlm.affiliate_package ap),
 'cds',(SELECT jsonb_agg(to_jsonb(cd) ORDER BY id) FROM mlm.investment_cd cd),
 'ledger',(SELECT jsonb_agg(to_jsonb(wm) ORDER BY id) FROM mlm.wallet_movement wm),
 'canonical',(SELECT jsonb_agg(to_jsonb(s) ORDER BY payment_intent_id) FROM payments.stripe_sale s)
 )::text)`).Scan(&out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	before := snapshot()
	check := func(t *testing.T, email string, expected map[string]string) {
		t.Helper()
		for _, fresh := range []bool{false, true} {
			summary, err := store.getMemberSummary(ctx, email, fresh)
			if err != nil {
				t.Fatal(err)
			}
			if len(summary.StripeSales) != len(expected) || len(summary.Payments) != 0 || summary.DataSource != recoveredStripeSource || !summary.PayoutLocked {
				t.Fatalf("historical source leaked non-active sales or operational data: %+v", summary)
			}
			for _, sale := range summary.StripeSales {
				status, exists := expected[sale.PaymentIntentID]
				if !exists || sale.Status != status || sale.SourceEligible {
					t.Errorf("active import status/eligibility/owner mismatch: %+v", sale)
				}
			}
			wire := memberSummaryJSON(t, summary)
			for _, key := range []string{"wallet_balance_usd", "commission_available_usd", "commission_maturing_usd", "available_for_withdrawal_usd"} {
				if value, exists := wire[key]; !exists || value != nil {
					t.Errorf("read-only import promoted unknown money into %s=%v", key, value)
				}
			}
		}
	}
	t.Run("active CSV excludes canonical sales outside its subset", func(t *testing.T) {
		check(t, "buyer@t.local", map[string]string{"pi_sales0001": "paid", "pi_sales0002": "under_review", "pi_sales0003": "disputed"})
	})
	t.Run("another owner sees no imported or canonical fallback sale", func(t *testing.T) {
		check(t, "other-scope@example.test", map[string]string{})
	})
	t.Run("import cannot replace canonical ownership", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `UPDATE recovery.stripe_sale_identity SET person_id=2 WHERE payment_intent_id='pi_sales0001'`); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if _, err := pool.Exec(ctx, `UPDATE recovery.stripe_sale_identity SET person_id=1 WHERE payment_intent_id='pi_sales0001'`); err != nil {
				t.Error(err)
			}
		}()
		check(t, "buyer@t.local", map[string]string{"pi_sales0002": "under_review", "pi_sales0003": "disputed"})
		check(t, "other-scope@example.test", map[string]string{})
	})
	t.Run("unverified canonical identity stays hidden", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `UPDATE recovery.stripe_sale_identity SET identity_verified=false WHERE payment_intent_id='pi_sales0001'`); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if _, err := pool.Exec(ctx, `UPDATE recovery.stripe_sale_identity SET identity_verified=true WHERE payment_intent_id='pi_sales0001'`); err != nil {
				t.Error(err)
			}
		}()
		check(t, "buyer@t.local", map[string]string{"pi_sales0002": "under_review", "pi_sales0003": "disputed"})
	})
	t.Run("new active batch replaces rather than unions old sales", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `INSERT INTO payments.sales_import_batch(id,file_sha256,source_name,row_count,gross_minor,refunded_minor,fee_minor,statement,controls,status)
 SELECT '87000000-0000-4000-8000-000000000002',repeat('c',64),'Synthetic second batch',1,10000,1000,300,statement,controls,'reviewed'
 FROM payments.sales_import_batch WHERE id='87000000-0000-4000-8000-000000000001';
 INSERT INTO payments.sales_import_row SELECT (jsonb_populate_record(NULL::payments.sales_import_row,to_jsonb(r)||jsonb_build_object(
 'batch_id','87000000-0000-4000-8000-000000000002','refunded_minor',1000,'net_minor',8700,'risk_status','disputed'))).*
 FROM payments.sales_import_row r WHERE batch_id='87000000-0000-4000-8000-000000000001' AND source_row=1;
 UPDATE payments.admin_sales_source SET active_batch_id='87000000-0000-4000-8000-000000000002' WHERE provider='stripe';`); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if _, err := pool.Exec(ctx, `UPDATE payments.admin_sales_source SET active_batch_id='87000000-0000-4000-8000-000000000001' WHERE provider='stripe'`); err != nil {
				t.Error(err)
			}
		}()
		check(t, "buyer@t.local", map[string]string{"pi_sales0001": "refunded"})
		summary, err := store.GetMemberSummary(ctx, "buyer@t.local")
		if err != nil || len(summary.StripeSales) != 1 || summary.StripeSales[0].RefundedUSD != "10.00" || summary.StripeSales[0].TotalUSD != "100.00" {
			t.Fatal("CSV refund and gross must not revert to canonical amounts", summary, err)
		}
	})
	t.Run("rejected active import fails closed", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `INSERT INTO payments.sales_import_batch(id,file_sha256,source_name,row_count,gross_minor,refunded_minor,fee_minor,statement,controls,status)
 SELECT '87000000-0000-4000-8000-000000000003',repeat('d',64),'Synthetic rejected batch',1,10000,0,300,statement,controls,'rejected'
 FROM payments.sales_import_batch WHERE id='87000000-0000-4000-8000-000000000001';
 UPDATE payments.admin_sales_source SET active_batch_id='87000000-0000-4000-8000-000000000003' WHERE provider='stripe';`); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if _, err := pool.Exec(ctx, `UPDATE payments.admin_sales_source SET active_batch_id='87000000-0000-4000-8000-000000000001' WHERE provider='stripe'`); err != nil {
				t.Error(err)
			}
		}()
		if _, err := store.GetMemberSummary(ctx, "buyer@t.local"); err == nil {
			t.Error("rejected active import silently returned canonical sales")
		}
	})
	t.Run("missing active source fails closed", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `DELETE FROM payments.admin_sales_source WHERE provider='stripe'`); err != nil {
			t.Fatal(err)
		}
		if _, err := store.GetMemberSummary(ctx, "buyer@t.local"); err == nil {
			t.Error("missing CSV source silently returned canonical sales")
		}
		if _, err := pool.Exec(ctx, `INSERT INTO payments.admin_sales_source(provider,active_batch_id) VALUES('stripe','87000000-0000-4000-8000-000000000001')`); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("partial reporting without sale view fails closed", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `DROP VIEW payments.v_admin_sales`); err != nil {
			t.Fatal(err)
		}
		if _, err := store.GetMemberSummary(ctx, "buyer@t.local"); err == nil {
			t.Error("partial reporting silently returned canonical sales")
		}
	})
	if after := snapshot(); after != before {
		t.Fatal("historical read changed identity, positions, ledger, memberships, principal or canonical evidence")
	}
}
