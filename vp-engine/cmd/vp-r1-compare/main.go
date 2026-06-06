// Command vp-r1-compare runs the same scenario across pause modes
// (P-A skip, P-B carry, P-C reduce) at multiple compliance levels and
// optionally with R1-stale + R2 yield enabled. Reports the diff vs an
// R1-OFF baseline.
//
// Usage:
//
//	vp-r1-compare --periods 26 --initial 2000 --growth 0.04
//	vp-r1-compare --compliance 0.0,0.5,0.75,1.0 --stale 8
//	vp-r1-compare --r2 --yield-rate 0.25
package main

import (
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/shopspring/decimal"

	"github.com/vicionpower/vp-engine/internal/simulator"
)

func main() {
	var (
		periods   = flag.Int("periods", 26, "binary periods")
		initial   = flag.Int("initial", 2000, "starting tree size")
		growth    = flag.Float64("growth", 0.04, "per-period growth fraction")
		seed      = flag.Int64("seed", 42, "RNG seed")
		complList = flag.String("compliance", "0.0,0.5,0.75,1.0", "compliance probabilities to sweep")
		stale     = flag.Int("stale", 0, "PurchaseStalePeriods (0 = off). Forces pause/recover cycles.")
		r2        = flag.Bool("r2", false, "enable R2 yield (25%/year for affiliates with 2 directs balanced)")
		yieldRate = flag.Float64("yield-rate", 0.25, "R2 annual yield rate (only used with --r2)")
	)
	flag.Parse()

	probs := parseProbs(*complList)

	fmt.Printf("vp-r1-compare — ADR-0013 R1 (pause modes × compliance)")
	if *stale > 0 {
		fmt.Printf("  + R1-stale=%d", *stale)
	}
	if *r2 {
		fmt.Printf("  + R2 yield=%.0f%%/yr", *yieldRate*100)
	}
	fmt.Println()
	fmt.Printf("  periods=%d  initial=%d  growth=%.2f  seed=%d\n\n",
		*periods, *initial, *growth, *seed)

	base := simulator.Default()
	base.Periods = *periods
	base.InitialAffiliates = *initial
	base.GrowthRate = *growth
	base.Seed = *seed
	if *r2 {
		base.Plan.YieldEnabled = true
		base.Plan.YieldAnnualRate = decimal.NewFromFloat(*yieldRate)
	}
	baseResults, err := simulator.RunScenario(base, nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	baseAgg := aggregate(baseResults)

	fmt.Printf("%-22s %12s %12s %10s %8s %8s %8s %8s\n",
		"scenario", "inflows", "paid", "margin%", "Δ_pp", "unqual", "carry$", "yieldQ")
	fmt.Println(strings.Repeat("-", 95))
	printRow("R1 OFF (baseline)", baseAgg, baseAgg)
	fmt.Println()

	modes := []struct {
		name string
		mode string
	}{
		{"P-A skip", "skip"},
		{"P-B carry", "carry"},
		{"P-C reduce 50%", "reduce"},
	}

	for _, m := range modes {
		for _, prob := range probs {
			s := base
			s.Plan.DepthRepurchaseEnabled = true
			s.Plan.RepurchaseComplianceProb = prob
			s.Plan.PauseMode = m.mode
			s.Plan.PurchaseStalePeriods = *stale
			results, err := simulator.RunScenario(s, nil)
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(2)
			}
			agg := aggregate(results)
			label := fmt.Sprintf("%s c=%.0f%%", m.name, prob*100)
			printRow(label, agg, baseAgg)
		}
		fmt.Println()
	}

	fmt.Println("Legend:")
	fmt.Println("  Δ_pp     = change in margin% vs R1 OFF baseline (positive = better for operator)")
	fmt.Println("  unqual   = affiliates failing R1 at end of run")
	fmt.Println("  carry$   = max Σ PausedCarry observed in any period (P-B holding)")
	fmt.Println("  yieldQ   = affiliates qualified for R2 at end of run (2 directos balanced)")
	fmt.Println("  P-A skip = lose payment entirely if unqualified")
	fmt.Println("  P-B carry= withhold payment; release on next compliance (decays after 4 periods)")
	fmt.Println("  P-C 50%  = pay half if unqualified")
}

type aggResult struct {
	inflows    decimal.Decimal
	paid       decimal.Decimal
	margin     decimal.Decimal
	marginPct  float64
	worstTheta decimal.Decimal
	unqualEnd  int
	maxCarry   decimal.Decimal
	yieldQEnd  int
}

func aggregate(rs []simulator.PeriodResult) aggResult {
	a := aggResult{worstTheta: decimal.NewFromInt(1)}
	for _, r := range rs {
		a.inflows = a.inflows.Add(r.Inflows)
		a.paid = a.paid.Add(r.TotalPaid)
		a.margin = a.margin.Add(r.Margin)
		if r.Theta.LessThan(a.worstTheta) {
			a.worstTheta = r.Theta
		}
		if r.PausedCarryHeld.GreaterThan(a.maxCarry) {
			a.maxCarry = r.PausedCarryHeld
		}
	}
	if !a.inflows.IsZero() {
		f, _ := a.margin.Div(a.inflows).Mul(decimal.NewFromInt(100)).Float64()
		a.marginPct = f
	}
	if len(rs) > 0 {
		a.unqualEnd = rs[len(rs)-1].UnqualifiedR1
		a.yieldQEnd = rs[len(rs)-1].YieldQualified
	}
	return a
}

func printRow(label string, a, base aggResult) {
	diff := ""
	if label != "R1 OFF (baseline)" {
		d := a.marginPct - base.marginPct
		sign := "+"
		if d < 0 {
			sign = ""
		}
		diff = fmt.Sprintf("%s%.2f", sign, d)
	}
	fmt.Printf("%-22s %12s %12s %9.2f%% %8s %8d %8s %8d\n",
		label,
		a.inflows.StringFixed(0),
		a.paid.StringFixed(0),
		a.marginPct, diff,
		a.unqualEnd,
		a.maxCarry.StringFixed(0),
		a.yieldQEnd,
	)
}

func parseProbs(s string) []float64 {
	out := []float64{}
	for _, p := range strings.Split(s, ",") {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		f, err := strconv.ParseFloat(p, 64)
		if err != nil {
			fmt.Fprintf(os.Stderr, "invalid compliance value %q: %v\n", p, err)
			os.Exit(2)
		}
		out = append(out, f)
	}
	return out
}
