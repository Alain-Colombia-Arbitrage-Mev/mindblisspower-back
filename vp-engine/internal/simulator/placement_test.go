// Placement property tests. Validates the *shape* invariants of the auto-
// placement algorithm — separate from the *monetary* invariants T1-T4
// covered in properties_test.go.
//
// Why this matters: a buggy placement algorithm could degenerate the tree
// into a near-chain, which would make the binary plan pay $0 in steady-state
// (good for the company, terrible for the product). These tests guarantee
// the tree grows like a balanced binary tree.
package simulator

import (
	"math"
	"testing"

	"github.com/leanovate/gopter"
	"github.com/leanovate/gopter/gen"
	"github.com/leanovate/gopter/prop"
	"github.com/shopspring/decimal"
)

// buildTree creates a tree with N affiliates using the given strategy.
func buildTree(n int, strategy string, seed int64) (*Tree, int64) {
	t := NewTree(seed)
	root := t.CreateRoot()
	rng := t.Seed()
	price := decimal.RequireFromString("100")
	for i := 0; i < n; i++ {
		PlaceWithStrategy(t, root, price, strategy, rng)
	}
	return t, root
}

// P1 — weak-leg auto-place keeps max depth within a small constant of log₂(N).
//
// Theoretical lower bound for any complete binary tree of N nodes:
// ceil(log₂(N+1)). Our placement always places at the first empty slot
// found via weak-leg, which is BFS-ish — it should achieve close-to-ideal.
//
// Tolerance: 2× ideal. In practice it's far tighter (≈1.0× as the manual run
// showed); 2× gives gopter room to find adversarial seeds without false fail.
func TestProperty_PlacementBoundedDepth(t *testing.T) {
	params := gopter.DefaultTestParametersWithSeed(101)
	params.MinSuccessfulTests = 30
	p := gopter.NewProperties(params)

	p.Property("weak-leg: max depth ≤ 2 × ceil(log2(N+1))", prop.ForAll(
		func(n int, seed int64) bool {
			if n < 4 {
				return true
			}
			tree, root := buildTree(n, StrategyWeakLeg, seed)
			s := ComputeStats(tree, root)
			ideal := math.Ceil(math.Log2(float64(n + 1)))
			limit := int(ideal * 2)
			ok := s.MaxDepth <= limit
			if !ok {
				t.Logf("DEPTH OVERFLOW n=%d seed=%d max=%d ideal=%.0f limit=%d",
					n, seed, s.MaxDepth, ideal, limit)
			}
			return ok
		},
		gen.IntRange(10, 5000),
		gen.Int64Range(1, 10000),
	))

	p.TestingRun(t)
}

// P2 — global L/R balance: |L_sum - R_sum| / N stays small under weak-leg.
// The placement counter tie-break should keep the global ratio near 0.5.
func TestProperty_GlobalBalance(t *testing.T) {
	params := gopter.DefaultTestParametersWithSeed(102)
	params.MinSuccessfulTests = 30
	p := gopter.NewProperties(params)

	// Empirical bound: weak-leg + count tie-break keeps global L/(L+R) within
	// 10% of perfect balance for any N ≥ 100. The deviation is dominated by
	// partial level-filling artifacts at small N and shrinks as N grows.
	// We could derive a tighter analytical bound but 10% is enough to
	// distinguish the healthy algorithm from degenerate placements (which
	// give L/(L+R) = 1.0 or 0.0).
	p.Property("weak-leg: |L/(L+R) - 0.5| < 0.10 for N ≥ 100", prop.ForAll(
		func(n int, seed int64) bool {
			if n < 100 {
				return true
			}
			tree, root := buildTree(n, StrategyWeakLeg, seed)
			s := ComputeStats(tree, root)
			deviation := math.Abs(s.LeftRightRatio - 0.5)
			ok := deviation < 0.10
			if !ok {
				t.Logf("BALANCE DRIFT n=%d seed=%d L/(L+R)=%.4f dev=%.4f depth=%d",
					n, seed, s.LeftRightRatio, deviation, s.MaxDepth)
			}
			return ok
		},
		gen.IntRange(100, 5000),
		gen.Int64Range(1, 10000),
	))

	p.TestingRun(t)
}

