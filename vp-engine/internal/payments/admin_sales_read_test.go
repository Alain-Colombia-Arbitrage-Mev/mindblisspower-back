package payments

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
)

func TestAdminSalesFiltersAreExactAndHistoricalScopeIsExplicit(t *testing.T) {
	for _, query := range []string{"provider=other", "provider=Stripe", "provider=stripe&provider=nowpayments", "scope=month", "scope=all&scope=all", "days=0", "days=366", "days=oops", "days=", "days=-1", "days=1.5", "days=1&days=2", "days=9999999999999", "days=%2B30"} {
		if _, _, _, err := adminSalesRequest(httptest.NewRequest(http.MethodGet, "/?"+query, nil)); err == nil {
			t.Fatalf("invalid filter accepted: %s", query)
		}
	}
	r, from, days, err := adminSalesRequest(httptest.NewRequest(http.MethodGet, "/?scope=all&provider=nowpayments", nil))
	if err != nil || !from.IsZero() || days != 0 || salesProvider(r.Context()) != "nowpayments" {
		t.Fatal("all-time/provider filter lost", from, days, err)
	}
	_, from, days, err = adminSalesRequest(httptest.NewRequest(http.MethodGet, "/?days=7", nil))
	if err != nil || from.IsZero() || days != 7 {
		t.Fatal("period filter lost", err)
	}
}

func TestConsolidatedSalesJSONNeverInventsCashOrActivation(t *testing.T) {
	summary := &AdminSalesSummary{DataSource: consolidatedSalesSource, Currency: "usd"}
	for _, value := range []any{
		AdminFinance{DataSource: consolidatedSalesSource, SalesSummary: summary, InflowsUSD: "450.00"},
		SalesCashSummary{DataSource: consolidatedSalesSource, SalesSummary: summary, GrossChargedUSD: "450.00"},
	} {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		var wire map[string]any
		if err := json.Unmarshal(data, &wire); err != nil {
			t.Fatal(err)
		}
		for _, field := range []string{"stripe_receivable_usd", "stripe_fee_usd"} {
			if wire[field] != nil {
				t.Fatalf("unknown %s became money: %v", field, wire[field])
			}
		}
		if wire["sales_summary"] == nil || wire["stripe_recovery"] != nil {
			t.Fatal("new source lost or old owner declaration exposed")
		}
	}
	data, _ := json.Marshal(SalesTransaction{DataSource: consolidatedSalesSource, SourceStatus: "Paid", RiskStatus: "disputed", ReadOnly: true})
	var wire map[string]any
	_ = json.Unmarshal(data, &wire)
	for _, field := range []string{"amount_usd", "fee_usd", "activated_at", "refunded_at", "stripe_present"} {
		if wire[field] != nil {
			t.Fatalf("unknown source detail invented: %s=%v", field, wire[field])
		}
	}
	if wire["source_status"] != "Paid" || wire["risk_status"] != "disputed" {
		t.Fatal("source label erased canonical dispute")
	}
	if strings.Contains(adminSalesUsersSQL(), "purchase_intent") || strings.Contains(adminSalesUsersSQL(), "lower(pi.user_id)") {
		t.Fatal("consolidated users still guess by legacy email")
	}
}

