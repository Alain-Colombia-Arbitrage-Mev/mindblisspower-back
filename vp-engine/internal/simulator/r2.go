// ADR-0015 R2 — annual yield gated on "2 directos balanced".
//
// Rule: an affiliate qualifies for the 25%/year yield iff they have at least
// one personally-sponsored direct on each side of their binary subtree
// (DirectsLeft ≥ 1 AND DirectsRight ≥ 1). Yield is paid every
// YieldCadencePeriods periods (4 = monthly when periods are weekly) as
// PackagePrice × YieldAnnualRate / 12.
//
// Yield is subject to θ (the treasury invariant) but bypasses T2/T3 caps:
// it's a capital-return stream, not a binary commission.
package simulator

import "github.com/shopspring/decimal"

// isQualifiedR2 returns true iff the affiliate has at least one personally
// sponsored direct on each side of their binary tree. The root never
// qualifies for yield.
func isQualifiedR2(n *Node) bool {
	if n == nil || n.ParentID == 0 {
		return false
	}
	return n.DirectsLeft > 0 && n.DirectsRight > 0
}

// yieldEntry is one pending yield payment for a single node this period.
type yieldEntry struct {
	NodeID int64
	Amount decimal.Decimal
}

// computeYieldCandidates returns the per-affiliate yield payments owed this
// period (before θ scaling). Empty if YieldEnabled is false or it's not a
// cadence boundary.
func computeYieldCandidates(tree *Tree, rootID int64, plan PlanConfig, period int) []yieldEntry {
	if !plan.YieldEnabled || plan.YieldCadencePeriods <= 0 {
		return nil
	}
	if period%plan.YieldCadencePeriods != 0 {
		return nil
	}
	monthlyRate := plan.YieldAnnualRate.Div(decimal.NewFromInt(12))
	out := make([]yieldEntry, 0)
	for _, n := range allNodes(tree, rootID) {
		if !isQualifiedR2(n) || n.PackageClosed {
			continue
		}
		if n.PackagePrice.IsZero() {
			continue
		}
		amt := n.PackagePrice.Mul(monthlyRate).RoundDown(2)
		if amt.Sign() <= 0 {
			continue
		}
		out = append(out, yieldEntry{NodeID: n.ID, Amount: amt})
	}
	return out
}

// countYieldQualified returns how many affiliates meet the R2 condition at
// the end of a period. Reported in PeriodResult.YieldQualified.
func countYieldQualified(tree *Tree, rootID int64) int {
	n := 0
	for _, node := range allNodes(tree, rootID) {
		if isQualifiedR2(node) && !node.PackageClosed {
			n++
		}
	}
	return n
}
