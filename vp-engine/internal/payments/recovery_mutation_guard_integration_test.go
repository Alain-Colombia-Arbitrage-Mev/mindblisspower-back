package payments

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/rs/zerolog"
	"github.com/shopspring/decimal"
	"github.com/vicionpower/vp-engine/internal/bonusengine"
	"github.com/vicionpower/vp-engine/internal/ledger"
	"github.com/vicionpower/vp-engine/internal/shared/financialguard"
	"github.com/vicionpower/vp-engine/internal/withdrawals"
	v1 "github.com/vicionpower/vp-engine/proto/gen/go/vicionpower/v1"
)

func TestRecoveryFinancialMutationDomainsIntegration(t *testing.T) {
	if testing.Short() {
		t.Skip("isolated PostgreSQL testcontainer")
	}
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	// Source presence alone locks writes: even no captures, plan, wallets or
	// intents must not silently be treated as an operational zero-balance DB.
	if _, err := pool.Exec(ctx, `CREATE TABLE payments.stripe_sale(payment_intent_id text PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	store := NewStore(pool)
	withdrawalStore := withdrawals.NewStore(pool)
	engine := bonusengine.New(pool, nil, zerolog.Nop())
	for _, tc := range []struct {
		name string
		call func() error
	}{
		{"create purchase", func() error { _, err := store.CreatePurchaseIntent(ctx, PurchaseIntent{}); return err }},
		{"activation and PV credit", func() error { _, err := store.ActivatePaidPurchase(ctx, "cs_synthetic", "pi_synthetic"); return err }},
		{"refund before gateway", func() error {
			_, err := store.RefundPurchaseIntent(ctx, &StripeGateway{}, "synthetic", 100, "test review", "admin@example.test")
			return err
		}},
		{"reopen purchase", func() error { return store.ReopenIntent(ctx, "synthetic") }},
		{"operational charge", func() error {
			_, err := store.RecordOperationalCharge(ctx, "failed", 1, "synthetic review", "admin@example.test", time.Time{})
			return err
		}},
		{"request withdrawal", func() error {
			_, err := withdrawalStore.RequestWithdrawal(ctx, "member@example.test", "100", "synthetic account")
			return err
		}},
		{"approve withdrawal", func() error { return withdrawalStore.SetWithdrawalStatus(ctx, 1, "approved", "admin@example.test") }},
		{"pay withdrawal", func() error { return withdrawalStore.SetWithdrawalStatus(ctx, 1, "paid", "admin@example.test") }},
		{"binary close", func() error { return engine.CloseBinaryPeriod(ctx, 1) }},
		{"ROI daily", func() error { return engine.RunROIDaily(ctx) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.call(); !errors.Is(err, financialguard.ErrRecoveryReview) {
				t.Fatalf("financial mutation was not rejected by the recovery guard: %v", err)
			}
		})
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := bonusengine.PayV2Streams(ctx, tx, nil, 1, nil, decimal.NewFromInt(1), time.Now(), 0); !errors.Is(err, financialguard.ErrRecoveryReview) {
		t.Fatal("direct commission payment entry must remain locked", err)
	}
	if err := bonusengine.AccruePoints(ctx, tx, nil, nil, decimal.NewFromInt(1)); !errors.Is(err, financialguard.ErrRecoveryReview) {
		t.Fatal("direct compensation-point accrual must remain locked", err)
	}
	service := ledger.New(pool, nil, zerolog.Nop())
	_, err = service.PostTransaction(ctx, connect.NewRequest(&v1.PostTransactionRequest{
		ExternalRef: "synthetic:recovery-blocked", Movements: []*v1.Movement{{WalletId: 1, AffiliateId: 1, ConceptId: 1, Amount: "1.00"}},
	}))
	if !errors.Is(err, financialguard.ErrRecoveryReview) || connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("ledger must reject a valid-shaped mutation as FailedPrecondition", err)
	}
	var artifacts int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM mlm.transaction)
		+ (SELECT count(*) FROM mlm.wallet_movement) + (SELECT count(*) FROM payments.purchase_intent)
		+ (SELECT count(*) FROM mlm.withdrawal_request) + (SELECT count(*) FROM mlm.affiliate_package)
		+ (SELECT count(*) FROM mlm.investment_cd) + (SELECT count(*) FROM mlm.tree_event)
		+ (SELECT count(*) FROM mlm.affiliate_payout_state) + (SELECT count(*) FROM mlm.binary_period)`).Scan(&artifacts); err != nil || artifacts != 0 {
		t.Fatal("rejected operations left financial artifacts", artifacts, err)
	}
	h := NewHandler(store, &StripeGateway{}, "synthetic-service-token", []string{"admin@example.test"}, 0, zerolog.Nop())
	h.SetSuperAdmins([]string{"admin@example.test"})
	h.SetIdentityVerifier(fakeVerifier{email: "member@example.test"}, true)
	r := httptest.NewRequest(http.MethodPost, "/api/payments/checkout", strings.NewReader(`{"email":"member@example.test","package_id":1}`))
	r.Header.Set("X-VP-Service-Token", "synthetic-service-token")
	r.Header.Set(idTokenHeader, "synthetic-id-token")
	w := httptest.NewRecorder()
	h.handleCheckout(w, r)
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "stripe_recovery_financial_review_required") {
		t.Fatal("checkout must stop before provisioning or calling Stripe", w.Code, w.Body.String())
	}
	r = httptest.NewRequest(http.MethodGet, "/api/payments/resume?t="+h.signResumeToken("synthetic"), nil)
	r.Header.Set("X-VP-Service-Token", "synthetic-service-token")
	w = httptest.NewRecorder()
	h.handleResume(w, r)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatal("resume must stop before creating a new checkout", w.Code)
	}
	h.SetIdentityVerifier(fakeVerifier{email: "admin@example.test"}, true)
	for _, tc := range []struct{ path, body string }{
		{"/api/admin/payments/refund", `{"id":"00000000-0000-0000-0000-000000000001","reason":"synthetic review"}`},
		{"/api/admin/operational-charges", `{"charge_type":"failed","quantity":1,"reason":"synthetic review"}`},
	} {
		r = httptest.NewRequest(http.MethodPost, tc.path+"?email=admin@example.test", strings.NewReader(tc.body))
		r.Header.Set("X-VP-Service-Token", "synthetic-service-token")
		r.Header.Set(idTokenHeader, "synthetic-id-token")
		w = httptest.NewRecorder()
		h.Routes().ServeHTTP(w, r)
		if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "stripe_recovery_financial_review_required") {
			t.Fatal("admin financial mutation must return a review lock", tc.path, w.Code, w.Body.String())
		}
	}
	if _, err := pool.Exec(ctx, `DROP TABLE payments.stripe_sale`); err != nil {
		t.Fatal(err)
	}
	if err := financialguard.RequireOperational(ctx, pool); err != nil {
		t.Fatal("normal operational databases retain their existing flow", err)
	}
}
