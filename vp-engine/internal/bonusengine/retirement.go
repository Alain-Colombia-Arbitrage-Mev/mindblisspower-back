package bonusengine

import (
	"github.com/shopspring/decimal"
)

// retirementContribConceptID = 1007 'Aporte a plan de jubilación'.
const retirementContribConceptID = 1007

// routeSplit divide un neto (post-θ) entre jubilación y retirable.
// toRetirement = net×pct (RoundDown 2); el remanente exacto va a retirable.
func routeSplit(net, pctToPlan decimal.Decimal) (toRetirement, toWithdrawable decimal.Decimal) {
	if pctToPlan.Sign() <= 0 {
		return decimal.Zero, net
	}
	toRetirement = net.Mul(pctToPlan).RoundDown(2)
	if toRetirement.GreaterThan(net) {
		toRetirement = net
	}
	toWithdrawable = net.Sub(toRetirement)
	return toRetirement, toWithdrawable
}