// P3 — no orphans: every non-root node has a parent in the tree.
func TestProperty_NoOrphans(t *testing.T) {
	params := gopter.DefaultTestParametersWithSeed(103)
	params.MinSuccessfulTests = 20
	p := gopter.NewProperties(params)

	p.Property("every non-root node has a valid parent", prop.ForAll(
		func(n int, seed int64) bool {
			tree, root := buildTree(n, StrategyWeakLeg, seed)
			for id, node := range tree.nodes {
				if id == root {
					continue
				}
				if node.ParentID == 0 {
					return false
				}
				if _, ok := tree.nodes[node.ParentID]; !ok {
					return false
				}
			}
			return true
		},
		gen.IntRange(1, 2000),
		gen.Int64Range(1, 10000),
	))

	p.TestingRun(t)
}

// P4 — parent-child linkage consistency: if A's LeftID = B, then B.ParentID = A
// and B.Position = "L". (Same for right.)
func TestProperty_LinkageConsistency(t *testing.T) {
	params := gopter.DefaultTestParametersWithSeed(104)
	params.MinSuccessfulTests = 20
	p := gopter.NewProperties(params)

	p.Property("parent.LeftID/RightID matches child.ParentID/Position", prop.ForAll(
		func(n int, seed int64) bool {
			tree, _ := buildTree(n, StrategyWeakLeg, seed)
			for _, parent := range tree.nodes {
				if parent.LeftID != 0 {
					c := tree.nodes[parent.LeftID]
					if c == nil || c.ParentID != parent.ID || c.Position != "L" {
						return false
					}
				}
				if parent.RightID != 0 {
					c := tree.nodes[parent.RightID]
					if c == nil || c.ParentID != parent.ID || c.Position != "R" {
						return false
					}
				}
			}
			return true
		},
		gen.IntRange(1, 1000),
		gen.Int64Range(1, 10000),
	))

	p.TestingRun(t)
}

// P5 — count consistency: LeftCount + RightCount + 1 = subtree size at every node.
// Compute the actual subtree size by BFS and compare with stored counters.
func TestProperty_CountConsistency(t *testing.T) {
	params := gopter.DefaultTestParametersWithSeed(105)
	params.MinSuccessfulTests = 20
	p := gopter.NewProperties(params)

	p.Property("LeftCount/RightCount match actual subtree sizes", prop.ForAll(
		func(n int, seed int64) bool {
			tree, _ := buildTree(n, StrategyWeakLeg, seed)
			for _, node := range tree.nodes {
				actualL := subtreeSize(tree, node.LeftID)
				actualR := subtreeSize(tree, node.RightID)
				if int64(actualL) != node.LeftCount || int64(actualR) != node.RightCount {
					t.Logf("COUNT MISMATCH node=%d L stored=%d actual=%d  R stored=%d actual=%d",
						node.ID, node.LeftCount, actualL, node.RightCount, actualR)
					return false
				}
			}
			return true
		},
		gen.IntRange(1, 500),
		gen.Int64Range(1, 10000),
	))

	p.TestingRun(t)
}

// P6 — degeneracy demonstration: always-left produces a chain.
// Sanity check that our adversarial baseline works.
func TestProperty_AlwaysLeftIsChain(t *testing.T) {
	tree, root := buildTree(50, StrategyAlwaysLeft, 1)
	s := ComputeStats(tree, root)
	if s.MaxDepth != 50 {
		t.Errorf("always-left should produce chain depth=N, got max_depth=%d for N=50", s.MaxDepth)
	}
	if s.LeftRightRatio != 1.0 {
		t.Errorf("always-left should have L/(L+R)=1.0, got %f", s.LeftRightRatio)
	}
}

// subtreeSize returns total nodes in subtree rooted at id (0 = empty).
func subtreeSize(tree *Tree, id int64) int {
	if id == 0 {
		return 0
	}
	n := tree.nodes[id]
	if n == nil {
		return 0
	}
	return 1 + subtreeSize(tree, n.LeftID) + subtreeSize(tree, n.RightID)
}
