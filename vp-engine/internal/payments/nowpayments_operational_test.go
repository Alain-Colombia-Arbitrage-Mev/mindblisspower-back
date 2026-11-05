package payments

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/vicionpower/vp-engine/internal/shared/financialguard"
)

func TestNOWPaymentsOperationalConfigIsSeparateAndExplicit(t *testing.T) {
	t.Setenv("NOWPAYMENTS_OPERATIONAL_ENABLED", "false")
	if got, err := loadNOWPaymentsOperationalSettings("", ""); err != nil || got.Enabled {
		t.Fatal("operations enabled by default", err)
	}
	t.Setenv("NOWPAYMENTS_OPERATIONAL_ENABLED", "true")
	t.Setenv("NOWPAYMENTS_MEMBERSHIPS_ENABLED", "true")
	t.Setenv("NOWPAYMENTS_ENGINE_ENABLED", "true")
	t.Setenv("SERVICE_READ_ONLY", "true")
	t.Setenv("ENV", "production")
	t.Setenv("NOWPAYMENTS_ENV", "production")
	t.Setenv("NOWPAYMENTS_API_KEY", "synthetic-key")
	t.Setenv("NOWPAYMENTS_IPN_SECRET", "synthetic-signature")
	t.Setenv("NOWPAYMENTS_IPN_URL", "https://mindblisspower.com/api/webhooks/nowpayments")
	reader := "postgres://reader:test@database.example/test?sslmode=verify-full"
	capture := "postgres://capture:test@database.example/test?sslmode=verify-full"
	t.Setenv("NOWPAYMENTS_OPERATIONAL_DATABASE_URL", "postgres://operations:test@database.example/test?sslmode=verify-full")
	if got, err := loadNOWPaymentsOperationalSettings(reader, capture); err != nil || !got.Enabled || !got.Provider.MembershipsEnabled {
		t.Fatal("explicit isolated mode unavailable", err)
	}
	for _, bad := range []string{reader, capture, "postgres://operations:test@other.example/test?sslmode=verify-full", "postgres://operations:test@database.example/test?sslmode=disable"} {
		t.Setenv("NOWPAYMENTS_OPERATIONAL_DATABASE_URL", bad)
		if _, err := loadNOWPaymentsOperationalSettings(reader, capture); err == nil {
			t.Fatal("nonisolated writer accepted")
		}
	}
}

func TestNOWPaymentsOperationalReadOnlyAllowsOnlyExplicitProviderCheckout(t *testing.T) {
	var calls int
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(http.StatusAccepted) })
	config := Config{ReadOnly: true, NOWPaymentsOperational: NOWPaymentsOperationalSettings{Enabled: true}}
	for _, tc := range []struct {
		path, body string
		want       int
	}{
		{"/api/payments/checkout", `{"provider":"nowpayments"}`, http.StatusAccepted},
		{"/api/payments/checkout", `{"provider":"stripe"}`, http.StatusServiceUnavailable},
		{"/api/payments/checkout", `{}`, http.StatusServiceUnavailable},
		{"/api/payments/checkout?other=1", `{"provider":"nowpayments"}`, http.StatusServiceUnavailable},
		{"/api/admin/refund", `{"provider":"nowpayments"}`, http.StatusServiceUnavailable},
	} {
		w := httptest.NewRecorder()
		config.ReadOnlyHandler(next).ServeHTTP(w, httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body)))
		if w.Code != tc.want {
			t.Fatal("read-only boundary changed", tc.path, w.Code)
		}
	}
	if calls != 1 {
		t.Fatal("unrelated finance reached handler", calls)
	}
}

