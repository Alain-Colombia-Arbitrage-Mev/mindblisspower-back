package payments

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/vicionpower/vp-engine/internal/nowengine"
	"github.com/vicionpower/vp-engine/internal/shared/financialguard"
)

func TestNOWScopedEnginePostgresRestrictedRole(t *testing.T) {
	if testing.Short() {
		t.Skip("isolated PostgreSQL testcontainer")
	}
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	for _, name := range []string{"70_stable_identity_bindings.sql", "74_nowpayments_membership_review.sql", "75_nowpayments_webhook_capture.sql", "77_nowpayments_included_pricing.sql", "79_nowpayments_operational_orders.sql", "80_nowpayments_scoped_engine.sql"} {
		data, err := os.ReadFile(filepath.Join(findRepoRoot(t), "_meta", "migration", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(data)); err != nil {
			t.Fatal(name, err)
		}
	}
	admin := seedAdmin(t, ctx, pool, "devfidubit@gmail.com")
	var root int64
	if err := pool.QueryRow(ctx, `INSERT INTO mlm.affiliate(person_id,parent_id,position,status) VALUES($1,NULL,NULL,'active') RETURNING id`, admin).Scan(&root); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(findRepoRoot(t), "_meta", "migration", "33_seed_plan_config.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, string(data)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO mlm.asset(id,symbol,name,is_fiat,decimals) VALUES(1,'USD','US Dollar',true,2) ON CONFLICT(symbol) DO NOTHING;
 INSERT INTO mlm.package(id,name,amount_usd,pv,type) VALUES(8001,'NOW synthetic 1000',1000,1000,'enrollment');
 INSERT INTO mlm.concept(id,kind,name_es,name_en,factor,requires_pair,active) VALUES(1100,'binary_bonus','Binario NOW sintético','Synthetic NOW binary',1,false,true);
 CREATE TABLE payments.stripe_sale(payment_intent_id text PRIMARY KEY);
 INSERT INTO payments.stripe_sale VALUES('pi_legacy_frozen');`); err != nil {
		t.Fatal(err)
	}
	service := nowengine.New(pool, root)
	store := NewNOWPaymentsOperationalStore(pool)
	store.SetNOWOperationalReadiness(service.ValidateReady)
	capture := NewNOWPaymentsCaptureStore(pool)
	affiliates := map[string]int64{"root": root}
	orders := []NOWPaymentsMembershipAttempt{}
	parent := "root"
	for index, name := range []string{"grand", "manager", "left", "right"} {
		position := "L"
		if name == "right" {
			position = "R"
		}
		if name == "left" || name == "right" {
			parent = "manager"
		}
		subject := "synthetic-now-engine-" + name
		email := name + "@now-engine.example.test"
		if _, err := pool.Exec(ctx, `INSERT INTO auth.user(id,email,email_verified) VALUES($1,$2,true)`, subject, email); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO mlm.person(first_name,last_name,email,phone_number,status,user_id) VALUES($1,'NOWEngine',$2,'0','active',$3)`, name, email, subject); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO identity.auth_binding(subject,person_id,link_method) SELECT $1,id,'new_registration' FROM mlm.person WHERE user_id=$1`, subject); err != nil {
			t.Fatal(err)
		}
		var affiliate int64
		if err := pool.QueryRow(ctx, `INSERT INTO mlm.affiliate(person_id,parent_id,sponsor_id,position,status)
 SELECT id,$2,$2,$3::mlm.tree_position,'active' FROM mlm.person WHERE user_id=$1 RETURNING id`, subject, affiliates[parent], position).Scan(&affiliate); err != nil {
			t.Fatal(err)
		}
		affiliates[name] = affiliate
		order, err := store.CreateNOWPaymentsMembership(ctx, NOWPaymentsMembershipInput{Subject: subject, Email: email, Environment: "production", PackageID: 8001})
		if err != nil {
			t.Fatal("create engine-owned NOW order", name, err)
		}
		invoice, paymentID := fmt.Sprintf("8000%d", index+1), fmt.Sprintf("80000%d", index+1)
		if err := store.AttachNOWPaymentsInvoice(ctx, order.ID, "production", invoice); err != nil {
			t.Fatal(err)
		}
		payment := syntheticNOWPayment(order.ID, invoice, paymentID, "finished")
		payment.PriceAmount = "1000.00"
		payment.PayAmount = "1000"
		payment.ActuallyPaid = "1000"
		hash := fmt.Sprintf("%064x", index+1)
		if err := capture.Capture(ctx, "production", payment, payment, hash); err != nil {
			t.Fatal(err)
		}
		if state, err := store.processNOWOperationalPayment(ctx, "production", payment, payment, hash); err != nil || state != "activated" {
			t.Fatal("activate fixture", state, err)
		}
		orders = append(orders, order)
		if name == "grand" {
			parent = "grand"
		}
	}
	// Only the disposable fixture is backdated. Production code exposes no clock
	// override or history mutation route. The immutable trigger is restored before
	// the restricted application login or engine is used.
	if _, err := pool.Exec(ctx, `ALTER TABLE payments.nowpayments_operational_order DISABLE TRIGGER nowpayments_operational_order_immutable;
 UPDATE payments.nowpayments_operational_order SET activated_at=date_trunc('week',now() AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota'-interval '14 days';
 ALTER TABLE payments.nowpayments_operational_order ENABLE TRIGGER nowpayments_operational_order_immutable;
 UPDATE mlm.affiliate_package SET activated_at=date_trunc('week',now() AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota'-interval '14 days';
 UPDATE mlm.investment_cd SET start_at=date_trunc('week',now() AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota'-interval '14 days',matures_at=(date_trunc('week',now() AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota')+interval '351 days';
 UPDATE mlm.affiliate SET left_pv_lifetime=100000000,right_pv_lifetime=100000000 WHERE id IN(SELECT affiliate_id FROM payments.nowpayments_operational_order);`); err != nil {
		t.Fatal("backdate isolated fixture", err)
	}
	if _, err := pool.Exec(ctx, `CREATE ROLE now_engine_synthetic LOGIN NOINHERIT PASSWORD 'synthetic-isolated-only'`); err != nil {
		t.Fatal(err)
	}
	manifest, err := os.ReadFile(filepath.Join(findRepoRoot(t), "_meta", "roles", "nowpayments_operational_runtime.sql"))
	if err != nil {
		t.Fatal(err)
	}
	grantTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := grantTx.Exec(ctx, `SELECT set_config('mindbliss.nowpayments_operations_role','now_engine_synthetic',true)`); err != nil {
		grantTx.Rollback(ctx)
		t.Fatal(err)
	}
	if _, err := grantTx.Exec(ctx, string(manifest)); err != nil {
		grantTx.Rollback(ctx)
		t.Fatal("exact production runtime manifest", err)
	}
	if err := grantTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	cfg := pool.Config()
	cfg.ConnConfig.User = "now_engine_synthetic"
	cfg.ConnConfig.Password = "synthetic-isolated-only"
	writer, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	service = nowengine.New(writer, root)
	if err := service.Run(ctx); err != nil {
		t.Fatal("first bounded backlog batch", err)
	}
	var days int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM payments.nowpayments_engine_roi_rate_day`).Scan(&days); err != nil || days != 4 {
		t.Fatal("partial daily batch was not committed", days, err)
	}
	for range 31 {
		if err := service.Run(ctx); err != nil {
			t.Fatal("scoped engine", err)
		}
	}
	var accruedSources int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM payments.nowpayments_engine_roi_state`).Scan(&accruedSources); err != nil || accruedSources != len(orders) {
		t.Fatal("backlog repeatedly processed only its prefix", accruedSources, len(orders), err)
	}
	var before, after int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM payments.nowpayments_engine_payment`).Scan(&before); err != nil || before == 0 {
		t.Fatal("no accruals posted", err)
	}
	if err := service.Run(ctx); err != nil {
		t.Fatal("idempotent replay", err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM payments.nowpayments_engine_payment`).Scan(&after); err != nil || after != before {
		t.Fatal("replay duplicated ledger", before, after, err)
	}
	var referrals, binary, royalty decimal.Decimal
	if err := pool.QueryRow(ctx, `SELECT COALESCE(sum(entitlement_usd) FILTER(WHERE kind='direct_bonus'),0),COALESCE(sum(entitlement_usd) FILTER(WHERE kind='binary_bonus'),0),COALESCE(sum(entitlement_usd) FILTER(WHERE kind='royalty'),0) FROM payments.nowpayments_engine_obligation`).Scan(&referrals, &binary, &royalty); err != nil {
		t.Fatal(err)
	}
	if !referrals.Equal(decimal.NewFromInt(99)) || !binary.Equal(decimal.RequireFromString("19.80")) || !royalty.Equal(decimal.NewFromInt(99)) {
		t.Fatal("wrong net/legacy-PV compensation", referrals, binary, royalty)
	}
	var capUsage, limitedPaid decimal.Decimal
	if err := pool.QueryRow(ctx, `SELECT (SELECT COALESCE(sum(paid_total),0) FROM mlm.package_cap_state),
 (SELECT COALESCE(sum(p.amount_usd),0) FROM payments.nowpayments_engine_payment p JOIN payments.nowpayments_engine_obligation e ON e.id=p.obligation_id WHERE e.kind IN('roi','binary_bonus'))`).Scan(&capUsage, &limitedPaid); err != nil || !capUsage.Equal(limitedPaid) {
		t.Fatal("referral/royalty wrongly consumed ROI/binary cap", capUsage, limitedPaid, err)
	}
	var isolated bool
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM payments.stripe_sale)=1 AND NOT EXISTS(SELECT 1 FROM mlm.binary_period)
 AND NOT EXISTS(SELECT 1 FROM mlm.tree_event WHERE kind='pv_credit')
 AND NOT EXISTS(SELECT 1 FROM mlm.wallet_movement wm JOIN mlm.transaction t ON t.id=wm.transaction_id WHERE t.external_ref NOT LIKE 'now:%')
 AND NOT EXISTS(SELECT 1 FROM mlm.wallet_movement WHERE available_at<=CURRENT_DATE)
 AND NOT EXISTS(SELECT 1 FROM mlm.affiliate_rank_achieved)`).Scan(&isolated); err != nil || !isolated {
		t.Fatal("legacy or liquid funds changed", isolated, err)
	}
	if err := financialguard.RequireOperational(ctx, pool); err == nil {
		t.Fatal("legacy financial guard removed")
	}
	for _, query := range []string{`DELETE FROM payments.nowpayments_engine_payment`, `UPDATE payments.stripe_sale SET payment_intent_id='forbidden'`, `UPDATE mlm.affiliate SET left_pv_lifetime=0`, `UPDATE mlm.plan_config SET royalty_rate=.99`} {
		if _, err := writer.Exec(ctx, query); err == nil {
			t.Fatal("restricted engine can mutate unrelated history", query)
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE payments.nowpayments_operational_order SET state='risk_review' WHERE attempt_id=$1::uuid`, orders[0].ID); err != nil {
		t.Fatal(err)
	}
	if err := service.Run(ctx); err == nil || !strings.Contains(err.Error(), "risk review") {
		t.Fatal("risk/refund did not freeze future engine", err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM payments.nowpayments_engine_payment`).Scan(&after); err != nil || after != before {
		t.Fatal("risk freeze wrote money", after, before, err)
	}
	tx, err := writer.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := service.ValidateReady(ctx, tx); err == nil {
		t.Fatal("risk invoice readiness accepted")
	}
}
