package payments

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/vicionpower/vp-engine/internal/nowpayments"
)

// Opt-in fixture only: exact loopback/database/user preconditions are checked
// BEFORE connecting. Run in the disposable, network-none PostgreSQL namespace.
func TestNOWCapturePostgresSynthetic(t *testing.T) {
	dsn := os.Getenv("NOWPAYMENTS_CAPTURE_SYNTHETIC_DSN")
	if dsn == "" {
		t.Skip("requires explicit disposable synthetic PostgreSQL")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil || cfg.ConnConfig.Host != "127.0.0.1" || cfg.ConnConfig.Port != 5432 || cfg.ConnConfig.Database != "now_capture_test" || cfg.ConnConfig.User != "postgres" || cfg.ConnConfig.Password != "synthetic-capture-test" || cfg.ConnConfig.TLSConfig != nil {
		t.Fatal("refusing non-synthetic PostgreSQL target")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal("fixture unavailable")
	}
	defer pool.Close()
	var database string
	var empty bool
	if err := pool.QueryRow(ctx, `SELECT current_database(),to_regnamespace('payments') IS NULL AND to_regnamespace('mlm') IS NULL AND to_regnamespace('auth') IS NULL AND to_regnamespace('identity') IS NULL`).Scan(&database, &empty); err != nil || database != "now_capture_test" || !empty {
		t.Fatal("fixture is not a pristine dedicated database")
	}
	_, err = pool.Exec(ctx, `CREATE SCHEMA payments; CREATE SCHEMA auth; CREATE SCHEMA mlm; CREATE SCHEMA identity;
 CREATE TABLE auth.user(id text PRIMARY KEY,email text UNIQUE NOT NULL,email_verified boolean NOT NULL DEFAULT false);
 CREATE TABLE mlm.person(id bigint PRIMARY KEY,public_id uuid UNIQUE NOT NULL,user_id text,email text,status text,blacklisted boolean);
 CREATE TABLE mlm.affiliate(id bigint PRIMARY KEY);
 CREATE TABLE mlm.package(id integer PRIMARY KEY);
 CREATE TABLE identity.auth_binding(provider text,subject text,person_id bigint,PRIMARY KEY(provider,subject));
 CREATE TABLE payments.stripe_sale(id bigint PRIMARY KEY,amount numeric);INSERT INTO payments.stripe_sale VALUES(1,123);
 CREATE TABLE mlm.wallet_movement(id bigint);CREATE TABLE mlm.tree_event(id bigint);CREATE TABLE mlm.affiliate_package(id bigint);
 INSERT INTO auth.user VALUES('capture-owner','owner@example.test',true),('other-subject','other@example.test',true);
 INSERT INTO mlm.person VALUES(1,'ccf27a76-4e26-411c-acaf-8e53bd9e64f6','capture-owner','owner@example.test','active',false);
 INSERT INTO identity.auth_binding VALUES('better_auth','capture-owner',1);
 INSERT INTO mlm.package VALUES(1001),(1002);`)
	if err != nil {
		t.Fatal("seed synthetic schema", err)
	}
	for _, name := range []string{"74_nowpayments_membership_review.sql", "75_nowpayments_webhook_capture.sql"} {
		bytes, err := os.ReadFile(filepath.Join(findRepoRoot(t), "_meta", "migration", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err = pool.Exec(ctx, string(bytes)); err != nil {
			t.Fatal("apply", name, err)
		}
	}
	_, err = pool.Exec(ctx, `INSERT INTO payments.nowpayments_membership_attempt
 (id,environment,auth_subject,person_id,person_public_id,package_id,package_name,pv,amount_usd,fee_usd,total_cents,state,invoice_id)
 VALUES('3f3fba2c-d836-430d-b45e-63fd73050384','production','capture-owner',1,'ccf27a76-4e26-411c-acaf-8e53bd9e64f6',1001,'Synthetic',10,100,1,10100,'invoice_created','9001');
 CREATE ROLE now_capture_synthetic_writer NOLOGIN;
 GRANT USAGE ON SCHEMA payments,auth,mlm,identity TO now_capture_synthetic_writer;
 GRANT SELECT,INSERT ON payments.nowpayments_webhook_capture TO now_capture_synthetic_writer;
 GRANT USAGE ON SEQUENCE payments.nowpayments_webhook_capture_id_seq TO now_capture_synthetic_writer;
 GRANT SELECT(id,environment,state,invoice_id,currency,total_cents,auth_subject,person_id,person_public_id) ON payments.nowpayments_membership_attempt TO now_capture_synthetic_writer;
 GRANT SELECT ON auth.user,identity.auth_binding,mlm.person TO now_capture_synthetic_writer;`)
	if err != nil {
		t.Fatal("seed owned order and restricted role", err)
	}
	restrictedCfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	restrictedCfg.ConnConfig.RuntimeParams["role"] = "now_capture_synthetic_writer"
	restricted, err := pgxpool.NewWithConfig(ctx, restrictedCfg)
	if err != nil {
		t.Fatal(err)
	}
	defer restricted.Close()
	store := NewNOWPaymentsCaptureStore(restricted)
	payment := nowpayments.Payment{PaymentID: "8001", InvoiceID: "9001", OrderID: syntheticNOWOrder, Status: "waiting", PriceAmount: "101", PriceCurrency: "usd", PayAmount: "10", ActuallyPaid: "0", PayCurrency: "trx"}
	capture := func(hash string, p nowpayments.Payment) {
		t.Helper()
		if err := store.Capture(ctx, "production", p, p, strings.Repeat(hash, 64)); err != nil {
			t.Fatal("capture", err)
		}
	}
	read := func() NOWPaymentsCaptureStatus {
		t.Helper()
		s, err := store.OwnedStatus(ctx, "production", syntheticNOWOrder, "capture-owner", "owner@example.test")
		if err != nil {
			t.Fatal("owned status", err)
		}
		return s
	}
	if s := read(); s.Persisted || s.PaymentConfirmed {
		t.Fatal("no evidence must remain pending")
	}
	capture("1", payment)
	if s := read(); s.State != "pending" || !s.Persisted || s.PaymentConfirmed {
		t.Fatal("waiting must not complete")
	}
	payment.Status, payment.ActuallyPaid = "finished", "10"
	capture("2", payment)
	capture("2", payment)
	if s := read(); s.State != "completed" || !s.PaymentConfirmed || !s.SignatureValidated || !s.ProviderVerified || !s.Persisted || s.FulfillmentStatus != "not_activated" {
		t.Fatal("finished payment not projected safely", s)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM payments.nowpayments_webhook_capture`).Scan(&count); err != nil || count != 2 {
		t.Fatal("duplicate was not idempotent")
	}
	var concurrent sync.WaitGroup
	errorsChannel := make(chan error, 4)
	for range 4 {
		concurrent.Add(1)
		go func() {
			defer concurrent.Done()
			errorsChannel <- store.Capture(ctx, "production", payment, payment, strings.Repeat("2", 64))
		}()
	}
	concurrent.Wait()
	close(errorsChannel)
	for err := range errorsChannel {
		if err != nil {
			t.Fatal("concurrent duplicate", err)
		}
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM payments.nowpayments_webhook_capture`).Scan(&count); err != nil || count != 2 {
		t.Fatal("concurrent replay was not idempotent")
	}
	if _, err := store.OwnedStatus(ctx, "production", syntheticNOWOrder, "other-subject", "owner@example.test"); !errors.Is(err, errNOWCaptureOrderNotFound) {
		t.Fatal("email coincidence inherited ownership")
	}
	if _, err := pool.Exec(ctx, `UPDATE auth.user SET email_verified=false WHERE id='capture-owner'`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.OwnedStatus(ctx, "production", syntheticNOWOrder, "capture-owner", "owner@example.test"); !errors.Is(err, errNOWCaptureOrderNotFound) {
		t.Fatal("unverified owner read status")
	}
	if _, err := pool.Exec(ctx, `UPDATE auth.user SET email_verified=true WHERE id='capture-owner'`); err != nil {
		t.Fatal(err)
	}
	// A signed risk state outranks an API response lagging at finished.
	signedRisk := payment
	signedRisk.Status = "refunded"
	if err := store.Capture(ctx, "production", signedRisk, payment, strings.Repeat("3", 64)); err != nil {
		t.Fatal("capture signed risk", err)
	}
	capture("4", payment)
	if s := read(); s.State != "under_review" || s.PaymentConfirmed {
		t.Fatal("late finished callback erased refund risk")
	}
	// A foreign order is permanently quarantined, including after later order
	// creation. Capture must never infer an owner or bind legacy identities.
	orphan := payment
	orphan.PaymentID = "8002"
	orphan.OrderID = "0eeb0d70-7b04-4c31-9a29-4a15d5296006"
	orphan.InvoiceID = "9002"
	capture("5", orphan)
	_, err = pool.Exec(ctx, `INSERT INTO payments.nowpayments_membership_attempt
 (id,environment,auth_subject,person_id,person_public_id,package_id,package_name,pv,amount_usd,fee_usd,total_cents,state,invoice_id)
 VALUES('0eeb0d70-7b04-4c31-9a29-4a15d5296006','production','capture-owner',1,'ccf27a76-4e26-411c-acaf-8e53bd9e64f6',1002,'Synthetic',10,100,1,10100,'invoice_created','9002');`)
	if err != nil {
		t.Fatal(err)
	}
	capture("6", orphan)
	var matched int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM payments.nowpayments_webhook_capture WHERE payment_id='8002' AND matched_attempt_id IS NOT NULL`).Scan(&matched); err != nil || matched != 0 {
		t.Fatal("unknown payment was auto-bound")
	}
	// The dedicated role has no operational financial mutation privileges.
	for _, q := range []string{`DELETE FROM payments.nowpayments_webhook_capture`, `UPDATE payments.nowpayments_webhook_capture SET payment_status='finished'`, `TRUNCATE payments.nowpayments_webhook_capture`, `UPDATE payments.nowpayments_membership_attempt SET state='closed_reviewed'`, `INSERT INTO mlm.wallet_movement VALUES(1)`, `INSERT INTO mlm.tree_event VALUES(1)`, `INSERT INTO mlm.affiliate_package VALUES(1)`, `UPDATE auth.user SET email_verified=true`, `UPDATE payments.stripe_sale SET amount=0`} {
		if _, err := restricted.Exec(ctx, q); err == nil {
			t.Fatal("capture role was allowed an unrelated write")
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE payments.nowpayments_webhook_capture SET payment_status='finished'`); err == nil {
		t.Fatal("append-only trigger failed")
	}
	var untouched bool
	if err := pool.QueryRow(ctx, `SELECT (SELECT amount=123 FROM payments.stripe_sale WHERE id=1) AND
 (SELECT count(*)=0 FROM mlm.wallet_movement) AND (SELECT count(*)=0 FROM mlm.tree_event) AND
 (SELECT count(*)=0 FROM mlm.affiliate_package) AND (SELECT count(*)=1 FROM identity.auth_binding) AND
 (SELECT state='invoice_created' FROM payments.nowpayments_membership_attempt WHERE id='3f3fba2c-d836-430d-b45e-63fd73050384')`).Scan(&untouched); err != nil || !untouched {
		t.Fatal("capture mutated historical/operational domain")
	}
}
