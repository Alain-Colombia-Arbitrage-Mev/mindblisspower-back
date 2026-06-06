// ADR-0013 R1 — depth-based repurchase qualification.
//
// Rule: an affiliate must have purchased a package AFTER their MaxDownlineDepth
// crossed the latest multiple of RepurchaseThreshold (default 10). Otherwise
// their bonus is paused (P-A skip mode).
package simulator

import (
	"math/rand"

	"github.com/shopspring/decimal"
)

// isQualifiedR1 returns true iff the affiliate either:
//   - has not yet crossed any depth threshold, or
//   - has made a purchase after the most recent threshold crossing.
//
// If R1 is disabled in plan, always returns true.
func isQualifiedR1(n *Node, plan PlanConfig) bool {
	if !plan.DepthRepurchaseEnabled {
		return true
	}
	if n.LastDepthThresholdCrossed == 0 {
		return true
	}
	return n.LastPurchaseAt > n.LastDepthThresholdAt
}

// processRepurchases is called at the start of each period BEFORE event
// generation. For each affiliate currently failing R1, roll a random number
// against RepurchaseComplianceProb. If they comply:
//   - their LastPurchaseAt becomes current period
//   - an inflow is generated (random package price)
//   - if PauseMode = "carry", any PausedCarry is released to the wallet
//
// Also expires PausedCarry on affiliates who didn't comply within
// PausedCarryDecayPeriods.
//
// Returns (inflowFromRepurchases, releasedPausedCarry).
func processRepurchases(tree *Tree, rootID int64, plan PlanConfig, prices []decimal.Decimal, rng *rand.Rand, period int) (decimal.Decimal, decimal.Decimal) {
	if !plan.DepthRepurchaseEnabled {
		return decimal.Zero, decimal.Zero
	}
	// R1-stale: promote affiliates whose purchase is stale to "needs
	// repurchase" by stamping a synthetic threshold crossing this period.
	// This is what makes pause modes P-A/P-B/P-C actually diverge: forces
	// pause/recover cycles instead of one-shot depth crossings.
	if plan.PurchaseStalePeriods > 0 {
		for _, n := range tree.AllNodesSorted() {
			if n.ID == rootID {
				continue
			}
			if period-n.LastPurchaseAt > plan.PurchaseStalePeriods {
				if n.LastDepthThresholdCrossed == 0 {
					n.LastDepthThresholdCrossed = plan.RepurchaseThreshold
				}
				n.LastDepthThresholdAt = period
			}
		}
	}
	total := decimal.Zero
	released := decimal.Zero
	for _, n := range tree.AllNodesSorted() {
		if n.ID == rootID {
			continue
		}

		// P-B: expire PausedCarry that's been sitting too long.
		if plan.PauseMode == "carry" && n.PausedCarry.GreaterThan(decimal.Zero) {
			if period-n.PausedCarryUpdatedAt > plan.PausedCarryDecayPeriods {
				n.PausedCarry = decimal.Zero
			}
		}

		if isQualifiedR1(n, plan) {
			continue
		}
		if rng.Float64() < plan.RepurchaseComplianceProb {
			n.LastPurchaseAt = period
			// Renewal inflow — fraction of the affiliate's package, NOT a
			// full new package. Default 0 (the 5%/period ongoing
			// contribution already represents recurring activity). Keep
			// `prices` parameter for API stability.
			_ = prices
			if plan.RenewalCostFactor.GreaterThan(decimal.Zero) {
				renewal := n.PackagePrice.Mul(plan.RenewalCostFactor).Round(2)
				total = total.Add(renewal)
			}

			// P-B: release accumulated paused carry to the wallet now
			// (subject to package + period caps; θ already done above for
			// this period's regular candidates — paused-carry release is
			// treated as a separate inflow for simplicity in v1).
			if plan.PauseMode == "carry" && n.PausedCarry.GreaterThan(decimal.Zero) {
				release := n.PausedCarry
				n.PausedCarry = decimal.Zero
				n.PeriodPaid = n.PeriodPaid.Add(release)
				n.PackagePaid = n.PackagePaid.Add(release)
				if n.PackagePaid.GreaterThanOrEqual(plan.LifetimeCapFactor.Mul(n.PackagePrice)) {
					n.PackageClosed = true
				}
				released = released.Add(release)
			}
		}
	}
	return total, released
}

// countUnqualifiedR1 returns how many affiliates fail R1 right now. Used by
// reports and tests.
func countUnqualifiedR1(tree *Tree, rootID int64, plan PlanConfig) int {
	if !plan.DepthRepurchaseEnabled {
		return 0
	}
	n := 0
	for id, node := range tree.nodes {
		if id == rootID {
			continue
		}
		if !isQualifiedR1(node, plan) {
			n++
		}
	}
	return n
}
