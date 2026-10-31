package payments

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
	"github.com/vicionpower/vp-engine/internal/nowpayments"
)

// All identities, credentials, provider responses and invoices below belong to
// a disposable PostgreSQL fixture. The injected transport never uses a network.
func TestNOWPurchaseLifecyclePostgresRestrictedRole(t *testing.T) {
	if testing.Short() {
		t.Skip("isolated PostgreSQL testcontainer")
	}
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	apply := func(name string) {
		t.Helper()
		data, err := os.ReadFile(filepath.Join(findRepoRoot(t), "_meta", "migration", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(data)); err != nil {
			t.Fatal(name, err)
		}
	}
	for _, name := range []string{"70_stable_identity_bindings.sql", "74_nowpayments_membership_review.sql", "75_nowpayments_webhook_capture.sql", "77_nowpayments_included_pricing.sql", "79_nowpayments_operational_orders.sql", "80_nowpayments_scoped_engine.sql", "82_nowpayments_calendar_maturity.sql"} {
		apply(name)
	}
	admin := seedAdmin(t, ctx, pool, "lifecycle-admin@example.test")
	seedActivePlan(t, ctx, pool, admin)
	var root int64
	if err := pool.QueryRow(ctx, `INSERT INTO mlm.affiliate(person_id,parent_id,position,status) VALUES($1,NULL,NULL,'active') RETURNING id`, admin).Scan(&root); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO mlm.asset(id,symbol,name,is_fiat,decimals) VALUES(1,'USD','Synthetic USD',true,2) ON CONFLICT(symbol) DO NOTHING;
 INSERT INTO mlm.package(id,name,amount_usd,pv,type) SELECT id,'Synthetic NOW lifecycle',100,100,'enrollment' FROM generate_series(8400,8440) id;
 CREATE ROLE mindbliss_payments_20261025 LOGIN NOINHERIT PASSWORD 'synthetic-lifecycle-reader';
 GRANT USAGE ON SCHEMA auth,identity,mlm,payments TO mindbliss_payments_20261025;
 GRANT SELECT(id,email,email_verified) ON auth.user TO mindbliss_payments_20261025;
 GRANT SELECT(subject,person_id,provider) ON identity.auth_binding TO mindbliss_payments_20261025;
 GRANT SELECT ON mlm.person,mlm.affiliate,mlm.blacklist TO mindbliss_payments_20261025;`); err != nil {
		t.Fatal(err)
	}
	owner := nowLifecycleOwner(t, ctx, pool, "owner", root, "L")
	other := nowLifecycleOwner(t, ctx, pool, "other", root, "R")
	// Model the two already-issued, unpaid production invoices before applying
	// the additive lifecycle migration; every original snapshot must survive.
	if _, err := pool.Exec(ctx, `WITH attempts AS(
 INSERT INTO payments.nowpayments_membership_attempt(environment,auth_subject,person_id,person_public_id,affiliate_id,
 package_id,package_name,pv,amount_usd,fee_usd,total_cents,state,invoice_id,pricing_policy,provider_cost_usd,commission_base_usd)
 SELECT 'production',$1,p.id,p.public_id,a.id,pkg.id,pkg.name,pkg.pv,100,0,10000,'creating_invoice',NULL,
 'catalog_includes_provider_1pct_v1',1,99 FROM mlm.person p JOIN mlm.affiliate a ON a.person_id=p.id
 CROSS JOIN mlm.package pkg WHERE p.user_id=$1 AND pkg.id IN(8400,8401) RETURNING id,package_id)
 INSERT INTO payments.nowpayments_operational_order(attempt_id,capacity_slot,plan_config_id,roi_tier_id,cd_lock_days,lifetime_cap_factor,
 plan_snapshot,roi_base_annual_rate,roi_qualified_annual_rate)
 SELECT a.id,(a.package_id-8399)::smallint,c.id,t.id,c.cd_lock_days,c.lifetime_cap_factor,to_jsonb(c),t.base_annual_rate,t.qualified_annual_rate
 FROM attempts a CROSS JOIN mlm.plan_config c CROSS JOIN mlm.cd_roi_tier t
 WHERE c.effective_from<=now() AND(c.effective_to IS NULL OR c.effective_to>now()) AND t.active AND t.min_amount_usd<=100 AND(t.max_amount_usd IS NULL OR t.max_amount_usd>100)`, owner.subject); err != nil {
		t.Fatal("old pending fixture", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE payments.nowpayments_membership_attempt SET state='invoice_created',invoice_id=(84000+package_id)::text WHERE package_id IN(8400,8401)`); err != nil {
		t.Fatal("old pending invoice attachment", err)
	}
	const pendingSnapshot = `SELECT jsonb_agg(jsonb_build_object('attempt',to_jsonb(a)-'checkout_open','order',to_jsonb(o)) ORDER BY a.package_id)::text
 FROM payments.nowpayments_membership_attempt a JOIN payments.nowpayments_operational_order o ON o.attempt_id=a.id WHERE a.package_id IN(8400,8401)`
	var oldPending string
	if err := pool.QueryRow(ctx, pendingSnapshot).Scan(&oldPending); err != nil {
		t.Fatal(err)
	}
	apply("83_nowpayments_member_reader.sql")
	applyNOWPurchaseLifecycleMigration(t, ctx, pool)
	writer := nowEngineRestrictedWriter(t, ctx, pool)
	defer writer.Close()
	store := NewNOWPaymentsOperationalStore(writer)
	store.SetNOWOperationalReadiness(func(context.Context, pgx.Tx) error { return nil })
	readerConfig := pool.Config()
	readerConfig.ConnConfig.User, readerConfig.ConnConfig.Password = "mindbliss_payments_20261025", "synthetic-lifecycle-reader"
	readerConfig.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	reader, err := pgxpool.NewWithConfig(ctx, readerConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	readStore := NewStore(reader)
	var providerCalls atomic.Int64
	client, err := nowpayments.New(nowpayments.Config{APIKey: "synthetic-never-transmitted", IPNSecret: "synthetic-signature", HTTPClient: &http.Client{Transport: nowLifecycleRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodPost || r.URL.String() != "https://api.nowpayments.io/v1/invoice" {
			return nil, errors.New("unexpected synthetic provider request")
		}
		count := providerCalls.Add(1)
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(fmt.Sprintf(`{"id":"%d","invoice_url":"https://nowpayments.io/payment/?iid=%d"}`, 840000+count, 840000+count)))}, nil
	})}})
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHandler(readStore, nil, "synthetic-service", nil, 0, zerolog.Nop())
	handler.nowMemberships = &nowPaymentsMemberships{client: client, store: store, environment: "production", operational: true,
		callbackURL: "https://mindblisspower.com/api/webhooks/nowpayments", successURL: "https://mindblisspower.com/dashboard/packages?payment_provider=nowpayments&status=review",
		cancelURL: "https://mindblisspower.com/dashboard/packages?payment_provider=nowpayments&status=cancelled"}
	checkout := func(in NOWPaymentsMembershipInput) (int, checkoutResponse, string) {
		r := httptest.NewRequest(http.MethodPost, "/api/payments/checkout", nil).WithContext(ctx)
		w := httptest.NewRecorder()
		handler.handleNOWMembershipCheckout(w, r, checkoutRequest{Email: in.Email, authSubject: in.Subject, PackageID: in.PackageID, PurchaseRequestID: in.PurchaseRequestID}, nil, "")
		var out checkoutResponse
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out, w.Body.String()
	}
	create := func(pkg int) (NOWPaymentsMembershipInput, NOWPaymentsMembershipAttempt) {
		t.Helper()
		in := owner.input(pkg)
		order, err := store.CreateNOWPaymentsMembership(ctx, in)
		if err != nil {
			t.Fatal("new synthetic purchase", err)
		}
		return in, order
	}
	var syntheticSequence atomic.Int64
	paymentFor := func(order NOWPaymentsMembershipAttempt) nowpayments.Payment {
		t.Helper()
		sequence := syntheticSequence.Add(1)
		invoice := fmt.Sprintf("8500%d", sequence)
		if err := store.AttachNOWPaymentsInvoice(ctx, order.ID, "production", invoice); err != nil {
			t.Fatal(err)
		}
		payment := syntheticNOWPayment(order.ID, invoice, fmt.Sprintf("8600%d", sequence), "finished")
		payment.PriceAmount, payment.PayAmount, payment.ActuallyPaid = "100.00", "100", "100"
		return payment
	}
	capture := NewNOWPaymentsCaptureStore(pool)
	record := func(payment nowpayments.Payment, hash string) {
		t.Helper()
		if err := capture.Capture(ctx, "production", payment, payment, hash); err != nil {
			t.Fatal("synthetic signed/provider evidence", err)
		}
	}
	activate := func(order NOWPaymentsMembershipAttempt, hash string) {
		t.Helper()
		payment := paymentFor(order)
		record(payment, hash)
		if state, err := store.processNOWOperationalPayment(ctx, "production", payment, payment, hash); err != nil || state != "activated" {
			t.Fatal("synthetic activation", state, err)
		}
	}
	assertPendingPreserved := func() {
		t.Helper()
		var current string
		var open int
		if err := pool.QueryRow(ctx, pendingSnapshot).Scan(&current); err != nil || current != oldPending {
			t.Fatal("lifecycle changed previously issued pending invoice snapshots", err)
		}
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM payments.nowpayments_membership_attempt WHERE package_id IN(8400,8401) AND checkout_open`).Scan(&open); err != nil || open != 2 {
			t.Fatal("old pending invoices lost their unique collection reservation", open, err)
		}
	}
	assertPendingPreserved()

	t.Run("simultaneous retries create only one provider invoice", func(t *testing.T) {
		for _, sameKey := range []bool{true, false} {
			pkg := 8402
			if !sameKey {
				pkg++
			}
			first, second := owner.input(pkg), owner.input(pkg)
			if sameKey {
				second.PurchaseRequestID = first.PurchaseRequestID
			}
			before := providerCalls.Load()
			start := make(chan struct{})
			var wg sync.WaitGroup
			results := make(chan int, 2)
			for _, in := range []NOWPaymentsMembershipInput{first, second} {
				wg.Add(1)
				go func(input NOWPaymentsMembershipInput) {
					defer wg.Done()
					<-start
					status, _, _ := checkout(input)
					results <- status
				}(in)
			}
			close(start)
			wg.Wait()
			close(results)
			ok := 0
			for status := range results {
				if status == http.StatusOK {
					ok++
				} else if status != http.StatusConflict && status != http.StatusServiceUnavailable {
					t.Fatal("unexpected concurrent checkout status", status)
				}
			}
			var attempts, opened int
			if err := pool.QueryRow(ctx, `SELECT count(*),count(*) FILTER(WHERE checkout_open) FROM payments.nowpayments_membership_attempt WHERE package_id=$1`, pkg).Scan(&attempts, &opened); err != nil || attempts != 1 || opened != 1 || ok < 1 || providerCalls.Load()-before != 1 {
				t.Fatal("double click reserved or invoiced more than one purchase", sameKey, attempts, opened, ok, providerCalls.Load()-before, err)
			}
			status, replay, _ := checkout(first)
			if status != http.StatusOK || !replay.Reused || replay.URL == "" || providerCalls.Load()-before != 1 {
				t.Fatal("retry did not reuse the persisted invoice", status, replay.Reused)
			}
		}
	})

	t.Run("same SKU memberships retain independent CDs and request identity", func(t *testing.T) {
		in, first := create(8404)
		activate(first, strings.Repeat("1", 64))
		if _, err := store.CreateNOWPaymentsMembership(ctx, in); !errors.Is(err, ErrNOWPurchaseProcessed) {
			t.Fatal("old request key opened a fresh purchase after activation", err)
		}
		_, second := create(8404)
		activate(second, strings.Repeat("2", 64))
		if first.ID == second.ID {
			t.Fatal("explicit new purchase reused an activated membership")
		}
		var distinctCDs, distinctPackages, correctLocks, closedCheckouts int
		if err := pool.QueryRow(ctx, `SELECT count(DISTINCT o.investment_cd_id),count(DISTINCT o.affiliate_package_id),
 count(*) FILTER(WHERE cd.matures_at-cd.start_at=interval '365 days'),count(*) FILTER(WHERE NOT a.checkout_open)
 FROM payments.nowpayments_operational_order o JOIN payments.nowpayments_membership_attempt a ON a.id=o.attempt_id
 JOIN mlm.investment_cd cd ON cd.id=o.investment_cd_id WHERE a.package_id=8404 AND o.state='activated'`).Scan(&distinctCDs, &distinctPackages, &correctLocks, &closedCheckouts); err != nil || distinctCDs != 2 || distinctPackages != 2 || correctLocks != 2 || closedCheckouts != 2 {
			t.Fatal("repeat membership merged principal or reopened collection", distinctCDs, distinctPackages, correctLocks, closedCheckouts, err)
		}
		if _, err := store.CancelNOWPurchase(ctx, "production", owner.subject, owner.email, first.ID); !errors.Is(err, ErrNOWPurchaseCannotCancel) {
			t.Fatal("activated membership was locally cancelled", err)
		}
	})

	t.Run("resume and local cancellation are owned and idempotent", func(t *testing.T) {
		in := owner.input(8405)
		before := providerCalls.Load()
		status, response, body := checkout(in)
		if status != http.StatusOK {
			t.Fatal(status, body)
		}
		for range 2 {
			resumed, err := store.ResumeNOWPurchase(ctx, "production", owner.subject, owner.email, response.OrderID)
			if err != nil || resumed.ID != response.OrderID || !resumed.Reused {
				t.Fatal("resume did not reuse owned invoice", err)
			}
		}
		for _, operation := range []func() error{
			func() error {
				_, err := store.ResumeNOWPurchase(ctx, "production", other.subject, other.email, response.OrderID)
				return err
			},
			func() error {
				_, err := store.CancelNOWPurchase(ctx, "production", other.subject, other.email, response.OrderID)
				return err
			},
			func() error {
				_, err := store.CancelNOWPurchase(ctx, "production", owner.subject, other.email, response.OrderID)
				return err
			},
		} {
			if err := operation(); err == nil {
				t.Fatal("foreign owner read or cancelled purchase")
			}
		}
		for range 2 {
			if _, err := store.CancelNOWPurchase(ctx, "production", owner.subject, owner.email, response.OrderID); err != nil {
				t.Fatal("cancel replay was not idempotent", err)
			}
		}
		if _, err := store.ResumeNOWPurchase(ctx, "production", owner.subject, owner.email, response.OrderID); !errors.Is(err, ErrNOWPurchaseCannotResume) {
			t.Fatal("local cancellation reopened a payable invoice", err)
		}
		if _, err := store.CreateNOWPaymentsMembership(ctx, in); !errors.Is(err, ErrNOWPurchaseProcessed) {
			t.Fatal("cancelled request key opened a second invoice", err)
		}
		var safe bool
		if err := pool.QueryRow(ctx, `SELECT NOT a.checkout_open AND a.state='invoice_created' AND o.state='security_blocked'
 AND(SELECT count(*) FROM payments.nowpayments_purchase_cancellation c WHERE c.attempt_id=a.id)=1
 AND o.investment_cd_id IS NULL AND o.pv_source_id IS NULL AND o.inflow_id IS NULL
 FROM payments.nowpayments_membership_attempt a JOIN payments.nowpayments_operational_order o ON o.attempt_id=a.id WHERE a.id=$1::uuid`, response.OrderID).Scan(&safe); err != nil || !safe || providerCalls.Load()-before != 1 {
			t.Fatal("cancel mutated payment evidence or contacted provider", safe, err)
		}
		if _, err := store.CreateNOWPaymentsMembership(ctx, owner.input(8405)); err != nil {
			t.Fatal("explicit new purchase remained blocked by local cancellation", err)
		}
	})

	t.Run("unknown invoice outcomes cannot be cancelled or retried", func(t *testing.T) {
		in, order := create(8406)
		if _, err := store.CancelNOWPurchase(ctx, "production", owner.subject, owner.email, order.ID); !errors.Is(err, ErrNOWPurchaseCannotCancel) {
			t.Fatal("in-flight creation was released", err)
		}
		if err := store.MarkNOWPaymentsInvoiceUnknown(ctx, order.ID, "production"); err != nil {
			t.Fatal(err)
		}
		if _, err := store.CancelNOWPurchase(ctx, "production", owner.subject, owner.email, order.ID); !errors.Is(err, ErrNOWPurchaseCannotCancel) {
			t.Fatal("uncertain payable invoice was released", err)
		}
		before := providerCalls.Load()
		if status, _, _ := checkout(in); status == http.StatusOK || providerCalls.Load() != before {
			t.Fatal("unknown request retried provider creation", status)
		}
		reused, err := store.CreateNOWPaymentsMembership(ctx, owner.input(8406))
		if err != nil || reused.ID != order.ID || !reused.Reused || reused.Reusable {
			t.Fatal("new key bypassed an uncertain invoice instead of retaining its review", err)
		}
	})

	t.Run("cancelled invoice retains late signed payment for manual review", func(t *testing.T) {
		_, order := create(8407)
		payment := paymentFor(order)
		if _, err := store.CancelNOWPurchase(ctx, "production", owner.subject, owner.email, order.ID); err != nil {
			t.Fatal(err)
		}
		hash := strings.Repeat("3", 64)
		record(payment, hash)
		for range 2 {
			if queued, err := store.enqueueNOWOperationalPayment(ctx, "production", order.ID, string(payment.PaymentID), hash); err != nil || !queued {
				t.Fatal("late capture was dropped instead of retained", queued, err)
			}
			if _, err := store.RunNOWOperationalJobs(ctx, 5); err != nil {
				t.Fatal("late cancelled payment worker", err)
			}
		}
		var safe bool
		if err := pool.QueryRow(ctx, `SELECT o.state='security_blocked' AND o.investment_cd_id IS NULL AND o.pv_source_id IS NULL AND o.inflow_id IS NULL
 AND NOT a.checkout_open AND a.payment_id=$2 AND a.state='pending_review'
 AND(SELECT count(*) FROM payments.nowpayments_membership_receipt WHERE attempt_id=a.id)=1
 AND(SELECT count(*) FROM payments.nowpayments_webhook_capture WHERE matched_attempt_id=a.id AND finished_verified)=1
 AND(SELECT count(*) FROM payments.nowpayments_operational_job WHERE attempt_id=a.id AND state='held')=1
 FROM payments.nowpayments_operational_order o JOIN payments.nowpayments_membership_attempt a ON a.id=o.attempt_id WHERE a.id=$1::uuid`, order.ID, string(payment.PaymentID)).Scan(&safe); err != nil || !safe {
			t.Fatal("late payment activated, lost evidence, or duplicated work", err)
		}
	})

	t.Run("activation and cancellation serialize without partial principal", func(t *testing.T) {
		for iteration := range 3 {
			_, order := create(8408 + iteration)
			payment := paymentFor(order)
			hash := fmt.Sprintf("%064x", iteration+10)
			record(payment, hash)
			if _, err := store.RecordNOWPaymentsReceipt(ctx, "production", payment, payment, hash); err != nil {
				t.Fatal(err)
			}
			start := make(chan struct{})
			var wg sync.WaitGroup
			errorsChannel := make(chan error, 2)
			wg.Add(2)
			go func() {
				defer wg.Done()
				<-start
				_, err := store.activateNOWOperationalOrder(ctx, "production", order.ID)
				errorsChannel <- err
			}()
			go func() {
				defer wg.Done()
				<-start
				_, err := store.CancelNOWPurchase(ctx, "production", owner.subject, owner.email, order.ID)
				errorsChannel <- err
			}()
			close(start)
			wg.Wait()
			close(errorsChannel)
			for err := range errorsChannel {
				if err != nil && !errors.Is(err, ErrNOWPurchaseCannotCancel) {
					t.Fatal("activation/cancel lock race failed", err)
				}
			}
			var atomicResult bool
			if err := pool.QueryRow(ctx, `SELECT
 (o.state='activated' AND o.investment_cd_id IS NOT NULL AND o.pv_source_id IS NOT NULL AND o.inflow_id IS NOT NULL AND NOT a.checkout_open
 AND NOT EXISTS(SELECT 1 FROM payments.nowpayments_purchase_cancellation c WHERE c.attempt_id=a.id))
 OR(o.state='security_blocked' AND o.investment_cd_id IS NULL AND o.pv_source_id IS NULL AND o.inflow_id IS NULL AND NOT a.checkout_open
 AND EXISTS(SELECT 1 FROM payments.nowpayments_purchase_cancellation c WHERE c.attempt_id=a.id))
 FROM payments.nowpayments_operational_order o JOIN payments.nowpayments_membership_attempt a ON a.id=o.attempt_id WHERE a.id=$1::uuid`, order.ID).Scan(&atomicResult); err != nil || !atomicResult {
				t.Fatal("cancel raced into partial or cancelled active membership", iteration, err)
			}
		}
	})

	t.Run("new blacklist or inactive node cannot resume collection", func(t *testing.T) {
		in, order := create(8413)
		paymentFor(order)
		t.Cleanup(func() {
			_, _ = pool.Exec(ctx, `DELETE FROM mlm.blacklist WHERE source='lifecycle-test'`)
			_, _ = pool.Exec(ctx, `UPDATE mlm.affiliate SET status='active' WHERE person_id=(SELECT id FROM mlm.person WHERE user_id=$1)`, owner.subject)
		})
		assertHeld := func(reason string) {
			t.Helper()
			if _, err := store.ResumeNOWPurchase(ctx, "production", owner.subject, owner.email, order.ID); !errors.Is(err, ErrNOWPurchaseCannotResume) {
				t.Fatal(reason+" reopened invoice collection", err)
			}
			before := providerCalls.Load()
			if status, _, _ := checkout(in); status == http.StatusOK || providerCalls.Load() != before {
				t.Fatal(reason+" supplied an invoice or contacted provider", status)
			}
			history, err := readStore.ListNOWPurchases(ctx, "production", owner.subject, owner.email)
			if err != nil {
				t.Fatal(reason+" made history unavailable instead of holding collection", err)
			}
			found := false
			for _, item := range history.Purchases {
				if item.OrderID == order.ID {
					found = true
					if item.CanResume || item.PaymentStatus != "under_review" {
						t.Fatal(reason+" exposed a resume action", item.PaymentStatus)
					}
				}
			}
			if !found {
				t.Fatal(reason + " hid existing purchase history")
			}
		}
		if _, err := pool.Exec(ctx, `INSERT INTO mlm.blacklist(email,email_norm,motive,source) VALUES($1,mlm.norm_email($1),'Synthetic fixture only','lifecycle-test')`, owner.email); err != nil {
			t.Fatal(err)
		}
		assertHeld("current registry blacklist")
		if _, err := pool.Exec(ctx, `DELETE FROM mlm.blacklist WHERE source='lifecycle-test'`); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE mlm.affiliate SET status='suspended' WHERE person_id=(SELECT id FROM mlm.person WHERE user_id=$1)`, owner.subject); err != nil {
			t.Fatal(err)
		}
		assertHeld("inactive network node")
		if _, err := pool.Exec(ctx, `UPDATE mlm.affiliate SET status='active' WHERE person_id=(SELECT id FROM mlm.person WHERE user_id=$1)`, owner.subject); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("history uses the exact read-only role and scopes its owner", func(t *testing.T) {
		history, err := readStore.ListNOWPurchases(ctx, "production", owner.subject, owner.email)
		if err != nil {
			t.Fatal("production history reader ACL", err)
		}
		wire, err := json.Marshal(history)
		if err != nil || !strings.Contains(string(wire), "cancelled_local") || !strings.Contains(string(wire), "under_review") || !strings.Contains(string(wire), "activated") {
			t.Fatal("history does not distinguish activation, local abandon and late payment review", string(wire), err)
		}
		foreign, err := readStore.ListNOWPurchases(ctx, "production", other.subject, other.email)
		if err != nil {
			t.Fatal(err)
		}
		if len(foreign.Purchases) != 0 {
			t.Fatal("history leaked another owner's invoice")
		}
		if _, err := readStore.ListNOWPurchases(ctx, "production", other.subject, owner.email); err == nil {
			t.Fatal("email alone inherited another owner's history")
		}
		for _, query := range []string{`UPDATE payments.nowpayments_membership_attempt SET checkout_open=false`, `INSERT INTO payments.nowpayments_purchase_cancellation(attempt_id,auth_subject,environment) SELECT id,auth_subject,environment FROM payments.nowpayments_membership_attempt LIMIT 1`, `DELETE FROM payments.nowpayments_purchase_request`} {
			if _, err := reader.Exec(ctx, query); err == nil {
				t.Fatal("history role can mutate purchase lifecycle")
			}
		}
		var noLifecycleWrite bool
		if err := reader.QueryRow(ctx, `SELECT NOT has_column_privilege(current_user,'payments.nowpayments_membership_attempt','checkout_open','UPDATE')
 AND NOT has_table_privilege(current_user,'payments.nowpayments_purchase_request','INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege(current_user,'payments.nowpayments_purchase_cancellation','INSERT,UPDATE,DELETE')`).Scan(&noLifecycleWrite); err != nil || !noLifecycleWrite {
			t.Fatal("history reader inherited lifecycle writes", err)
		}
	})

	t.Run("history stays readable when new collection is paused", func(t *testing.T) {
		paused := NewHandler(readStore, nil, "synthetic-paused-service", nil, 0, zerolog.Nop())
		paused.SetIdentityVerifier(owner, true)
		paused.nowCapture = &nowPaymentsCapture{environment: "production"}
		config := Config{ReadOnly: true, NOWPaymentsCapture: NOWPaymentsCaptureSettings{Enabled: true}}
		router := config.ReadOnlyHandler(paused.Routes())
		before := providerCalls.Load()
		for _, method := range []string{http.MethodGet, http.MethodPost} {
			path := nowPurchasesPath
			if method == http.MethodPost {
				path += "/resume"
			}
			r := httptest.NewRequest(method, path, nil).WithContext(ctx)
			r.Header.Set("X-VP-Service-Token", "synthetic-paused-service")
			r.Header.Set(idTokenHeader, "synthetic-verified-token")
			w := httptest.NewRecorder()
			router.ServeHTTP(w, r)
			if method == http.MethodGet {
				var history NOWPurchaseHistory
				if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &history) != nil || len(history.Purchases) == 0 || w.Header().Get("Cache-Control") != "private, no-store" {
					t.Fatal("paused collection hid read-only purchase history", w.Code)
				}
			} else if w.Code != http.StatusServiceUnavailable {
				t.Fatal("paused collection allowed invoice resume", w.Code)
			}
		}
		if providerCalls.Load() != before {
			t.Fatal("history while paused contacted provider")
		}
	})

	t.Run("database role cannot commit cancellation audit without blocking", func(t *testing.T) {
		_, order := create(8412)
		paymentFor(order)
		if _, err := writer.Exec(ctx, `INSERT INTO payments.nowpayments_purchase_cancellation(attempt_id,auth_subject,environment) VALUES($1::uuid,$2,'production')`, order.ID, owner.subject); err == nil {
			t.Fatal("cancellation audit committed without closing collection and blocking activation")
		}
		if _, err := writer.Exec(ctx, `INSERT INTO payments.nowpayments_purchase_cancellation(attempt_id,auth_subject,environment) VALUES($1::uuid,$2,'production')`, order.ID, other.subject); err == nil {
			t.Fatal("runtime role appended foreign-owner cancellation proof")
		}
		if _, err := writer.Exec(ctx, `INSERT INTO payments.nowpayments_purchase_request(auth_subject,environment,purchase_request_id,attempt_id) VALUES($1,'production',$2::uuid,$3::uuid)`, other.subject, uuid.NewString(), order.ID); err == nil {
			t.Fatal("runtime role rebound a purchase key across owners")
		}
		var retained bool
		if err := pool.QueryRow(ctx, `SELECT a.checkout_open AND o.state='awaiting_payment'
 AND NOT EXISTS(SELECT 1 FROM payments.nowpayments_purchase_cancellation c WHERE c.attempt_id=a.id)
 FROM payments.nowpayments_membership_attempt a JOIN payments.nowpayments_operational_order o ON o.attempt_id=a.id WHERE a.id=$1::uuid`, order.ID).Scan(&retained); err != nil || !retained {
			t.Fatal("failed direct-role cancellation released a pending invoice", err)
		}
	})

	for _, query := range []string{`UPDATE payments.nowpayments_purchase_request SET created_at=now()`, `DELETE FROM payments.nowpayments_purchase_cancellation`, `UPDATE payments.nowpayments_membership_attempt SET checkout_open=true WHERE NOT checkout_open`, `UPDATE payments.nowpayments_membership_attempt SET checkout_open=false WHERE package_id=8400`, `UPDATE auth.user SET email_verified=false`, `UPDATE mlm.affiliate SET left_pv_lifetime=1`} {
		if _, err := writer.Exec(ctx, query); err == nil {
			t.Fatal("runtime role rewrote lifecycle audit, reopened collection, or changed unrelated identity/PV", query)
		}
	}
	var unchanged bool
	if err := pool.QueryRow(ctx, `SELECT NOT EXISTS(SELECT 1 FROM mlm.wallet WHERE balance<>0)
 AND NOT EXISTS(SELECT 1 FROM mlm.wallet_movement) AND NOT EXISTS(SELECT 1 FROM mlm.tree_event)
 AND NOT EXISTS(SELECT 1 FROM payments.nowpayments_engine_obligation) AND NOT EXISTS(SELECT 1 FROM payments.purchase_intent)`).Scan(&unchanged); err != nil || !unchanged {
		t.Fatal("purchase lifecycle fabricated balance, PV, payouts or Stripe intents", err)
	}
	assertPendingPreserved()
}

