package payments

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
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
	for _, name := range []string{"70_stable_identity_bindings.sql", "74_nowpayments_membership_review.sql", "75_nowpayments_webhook_capture.sql", "77_nowpayments_included_pricing.sql", "79_nowpayments_operational_orders.sql", "80_nowpayments_scoped_engine.sql", "82_nowpayments_calendar_maturity.sql"} {
		data, err := os.ReadFile(filepath.Join(findRepoRoot(t), "_meta", "migration", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(data)); err != nil {
			t.Fatal(name, err)
		}
	}
	applyNOWPurchaseLifecycleMigration(t, ctx, pool)
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
	writer := nowEngineRestrictedWriter(t, ctx, pool)
	defer writer.Close()
	service := nowengine.New(writer, root)
	assertReadOnlyReady := func(stage string) {
		t.Helper()
		tx, err := writer.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
		if err != nil {
			t.Fatal(stage, err)
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, `SET LOCAL ROLE now_engine_synthetic`); err != nil {
			t.Fatal("restricted read-only role", err)
		}
		const snapshotSQL = `SELECT jsonb_build_object('orders',(SELECT count(*) FROM payments.nowpayments_operational_order),
 'periods',(SELECT count(*) FROM payments.nowpayments_engine_period),'roi',(SELECT count(*) FROM payments.nowpayments_engine_roi_state),
 'rate_days',(SELECT count(*) FROM payments.nowpayments_engine_roi_rate_day),'obligations',(SELECT count(*) FROM payments.nowpayments_engine_obligation),
 'payments',(SELECT count(*) FROM payments.nowpayments_engine_payment),'wallets',(SELECT count(*) FROM mlm.wallet),
 'last_run',(SELECT last_run_at FROM payments.nowpayments_engine_control WHERE singleton))::text`
		var before, after string
		if err := tx.QueryRow(ctx, snapshotSQL).Scan(&before); err != nil {
			t.Fatal(stage, err)
		}
		if err := service.ValidateReady(ctx, tx); err != nil {
			t.Fatal("read-only readiness "+stage, err)
		}
		if err := tx.QueryRow(ctx, snapshotSQL).Scan(&after); err != nil || after != before {
			t.Fatal("readiness mutated state "+stage, err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal("read-only readiness commit "+stage, err)
		}
	}
	assertReadOnlyReady("zero sources")
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
		order, err := store.CreateNOWPaymentsMembership(ctx, NOWPaymentsMembershipInput{Subject: subject, Email: email, Environment: "production", PackageID: 8001, PurchaseRequestID: uuid.NewString()})
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
	assertReadOnlyReady("activated sources")
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
	var maturityUnchanged, calendarHold, commissionEvidence, legacyDateConservative bool
	if err := pool.QueryRow(ctx, `SELECT
 NOT EXISTS(SELECT 1 FROM payments.nowpayments_engine_obligation e JOIN payments.nowpayments_operational_order o ON o.attempt_id=e.source_attempt_id
 JOIN mlm.investment_cd cd ON cd.id=o.investment_cd_id WHERE e.kind='roi' AND e.available_at<>cd.matures_at),
 NOT EXISTS(SELECT 1 FROM payments.nowpayments_engine_obligation WHERE kind<>'roi' AND
 (available_at<>((created_at AT TIME ZONE 'America/Bogota')+interval '1 month') AT TIME ZONE 'America/Bogota' OR available_at<=created_at)),
 EXISTS(SELECT 1 FROM payments.nowpayments_engine_obligation e JOIN payments.nowpayments_engine_payment p ON p.obligation_id=e.id
 WHERE e.kind<>'roi' AND p.posted_at<e.created_at-interval '7 days' AND e.available_at>now()),
 NOT EXISTS(SELECT 1 FROM mlm.wallet_movement wm JOIN mlm.transaction t ON t.id=wm.transaction_id
 JOIN payments.nowpayments_engine_payment p ON p.transaction_ref=t.external_ref JOIN payments.nowpayments_engine_obligation e ON e.id=p.obligation_id
 WHERE wm.available_at IS NULL OR (wm.available_at::timestamp AT TIME ZONE 'UTC')<e.available_at)`).Scan(&maturityUnchanged, &calendarHold, &commissionEvidence, &legacyDateConservative); err != nil || !maturityUnchanged || !calendarHold || !commissionEvidence || !legacyDateConservative {
		t.Fatal("calendar/ROI maturity or UTC DATE projection violated", maturityUnchanged, calendarHold, commissionEvidence, legacyDateConservative, err)
	}
	assertNOWCalendarMonthPostgres(t, ctx, pool)
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

// The disposable database checks PostgreSQL's actual calendar arithmetic and
// the production constraint, not a second, subtly different Go month helper.
func assertNOWCalendarMonthPostgres(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	for _, timezone := range []string{"UTC", "Pacific/Auckland"} {
		for _, tc := range []struct{ name, created, available string }{
			{"ordinary", "2026-01-15T15:30:12.123456-05:00", "2026-02-15T15:30:12.123456-05:00"},
			{"nonleap_clamp", "2026-01-31T15:30:12.123456-05:00", "2026-02-28T15:30:12.123456-05:00"},
			{"leap_clamp", "2028-01-31T23:59:59.999999-05:00", "2028-02-29T23:59:59.999999-05:00"},
			{"leap_day", "2028-02-29T00:00:00-05:00", "2028-03-29T00:00:00-05:00"},
			{"not_end_of_following_month", "2026-04-30T08:45:10-05:00", "2026-05-30T08:45:10-05:00"},
			{"year_rollover", "2026-12-31T23:59:59-05:00", "2027-01-31T23:59:59-05:00"},
			{"utc_is_next_civil_day", "2026-03-01T02:30:00Z", "2026-03-29T02:30:00Z"},
		} {
			t.Run("calendar_month/"+timezone+"/"+tc.name, func(t *testing.T) {
				tx, err := pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback(ctx)
				if _, err := tx.Exec(ctx, `SELECT set_config('TimeZone',$1,true)`, timezone); err != nil {
					t.Fatal(err)
				}
				created, err := time.Parse(time.RFC3339Nano, tc.created)
				if err != nil {
					t.Fatal(err)
				}
				available, err := time.Parse(time.RFC3339Nano, tc.available)
				if err != nil {
					t.Fatal(err)
				}
				var actual time.Time
				if err := tx.QueryRow(ctx, `SELECT (($1::timestamptz AT TIME ZONE 'America/Bogota')+interval '1 month') AT TIME ZONE 'America/Bogota'`, created).Scan(&actual); err != nil || !actual.Equal(available) {
					t.Fatal("calendar wall-clock calculation", actual, available, err)
				}
				for _, kind := range []string{"direct_bonus", "royalty", "binary_bonus"} {
					const insert = `INSERT INTO payments.nowpayments_engine_obligation(external_ref,source_attempt_id,period_id,affiliate_id,affiliate_package_id,kind,
 entitlement_usd,commission_factor,available_at,created_at)
 SELECT $1,source_attempt_id,period_id,affiliate_id,affiliate_package_id,$2,1,.99,$3,$4
 FROM payments.nowpayments_engine_obligation WHERE kind<>'roi' ORDER BY id LIMIT 1 RETURNING available_at`
					if err := tx.QueryRow(ctx, insert, "now:calendar-test:"+kind, kind, available, created).Scan(&actual); err != nil || !actual.Equal(available) {
						t.Fatal("constraint rejected calendar month", kind, actual, err)
					}
					for _, invalid := range []time.Time{created, available.Add(-time.Microsecond), available.Add(time.Microsecond)} {
						sp, err := tx.Begin(ctx)
						if err != nil {
							t.Fatal(err)
						}
						err = sp.QueryRow(ctx, insert, "now:calendar-invalid:"+kind, kind, invalid, created).Scan(&actual)
						_ = sp.Rollback(ctx)
						var pgErr *pgconn.PgError
						if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
							t.Fatal("constraint accepted a shifted calendar maturity", kind, err)
						}
					}
				}
			})
		}
	}
}

func nowEngineRestrictedWriter(t *testing.T, ctx context.Context, pool *pgxpool.Pool) *pgxpool.Pool {
	t.Helper()
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
	defer grantTx.Rollback(ctx)
	if _, err := grantTx.Exec(ctx, `SELECT set_config('mindbliss.nowpayments_operations_role','now_engine_synthetic',true)`); err != nil {
		t.Fatal(err)
	}
	if _, err := grantTx.Exec(ctx, string(manifest)); err != nil {
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
	return writer
}
