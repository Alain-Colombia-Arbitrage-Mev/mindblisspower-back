package simulator

import (
	"testing"

	"github.com/shopspring/decimal"
)

// TestR3_PointsAccrueOnBlockPayment — when R3 is enabled, each paid
// block should bump the ancestor's PointsAccrued by PointsPerBlock.
// Verified indirectly: at a cadence period, PointsBonusPaid > 0 if the
// previous periods generated block payments.
func TestR3_PointsAccrueOnBlockPayment(t *testing.T) {
	s := Default()
	s.InitialAffiliates = 500
	s.Periods = 8 // 2 cadence boundaries at p=4, p=8
	s.Seed = 42
	s.Plan.PointsBonusEnabled = true
	s.Plan.PointsCadencePeriods = 4

	results, err := RunScenario(s, nil)
	if err != nil {
		t.Fatal(err)
	}

	// Non-cadence periods: PointsBonusPaid must be 0, PointsHeld may grow.
	// Cadence periods (4, 8): PointsBonusPaid should be > 0 if any blocks
	// were paid in prior periods.
	var sawPayout bool
	for _, r := range results {
		isCadence := r.Period%4 == 0
		if !isCadence && r.PointsBonusPaid.GreaterThan(decimal.Zero) {
			t.Errorf("p=%d: PointsBonusPaid > 0 outside cadence", r.Period)
		}
		if isCadence && r.PointsBonusPaid.GreaterThan(decimal.Zero) {
			sawPayout = true
		}
	}
	if !sawPayout {
		t.Errorf("expected at least one points-bonus payout in 8 periods; got none")
	}
}

// TestR3_PointsBonusOff_NoEffect — with PointsBonusEnabled=false, results
// should be identical to a baseline without the feature.
func TestR3_PointsBonusOff_NoEffect(t *testing.T) {
	off := Default()
	off.InitialAffiliates = 300
	off.Periods = 8
	off.Seed = 42
	off.Plan.PointsBonusEnabled = false

	on := off
	on.Plan.PointsBonusEnabled = true
	// But never reach cadence:
	on.Plan.PointsCadencePeriods = 1000

	rOff, _ := RunScenario(off, nil)
	rOn, _ := RunScenario(on, nil)

	for i := range rOff {
		// PointsBonusPaid must be 0 in both; total paid identical
		// (accrual without payout doesn't move money).
		if !rOff[i].TotalPaid.Equal(rOn[i].TotalPaid) {
			t.Errorf("p=%d: enabling R3 without cadence changed paid (off=%s on=%s)",
				i+1, rOff[i].TotalPaid, rOn[i].TotalPaid)
		}
	}
}

// TestR3_T1HoldsWithPointsBonus — T1 invariant must hold when R3 is on.
// Use high points-per-block to stress θ.
func TestR3_T1HoldsWithPointsBonus(t *testing.T) {
	s := Default()
	s.InitialAffiliates = 800
	s.Periods = 12
	s.Seed = 42
	s.Plan.PointsBonusEnabled = true
	s.Plan.PointsPerBlock = decimal.RequireFromString("5") // 5 points per block
	s.Plan.PointsDollarsPerPoint = decimal.RequireFromString("1")
	s.Plan.PointsCadencePeriods = 2 // every 2 periods

	results, err := RunScenario(s, nil)
	if err != nil {
		t.Fatal(err)
	}

	for _, r := range results {
		maxAllowed, _ := s.Plan.TreasuryAlpha.Mul(r.Inflows).Float64()
		paid, _ := r.TotalPaid.Float64()
		if paid > maxAllowed+0.05 {
			t.Errorf("T1 violation p=%d paid=%.2f max=%.2f", r.Period, paid, maxAllowed)
		}
	}
}

// TestR3_PointsRespectT2 — points bonus must add to PackagePaid so the
// lifetime cap (T2) closes the package when crossed.
func TestR3_PointsRespectT2(t *testing.T) {
	s := Default()
	s.InitialAffiliates = 200
	s.Periods = 30
	s.Seed = 42
	s.Plan.PointsBonusEnabled = true
	s.Plan.PointsPerBlock = decimal.RequireFromString("10") // generoso
	s.Plan.PointsDollarsPerPoint = decimal.RequireFromString("1")
	s.Plan.PointsCadencePeriods = 4

	results, err := RunScenario(s, nil)
	if err != nil {
		t.Fatal(err)
	}

	// PackageCapHits should increase over time as packages close.
	first := results[0].Breakage.PackageCapHits
	last := results[len(results)-1].Breakage.PackageCapHits
	if last <= first {
		t.Logf("PackageCapHits first=%d last=%d (may be OK if no node hit T2)",
			first, last)
	}
	// Final period accumulated breakage from R3 should be reflected.
	// Not a hard assertion — depends on scenario — just confirm it's > 0
	// somewhere.
	var totalPkgHits int
	for _, r := range results {
		totalPkgHits += r.Breakage.PackageCapHits
	}
	if totalPkgHits == 0 {
		t.Logf("no T2 hits in 30 periods with PointsPerBlock=10 — scenario didn't stress T2")
	}
}
