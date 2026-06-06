// ADR-0016 R3 — points bonus.
//
// Rule: each binary block actually paid to an affiliate also accrues
// PointsPerBlock (default 1.0) points to that affiliate. Every
// PointsCadencePeriods (default 4 = monthly when weekly), accrued points
// are converted to USD at PointsDollarsPerPoint (default 1.0) and paid.
//
// Same caps as the binary block bonus: T1 (θ), T2 (lifetime per package),
// T3 (per-period). Subject to PauseMode (a paused affiliate doesn't
// accrue points because they didn't get the underlying block paid).
//
// See docs/bonos_puntos.md for the rationale of "1 point per closed
// block" (vs PV-matched or red-comercial alternatives) and "all caps"
// (vs T1-only as for R2 yield).
package simulator

import "github.com/shopspring/decimal"

// computePointsBonusCandidates produces synthetic Candidate entries for
// each node whose PointsAccrued > 0 at a cadence period. Each candidate
// looks like a block payment so the existing applyCaps / payment loop
// can handle it without special-casing.
//
// Returns empty slice if not a cadence period or feature disabled.
func computePointsBonusCandidates(tree *Tree, rootID int64, plan PlanConfig, period int) []Candidate {
	if !plan.PointsBonusEnabled || plan.PointsCadencePeriods <= 0 {
		return nil
	}
	if period%plan.PointsCadencePeriods != 0 {
		return nil
	}
	out := make([]Candidate, 0)
	for _, n := range allNodes(tree, rootID) {
		if n.PointsAccrued.IsZero() {
			continue
		}
		if n.PackageClosed {
			continue
		}
		gross := n.PointsAccrued.Mul(plan.PointsDollarsPerPoint).RoundDown(2)
		if gross.Sign() <= 0 {
			continue
		}
		out = append(out, Candidate{
			AncestorID:    n.ID,
			SourceEventID: 0, // synthetic — no underlying purchase event
			NewBlocks:     0, // points bonus doesn't consume PV
			Side:          "",
			GrossAmount:   gross,
		})
	}
	return out
}

// resetPointsAccrued clears all PointsAccrued counters. Called after a
// cadence payout completes.
func resetPointsAccrued(tree *Tree, rootID int64) {
	for _, n := range allNodes(tree, rootID) {
		n.PointsAccrued = decimal.Zero
	}
}

// sumPointsAccrued reports the total points sitting in nodes (not yet
// converted to USD). Used for reporting / monitoring.
func sumPointsAccrued(tree *Tree, rootID int64) decimal.Decimal {
	total := decimal.Zero
	for _, n := range allNodes(tree, rootID) {
		total = total.Add(n.PointsAccrued)
	}
	return total
}
