// Command vp-tree-stats builds a tree using the auto-placement algorithm and
// prints shape metrics. Useful for tuning the placement strategy and verifying
// the tree never degenerates into a chain under realistic enrollment patterns.
//
// Usage:
//
//	vp-tree-stats --affiliates 10000 --strategy weak-leg --seed 42
//	vp-tree-stats --affiliates 5000 --json
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/shopspring/decimal"

	"github.com/vicionpower/vp-engine/internal/simulator"
)

func main() {
	var (
		count    = flag.Int("affiliates", 1000, "number of affiliates to place")
		seed     = flag.Int64("seed", 42, "RNG seed")
		strategy = flag.String("strategy", "weak-leg", "placement strategy: weak-leg | random | always-left")
		jsonOut  = flag.Bool("json", false, "emit JSON instead of human-readable text")
	)
	flag.Parse()

	prices := []decimal.Decimal{
		decimal.RequireFromString("100"),
		decimal.RequireFromString("500"),
		decimal.RequireFromString("1000"),
	}

	tree := simulator.NewTree(*seed)
	rootID := tree.CreateRoot()
	rng := tree.Seed()

	for i := 0; i < *count; i++ {
		price := prices[rng.Intn(len(prices))]
		simulator.PlaceWithStrategy(tree, rootID, price, *strategy, rng)
	}

	stats := simulator.ComputeStats(tree, rootID)

	if *jsonOut {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(stats)
		return
	}

	printHuman(stats, *strategy, *count, *seed)
}

func printHuman(s simulator.TreeStats, strategy string, n int, seed int64) {
	fmt.Printf("vp-tree-stats — placement shape report\n")
	fmt.Printf("  strategy=%s  affiliates=%d  seed=%d\n\n", strategy, n, seed)

	fmt.Printf("DEPTH\n")
	fmt.Printf("  max         : %d\n", s.MaxDepth)
	fmt.Printf("  mean        : %.2f\n", s.MeanDepth)
	fmt.Printf("  ideal       : %.0f (= ceil log2(%d+1))\n", s.IdealDepth, s.NodeCount)
	fmt.Printf("  inflation   : %.2fx  (1.0 = perfect, >2.0 = drifting toward chain)\n", s.DepthInflation)
	fmt.Println()

	fmt.Printf("BALANCE\n")
	fmt.Printf("  L/(L+R)     : %.4f  (0.5 = perfectly even)\n", s.LeftRightRatio)
	fmt.Printf("  median skew : %.4f  (per internal node, |L-R|/(L+R+1))\n", s.MedianSkew)
	fmt.Printf("  max skew    : %.4f  (1.0 = some node is fully one-sided)\n", s.MaxSkew)
	fmt.Printf("  Gini        : %.4f  (0 = equal subtrees, 1 = one node owns everything)\n", s.GiniSubtreeSize)
	fmt.Println()

	fmt.Printf("COVERAGE\n")
	fmt.Printf("  any empty leg : %.2f%%  (internal node has at least one empty side)\n", s.EmptyLegRate*100)
	fmt.Printf("  both empty    : %.2f%%  (pure leaf)\n", s.BothEmptyRate*100)
	fmt.Println()

	fmt.Printf("DEPTH HISTOGRAM\n")
	maxBucket := 0
	for _, c := range s.DepthHistogram {
		if c > maxBucket {
			maxBucket = c
		}
	}
	for d, c := range s.DepthHistogram {
		bar := ""
		if maxBucket > 0 {
			barLen := int(float64(c) / float64(maxBucket) * 40)
			bar = strings.Repeat("█", barLen)
		}
		fmt.Printf("  d=%2d  %6d  %s\n", d, c, bar)
	}
}
