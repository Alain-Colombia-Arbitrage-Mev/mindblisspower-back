package simulator

import (
	"math"
	"math/rand"

	"github.com/shopspring/decimal"
)

// SponsorDistribution names a sponsor-selection model.
const (
	SponsorUniform   = "uniform"
	SponsorPowerLaw  = "power-law"
)

func pickPrice(rng *rand.Rand, prices []decimal.Decimal) decimal.Decimal {
	if len(prices) == 0 {
		return decimal.RequireFromString("100")
	}
	return prices[rng.Intn(len(prices))]
}

// pickSponsor returns a random non-root affiliate id. Falls back to root
// if the tree is otherwise empty.
//
// IMPORTANT: iterating a Go map yields random order. To keep the simulator
// deterministic under a fixed seed we sort the candidate IDs before drawing.
func pickSponsor(rng *rand.Rand, tree *Tree, rootID int64) int64 {
	if len(tree.nodes) <= 1 {
		return rootID
	}
	candidates := make([]int64, 0, len(tree.nodes)-1)
	for id := range tree.nodes {
		if id == rootID {
			continue
		}
		candidates = append(candidates, id)
	}
	// Insertion sort (n small in practice for sim sizes, plus avoids importing sort).
	for i := 1; i < len(candidates); i++ {
		j := i
		for j > 0 && candidates[j] < candidates[j-1] {
			candidates[j], candidates[j-1] = candidates[j-1], candidates[j]
			j--
		}
	}
	return candidates[rng.Intn(len(candidates))]
}

// pickSponsorPowerLaw selects sponsors weighted by subtree-size raised to alpha.
// alpha=0 collapses to uniform, alpha=1 is proportional to recruits (rich-get-
// richer), alpha=2 is heavily skewed. Realistic MLM data fits alpha ≈ 1.2-1.8.
//
// The math: weight_i = (subtree_size_i + 1)^alpha.
// Sample by cumulative weight.
func pickSponsorPowerLaw(rng *rand.Rand, tree *Tree, rootID int64, alpha float64) int64 {
	if len(tree.nodes) <= 1 {
		return rootID
	}
	ids := make([]int64, 0, len(tree.nodes)-1)
	for id := range tree.nodes {
		if id == rootID {
			continue
		}
		ids = append(ids, id)
	}
	for i := 1; i < len(ids); i++ {
		j := i
		for j > 0 && ids[j] < ids[j-1] {
			ids[j], ids[j-1] = ids[j-1], ids[j]
			j--
		}
	}
	// Compute weights = (subtree_size + 1)^alpha.
	weights := make([]float64, len(ids))
	var totalW float64
	for i, id := range ids {
		n := tree.nodes[id]
		size := float64(n.LeftCount + n.RightCount + 1)
		w := math.Pow(size, alpha)
		weights[i] = w
		totalW += w
	}
	if totalW == 0 {
		return ids[rng.Intn(len(ids))]
	}
	r := rng.Float64() * totalW
	cum := 0.0
	for i, w := range weights {
		cum += w
		if r <= cum {
			return ids[i]
		}
	}
	return ids[len(ids)-1]
}

// PickSponsorByDistribution is the exported entry-point used by external
// CLIs. Internal code uses the lowercase variant.
func PickSponsorByDistribution(rng *rand.Rand, tree *Tree, rootID int64, dist string, alpha float64) int64 {
	return pickSponsorByDistribution(rng, tree, rootID, dist, alpha)
}

// pickSponsorByDistribution dispatches based on scenario.SponsorDist.
func pickSponsorByDistribution(rng *rand.Rand, tree *Tree, rootID int64, dist string, alpha float64) int64 {
	switch dist {
	case "", SponsorUniform:
		return pickSponsor(rng, tree, rootID)
	case SponsorPowerLaw:
		return pickSponsorPowerLaw(rng, tree, rootID, alpha)
	default:
		panic("unknown sponsor distribution: " + dist)
	}
}
