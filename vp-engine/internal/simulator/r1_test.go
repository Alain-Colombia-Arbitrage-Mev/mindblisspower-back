package simulator

import (
	"testing"

	"github.com/leanovate/gopter"
	"github.com/leanovate/gopter/gen"
	"github.com/leanovate/gopter/prop"
)

// TestR1_NeverPaysUnqualified — when R1 is enabled and an affiliate fails
// the qualification at the START of a period, they should not appear in any
// candidate generated that period.
//
// We can't observe the candidate list from outside RunScenario, so we use a
// proxy: if compliance prob is 0, the affiliate cannot ever recover from a
// threshold crossing, so unqualified count must only grow once any node hits
// depth 10. And the cumulative-paid should be lower than R1-off run.
func TestR1_PausesUnqualified(t *testing.T) {
	off := Default()
	off.InitialAffiliates = 2000
	off.Periods = 8
	off.Seed = 42
	off.Plan.DepthRepurchaseEnabled = false

	on := off
	on.Plan.DepthRepurchaseEnabled = true
	on.Plan.RepurchaseComplianceProb = 0.0 // nobody ever recompran

	roff, err := RunScenario(off, nil)
	if err != nil {
		t.Fatal(err)
	}
	ron, err := RunScenario(on, nil)
	if err != nil {
		t.Fatal(err)
	}

	var paidOff, paidOn float64
	for _, r := range roff {
		f, _ := r.TotalPaid.Float64()
		paidOff += f
	}
	for _, r := range ron {
		f, _ := r.TotalPaid.Float64()
		paidOn += f
	}
	if paidOn >= paidOff {
		t.Errorf("R1-on with 0%% compliance should pay STRICTLY less than R1-off; off=%.2f on=%.2f", paidOff, paidOn)
	}
}

// TestR1_FullComplianceMatchesOff — if everyone repurchases (compliance=1.0),
// the qualification should never block anyone, so payouts must match the
// R1-off run within a few percent (small diff comes from repurchase inflows
// which change θ).
func TestR1_FullCompliance(t *testing.T) {
	off := Default()
	off.InitialAffiliates = 2000
	off.Periods = 8
	off.Seed = 42

	on := off
	on.Plan.DepthRepurchaseEnabled = true
	on.Plan.RepurchaseComplianceProb = 1.0

	roff, err := RunScenario(off, nil)
	if err != nil {
		t.Fatal(err)
	}
	ron, err := RunScenario(on, nil)
	if err != nil {
		t.Fatal(err)
	}

	for i, r := range ron {
		if r.UnqualifiedR1 != 0 {
			t.Errorf("period %d: at 100%% compliance UnqualifiedR1 should be 0, got %d", r.Period, r.UnqualifiedR1)
		}
		// At 100% compliance the only difference from R1-off is extra inflow
		// from repurchase events, which slightly raises α·inflows and may
		// raise θ — payouts can be SLIGHTLY higher with R1-on, not lower.
		fOn, _ := r.TotalPaid.Float64()
		fOff, _ := roff[i].TotalPaid.Float64()
		if fOn+0.01 < fOff*0.95 {
			t.Errorf("period %d: paid dropped > 5%% under 100%% compliance; off=%.2f on=%.2f", r.Period, fOff, fOn)
		}
	}
}

// TestR1_T1StillHolds — the treasury invariant must hold regardless of R1.
// Generated random scenarios with R1 on, verify totalPaid ≤ α·inflows.
func TestR1_T1Invariant(t *testing.T) {
	params := gopter.DefaultTestParametersWithSeed(201)
	params.MinSuccessfulTests = 20
	p := gopter.NewProperties(params)

	p.Property("R1 on: paid ≤ α × inflows for every period", prop.ForAll(
		func(seed int64, complianceProb float64) bool {
			s := Default()
			s.InitialAffiliates = 1500
			s.Periods = 8
			s.Seed = seed
			s.Plan.DepthRepurchaseEnabled = true
			s.Plan.RepurchaseComplianceProb = complianceProb

			results, err := RunScenario(s, nil)
			if err != nil {
				return false
			}
			for _, r := range results {
				maxAllowed, _ := s.Plan.TreasuryAlpha.Mul(r.Inflows).Float64()
				paid, _ := r.TotalPaid.Float64()
				if paid > maxAllowed+0.01 {
					t.Logf("T1 VIOLATED with R1 p=%d paid=%.2f max=%.2f compliance=%.2f",
						r.Period, paid, maxAllowed, complianceProb)
					return false
				}
			}
			return true
		},
		gen.Int64Range(1, 10000),
		gen.Float64Range(0.0, 1.0),
	))

	p.TestingRun(t)
}

// TestR1_DeterminismHolds — same seed + same R1 settings = same result.
func TestR1_Determinism(t *testing.T) {
	s := Default()
	s.InitialAffiliates = 800
	s.Periods = 6
	s.Plan.DepthRepurchaseEnabled = true
	s.Plan.RepurchaseComplianceProb = 0.7

	r1, _ := RunScenario(s, nil)
	r2, _ := RunScenario(s, nil)
	for i := range r1 {
		if !r1[i].TotalPaid.Equal(r2[i].TotalPaid) {
			t.Errorf("R1 determinism break p=%d %s vs %s", i+1, r1[i].TotalPaid, r2[i].TotalPaid)
		}
		if r1[i].UnqualifiedR1 != r2[i].UnqualifiedR1 {
			t.Errorf("R1 unqualified count differs p=%d %d vs %d", i+1, r1[i].UnqualifiedR1, r2[i].UnqualifiedR1)
		}
	}
}
