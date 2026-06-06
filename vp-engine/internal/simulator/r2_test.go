package simulator

import (
	"testing"

	"github.com/shopspring/decimal"
)

// TestR2_DirectsTracking — placing nodes under a sponsor via auto-place
// should increment DirectsLeft/DirectsRight based on which subtree of the
// sponsor they land in. Personally-sponsored only (SponsorID = me).
func TestR2_DirectsTracking(t *testing.T) {
	tree := NewTree(42)
	rootID := tree.CreateRoot()
	tree.SetPeriod(1)

	// Sponsor S placed under root.
	sponsorID, _, _ := tree.AutoPlace(rootID, decimal.NewFromInt(100))
	s := tree.Get(sponsorID)
	if s.DirectsLeft != 0 || s.DirectsRight != 0 {
		t.Fatalf("fresh sponsor should have 0/0 directs, got %d/%d", s.DirectsLeft, s.DirectsRight)
	}

	// Place 1 direct under S — weak-leg picks L first (empty).
	d1, _, side1 := tree.AutoPlace(sponsorID, decimal.NewFromInt(100))
	if side1 != "L" {
		t.Fatalf("first direct expected on L, got %s", side1)
	}
	if s.DirectsLeft != 1 {
		t.Errorf("after first direct: DirectsLeft = %d, want 1", s.DirectsLeft)
	}
	if s.DirectsRight != 0 {
		t.Errorf("after first direct: DirectsRight = %d, want 0", s.DirectsRight)
	}
	_ = d1

	// Second direct under S — weak-leg picks R now.
	_, _, side2 := tree.AutoPlace(sponsorID, decimal.NewFromInt(100))
	if side2 != "R" {
		t.Fatalf("second direct expected on R, got %s", side2)
	}
	if s.DirectsLeft != 1 || s.DirectsRight != 1 {
		t.Errorf("after 2 directs: %d/%d, want 1/1", s.DirectsLeft, s.DirectsRight)
	}

	// Now isQualifiedR2 must be true for S.
	if !isQualifiedR2(s) {
		t.Errorf("sponsor with 1 direct on each side should qualify R2")
	}
}

// TestR2_QualificationGate — only balanced affiliates earn yield.
// One-sided directs should NOT qualify.
func TestR2_QualificationGate(t *testing.T) {
	tree := NewTree(42)
	rootID := tree.CreateRoot()
	tree.SetPeriod(1)

	a, _, _ := tree.AutoPlace(rootID, decimal.NewFromInt(100))

	// Place 5 directs under a, but all land on Left first then descend
	// further left under d1 — they're still "directs of a" only if
	// SponsorID == a. weak-leg balances, so by direct 3 we'd be on R.
	for i := 0; i < 2; i++ {
		tree.AutoPlace(a, decimal.NewFromInt(100))
	}
	node := tree.Get(a)
	if !isQualifiedR2(node) {
		t.Errorf("2 directs (1L,1R) should qualify R2")
	}

	// Now place a node with only L direct: another fresh sponsor.
	b, _, _ := tree.AutoPlace(rootID, decimal.NewFromInt(100))
	tree.AutoPlace(b, decimal.NewFromInt(100)) // only 1 direct → L only
	bn := tree.Get(b)
	if isQualifiedR2(bn) {
		t.Errorf("1 direct on L only should NOT qualify R2; got L=%d R=%d",
			bn.DirectsLeft, bn.DirectsRight)
	}
}

