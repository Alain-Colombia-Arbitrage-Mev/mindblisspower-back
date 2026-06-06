// Command vp-sponsor-dist compares uniform vs power-law sponsor recruitment
// patterns and reports how each shapes the tree and the payouts.
//
// Real MLM data is heavily power-law: a small fraction of affiliates recruit
// most of the downline. This tool shows whether the binary plan stays solvent
// (and pays fairly) under those realistic dynamics.
//
// Usage:
//
//	vp-sponsor-dist --initial 500 --growth 0.05 --periods 24
//	vp-sponsor-dist --alpha 1.8                   # heavier skew
package main

import (
	"flag"
	"fmt"
	"os"
	"sort"

	"github.com/shopspring/decimal"

	"github.com/vicionpower/vp-engine/internal/simulator"
)

func main() {
	var (
		periods = flag.Int("periods", 24, "binary periods")
		initial = flag.Int("initial", 500, "starting tree size")
		growth  = flag.Float64("growth", 0.05, "per-period growth fraction")
		seed    = flag.Int64("seed", 42, "RNG seed")
		alpha   = flag.Float64("alpha", 1.5, "power-law exponent (0=uniform, 1=proportional, 2=heavy skew)")
	)
	flag.Parse()

	distributions := []struct {
		name  string
		dist  string
		alpha float64
	}{
		{"uniform", simulator.SponsorUniform, 0},
		{fmt.Sprintf("power-law α=%.1f", *alpha), simulator.SponsorPowerLaw, *alpha},
	}

	fmt.Printf("vp-sponsor-dist\n")
	fmt.Printf("  periods=%d  initial=%d  growth=%.2f  seed=%d\n\n",
		*periods, *initial, *growth, *seed)

	for _, d := range distributions {
		scenario := simulator.Default()
		scenario.Periods = *periods
		scenario.InitialAffiliates = *initial
		scenario.GrowthRate = *growth
		scenario.Seed = *seed
		scenario.SponsorDistribution = d.dist
		scenario.SponsorPowerLawAlpha = d.alpha

		results, err := simulator.RunScenario(scenario, nil)
		if err != nil {
			fmt.Fprintf(os.Stderr, "scenario failed: %v\n", err)
			os.Exit(1)
		}

		var cumIn, cumPaid decimal.Decimal
		worstTheta := decimal.NewFromInt(1)
		for _, r := range results {
			cumIn = cumIn.Add(r.Inflows)
			cumPaid = cumPaid.Add(r.TotalPaid)
			if r.Theta.LessThan(worstTheta) {
				worstTheta = r.Theta
			}
		}

		tree, root := buildFinalTree(scenario)
		stats := simulator.ComputeStats(tree, root)
		concentration := computeRecruiterConcentration(tree, root)

		marginPct := 0.0
		if !cumIn.IsZero() {
			f, _ := cumIn.Sub(cumPaid).Div(cumIn).Mul(decimal.NewFromInt(100)).Float64()
			marginPct = f
		}

		fmt.Printf("══ %s ══\n", d.name)
		fmt.Printf("  inflows: $%s   paid: $%s   margin: %.2f%%   worst θ: %s\n",
			cumIn.StringFixed(0), cumPaid.StringFixed(0), marginPct, worstTheta.StringFixed(4))
		fmt.Printf("  tree size: %d   max depth: %d   L/(L+R): %.3f   Gini: %.3f\n",
			stats.NodeCount, stats.MaxDepth, stats.LeftRightRatio, stats.GiniSubtreeSize)
		fmt.Printf("  recruiter concentration: top 1%% own %.1f%% of recruits, top 10%% own %.1f%%\n",
			concentration.top1Pct*100, concentration.top10Pct*100)
		fmt.Println()
	}
}

type concentrationStats struct {
	top1Pct  float64
	top10Pct float64
}

// computeRecruiterConcentration counts direct downline per node and reports
// the share owned by the top 1% / 10% of recruiters. Whales emerge when
// power-law sponsor selection compounds: a node that recruits early gets
// more chances to recruit again.
func computeRecruiterConcentration(tree *simulator.Tree, _ int64) concentrationStats {
	// Count direct sponsors (SponsorID points to this node).
	direct := map[int64]int{}
	for _, n := range tree.AllNodesSorted() {
		if n.SponsorID != 0 {
			direct[n.SponsorID]++
		}
	}
	counts := make([]int, 0, len(direct))
	totalRecruits := 0
	for _, c := range direct {
		counts = append(counts, c)
		totalRecruits += c
	}
	if totalRecruits == 0 || len(counts) == 0 {
		return concentrationStats{}
	}
	sort.Sort(sort.Reverse(sort.IntSlice(counts)))

	top1 := int(float64(len(counts)) * 0.01)
	if top1 < 1 {
		top1 = 1
	}
	top10 := int(float64(len(counts)) * 0.10)
	if top10 < 1 {
		top10 = 1
	}
	var sum1, sum10 int
	for i := 0; i < top1; i++ {
		sum1 += counts[i]
	}
	for i := 0; i < top10; i++ {
		sum10 += counts[i]
	}
	return concentrationStats{
		top1Pct:  float64(sum1) / float64(totalRecruits),
		top10Pct: float64(sum10) / float64(totalRecruits),
	}
}

func buildFinalTree(s simulator.Scenario) (*simulator.Tree, int64) {
	t := simulator.NewTree(s.Seed)
	root := t.CreateRoot()
	rng := t.Seed()
	prices := s.PackagePrices
	pick := func() decimal.Decimal {
		if len(prices) == 0 {
			return decimal.RequireFromString("100")
		}
		return prices[rng.Intn(len(prices))]
	}
	for i := 0; i < s.InitialAffiliates; i++ {
		simulator.PlaceWithStrategy(t, root, pick(), s.Strategy, rng)
	}
	for p := 1; p <= s.Periods; p++ {
		newCount := int(float64(t.Size()-1) * s.GrowthRate)
		for i := 0; i < newCount; i++ {
			sponsor := simulator.PickSponsorByDistribution(rng, t, root, s.SponsorDistribution, s.SponsorPowerLawAlpha)
			simulator.PlaceWithStrategy(t, sponsor, pick(), s.Strategy, rng)
		}
	}
	return t, root
}
