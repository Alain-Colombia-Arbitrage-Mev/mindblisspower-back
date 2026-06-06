package simulator

import (
	"testing"

	"github.com/shopspring/decimal"
)

func TestEnumerateCandidatesRequiresBinaryChildrenAndSponsoredDirectsByLeg(t *testing.T) {
	tree := NewTree(11)
	root := tree.CreateRoot()
	b, _, _ := tree.AutoPlace(root, decimal.RequireFromString("1000"))

	// Spillover structure: B receives active binary children on both legs, but
	// they were sponsored by root, not by B.
	left, _, _ := tree.attach(tree.Get(b), "L", root, decimal.RequireFromString("1000"))
	right, _, _ := tree.attach(tree.Get(b), "R", root, decimal.RequireFromString("1000"))

	plan := V1Conservative()
	plan.QualifiedDirectsLeft = 1
	plan.QualifiedDirectsRight = 1

	events := []Event{
		{ID: 1, NodeID: left, PV: decimal.RequireFromString("500"), USD: decimal.RequireFromString("500")},
		{ID: 2, NodeID: right, PV: decimal.RequireFromString("500"), USD: decimal.RequireFromString("500")},
	}

	for _, c := range enumerateCandidates(tree, events, plan) {
		if c.AncestorID == b {
			t.Fatalf("B should not earn from spillover-only children; got %+v", c)
		}
	}
}

func TestEnumerateCandidatesPaysWhenTreeRulesAreMet(t *testing.T) {
	tree := NewTree(12)
	root := tree.CreateRoot()
	b, _, _ := tree.AutoPlace(root, decimal.RequireFromString("1000"))

	left, _, _ := tree.attach(tree.Get(b), "L", b, decimal.RequireFromString("1000"))
	right, _, _ := tree.attach(tree.Get(b), "R", b, decimal.RequireFromString("1000"))

	plan := V1Conservative()
	plan.QualifiedDirectsLeft = 1
	plan.QualifiedDirectsRight = 1

	events := []Event{
		{ID: 1, NodeID: left, PV: decimal.RequireFromString("500"), USD: decimal.RequireFromString("500")},
		{ID: 2, NodeID: right, PV: decimal.RequireFromString("500"), USD: decimal.RequireFromString("500")},
	}

	for _, c := range enumerateCandidates(tree, events, plan) {
		if c.AncestorID == b {
			if !c.GrossAmount.Equal(decimal.RequireFromString("10")) {
				t.Fatalf("gross amount = %s, want 10", c.GrossAmount)
			}
			return
		}
	}
	t.Fatal("B should earn when it has binary children and sponsored directs on both legs")
}

func TestRunScenarioSeedsInitialPopulationWithTreeRuleSponsors(t *testing.T) {
	s := Default()
	s.InitialAffiliates = 300
	s.Periods = 4
	s.GrowthRate = 0
	s.Seed = 42
	s.Plan.QualifiedDirectsLeft = 1
	s.Plan.QualifiedDirectsRight = 1

	results, err := RunScenario(s, nil)
	if err != nil {
		t.Fatal(err)
	}

	totalBinary := decimal.Zero
	for _, r := range results {
		totalBinary = totalBinary.Add(r.BinaryPaid)
	}
	if !totalBinary.GreaterThan(decimal.Zero) {
		t.Fatal("expected initial simulation to create qualified sponsors and binary payouts under tree rules")
	}
}
