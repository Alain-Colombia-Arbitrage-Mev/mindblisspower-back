package payments

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/shopspring/decimal"
)

func TestNOWPaymentsPriceIncludesProviderCostWithoutCustomerSurcharge(t *testing.T) {
	for _, tc := range []struct {
		amount, wantCost, wantBase string
		wantCents                  int64
	}{
		{"100", "1.0000", "99.0000", 10000},
		{"250", "2.5000", "247.5000", 25000},
		{"500", "5.0000", "495.0000", 50000},
		{"1000", "10.0000", "990.0000", 100000},
		{"2500", "25.0000", "2475.0000", 250000},
		{"5000", "50.0000", "4950.0000", 500000},
		{"10000", "100.0000", "9900.0000", 1000000},
		{"25000", "250.0000", "24750.0000", 2500000},
		{"50000", "500.0000", "49500.0000", 5000000},
		{"100000", "1000.0000", "99000.0000", 10000000},
		{"0.01", "0.0001", "0.0099", 1},
		{"0.50", "0.0050", "0.4950", 50},
		{"100.01", "1.0001", "99.0099", 10001},
		{"999999999999.99", "9999999999.9999", "989999999999.9901", 99999999999999},
	} {
		t.Run(tc.amount, func(t *testing.T) {
			amount := decimal.RequireFromString(tc.amount)
			got, err := nowPaymentsPrice(amount)
			if err != nil {
				t.Fatal(err)
			}
			if got.AmountUSD != amount.StringFixed(2) || got.FeeUSD != "0.00" || got.TotalCents != tc.wantCents ||
				got.ProviderCostUSD != tc.wantCost || got.CommissionBaseUSD != tc.wantBase || got.Policy != nowPaymentsIncludedPricingPolicy {
				t.Fatalf("unexpected provider-specific price: %+v", got)
			}
			cost := decimal.RequireFromString(got.ProviderCostUSD)
			base := decimal.RequireFromString(got.CommissionBaseUSD)
			if !cost.Equal(amount.Shift(-2)) || !base.Equal(amount.Mul(decimal.New(99, -2))) || !cost.Add(base).Equal(amount) {
				t.Fatal("included cost and net basis must reconcile exactly to the customer total")
			}
		})
	}
}

func TestNOWPaymentsPriceRejectsInvalidCatalogueAmounts(t *testing.T) {
	for _, raw := range []string{"0", "-0.01", "100.001", "0.0001", "1000000000000", "92233720368547758.08"} {
		t.Run(raw, func(t *testing.T) {
			got, err := nowPaymentsPrice(decimal.RequireFromString(raw))
			if !errors.Is(err, ErrNOWPaymentsEvidence) || got != (nowPaymentsMembershipPricing{}) {
				t.Fatal("unsafe amount accepted", got, err)
			}
		})
	}
}

func TestNOWPaymentsPricingDoesNotChangeStripePackPricing(t *testing.T) {
	pack := Pack{AmountUSD: decimal.NewFromInt(100)}
	if _, err := nowPaymentsPrice(pack.AmountUSD); err != nil {
		t.Fatal(err)
	}
	if pack.FeeUSD().StringFixed(2) != "1.00" || pack.TotalUSD().StringFixed(2) != "101.00" || pack.TotalCents() != 10100 {
		t.Fatal("NOWPayments pricing must not alter Stripe or historical Pack semantics")
	}
}

func TestNOWPaymentsNewInvoiceUsesPersistedIncludedPrice(t *testing.T) {
	handler, client, store := fakeNOWMembershipHandler()
	pricing, err := nowPaymentsPrice(decimal.NewFromInt(100))
	if err != nil {
		t.Fatal(err)
	}
	store.attempt.AmountUSD, store.attempt.FeeUSD, store.attempt.TotalCents = pricing.AmountUSD, pricing.FeeUSD, pricing.TotalCents
	store.attempt.PricingPolicy, store.attempt.ProviderCostUSD, store.attempt.CommissionBaseUSD = pricing.Policy, pricing.ProviderCostUSD, pricing.CommissionBaseUSD
	w := httptest.NewRecorder()
	handler.handleNOWMembershipCheckout(w, httptest.NewRequest(http.MethodPost, "/", nil), checkoutRequest{Email: "verified@example.test", PackageID: 1}, nil, "")
	var response checkoutResponse
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusOK || client.creates != 1 || client.request.AmountUSDMinor != 10000 ||
		response.TotalUSD != "100.00" || response.FeeUSD != "0.00" || response.Provider != "nowpayments" || response.FulfillmentStatus != "review_required" {
		t.Fatal("included provider cost was added to the customer invoice or changed review-only delivery", response, w.Code)
	}
}
