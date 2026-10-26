package payments

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/vicionpower/vp-engine/internal/nowpayments"
	"github.com/vicionpower/vp-engine/internal/shared/financialguard"
)

func syntheticNOWPayment(order, invoice, payment, status string) nowpayments.Payment {
	return nowpayments.Payment{
		OrderID: order, InvoiceID: nowpayments.ProviderID(invoice), PaymentID: nowpayments.ProviderID(payment),
		Status: status, PriceCurrency: "usd", PriceAmount: "101.00", PayCurrency: "usdttrc20",
		PayAmount: "101", ActuallyPaid: "101", OutcomeAmount: "100.5", OutcomeCurrency: "usdttrc20",
	}
}

func TestNOWPaymentsMembershipEvidenceMatching(t *testing.T) {
	attempt := NOWPaymentsMembershipAttempt{ID: "4c6b6c20-a09d-441e-bb07-febd2a9dab6b", InvoiceID: "7001", TotalCents: 10100}
	valid := syntheticNOWPayment(attempt.ID, attempt.InvoiceID, "9001", "finished")
	if err := matchingNOWPaymentsEvidence(attempt, valid, valid); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		change func(*nowpayments.Payment)
	}{
		{"foreign order", func(p *nowpayments.Payment) { p.OrderID = "cb0e9009-a4c1-46a8-bd8e-a2379947ebe5" }},
		{"foreign invoice", func(p *nowpayments.Payment) { p.InvoiceID = "7002" }},
		{"foreign payment", func(p *nowpayments.Payment) { p.PaymentID = "9002" }},
		{"wrong gross", func(p *nowpayments.Payment) { p.PriceAmount = "100.99" }},
		{"wrong currency", func(p *nowpayments.Payment) { p.PriceCurrency = "eur" }},
		{"missing status", func(p *nowpayments.Payment) { p.Status = "" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			changed := valid
			tc.change(&changed)
			if !errors.Is(matchingNOWPaymentsEvidence(attempt, changed, valid), ErrNOWPaymentsEvidence) ||
				!errors.Is(matchingNOWPaymentsEvidence(attempt, valid, changed), ErrNOWPaymentsEvidence) {
				t.Fatal("both authenticated sources must match the persisted order")
			}
		})
	}
}

func TestNOWPaymentsMembershipReviewState(t *testing.T) {
	for _, tc := range []struct {
		previous, status      string
		finished, multiple    bool
		wantReason, wantState string
	}{
		{"invoice_created", "waiting", false, false, "provider_nonfinal", "invoice_created"},
		{"invoice_created", "confirmed", false, false, "provider_nonfinal", "invoice_created"},
		{"invoice_created", "finished", true, false, "finished_membership_review", "pending_review"},
		{"pending_review", "waiting", false, false, "provider_nonfinal", "pending_review"},
		{"invoice_created", "partially_paid", false, false, "provider_risk", "pending_review"},
		{"pending_review", "refunded", false, false, "provider_risk", "pending_review"},
		{"invoice_created", "finished", true, true, "multiple_payments", "pending_review"},
		{"invoice_created", "unknown_new_status", false, false, "provider_risk", "pending_review"},
	} {
		reason, state := nowPaymentsReviewState(tc.previous, tc.status, tc.finished, tc.multiple)
		if reason != tc.wantReason || state != tc.wantState {
			t.Fatalf("%+v: got %q/%q", tc, reason, state)
		}
	}
	for _, value := range []string{"", "Production", "test", "production ", "live"} {
		if validNOWPaymentsEnvironment(value) {
			t.Fatal("environment inferred or normalized", value)
		}
	}
}

