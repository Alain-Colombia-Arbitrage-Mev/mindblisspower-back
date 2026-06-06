package bonusengine

import "github.com/shopspring/decimal"

// theta = clamp(alpha × inflows / projected, 0, 1).
// projected=0 → theta=1 (no candidates, sin throttle).
// Redondeo a 6 decimales (matchea numeric(8,6) del schema).
//
// Función pura — testeable sin DB.
func ComputeTheta(alpha, inflows, projected decimal.Decimal) decimal.Decimal {
	one := decimal.NewFromInt(1)
	if projected.LessThanOrEqual(decimal.Zero) {
		return one
	}
	raw := alpha.Mul(inflows).Div(projected)
	if raw.GreaterThanOrEqual(one) {
		return one
	}
	if raw.LessThan(decimal.Zero) {
		return decimal.Zero
	}
	return raw.RoundDown(6)
}