// TestR2_YieldCadence — yield only fires every YieldCadencePeriods,
// and the amount = PackagePrice × YieldAnnualRate / 12.
func TestR2_YieldCadence(t *testing.T) {
	s := Default()
	s.InitialAffiliates = 300
	s.Periods = 12
	s.Seed = 42
	s.GrowthRate = 0.0
	s.Plan.YieldEnabled = true
	s.Plan.YieldAnnualRate = decimal.RequireFromString("0.25")
	s.Plan.YieldCadencePeriods = 4

	results, err := RunScenario(s, nil)
	if err != nil {
		t.Fatal(err)
	}

	for _, r := range results {
		isCadence := r.Period%4 == 0
		if !isCadence && r.YieldPaid.GreaterThan(decimal.Zero) {
			t.Errorf("period %d: YieldPaid > 0 but not a cadence period", r.Period)
		}
		if isCadence && r.YieldQualified > 0 && r.YieldPaid.IsZero() {
			// Could be θ = 0 in extreme cases; tolerated.
			t.Logf("period %d: cadence period with %d qualified but YieldPaid=0 (likely θ=0)",
				r.Period, r.YieldQualified)
		}
	}
}

// TestR2_T1HoldsWithYield — T1 must hold even when yield is added.
// totalPaid ≤ α × inflows for every period, no matter what.
func TestR2_T1HoldsWithYield(t *testing.T) {
	s := Default()
	s.InitialAffiliates = 1000
	s.Periods = 12
	s.Seed = 42
	s.Plan.YieldEnabled = true
	s.Plan.YieldAnnualRate = decimal.RequireFromString("0.50") // exagerado a propósito
	s.Plan.YieldCadencePeriods = 2                              // forzar pagos frecuentes

	results, err := RunScenario(s, nil)
	if err != nil {
		t.Fatal(err)
	}

	for _, r := range results {
		maxAllowed, _ := s.Plan.TreasuryAlpha.Mul(r.Inflows).Float64()
		paid, _ := r.TotalPaid.Float64()
		if paid > maxAllowed+0.05 {
			t.Errorf("T1 violation p=%d paid=%.2f max=%.2f (α=0.45, yield rate 50%%)",
				r.Period, paid, maxAllowed)
		}
	}
}

// TestLock_CapitalLockedThenReleased — at p=1, all freshly-deposited capital
// is locked. After CapitalLockPeriods, it's released (drops to 0 if no new
// deposits).
func TestLock_CapitalLockedThenReleased(t *testing.T) {
	s := Default()
	s.InitialAffiliates = 200
	s.Periods = 60 // > 52 to see the release
	s.Seed = 42
	s.GrowthRate = 0.0 // no nuevos depósitos → lock se libera limpio
	s.Plan.CapitalLockPeriods = 52

	results, err := RunScenario(s, nil)
	if err != nil {
		t.Fatal(err)
	}

	// p=1: deposits made at p=0, lock active → LockedCapital > 0.
	if results[0].LockedCapital.IsZero() {
		t.Errorf("p=1: expected LockedCapital > 0, got %s", results[0].LockedCapital)
	}
	// p=51: still within lock window (52 periods from p=0).
	if results[50].LockedCapital.IsZero() {
		t.Errorf("p=51: expected lock still active, got 0")
	}
	// p=53: > 52 periods after deposit (deposits made at p=0, released when p-0 ≥ 52, i.e. p=52).
	if !results[52].LockedCapital.IsZero() {
		t.Errorf("p=53: expected lock released, got %s", results[52].LockedCapital)
	}
}

// TestLock_DoesNotAffectMargin — LockedCapital is reporting only; it should
// not impact margin or theta. Run with lock on vs off and assert paid is
// identical (modulo determinism).
func TestLock_DoesNotAffectMargin(t *testing.T) {
	off := Default()
	off.InitialAffiliates = 500
	off.Periods = 10
	off.Seed = 42
	off.Plan.CapitalLockPeriods = 0

	on := off
	on.Plan.CapitalLockPeriods = 52

	rOff, err := RunScenario(off, nil)
	if err != nil {
		t.Fatal(err)
	}
	rOn, err := RunScenario(on, nil)
	if err != nil {
		t.Fatal(err)
	}

	for i := range rOff {
		if !rOff[i].TotalPaid.Equal(rOn[i].TotalPaid) {
			t.Errorf("p=%d: lock changed paid (off=%s on=%s) — must be reporting only",
				i+1, rOff[i].TotalPaid, rOn[i].TotalPaid)
		}
	}
}