func TestNOWPaymentsMembershipStoreIntegration(t *testing.T) {
	if testing.Short() {
		t.Skip("isolated PostgreSQL testcontainer")
	}
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	for _, file := range []string{"70_stable_identity_bindings.sql", "74_nowpayments_membership_review.sql"} {
		migration, err := os.ReadFile(filepath.Join(findRepoRoot(t), "_meta", "migration", file))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(migration)); err != nil {
			t.Fatal(file, err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO auth.user(id,email,email_verified) VALUES('synthetic-now-member','now-member@example.test',true);
 INSERT INTO mlm.person(first_name,last_name,email,phone_number,status,user_id)
 VALUES('Synthetic','NOW member','now-member@example.test','0','active','synthetic-now-member');
 INSERT INTO identity.auth_binding(subject,person_id,link_method)
 SELECT 'synthetic-now-member',id,'new_registration' FROM mlm.person WHERE user_id='synthetic-now-member';
 INSERT INTO mlm.package(id,name,amount_usd,pv,type) VALUES
 (1001,'Synthetic membership',100,50,'enrollment'),(1002,'Synthetic second',100,50,'enrollment'),
 (1003,'Synthetic concurrent',100,50,'enrollment'),(1004,'Synthetic Stripe pending',100,50,'enrollment');`); err != nil {
		t.Fatal(err)
	}
	store := NewStore(pool)
	in := NOWPaymentsMembershipInput{Email: "now-member@example.test", Environment: "production", PackageID: 1001}
	if _, err := pool.Exec(ctx, `UPDATE auth.user SET email_verified=false WHERE id='synthetic-now-member'`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateNOWPaymentsMembership(ctx, in); !errors.Is(err, ErrCheckoutIdentityReview) {
		t.Fatal("unverified identity purchased membership", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE auth.user SET email_verified=true WHERE id='synthetic-now-member'`); err != nil {
		t.Fatal(err)
	}
	attempt, err := store.CreateNOWPaymentsMembership(ctx, in)
	if err != nil {
		t.Fatal("create immutable order", err)
	}
	if attempt.AuthSubject != "synthetic-now-member" || attempt.PersonID <= 0 || !validNOWPaymentsOrderID(attempt.PersonPublicID) ||
		attempt.AmountUSD != "100.00" || attempt.FeeUSD != "1.00" || attempt.TotalCents != 10100 || attempt.PV != 50 || attempt.State != "creating_invoice" {
		t.Fatal("incorrect server snapshot", attempt)
	}
	if _, err := store.CreateNOWPaymentsMembership(ctx, in); !errors.Is(err, ErrNOWPaymentsOutstanding) {
		t.Fatal("duplicate checkout must not create an invoice", err)
	}
	if _, err := store.LookupNOWPaymentsMembership(ctx, attempt.ID, "sandbox"); !errors.Is(err, ErrNOWPaymentsAttemptNotFound) {
		t.Fatal("cross-environment lookup", err)
	}
	if err := store.AttachNOWPaymentsInvoice(ctx, attempt.ID, "production", "7001"); err != nil {
		t.Fatal(err)
	}
	if err := store.AttachNOWPaymentsInvoice(ctx, attempt.ID, "production", "7002"); !errors.Is(err, ErrNOWPaymentsEvidence) {
		t.Fatal("invoice must not be replaced", err)
	}
	payment := syntheticNOWPayment(attempt.ID, "7001", "9001", "finished")
	badAmount := payment
	badAmount.PriceAmount = "1"
	if _, err := store.RecordNOWPaymentsReceipt(ctx, "production", payment, badAmount, strings.Repeat("0", 64)); !errors.Is(err, ErrNOWPaymentsEvidence) {
		t.Fatal("wrong amount accepted", err)
	}
	if _, err := store.RecordNOWPaymentsReceipt(ctx, "sandbox", payment, payment, strings.Repeat("0", 64)); !errors.Is(err, ErrNOWPaymentsAttemptNotFound) {
		t.Fatal("cross-environment receipt", err)
	}
	signedWaiting := payment
	signedWaiting.Status = "waiting"
	result, err := store.RecordNOWPaymentsReceipt(ctx, "production", signedWaiting, payment, strings.Repeat("1", 64))
	if err != nil || !result.Finished || result.State != "pending_review" || result.Duplicate {
		t.Fatal("finished evidence must remain unfulfilled", result, err)
	}
	result, err = store.RecordNOWPaymentsReceipt(ctx, "production", signedWaiting, payment, strings.Repeat("1", 64))
	if err != nil || !result.Duplicate || !result.Finished {
		t.Fatal("receipt replay", result, err)
	}
	var retainedReason string
	if _, err := store.RecordNOWPaymentsReceipt(ctx, "production", signedWaiting, signedWaiting, strings.Repeat("8", 64)); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT review_reason FROM payments.nowpayments_membership_attempt WHERE id=$1::uuid`, attempt.ID).Scan(&retainedReason); err != nil || retainedReason != "finished_membership_review" {
		t.Fatal("late pending callback erased finished review", retainedReason, err)
	}
	risk := payment
	risk.Status = "refunded"
	// Replaying an old signed callback must still capture new authoritative API
	// risk evidence, not suppress it merely because the IPN body hash matches.
	result, err = store.RecordNOWPaymentsReceipt(ctx, "production", signedWaiting, risk, strings.Repeat("1", 64))
	if err != nil || result.Duplicate || result.Finished || result.State != "pending_review" {
		t.Fatal("changed API risk hidden by IPN replay", result, err)
	}
	if result, err = store.RecordNOWPaymentsReceipt(ctx, "production", risk, risk, strings.Repeat("2", 64)); err != nil || result.Finished || result.State != "pending_review" {
		t.Fatal("refund must remain review", result, err)
	}
	if _, err = store.RecordNOWPaymentsReceipt(ctx, "production", payment, payment, strings.Repeat("3", 64)); err != nil {
		t.Fatal(err)
	}
	var reason string
	if err := pool.QueryRow(ctx, `SELECT review_reason FROM payments.nowpayments_membership_attempt WHERE id=$1::uuid`, attempt.ID).Scan(&reason); err != nil || reason != "provider_risk" {
		t.Fatal("late finished erased risk review", reason, err)
	}
	secondPayment := payment
	secondPayment.PaymentID = "9002"
	if result, err = store.RecordNOWPaymentsReceipt(ctx, "production", secondPayment, secondPayment, strings.Repeat("4", 64)); err != nil || !result.MultiplePayments {
		t.Fatal("extra payment requires review", result, err)
	}
	stored, err := store.LookupNOWPaymentsMembership(ctx, attempt.ID, "production")
	if err != nil || stored.PaymentID != "9001" || stored.State != "pending_review" {
		t.Fatal("first payment binding was replaced", stored, err)
	}
	secondIn := in
	secondIn.PackageID = 1002
	secondOrder, err := store.CreateNOWPaymentsMembership(ctx, secondIn)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.AttachNOWPaymentsInvoice(ctx, secondOrder.ID, "production", "7002"); err != nil {
		t.Fatal(err)
	}
	stolen := syntheticNOWPayment(secondOrder.ID, "7002", "9001", "finished")
	if _, err := store.RecordNOWPaymentsReceipt(ctx, "production", stolen, stolen, strings.Repeat("5", 64)); !errors.Is(err, ErrNOWPaymentsEvidence) {
		t.Fatal("payment credited to two orders", err)
	}
	unknownIn := in
	unknownIn.Environment = "sandbox"
	unknown, err := store.CreateNOWPaymentsMembership(ctx, unknownIn)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.MarkNOWPaymentsInvoiceUnknown(ctx, unknown.ID, "sandbox"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateNOWPaymentsMembership(ctx, unknownIn); !errors.Is(err, ErrNOWPaymentsOutstanding) {
		t.Fatal("ambiguous provider timeout must not create another payable invoice", err)
	}
	if err := store.AttachNOWPaymentsInvoice(ctx, unknown.ID, "sandbox", "7999"); !errors.Is(err, ErrNOWPaymentsEvidence) {
		t.Fatal("unknown invoice requires operator review", err)
	}
	concurrentIn := in
	concurrentIn.PackageID = 1003
	var createWG sync.WaitGroup
	createErrors := make(chan error, 2)
	for range 2 {
		createWG.Add(1)
		go func() {
			defer createWG.Done()
			_, err := store.CreateNOWPaymentsMembership(ctx, concurrentIn)
			createErrors <- err
		}()
	}
	createWG.Wait()
	close(createErrors)
	created, blocked := 0, 0
	for err := range createErrors {
		if err == nil {
			created++
		} else if errors.Is(err, ErrNOWPaymentsOutstanding) {
			blocked++
		} else {
			t.Fatal("concurrent order", err)
		}
	}
	if created != 1 || blocked != 1 {
		t.Fatal("concurrent checkout could duplicate provider invoices", created, blocked)
	}
	// A Stripe creation timeout can leave no session ID. The outstanding intent
	// still prevents switching providers and creating a second payable invoice.
	if _, err := pool.Exec(ctx, `INSERT INTO payments.purchase_intent(user_id,person_id,package_id,pv,amount_usd,fee_usd,total_cents,currency,status)
 VALUES('now-member@example.test',$1,1004,50,100,1,10100,'usd','created')`, attempt.PersonID); err != nil {
		t.Fatal(err)
	}
	stripePendingIn := in
	stripePendingIn.PackageID = 1004
	if _, err := store.CreateNOWPaymentsMembership(ctx, stripePendingIn); !errors.Is(err, ErrNOWPaymentsOutstanding) {
		t.Fatal("NOW invoice could duplicate unresolved Stripe checkout", err)
	}
	// This direct SQL transition is isolated fixture cleanup, not production or
	// automatic timeout recovery. Preserve the zero-financial-artifact assertion.
	if _, err := pool.Exec(ctx, `DELETE FROM payments.purchase_intent WHERE package_id=1004`); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{
		`UPDATE payments.nowpayments_membership_attempt SET total_cents=1`,
		`UPDATE payments.nowpayments_membership_attempt SET invoice_id='7999' WHERE invoice_id IS NOT NULL`,
		`UPDATE payments.nowpayments_membership_receipt SET finished_verified=false`,
		`DELETE FROM payments.nowpayments_membership_receipt`,
		`DELETE FROM payments.nowpayments_payment_binding`,
	} {
		if _, err := pool.Exec(ctx, query); err == nil {
			t.Fatal("immutable evidence mutation succeeded", query)
		}
	}
	// The row lock serializes concurrent callbacks, not a process-local mutex.
	var wg sync.WaitGroup
	errorsCh := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := store.RecordNOWPaymentsReceipt(ctx, "production", payment, payment, strings.Repeat("6", 64))
			errorsCh <- err
		}()
	}
	wg.Wait()
	close(errorsCh)
	for err := range errorsCh {
		if err != nil {
			t.Fatal("concurrent receipt", err)
		}
	}
	var receipts, artifacts int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM payments.nowpayments_membership_receipt WHERE body_sha256=$1`, strings.Repeat("6", 64)).Scan(&receipts); err != nil || receipts != 1 {
		t.Fatal("concurrent replay duplicated receipt", receipts, err)
	}
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM payments.purchase_intent)+(SELECT count(*) FROM payments.stripe_event)
 +(SELECT count(*) FROM mlm.affiliate)+(SELECT count(*) FROM mlm.affiliate_package)+(SELECT count(*) FROM mlm.tree_event)
 +(SELECT count(*) FROM mlm.transaction)+(SELECT count(*) FROM mlm.wallet_movement)+(SELECT count(*) FROM mlm.investment_cd)`).Scan(&artifacts); err != nil || artifacts != 0 {
		t.Fatal("NOW receipt created Stripe/network/financial artifacts", artifacts, err)
	}
	if _, err := pool.Exec(ctx, `CREATE TABLE payments.stripe_sale(payment_intent_id text PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	for _, call := range []func() error{
		func() error { _, err := store.CreateNOWPaymentsMembership(ctx, in); return err },
		func() error { return store.AttachNOWPaymentsInvoice(ctx, attempt.ID, "production", "7001") },
		func() error { return store.MarkNOWPaymentsInvoiceUnknown(ctx, attempt.ID, "production") },
		func() error {
			_, err := store.RecordNOWPaymentsReceipt(ctx, "production", payment, payment, strings.Repeat("7", 64))
			return err
		},
	} {
		if err := call(); !errors.Is(err, financialguard.ErrRecoveryReview) {
			t.Fatal("NOW membership bypassed financial recovery guard", err)
		}
	}
}