type nowLifecycleIdentity struct{ subject, email string }

func (owner nowLifecycleIdentity) VerifyEmail(context.Context, string) (string, error) {
	return owner.email, nil
}

func (owner nowLifecycleIdentity) VerifySubject(context.Context, string) (string, string, error) {
	return owner.subject, owner.email, nil
}

func nowLifecycleOwner(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string, parent int64, side string) nowLifecycleIdentity {
	t.Helper()
	out := nowLifecycleIdentity{subject: "synthetic-lifecycle-" + name, email: name + "@lifecycle.example.test"}
	if _, err := pool.Exec(ctx, `INSERT INTO auth.user(id,email,email_verified) VALUES($1,$2,true)`, out.subject, out.email); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO mlm.person(first_name,last_name,email,phone_number,status,user_id) VALUES('Synthetic','Lifecycle',$1,'0','active',$2)`, out.email, out.subject); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO identity.auth_binding(subject,person_id,link_method) SELECT $1,id,'new_registration' FROM mlm.person WHERE user_id=$1`, out.subject); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO mlm.affiliate(person_id,parent_id,sponsor_id,position,status) SELECT id,$2,$2,$3::mlm.tree_position,'active' FROM mlm.person WHERE user_id=$1`, out.subject, parent, side); err != nil {
		t.Fatal(err)
	}
	return out
}

func (owner nowLifecycleIdentity) input(pkg int) NOWPaymentsMembershipInput {
	return NOWPaymentsMembershipInput{Subject: owner.subject, Email: owner.email, Environment: "production", PackageID: pkg, PurchaseRequestID: uuid.NewString()}
}

type nowLifecycleRoundTripper func(*http.Request) (*http.Response, error)

func (f nowLifecycleRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func applyNOWPurchaseLifecycleMigration(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	// Production roles are named explicitly in84. These are entirely local,
	// synthetic stand-ins; runtime behavior is still exercised by a separate
	// actual NOINHERIT login granted from the operator's exact manifest.
	if _, err := pool.Exec(ctx, `DO $$ BEGIN
 CREATE ROLE mindbliss_now_ops_20261031 LOGIN NOINHERIT PASSWORD 'synthetic-lifecycle-operator';
 EXCEPTION WHEN duplicate_object THEN NULL; END $$;
 DO $$ BEGIN CREATE ROLE mindbliss_payments_20261025 LOGIN NOINHERIT PASSWORD 'synthetic-read-model';
 EXCEPTION WHEN duplicate_object THEN NULL; END $$;`); err != nil {
		t.Fatal("synthetic production-named roles", err)
	}
	files, err := filepath.Glob(filepath.Join(findRepoRoot(t), "_meta", "migration", "84_*.sql"))
	if err != nil || len(files) != 1 {
		t.Fatal("exactly one reviewed lifecycle migration84 is required", len(files), err)
	}
	data, err := os.ReadFile(files[0])
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, string(data)); err != nil {
		t.Fatal("lifecycle migration84", err)
	}
}
