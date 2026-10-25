package payments

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
)

func TestMemberSummaryRecoveryJSONUnknownBalances(t *testing.T) {
	for _, sales := range [][]MemberStripeSale{nil, {}, {{PaymentIntentID: "pi_synthetic", TotalUSD: "41.00", Status: "paid"}}} {
		summary := MemberSummary{DataSource: recoveredStripeSource, FinancialStatus: "pending_calculation_and_review", PayoutLocked: true, StripeSales: sales}
		wire := memberSummaryJSON(t, summary)
		for _, key := range []string{"wallet_balance_usd", "commission_available_usd", "commission_maturing_usd", "available_for_withdrawal_usd"} {
			if value, exists := wire[key]; !exists || value != nil {
				t.Fatalf("%s must be explicitly null, got %v", key, value)
			}
		}
		if wire["financial_status"] != "pending_calculation_and_review" || wire["payout_locked"] != true {
			t.Fatal("missing recovery financial gate")
		}
		if rows, ok := wire["stripe_sales"].([]any); !ok || len(rows) != len(sales) {
			t.Fatal("Stripe evidence must be an array, including when empty")
		}
	}
	wire := memberSummaryJSON(t, MemberSummary{WalletBalanceUSD: "25.00", CommissionAvailable: "15.00", CommissionMaturing: "10.00", AvailableForWithdrawal: "15.00"})
	if wire["wallet_balance_usd"] != "25.00" || wire["commission_available_usd"] != "15.00" || wire["available_for_withdrawal_usd"] != "15.00" {
		t.Fatal("legacy operational balance contract changed")
	}
}

func memberSummaryJSON(t *testing.T, summary MemberSummary) map[string]any {
	t.Helper()
	b, err := json.Marshal(summary)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(b, &wire); err != nil {
		t.Fatal(err)
	}
	return wire
}

func TestMemberRecoveryReadOnlyIsolationIntegration(t *testing.T) {
	if testing.Short() {
		t.Skip("isolated PostgreSQL testcontainer")
	}
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, recoveredStripeTestFixture+`
		INSERT INTO mlm.person(id,first_name,last_name,email,phone_number,status) OVERRIDING SYSTEM VALUE
		VALUES(2,'Other','Member','other@example.test','0','active');
		UPDATE recovery.stripe_sale_identity SET person_id=2 WHERE payment_intent_id NOT IN
		('pi_recovery1','pi_recovery2','pi_recovery3','pi_recovery4','pi_recovery5','pi_recovery6','pi_recovery7','pi_recovery18');
		UPDATE recovery.stripe_sale_identity SET identity_verified=false WHERE payment_intent_id='pi_recovery6';
		INSERT INTO recovery.stripe_sale_identity SELECT payment_intent_id,1,1,true,true
		FROM payments.stripe_sale WHERE payment_intent_id IN ('pi_otherproduct','pi_testmode','pi_eur');
	`); err != nil {
		t.Fatal(err)
	}
	cfg := pool.Config().Copy()
	cfg.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	readPool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer readPool.Close()
	store := NewStore(readPool)
	for _, fresh := range []bool{false, true} {
		summary, err := store.getMemberSummary(ctx, "buyer@t.local", fresh)
		if err != nil {
			t.Fatal(err)
		}
		if summary.DataSource != recoveredStripeSource || !summary.Positioned || !summary.PayoutLocked || len(summary.StripeSales) != 6 || len(summary.Payments) != 0 || summary.ActivePackages != 0 {
			t.Fatalf("recovery contract mixed evidence, operational intents or activations: %+v", summary)
		}
		for _, sale := range summary.StripeSales {
			switch sale.PaymentIntentID {
			case "pi_recovery1":
				if sale.Status != "refunded" || sale.RefundedUSD != "41.00" {
					t.Fatal("refund evidence lost")
				}
			case "pi_recovery2", "pi_recovery3", "pi_recovery4", "pi_recovery5":
				if sale.Status != "disputed" || sale.SourceEligible {
					t.Fatal("disputed capture promoted to eligibility")
				}
			case "pi_recovery7":
				if sale.Status != "paid" || !sale.SourceEligible {
					t.Fatal("source sale evidence lost")
				}
			default:
				t.Fatalf("another person, unverified identity or unrelated product leaked: %s", sale.PaymentIntentID)
			}
		}
	}
	for _, email := range []string{"other@example.test", "unprovisioned@example.test"} {
		summary, err := store.GetMemberSummary(ctx, email)
		if err != nil || !summary.PayoutLocked || summary.FinancialStatus != "pending_calculation_and_review" {
			t.Fatalf("missing recovery gate for %s: %v", email, err)
		}
		for _, sale := range summary.StripeSales {
			if sale.PaymentIntentID == "pi_recovery1" {
				t.Fatal("other user's sale leaked")
			}
		}
	}
	var intents int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM payments.purchase_intent`).Scan(&intents); err != nil || intents != 1 {
		t.Fatal("recovery read mutated operational payment evidence", intents, err)
	}
	h := NewHandler(store, nil, "synthetic-service-token", nil, 0, zerolog.Nop())
	h.SetIdentityVerifier(fakeVerifier{email: "other@example.test"}, true)
	r := httptest.NewRequest(http.MethodGet, "/api/payments/me?email=buyer@t.local", nil)
	r.Header.Set("X-VP-Service-Token", "synthetic-service-token")
	r.Header.Set(idTokenHeader, "synthetic-id-token")
	w := httptest.NewRecorder()
	h.handleMe(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("verified user cannot select another member: status=%d", w.Code)
	}
}

func TestMemberContextDoesNotPersistReferralIntegration(t *testing.T) {
	if testing.Short() {
		t.Skip("isolated PostgreSQL testcontainer")
	}
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO mlm.person(first_name,last_name,email,phone_number,status)
		VALUES('Referral','Member','referral@example.test','0','active');
		INSERT INTO mlm.affiliate(person_id,status,path,depth)
		SELECT id,'active',''::ltree,0 FROM mlm.person WHERE email='referral@example.test'`); err != nil {
		t.Fatal(err)
	}
	store := NewStore(pool)
	name, code, err := store.GetMemberContext(ctx, "referral@example.test")
	if err != nil || name != "Referral Member" {
		t.Fatal(name, err)
	}
	var id int64
	var persisted *string
	if err := pool.QueryRow(ctx, `SELECT a.id,a.invitation_link FROM mlm.affiliate a
		JOIN mlm.person p ON p.id=a.person_id WHERE p.email='referral@example.test'`).Scan(&id, &persisted); err != nil {
		t.Fatal(err)
	}
	if persisted != nil || code != fmt.Sprintf("MP%d", id) {
		t.Fatalf("GET must derive MP{id} without persisting a referral: code=%s persisted=%v", code, persisted)
	}
	sponsor, err := store.ResolveSponsorByCode(ctx, code)
	if err != nil || sponsor == nil || *sponsor != id {
		t.Fatal("virtual referral must resolve for registration without a persisted invitation_link", sponsor, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE mlm.affiliate SET invitation_link='legacy-referral' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if _, code, err := store.GetMemberContext(ctx, "referral@example.test"); err != nil || code != "legacy-referral" {
		t.Fatal("stored legacy referral must remain authoritative", code, err)
	}
}
