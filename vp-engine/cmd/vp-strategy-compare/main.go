// Command vp-strategy-compare runs the same scenario under all three
// placement strategies (weak-leg, random, always-left) and prints a
// side-by-side report.
//
// Demonstrates that:
//   - weak-leg keeps the tree near-balanced and pays meaningful bonuses
//   - random degenerates more slowly but pays less
//   - always-left produces a chain → $0 paid (T7 anti-Ponzi sanity check)
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/shopspring/decimal"

	"github.com/vicionpower/vp-engine/internal/simulator"
)

func main() {
	var (
		periods = flag.Int("periods", 12, "binary periods")
		initial = flag.Int("initial", 1000, "starting tree size")
		growth  = flag.Float64("growth", 0.02, "per-period growth fraction")
		seed    = flag.Int64("seed", 42, "RNG seed")
	)
	flag.Parse()

	strategies := []string{
		simulator.StrategyWeakLeg,
		simulator.StrategyRandom,
		simulator.StrategyAlwaysLeft,
	}

	fmt.Printf("vp-strategy-compare\n")
	fmt.Printf("  periods=%d  initial=%d  growth=%.2f  seed=%d\n\n",
		*periods, *initial, *growth, *seed)
	fmt.Printf("%-14s %12s %12s %12s %10s %10s %8s %8s\n",
		"strategy", "inflows", "paid", "margin", "margin%", "worst-θ", "depth", "balance")
	fmt.Println("-----------------------------------------------------------------------------------------------------------")

	for _, strat := range strategies {
		scenario := simulator.Default()
		scenario.Periods = *periods
		scenario.InitialAffiliates = *initial
		scenario.GrowthRate = *growth
		scenario.Seed = *seed
		scenario.Strategy = strat

		results, err := simulator.RunScenario(scenario, nil)
		if err != nil {
			fmt.Fprintf(os.Stderr, "strategy %s failed: %v\n", strat, err)
			os.Exit(1)
		}

		var cumIn, cumPaid, cumMargin decimal.Decimal
		worstTheta := decimal.NewFromInt(1)
		for _, r := range results {
			cumIn = cumIn.Add(r.Inflows)
			cumPaid = cumPaid.Add(r.TotalPaid)
			cumMargin = cumMargin.Add(r.Margin)
			if r.Theta.LessThan(worstTheta) {
				worstTheta = r.Theta
			}
		}

		// Rebuild a fresh tree of the same final size for shape metrics.
		// (RunScenario doesn't expose the tree it built.)
		t, root := buildFinalTree(scenario)
		stats := simulator.ComputeStats(t, root)

		marginPct := 0.0
		if !cumIn.IsZero() {
			f, _ := cumMargin.Div(cumIn).Mul(decimal.NewFromInt(100)).Float64()
			marginPct = f
		}

		fmt.Printf("%-14s %12s %12s %12s %9.2f%% %10s %8d %8.3f\n",
			strat,
			cumIn.StringFixed(0),
			cumPaid.StringFixed(0),
			cumMargin.StringFixed(0),
			marginPct,
			worstTheta.StringFixed(4),
			stats.MaxDepth,
			stats.LeftRightRatio,
		)
	}

	fmt.Println("\nLegend:")
	fmt.Println("  margin%   = retained / inflows over the run")
	fmt.Println("  worst-θ   = lowest throttle hit (1.0 = never throttled)")
	fmt.Println("  depth     = max depth of final tree")
	fmt.Println("  balance   = L/(L+R), 0.5 = even, 1.0 = degenerate left chain")
}

// buildFinalTree replays the placement phase only (no payouts) so we can
// inspect the shape. Cheap: O(N).
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
	// Apply growth approximately.
	for p := 1; p <= s.Periods; p++ {
		newCount := int(float64(t.Size()-1) * s.GrowthRate)
		for i := 0; i < newCount; i++ {
			simulator.PlaceWithStrategy(t, root, pick(), s.Strategy, rng)
		}
	}
	return t, root
}