// Uses the exact operator migration and actual existing NOW activation code in
// disposable PostgreSQL. Provider evidence is synthetic; no network is used.
func TestConsolidatedSalesPostgresReadModel(t *testing.T) {
	if testing.Short() {
		t.Skip("isolated PostgreSQL testcontainer")
	}
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if _, err := pool.Exec(ctx, recoveredStripeTestFixture); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"70_stable_identity_bindings.sql", "74_nowpayments_membership_review.sql", "75_nowpayments_webhook_capture.sql", "77_nowpayments_included_pricing.sql", "79_nowpayments_operational_orders.sql"} {
		data, err := os.ReadFile(filepath.Join(findRepoRoot(t), "_meta", "migration", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(data)); err != nil {
			t.Fatal(name, err)
		}
	}
	applyNOWPurchaseLifecycleMigration(t, ctx, pool)
	if _, err := pool.Exec(ctx, `SELECT setval(pg_get_serial_sequence('mlm.person','id'),1000,true)`); err != nil {
		t.Fatal(err)
	}
	admin := seedAdmin(t, ctx, pool, "sales-admin@example.test")
	seedActivePlan(t, ctx, pool, admin)
	if _, err := pool.Exec(ctx, `INSERT INTO auth.user(id,email,email_verified) VALUES('sales-subject','buyer@t.local',true);
 UPDATE mlm.person SET user_id='sales-subject' WHERE id=1;
 INSERT INTO identity.auth_binding(subject,person_id,link_method) VALUES('sales-subject',1,'new_registration');
 INSERT INTO mlm.package(id,name,amount_usd,pv,type) VALUES(8701,'Synthetic NOW',50,50,'enrollment');
 INSERT INTO mlm.asset(id,symbol,name,is_fiat,decimals) VALUES(1,'USD','Synthetic USD',true,2) ON CONFLICT(symbol) DO NOTHING;
 ALTER ROLE mindbliss_payments_20261025 PASSWORD 'synthetic-only-sales-reader';`); err != nil {
		t.Fatal(err)
	}
	writer := NewNOWPaymentsOperationalStore(pool)
	writer.SetNOWOperationalReadiness(func(context.Context, pgx.Tx) error { return nil })
	input := NOWPaymentsMembershipInput{Subject: "sales-subject", Email: "buyer@t.local", Environment: "production", PackageID: 8701, PurchaseRequestID: uuid.NewString()}
	order, err := writer.CreateNOWPaymentsMembership(ctx, input)
	if err != nil {
		t.Fatal("synthetic new NOW order", err)
	}
	if err := writer.AttachNOWPaymentsInvoice(ctx, order.ID, "production", "87001"); err != nil {
		t.Fatal(err)
	}
	payment := syntheticNOWPayment(order.ID, "87001", "870001", "finished")
	payment.PriceAmount, payment.PayAmount, payment.ActuallyPaid = "50.00", "50", "50"
	hash := strings.Repeat("a", 64)
	if err := NewNOWPaymentsCaptureStore(pool).Capture(ctx, "production", payment, payment, hash); err != nil {
		t.Fatal(err)
	}
	if state, err := writer.processNOWOperationalPayment(ctx, "production", payment, payment, hash); err != nil || state != "activated" {
		t.Fatal("synthetic NOW activation", state, err)
	}
	// A second independently payable invoice must remain absent from sales.
	input.PurchaseRequestID = uuid.NewString()
	unpaid, err := writer.CreateNOWPaymentsMembership(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if err := writer.AttachNOWPaymentsInvoice(ctx, unpaid.ID, "production", "87002"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(findRepoRoot(t), "_meta", "migration", "87_admin_sales_reporting.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, string(data)); err != nil {
		t.Fatal("exact reporting migration", err)
	}
	if _, err := pool.Exec(ctx, consolidatedSalesFixture); err != nil {
		t.Fatal("synthetic source import", err)
	}
	// Only narrow report views, not the raw NOW evidence or import tables.
	if _, err := pool.Exec(ctx, `GRANT USAGE ON SCHEMA mlm,payments TO mindbliss_payments_20261025;
 GRANT SELECT ON payments.v_admin_sales,payments.v_admin_sales_import_batch,payments.v_admin_sales_source,
 mlm.person,mlm.affiliate,mlm.rank,mlm.affiliate_package,mlm.affiliate_rank_achieved,mlm.country,mlm.blacklist TO mindbliss_payments_20261025;`); err != nil {
		t.Fatal(err)
	}
	config := pool.Config().Copy()
	config.ConnConfig.User, config.ConnConfig.Password = "mindbliss_payments_20261025", "synthetic-only-sales-reader"
	config.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	reader, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	store := NewStore(reader)
	var before string
	if err := pool.QueryRow(ctx, consolidatedImmutableSnapshot).Scan(&before); err != nil {
		t.Fatal(err)
	}
	summary, err := store.adminSalesSummary(ctx, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if summary.Sales != 4 || summary.GrossUSD != "450.00" || summary.ProcessingFeeUSD != "12.50" || summary.NetUSD != "437.50" || summary.PaidSales != 3 || summary.ReviewSales != 1 || summary.ReviewGrossUSD != "200.00" || summary.ActivatedSales != 1 || summary.DisputedSales != 1 || summary.RiskSales != 2 || summary.VerifiedProcessingFeeUSD != nil || len(summary.Sources) != 2 {
		t.Fatalf("source mix/risks/fees lost: %+v", summary)
	}
	if summary.ImportBatch == nil || summary.ImportBatch.Rows != 4 || !strings.Contains(string(summary.ImportBatch.Controls), "excluded_totals") || !strings.Contains(string(summary.ImportBatch.Statement), "owner_declaration") {
		t.Fatal("unfiltered import evidence absent", summary.ImportBatch)
	}
	stripeCtx := context.WithValue(ctx, adminSalesFilterKey{}, adminSalesFilter{provider: "stripe"})
	stripe, err := store.adminSalesSummary(stripeCtx, time.Time{})
	if err != nil || stripe.Sales != 3 || stripe.GrossUSD != "400.00" || stripe.ActivatedSales != 0 {
		t.Fatal("Stripe provider filter", stripe, err)
	}
	period, err := store.adminSalesSummary(ctx, time.Now().UTC().AddDate(0, 0, -1))
	if err != nil || period.Sales != 1 || period.GrossUSD != "50.00" || period.ImportBatch.Rows != 4 || period.ImportBatch.Scope != "all_time_import_snapshot" {
		t.Fatal("period facts or statement proration", period, err)
	}
	txns, total, err := store.SalesTransactions(ctx, time.Time{}, "", "", 100, 0)
	if err != nil || total != 4 || len(txns) != 4 {
		t.Fatal("consolidated history includes old, excluded or unpaid rows", total, err)
	}
	for _, row := range txns {
		if row.DataSource != consolidatedSalesSource || !row.ReadOnly || strings.Contains(row.ID, unpaid.ID) {
			t.Fatal("unsafe history row", row.ID)
		}
	}
	paid, total, err := store.SalesTransactions(stripeCtx, time.Time{}, "paid", "", 100, 0)
	if err != nil || total != 2 || len(paid) != 2 {
		t.Fatal("source Paid should not erase dispute", total, err)
	}
	var preserved bool
	for _, row := range paid {
		if row.RiskStatus == "disputed" && row.SourceStatus == "Paid" && row.FeeReconciliationStatus == "discrepancy" && row.VerifiedProcessingFeeUSD != nil && *row.VerifiedProcessingFeeUSD == "1.00" {
			preserved = true
		}
	}
	if !preserved {
		t.Fatal("source fee or canonical dispute overwritten")
	}
	disputed, total, err := store.SalesTransactions(stripeCtx, time.Time{}, "disputed", "pi_sales0003", 100, 0)
	if err != nil || total != 1 || len(disputed) != 1 || disputed[0].Status != "paid" || disputed[0].RiskStatus != "disputed" {
		t.Fatal("risk filter or PaymentIntent reference search lost independent evidence", total, err)
	}
	products, err := store.SalesReport(ctx, time.Time{})
	if err != nil || len(products) != 2 {
		t.Fatal("products grouped by provider verified catalog", len(products), err)
	}
	users, total, err := store.ListUsers(ctx, "buyer@t.local", 25, 0)
	if err != nil || total != 1 || len(users) != 1 || users[0].TotalPaidUSD != "450.00" || users[0].DataSource != consolidatedSalesSource {
		t.Fatal("user sales still read contaminated intents", users, total, err)
	}
	exported, err := store.ExportUsers(ctx, "buyer@t.local", "")
	if err != nil || len(exported) != 1 || exported[0].OwnPurchasesUSD != "450.00" {
		t.Fatal("user export uses stale history", exported, err)
	}
	payments, total, err := store.ListPayments(ctx, "", "", 100, 0)
	if err != nil || total != 4 || len(payments) != 4 || !payments[0].ReadOnly {
		t.Fatal("payments uses stale intent list", total, err)
	}
	finance, err := store.GetAdminFinance(ctx)
	if err != nil || finance.SalesSummary == nil || finance.StripeRecovery != nil || finance.InflowsUSD != "450.00" {
		t.Fatal("finance source overlay", finance, err)
	}
	all, err := store.AdminSummary(ctx)
	if err != nil || all.TotalSold != 4 || all.TotalRevenUSD != "450.00" || all.SalesSummary == nil {
		t.Fatal("admin totals still old", all, err)
	}
	cash, err := store.SalesCashSummary(ctx, time.Time{})
	if err != nil || cash.SalesSummary == nil || cash.GrossChargedUSD != "450.00" {
		t.Fatal("sales summary still old", cash, err)
	}
	h := NewHandler(store, nil, "synthetic-sales-token", []string{"sales-admin@example.test"}, 1, zerolog.Nop())
	h.SetIdentityVerifier(fakeVerifier{email: "sales-admin@example.test"}, true)
	wireFixtures := map[string]json.RawMessage{}
	for _, endpoint := range []string{"/api/admin/sales/report?scope=all", "/api/admin/sales/transactions?scope=all&provider=stripe", "/api/admin/payments?provider=nowpayments", "/api/admin/summary", "/api/admin/finance"} {
		r := httptest.NewRequest(http.MethodGet, endpoint, nil)
		r.Header.Set("X-VP-Service-Token", "synthetic-sales-token")
		r.Header.Set(idTokenHeader, "synthetic-sales-id-token")
		w := httptest.NewRecorder()
		h.Routes().ServeHTTP(w, r)
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"data_source":"consolidated_sales_v1"`) {
			t.Fatal("HTTP source contract", endpoint, w.Code, w.Body.String())
		}
		wireFixtures[endpoint] = append(json.RawMessage(nil), w.Body.Bytes()...)
	}
	// Optional synthetic-only interop artifact for the frontend contract tests.
	// No environment path is accepted and normal tests emit no files/payloads.
	if os.Getenv("ADMIN_SALES_EXPORT_SYNTHETIC_WIRE") == "true" {
		file, err := os.CreateTemp("", "mindbliss-sales-synthetic-wire-*.json")
		if err != nil {
			t.Fatal(err)
		}
		if err := json.NewEncoder(file).Encode(wireFixtures); err != nil {
			_ = file.Close()
			t.Fatal(err)
		}
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
		t.Log("Synthetic wire fixture:", file.Name())
	}
	var after string
	if err := pool.QueryRow(ctx, consolidatedImmutableSnapshot).Scan(&after); err != nil || after != before {
		t.Fatal("report reads changed canonical finance/tree/identity", err)
	}
	if _, err := reader.Exec(ctx, `UPDATE payments.sales_import_row SET display_status='paid'`); err == nil {
		t.Fatal("report runtime acquired import write authority")
	}
	if _, err := pool.Exec(ctx, `DROP VIEW payments.v_admin_sales_import_batch`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.AdminSummary(ctx); err == nil {
		t.Fatal("incomplete metadata must not fall back to old source")
	}
	if _, _, err := store.VerifyTransactionStripe(ctx, nil, "pi_sales0001"); !errors.Is(err, ErrRecoveryFinancialReview) {
		t.Fatal("financial guard was bypassed", err)
	}
}

const consolidatedSalesFixture = `
INSERT INTO payments.stripe_sale VALUES
 ('pi_sales0001',true,'succeeded','2024-06-01','2024-06-01','usd',10000,0,0,'{"packmindbliss":"true"}','["tag"]',true),
 ('pi_sales0002',true,'succeeded','2024-06-01','2024-06-01','usd',20000,0,0,'{"packmindbliss":"true"}','["tag"]',true),
 ('pi_sales0003',true,'succeeded','2024-06-01','2024-06-01','usd',10000,0,1,'{"packmindbliss":"true"}','["tag"]',false);
INSERT INTO payments.sales_import_batch(id,file_sha256,source_name,row_count,gross_minor,refunded_minor,fee_minor,statement,controls,status)
 VALUES('87000000-0000-4000-8000-000000000001',repeat('a',64),'Synthetic sales.csv',4,43000,0,1300,
 '{"schema_version":1,"kind":"owner_supplied_csv_preamble","currency":"usd","scope":"source_file_all_rows_not_membership_or_cash","reconciled":false,"evidence_status":"owner_declaration_not_bank_verified",
 "amounts":{"declared_gross_minor":"43000","declared_reserve_minor":"10000","declared_company_payout_minor":"12300","declared_incoming_minor":"1000","declared_review_minor":"19700"}}',
 '{"schema_version":1,
 "source_totals":{"rows":4,"gross_minor":"43000","refunded_minor":"0","fee_minor":"1300","net_minor":"41700"},
 "included_totals":{"rows":3,"gross_minor":"40000","refunded_minor":"0","fee_minor":"1200","net_minor":"38800"},
 "excluded_totals":{"rows":1,"gross_minor":"3000","refunded_minor":"0","fee_minor":"100","net_minor":"2900","reason":"unattributed_product"},
 "canonical_evidence":{"matched_rows":3,"missing_rows":1,"amount_conflicts":0,"disputed_rows":1,"disputed_gross_minor":"10000","fee_discrepancy_rows":1,"fee_discrepancy_minor":"200","verified_fee_minor":"400"},
 "statement_reconciliation":{"review_difference_minor":"300","reconciled":false}}','reviewed');
INSERT INTO payments.sales_import_row(batch_id,source_row,external_id,provider_reference,created_at,paid_at,currency,person_id,affiliate_id,buyer_email,buyer_name,
 package_id,package_name,base_minor,gross_minor,refunded_minor,fee_minor,net_minor,verified_fee_minor,display_status,source_status,activation_status,risk_status,
 product_scope,provider_verified,commission_eligible,fee_reconciliation_status,canonical_payment_intent_id,canonical_refunded_minor,canonical_dispute_count,canonical_source_eligible,record_sha256)
 SELECT '87000000-0000-4000-8000-000000000001',i,'pi_sales000'||i,'ch_sales000'||i,'2024-06-01','2024-06-01','usd',
 CASE WHEN i<4 THEN 1 END,CASE WHEN i<4 THEN 1 END,CASE WHEN i<4 THEN 'buyer@t.local' ELSE '' END,CASE WHEN i<4 THEN 'Synthetic Buyer' ELSE '' END,
 CASE WHEN i<4 THEN 1001 END,'Synthetic reported pack',CASE WHEN i<4 THEN 10000 END,
 CASE WHEN i=2 THEN 20000 WHEN i=4 THEN 3000 ELSE 10000 END,0,
 CASE WHEN i=2 THEN 600 WHEN i=4 THEN 100 ELSE 300 END,
 CASE WHEN i=2 THEN 19400 WHEN i=4 THEN 2900 ELSE 9700 END,
 CASE WHEN i=1 THEN 300 WHEN i=3 THEN 100 END,
 CASE WHEN i=2 THEN 'under_review' ELSE 'paid' END,CASE WHEN i=2 THEN 'En Revisión' ELSE 'Paid' END,'not_inferred_from_import',
 CASE WHEN i=2 THEN 'source_review' WHEN i=3 THEN 'disputed' ELSE 'none' END,
 CASE WHEN i<4 THEN 'mindbliss_membership' ELSE 'unattributed' END,false,false,
 CASE WHEN i=1 THEN 'matched' WHEN i=3 THEN 'discrepancy' ELSE 'unavailable' END,
 CASE WHEN i<4 THEN 'pi_sales000'||i END,CASE WHEN i<4 THEN 0 END,CASE WHEN i=3 THEN 1 WHEN i<4 THEN 0 END,CASE WHEN i<3 THEN true WHEN i=3 THEN false END,repeat('b',64)
 FROM generate_series(1,4) i;
INSERT INTO payments.admin_sales_source(provider,active_batch_id) VALUES('stripe','87000000-0000-4000-8000-000000000001');`

const consolidatedImmutableSnapshot = `SELECT md5(jsonb_build_object(
 'stripe',(SELECT jsonb_agg(to_jsonb(s) ORDER BY payment_intent_id) FROM payments.stripe_sale s),
 'person',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM mlm.person p),
 'affiliate',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM mlm.affiliate a),
 'packages',(SELECT jsonb_agg(to_jsonb(ap) ORDER BY id) FROM mlm.affiliate_package ap),
 'cd',(SELECT jsonb_agg(to_jsonb(cd) ORDER BY id) FROM mlm.investment_cd cd),
 'ledger',(SELECT jsonb_agg(to_jsonb(wm) ORDER BY id) FROM mlm.wallet_movement wm),
 'orders',(SELECT jsonb_agg(to_jsonb(o) ORDER BY attempt_id) FROM payments.nowpayments_operational_order o)
 )::text)`