func TestNOWPaymentsOperationalReadinessIsPrivateAndSanitized(t *testing.T) {
	h, _, _ := fakeNOWMembershipHandler()
	h.serviceToken = "synthetic-service-token"
	calls := 0
	h.SetNOWOperationalReadinessRunner(func(context.Context) error { calls++; return nil })
	config := Config{ReadOnly: true, NOWPaymentsOperational: NOWPaymentsOperationalSettings{Enabled: true}}
	invoke := func(method, path, token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, nil)
		if token != "" {
			r.Header.Set("X-VP-Service-Token", token)
		}
		w := httptest.NewRecorder()
		config.ReadOnlyHandler(http.HandlerFunc(h.handleNOWOperationalReadiness)).ServeHTTP(w, r)
		return w
	}
	for _, tc := range []struct{ method, path, token string }{
		{http.MethodGet, nowReadyPath, ""}, {http.MethodGet, nowReadyPath, "wrong"},
		{http.MethodPost, nowReadyPath, "synthetic-service-token"}, {http.MethodGet, nowReadyPath + "?force=1", "synthetic-service-token"},
	} {
		if w := invoke(tc.method, tc.path, tc.token); w.Code == http.StatusOK {
			t.Fatal("unauthorized/parameterized readiness accepted")
		}
	}
	if calls != 0 {
		t.Fatal("unauthorized readiness reached database", calls)
	}
	if w := invoke(http.MethodGet, nowReadyPath, "synthetic-service-token"); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"ready":true`) || !strings.Contains(w.Body.String(), `"engine_schema":1`) {
		t.Fatal("private readiness proof missing", w.Code, w.Body.String())
	}
	h.SetNOWOperationalReadinessRunner(func(context.Context) error { return errors.New("postgres://must-not-leak") })
	if w := invoke(http.MethodGet, nowReadyPath, "synthetic-service-token"); w.Code != http.StatusServiceUnavailable || strings.Contains(w.Body.String(), "postgres") {
		t.Fatal("readiness leaked private diagnostics", w.Code)
	}
}

func TestNOWPaymentsOperationalActivationIntegration(t *testing.T) {
	if testing.Short() {
		t.Skip("isolated PostgreSQL testcontainer")
	}
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
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
	if _, err := pool.Exec(ctx, `INSERT INTO auth.user(id,email,email_verified) VALUES('synthetic-operational','operational@example.test',true);
 INSERT INTO mlm.person(first_name,last_name,email,phone_number,status,user_id) VALUES('Synthetic','Operational','operational@example.test','0','active','synthetic-operational');
 INSERT INTO identity.auth_binding(subject,person_id,link_method) SELECT 'synthetic-operational',id,'new_registration' FROM mlm.person WHERE user_id='synthetic-operational';
 INSERT INTO mlm.package(id,name,amount_usd,pv,type) VALUES(7901,'Synthetic operational',100,100,'enrollment');
 INSERT INTO mlm.asset(id,symbol,name,is_fiat,decimals) VALUES(1,'USD','US Dollar',true,2) ON CONFLICT(symbol) DO NOTHING;
 CREATE TABLE payments.stripe_sale(payment_intent_id text PRIMARY KEY);
 INSERT INTO payments.stripe_sale VALUES('pi_recovery_untouched');`); err != nil {
		t.Fatal(err)
	}
	store := NewNOWPaymentsOperationalStore(pool)
	store.SetNOWOperationalReadiness(func(context.Context, pgx.Tx) error { return nil })
	in := NOWPaymentsMembershipInput{Subject: "synthetic-operational", Email: "operational@example.test", Environment: "production", PackageID: 7901, PurchaseRequestID: uuid.NewString()}
	if _, err := store.CreateNOWPaymentsMembership(ctx, in); !errors.Is(err, ErrNOWOperationalPlan) {
		t.Fatal("invoice order proceeded without active approved plan", err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM payments.nowpayments_membership_attempt`).Scan(&count); err != nil || count != 0 {
		t.Fatal("failed preflight persisted payable order", count, err)
	}
	admin := seedAdmin(t, ctx, pool, "plan-admin@example.test")
	seedActivePlan(t, ctx, pool, admin)
	// Existing placement must not move or acquire a different sponsor/rank.
	var affiliateID int64
	if err := pool.QueryRow(ctx, `INSERT INTO mlm.affiliate(person_id,parent_id,position,status,path,depth)
 SELECT id,NULL,NULL,'active',''::ltree,0 FROM mlm.person WHERE user_id='synthetic-operational' RETURNING id`).Scan(&affiliateID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE ROLE now_ops_synthetic LOGIN NOINHERIT PASSWORD 'synthetic-isolated-only';
 GRANT USAGE ON SCHEMA auth,identity,mlm,payments TO now_ops_synthetic;
 GRANT SELECT ON auth.user,identity.auth_binding,mlm.person,mlm.affiliate,mlm.affiliate_closure,mlm.package,mlm.plan_config,
 mlm.cd_roi_tier,mlm.asset,mlm.concept,mlm.package_cap_state,mlm.blacklist,mlm.wallet,mlm.affiliate_package,mlm.investment_cd,
 mlm.tree_event,payments.purchase_intent,payments.nowpayments_membership_attempt,payments.nowpayments_membership_receipt,
 payments.nowpayments_payment_binding,payments.nowpayments_operational_order,payments.nowpayments_operational_pv_source,
 payments.nowpayments_operational_inflow,payments.nowpayments_operational_job,payments.nowpayments_webhook_capture,
 payments.nowpayments_purchase_request,payments.nowpayments_purchase_cancellation TO now_ops_synthetic;
 GRANT INSERT ON payments.nowpayments_membership_attempt,payments.nowpayments_membership_receipt,payments.nowpayments_payment_binding,
 payments.nowpayments_operational_order,payments.nowpayments_operational_pv_source,payments.nowpayments_operational_inflow,payments.nowpayments_operational_job,
 mlm.affiliate,mlm.affiliate_closure,mlm.affiliate_package,mlm.package_cap_state,mlm.investment_cd,mlm.wallet,
 payments.nowpayments_purchase_request,payments.nowpayments_purchase_cancellation TO now_ops_synthetic;
 GRANT UPDATE(state,invoice_id,payment_id,review_reason,updated_at,checkout_open) ON payments.nowpayments_membership_attempt TO now_ops_synthetic;
 GRANT UPDATE(updated_at) ON mlm.person TO now_ops_synthetic;
 GRANT UPDATE(state,affiliate_id,affiliate_package_id,investment_cd_id,pv_source_id,inflow_id,activated_at,updated_at) ON payments.nowpayments_operational_order TO now_ops_synthetic;
 GRANT UPDATE(capture_id,state,attempts,available_at,lease_token,lease_until,last_error_code,updated_at) ON payments.nowpayments_operational_job TO now_ops_synthetic;
 GRANT UPDATE(left_count,right_count,updated_at) ON mlm.affiliate TO now_ops_synthetic;
 GRANT USAGE,SELECT ON SEQUENCE mlm.affiliate_id_seq,mlm.affiliate_package_id_seq,mlm.investment_cd_id_seq,mlm.wallet_id_seq,
 payments.nowpayments_membership_receipt_id_seq,payments.nowpayments_operational_pv_source_id_seq,payments.nowpayments_operational_inflow_id_seq TO now_ops_synthetic;`); err != nil {
		t.Fatal("narrow role grants", err)
	}
	writerConfig := pool.Config()
	writerConfig.ConnConfig.User = "now_ops_synthetic"
	writerConfig.ConnConfig.Password = "synthetic-isolated-only"
	writerPool, err := pgxpool.NewWithConfig(ctx, writerConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer writerPool.Close()
	store.db = writerPool
	var placementPerson int64
	if err := pool.QueryRow(ctx, `INSERT INTO mlm.person(first_name,last_name,email,phone_number,status) VALUES('Synthetic','NOW placement','placement@example.test','0','active') RETURNING id`).Scan(&placementPerson); err != nil {
		t.Fatal(err)
	}
	placementTx, err := writerPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	placed, err := autoPlaceNOWAffiliate(ctx, placementTx, placementPerson, affiliateID, "R")
	if err != nil {
		_ = placementTx.Rollback(ctx)
		t.Fatal("NOW-only restricted placement", err)
	}
	if err := placementTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var placementSafe bool
	if err := pool.QueryRow(ctx, `SELECT a.parent_id=$1 AND a.position='R' AND parent.right_count=1 AND parent.left_pv_lifetime=0 AND parent.right_pv_lifetime=0
 AND NOT EXISTS(SELECT 1 FROM mlm.tree_event) FROM mlm.affiliate a JOIN mlm.affiliate parent ON parent.id=a.parent_id WHERE a.id=$2`, affiliateID, placed).Scan(&placementSafe); err != nil || !placementSafe {
		t.Fatal("NOW placement changed global PV or wrong side", err)
	}
	var noPVWrite bool
	if err := writerPool.QueryRow(ctx, `SELECT NOT has_column_privilege(current_user,'mlm.affiliate','left_pv_lifetime','UPDATE') AND NOT has_table_privilege(current_user,'mlm.tree_event','INSERT')`).Scan(&noPVWrite); err != nil || !noPVWrite {
		t.Fatal("NOW writer can mutate global PV", err)
	}
	for _, statement := range []string{`UPDATE payments.stripe_sale SET payment_intent_id='forbidden'`, `UPDATE auth.user SET email_verified=false`, `INSERT INTO mlm.wallet_movement(transaction_id,wallet_id,affiliate_id,concept_id,amount) VALUES(gen_random_uuid(),1,1,1004,99)`, `UPDATE payments.nowpayments_webhook_capture SET risk_detected=false`} {
		if _, err := writerPool.Exec(ctx, statement); err == nil {
			t.Fatal("operational role can mutate unrelated evidence/finance", statement)
		}
	}
	order, err := store.CreateNOWPaymentsMembership(ctx, in)
	if err != nil {
		t.Fatal("operational order", err)
	}
	if err := store.AttachNOWPaymentsInvoice(ctx, order.ID, "production", "79001"); err != nil {
		t.Fatal(err)
	}
	payment := syntheticNOWPayment(order.ID, "79001", "790001", "finished")
	payment.PriceAmount, payment.PayAmount, payment.ActuallyPaid = "100.00", "100", "100"
	capture := NewNOWPaymentsCaptureStore(pool)
	digest := strings.Repeat("a", 64)
	if err := capture.Capture(ctx, "production", payment, payment, digest); err != nil {
		t.Fatal(err)
	}
	if queued, err := store.enqueueNOWOperationalPayment(ctx, "production", order.ID, string(payment.PaymentID), digest); err != nil || !queued {
		t.Fatal("durable enqueue", queued, err)
	}
	// A failed fulfillment rolls back all business artifacts, keeps the durable
	// job retryable, and does not require another provider charge/IPN delivery.
	if _, err := pool.Exec(ctx, `REVOKE INSERT ON mlm.investment_cd FROM now_ops_synthetic`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.RunNOWOperationalJobs(ctx, 5); err == nil {
		t.Fatal("fault-injected fulfillment should retry")
	}
	var retriable bool
	if err := pool.QueryRow(ctx, `SELECT state='queued' AND attempts=1 AND last_error_code='processing_unavailable' AND NOT EXISTS(SELECT 1 FROM mlm.affiliate_package) FROM payments.nowpayments_operational_job WHERE attempt_id=$1::uuid`, order.ID).Scan(&retriable); err != nil || !retriable {
		t.Fatal("failed delivery lost its job or partially activated", err)
	}
	if _, err := pool.Exec(ctx, `GRANT INSERT ON mlm.investment_cd TO now_ops_synthetic; UPDATE payments.nowpayments_operational_job SET available_at=now(),state='running',lease_until=now()-interval '1 second',lease_token=gen_random_uuid()`); err != nil {
		t.Fatal(err)
	}
	if n, err := store.RunNOWOperationalJobs(ctx, 5); err != nil || n != 1 {
		t.Fatal("durable worker", n, err)
	}
	if n, err := store.RunNOWOperationalJobs(ctx, 5); err != nil || n != 0 {
		t.Fatal("completed durable job was replayed", n, err)
	}
	for range 2 {
		if state, err := store.processNOWOperationalPayment(ctx, "production", payment, payment, digest); err != nil || state != "activated" {
			t.Fatal("activation/replay", state, err)
		}
	}
	var packages, cds, pvSources, treePV, stripeRows int
	var gross, net, method string
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM mlm.affiliate_package),(SELECT count(*) FROM mlm.investment_cd),
 (SELECT count(*) FROM payments.nowpayments_operational_pv_source),(SELECT count(*) FROM mlm.tree_event WHERE kind='pv_credit'),
 (SELECT count(*) FROM payments.stripe_sale),cd.principal_usd::text,f.net_usd::text,ap.payment_method
 FROM payments.nowpayments_operational_order o JOIN mlm.affiliate_package ap ON ap.id=o.affiliate_package_id
 JOIN mlm.investment_cd cd ON cd.id=o.investment_cd_id JOIN payments.nowpayments_operational_inflow f ON f.id=o.inflow_id WHERE o.attempt_id=$1::uuid`, order.ID).Scan(&packages, &cds, &pvSources, &treePV, &stripeRows, &gross, &net, &method); err != nil {
		t.Fatal(err)
	}
	if packages != 1 || cds != 1 || pvSources != 1 || treePV != 0 || stripeRows != 1 || gross != "100.00" || !strings.HasPrefix(net, "99.") || method != "nowpayments" {
		t.Fatal("NOW artifacts are not isolated/idempotent", packages, cds, pvSources, treePV, stripeRows, gross, net, method)
	}
	if err := financialguard.RequireOperational(ctx, pool); !errors.Is(err, financialguard.ErrRecoveryReview) {
		t.Fatal("legacy global guard unlocked", err)
	}
	var walletSafe bool
	if err := pool.QueryRow(ctx, `SELECT NOT EXISTS(SELECT 1 FROM mlm.wallet WHERE balance<>0) AND NOT EXISTS(SELECT 1 FROM mlm.wallet_movement)`).Scan(&walletSafe); err != nil || !walletSafe {
		t.Fatal("membership purchase credited a member wallet", err)
	}
	payment.Status = "refunded"
	if err := capture.Capture(ctx, "production", payment, payment, strings.Repeat("b", 64)); err != nil {
		t.Fatal(err)
	}
	if state, err := store.processNOWOperationalPayment(ctx, "production", payment, payment, strings.Repeat("b", 64)); err != nil || state != "risk_review" {
		t.Fatal("refund not held", state, err)
	}
	if state, err := store.ownedNOWOperationalState(ctx, "production", order.ID, "other-subject", "operational@example.test"); err != nil || state != "" {
		t.Fatal("foreign owner saw order", state, err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO mlm.package(id,name,amount_usd,pv,type) VALUES(7904,'Synthetic identity hold',100,100,'enrollment')`); err != nil {
		t.Fatal(err)
	}
	heldInput := in
	heldInput.PackageID = 7904
	heldInput.PurchaseRequestID = uuid.NewString()
	heldOrder, err := store.CreateNOWPaymentsMembership(ctx, heldInput)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.AttachNOWPaymentsInvoice(ctx, heldOrder.ID, "production", "79004"); err != nil {
		t.Fatal(err)
	}
	heldPayment := payment
	heldPayment.OrderID = heldOrder.ID
	heldPayment.InvoiceID = "79004"
	heldPayment.PaymentID = "790004"
	heldPayment.Status = "finished"
	if err := capture.Capture(ctx, "production", heldPayment, heldPayment, strings.Repeat("d", 64)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.enqueueNOWOperationalPayment(ctx, "production", heldOrder.ID, string(heldPayment.PaymentID), strings.Repeat("d", 64)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE auth.user SET email_verified=false WHERE id='synthetic-operational'`); err != nil {
		t.Fatal(err)
	}
	if n, err := store.RunNOWOperationalJobs(ctx, 5); err != nil || n != 1 {
		t.Fatal("permanent identity failure was retried/starved the batch", n, err)
	}
	var heldAudit bool
	if err := pool.QueryRow(ctx, `SELECT o.state='security_blocked' AND j.state='held' AND j.last_error_code='identity_review_required'
 AND o.activated_at IS NULL FROM payments.nowpayments_operational_order o JOIN payments.nowpayments_operational_job j USING(attempt_id) WHERE o.attempt_id=$1::uuid`, heldOrder.ID).Scan(&heldAudit); err != nil || !heldAudit {
		t.Fatal("permanent identity hold missing durable audit", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE auth.user SET email_verified=true WHERE id='synthetic-operational'`); err != nil {
		t.Fatal(err)
	}
	// Reserve 4,999 total slots using only synthetic, never-invoiced orders.
	// At the boundary two concurrent checkouts can observe the same RR snapshot;
	// the unique database slot, not a stale COUNT or environment flag, decides.
	if _, err := pool.Exec(ctx, `INSERT INTO mlm.package(id,name,amount_usd,pv,type)
 SELECT 80000+g,'Synthetic capacity reserve',100,100,'enrollment' FROM generate_series(3,4999) g;
 INSERT INTO mlm.package(id,name,amount_usd,pv,type) VALUES(7902,'Synthetic final slot A',100,100,'enrollment'),(7903,'Synthetic final slot B',100,100,'enrollment');
 WITH added AS(INSERT INTO payments.nowpayments_membership_attempt(environment,auth_subject,person_id,person_public_id,package_id,package_name,pv,amount_usd,fee_usd,total_cents,pricing_policy,provider_cost_usd,commission_base_usd)
 SELECT 'production','synthetic-operational',p.id,p.public_id,80000+g,'Synthetic capacity reserve',100,100,0,10000,'catalog_includes_provider_1pct_v1',1,99
 FROM generate_series(3,4999) g CROSS JOIN mlm.person p WHERE p.user_id='synthetic-operational' RETURNING id,package_id)
 INSERT INTO payments.nowpayments_operational_order(attempt_id,capacity_slot,plan_config_id,roi_tier_id,cd_lock_days,lifetime_cap_factor,plan_snapshot,roi_base_annual_rate,roi_qualified_annual_rate)
 SELECT a.id,a.package_id-80000,o.plan_config_id,o.roi_tier_id,o.cd_lock_days,o.lifetime_cap_factor,o.plan_snapshot,o.roi_base_annual_rate,o.roi_qualified_annual_rate FROM added a
 CROSS JOIN LATERAL(SELECT * FROM payments.nowpayments_operational_order ORDER BY capacity_slot LIMIT 1)o;`); err != nil {
		t.Fatal("synthetic capacity fixture", err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, pkg := range []int{7902, 7903} {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			candidate := in
			candidate.PackageID = id
			candidate.PurchaseRequestID = uuid.NewString()
			_, err := store.CreateNOWPaymentsMembership(ctx, candidate)
			results <- err
		}(pkg)
	}
	wg.Wait()
	close(results)
	created, rejected := 0, 0
	for err := range results {
		if err == nil {
			created++
		} else if errors.Is(err, ErrNOWOperationalPlan) {
			rejected++
		} else {
			t.Fatal("unexpected capacity outcome", err)
		}
	}
	if created != 1 || rejected != 1 {
		t.Fatal("concurrent checkout exceeded hard capacity before invoice", created, rejected)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM payments.nowpayments_operational_order`).Scan(&count); err != nil || count != 5000 {
		t.Fatal("capacity reservation mismatch", count, err)
	}
}
