package payments

import (
	"testing"

	"github.com/shopspring/decimal"
)

// Verifica la regla "todos pagan 1% de activación": total = pack + 1%, y el
// monto a Stripe en centavos = pack × 101 para los packs enteros del catálogo.
func TestPackPricing(t *testing.T) {
	cases := []struct {
		amount       string
		wantFeeUSD   string
		wantTotalUSD string
		wantCents    int64
	}{
		{"100", "1.00", "101.00", 10100},
		{"250", "2.50", "252.50", 25250},
		{"500", "5.00", "505.00", 50500},
		{"1000", "10.00", "1010.00", 101000},
		{"2500", "25.00", "2525.00", 252500},
		{"5000", "50.00", "5050.00", 505000},
		{"10000", "100.00", "10100.00", 1010000},
		{"25000", "250.00", "25250.00", 2525000},
		{"50000", "500.00", "50500.00", 5050000},
		{"100000", "1000.00", "101000.00", 10100000}, // VIP
	}
	for _, c := range cases {
		p := Pack{AmountUSD: decimal.RequireFromString(c.amount)}
		if got := p.FeeUSD().StringFixed(2); got != c.wantFeeUSD {
			t.Errorf("pack %s: fee = %s, want %s", c.amount, got, c.wantFeeUSD)
		}
		if got := p.TotalUSD().StringFixed(2); got != c.wantTotalUSD {
			t.Errorf("pack %s: total = %s, want %s", c.amount, got, c.wantTotalUSD)
		}
		if got := p.TotalCents(); got != c.wantCents {
			t.Errorf("pack %s: cents = %d, want %d", c.amount, got, c.wantCents)
		}
	}
}
