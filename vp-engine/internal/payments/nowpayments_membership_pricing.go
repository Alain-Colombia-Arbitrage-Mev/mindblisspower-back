package payments

import "github.com/shopspring/decimal"

// The NOWPayments merchant cost is included in the catalogue price; it is not
// the customer activation surcharge used by the independent Stripe flow.
const nowPaymentsIncludedPricingPolicy = "catalog_includes_provider_1pct_v1"

type nowPaymentsMembershipPricing struct {
	AmountUSD         string
	FeeUSD            string // Additional customer fee: always zero for this policy.
	ProviderCostUSD   string
	CommissionBaseUSD string
	TotalCents        int64
	Policy            string
}

// nowPaymentsPrice snapshots only the server-side catalogue amount. The invoice
// has exact USD cents. Cost and commission basis retain four decimal places so
// one percent of a cent-priced product is not rounded twice or lost; downstream
// commission awards still require their own separately approved rounding rule.
// This calculation neither allocates a commission nor activates a membership.
func nowPaymentsPrice(amount decimal.Decimal) (nowPaymentsMembershipPricing, error) {
	// Match the immutable order's numeric(14,2) catalogue-price column. Reject
	// unsupported precision/range before IntPart could truncate or overflow.
	if !amount.IsPositive() || !amount.Equal(amount.Round(2)) ||
		amount.GreaterThan(decimal.New(99999999999999, -2)) {
		return nowPaymentsMembershipPricing{}, ErrNOWPaymentsEvidence
	}
	cost := amount.Shift(-2)
	base := amount.Sub(cost)
	return nowPaymentsMembershipPricing{
		AmountUSD: amount.StringFixed(2), FeeUSD: "0.00",
		ProviderCostUSD: cost.StringFixed(4), CommissionBaseUSD: base.StringFixed(4),
		TotalCents: amount.Shift(2).IntPart(), Policy: nowPaymentsIncludedPricingPolicy,
	}, nil
}
