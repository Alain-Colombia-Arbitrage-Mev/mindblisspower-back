package payments

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/rs/zerolog"
	"github.com/shopspring/decimal"
)

func TestCheckoutCrossProviderOutstandingIntegration(t *testing.T) {
	if testing.Short() {
		t.Skip("isolated PostgreSQL testcontainer")
	}
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	apply := func(file string) {
		t.Helper()
		migration, err := os.ReadFile(filepath.Join(findRepoRoot(t), "_meta", "migration", file))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(migration)); err != nil {
			t.Fatal(file, err)
		}
	}
	apply("70_stable_identity_bindings.sql")
	if _, err := pool.Exec(ctx, `INSERT INTO auth.user(id,email,email_verified)
 VALUES('synthetic-cross-provider','cross-provider@example.test',true);
 INSERT INTO mlm.person(first_name,last_name,email,phone_number,status,user_id)
 VALUES('Synthetic','Cross provider','cross-provider@example.test','0','active','synthetic-cross-provider');
 INSERT INTO identity.auth_binding(subject,person_id,link_method)
 SELECT 'synthetic-cross-provider',id,'new_registration' FROM mlm.person WHERE user_id='synthetic-cross-provider';
 INSERT INTO mlm.package(id,name,amount_usd,pv,type)
 SELECT id,'Synthetic cross-provider membership',100,50,'enrollment' FROM generate_series(3000,3020) id;`); err != nil {
		t.Fatal(err)
	}
	var personID int64
	if err := pool.QueryRow(ctx, `SELECT id FROM mlm.person WHERE user_id='synthetic-cross-provider'`).Scan(&personID); err != nil {
		t.Fatal(err)
	}
	store := NewStore(pool)
	stripeInput := func(packageID int) PurchaseIntent {
		return PurchaseIntent{UserID: "cross-provider@example.test", PersonID: personID,
			PackageID: packageID, PV: 50, AmountUSD: decimal.NewFromInt(100), FeeUSD: decimal.NewFromInt(1),
			TotalCents: 10100, Currency: "usd", ReferralCode: "synthetic-referral"}
	}
	nowInput := func(packageID int) NOWPaymentsMembershipInput {
		return NOWPaymentsMembershipInput{Email: "cross-provider@example.test", Environment: "production", PackageID: packageID}
	}
	// A legacy Stripe-only database must not require the prepared NOW migration.
	if _, err := store.CreatePurchaseIntent(ctx, stripeInput(3000)); err != nil {
		t.Fatal("pre-74 Stripe checkout must remain supported", err)
	}
	// Catalog introspection replaces undefined-column retries within the new
	// transaction, so an older referral schema must still commit successfully.
	if _, err := pool.Exec(ctx, `ALTER TABLE payments.purchase_intent DROP COLUMN referral_code, DROP COLUMN preferred_side`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreatePurchaseIntent(ctx, stripeInput(3001)); err != nil {
		t.Fatal("legacy referral schema checkout must commit", err)
	}
	if _, err := pool.Exec(ctx, `ALTER TABLE payments.purchase_intent ADD COLUMN referral_code text, ADD COLUMN preferred_side char(1)`); err != nil {
		t.Fatal(err)
	}
	apply("74_nowpayments_membership_review.sql")

	t.Run("NOW reservations and uncertainty block Stripe", func(t *testing.T) {
		attempt, err := store.CreateNOWPaymentsMembership(ctx, nowInput(3002))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.CreatePurchaseIntent(ctx, stripeInput(3002)); !errors.Is(err, ErrNOWPaymentsOutstanding) {
			t.Fatal("creating NOW invoice must block another provider", err)
		}
		if err := store.MarkNOWPaymentsInvoiceUnknown(ctx, attempt.ID, "production"); err != nil {
			t.Fatal(err)
		}
		if _, err := store.CreatePurchaseIntent(ctx, stripeInput(3002)); !errors.Is(err, ErrNOWPaymentsOutstanding) {
			t.Fatal("unknown NOW invoice must not permit a second provider charge", err)
		}
		if _, err := pool.Exec(ctx, `UPDATE payments.nowpayments_membership_attempt SET state='pending_review' WHERE id=$1::uuid`, attempt.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := store.CreatePurchaseIntent(ctx, stripeInput(3002)); !errors.Is(err, ErrNOWPaymentsOutstanding) {
			t.Fatal("NOW manual review must not permit a second provider charge", err)
		}
	})

	t.Run("Stripe pending states block NOW", func(t *testing.T) {
		for i, state := range []string{"created", "paid", "needs_placement", "security_blocked", "disputed", "chargeback"} {
			packageID := 3003 + i
			id, err := store.CreatePurchaseIntent(ctx, stripeInput(packageID))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `UPDATE payments.purchase_intent SET status=$2 WHERE id=$1::uuid`, id, state); err != nil {
				t.Fatal(err)
			}
			if _, err := store.CreateNOWPaymentsMembership(ctx, nowInput(packageID)); !errors.Is(err, ErrNOWPaymentsOutstanding) {
				t.Fatal("Stripe pending/risk collection must block NOW", state, err)
			}
			if _, err := pool.Exec(ctx, `UPDATE payments.purchase_intent SET status='failed' WHERE id=$1::uuid`, id); err != nil {
				t.Fatal(err)
			}
			if _, err := store.CreateNOWPaymentsMembership(ctx, nowInput(packageID)); err != nil {
				t.Fatal("confirmed failed Stripe attempt need not block alternative payment", err)
			}
		}
	})

	t.Run("resume rechecks terminal states and bans", func(t *testing.T) {
		id, err := store.CreatePurchaseIntent(ctx, stripeInput(3018))
		if err != nil {
			t.Fatal(err)
		}
		for _, state := range []string{"paid", "activated", "needs_placement", "failed", "refunded", "security_blocked", "disputed", "chargeback"} {
			if _, err := pool.Exec(ctx, `UPDATE payments.purchase_intent SET status=$2 WHERE id=$1::uuid`, id, state); err != nil {
				t.Fatal(err)
			}
			if err := store.ReopenIntent(ctx, id); !errors.Is(err, ErrActivationState) {
				t.Fatal("stale or terminal intent reopened", state, err)
			}
		}
		if _, err := pool.Exec(ctx, `UPDATE payments.purchase_intent SET status='expired' WHERE id=$1::uuid`, id); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE mlm.person SET status='suspended' WHERE id=$1`, personID); err != nil {
			t.Fatal(err)
		}
		if err := store.ReopenIntent(ctx, id); !errors.Is(err, ErrCheckoutIdentityReview) {
			t.Fatal("suspended owner resumed collection", err)
		}
		if _, err := pool.Exec(ctx, `UPDATE mlm.person SET status='active' WHERE id=$1`, personID); err != nil {
			t.Fatal(err)
		}
		if err := store.ReopenIntent(ctx, id); err != nil {
			t.Fatal("eligible expired intent must reserve before external checkout", err)
		}
		if _, err := store.CreateNOWPaymentsMembership(ctx, nowInput(3018)); !errors.Is(err, ErrNOWPaymentsOutstanding) {
			t.Fatal("resumed Stripe reservation must block NOW", err)
		}
	})

	t.Run("expired Stripe resume cannot bypass NOW review", func(t *testing.T) {
		id, err := store.CreatePurchaseIntent(ctx, stripeInput(3019))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE payments.purchase_intent SET status='expired' WHERE id=$1::uuid`, id); err != nil {
			t.Fatal(err)
		}
		if _, err := store.CreateNOWPaymentsMembership(ctx, nowInput(3019)); err != nil {
			t.Fatal(err)
		}
		handler := NewHandler(store, nil, "synthetic-resume-token", nil, 0, zerolog.Nop())
		request := httptest.NewRequest(http.MethodGet, "/api/payments/resume?t="+handler.signResumeToken(id), nil)
		request.Header.Set("X-VP-Service-Token", "synthetic-resume-token")
		response := httptest.NewRecorder()
		handler.handleResume(response, request)
		if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "membership_payment_pending_review") {
			t.Fatal("resume must stop before invoking its absent provider", response.Code, response.Body.String())
		}
		var status string
		if err := pool.QueryRow(ctx, `SELECT status FROM payments.purchase_intent WHERE id=$1::uuid`, id).Scan(&status); err != nil || status != "expired" {
			t.Fatal("blocked resume must not reopen its Stripe intent", status, err)
		}
	})

	t.Run("simultaneous resume and NOW reserve one provider", func(t *testing.T) {
		id, err := store.CreatePurchaseIntent(ctx, stripeInput(3020))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE payments.purchase_intent SET status='expired' WHERE id=$1::uuid`, id); err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		results := make(chan error, 2)
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			results <- store.ReopenIntent(ctx, id)
		}()
		go func() {
			defer wg.Done()
			<-start
			_, err := store.CreateNOWPaymentsMembership(ctx, nowInput(3020))
			results <- err
		}()
		close(start)
		wg.Wait()
		close(results)
		reserved, blocked := 0, 0
		for err := range results {
			if err == nil {
				reserved++
			} else if errors.Is(err, ErrNOWPaymentsOutstanding) {
				blocked++
			} else {
				t.Fatal("resume/provider race failed unexpectedly", err)
			}
		}
		if reserved != 1 || blocked != 1 {
			t.Fatal("resume and NOW could both reserve payable checkouts", reserved, blocked)
		}
	})

	t.Run("simultaneous providers reserve exactly one order", func(t *testing.T) {
		for packageID := 3010; packageID < 3018; packageID++ {
			start := make(chan struct{})
			results := make(chan error, 2)
			var wg sync.WaitGroup
			wg.Add(2)
			go func() {
				defer wg.Done()
				<-start
				_, err := store.CreatePurchaseIntent(ctx, stripeInput(packageID))
				results <- err
			}()
			go func() {
				defer wg.Done()
				<-start
				_, err := store.CreateNOWPaymentsMembership(ctx, nowInput(packageID))
				results <- err
			}()
			close(start)
			wg.Wait()
			close(results)
			created, blocked := 0, 0
			for err := range results {
				if err == nil {
					created++
				} else if errors.Is(err, ErrNOWPaymentsOutstanding) {
					blocked++
				} else {
					t.Fatal("concurrent provider reservation failed unexpectedly", err)
				}
			}
			if created != 1 || blocked != 1 {
				t.Fatal("both providers could collect the same membership", created, blocked)
			}
			var count int
			if err := pool.QueryRow(ctx, `SELECT
 (SELECT count(*) FROM payments.purchase_intent WHERE person_id=$1 AND package_id=$2)+
 (SELECT count(*) FROM payments.nowpayments_membership_attempt WHERE person_id=$1 AND package_id=$2)`, personID, packageID).Scan(&count); err != nil || count != 1 {
				t.Fatal("shared person lock did not produce exactly one durable reservation", count, err)
			}
		}
	})
}
