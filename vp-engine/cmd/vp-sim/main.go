// Command vp-sim runs a Monte Carlo solvency simulation of the binary
// compensation plan defined in ADR-0012. It does not touch the database.
//
// Usage:
//
//	vp-sim --periods 52 --initial 10000 --growth 0.0 --seed 42
//	vp-sim --periods 52 --shock-period 30 --shock-mult 0.5    # economic shock
//	vp-sim --alpha 0.40 --kpkg 1.8                            # tighter caps
//
// Exit codes:
//
//	0 = solvent every period (T1 held)
//	1 = solvency breach detected
//	2 = invalid configuration / runtime error
package main

import (
	"encoding/csv"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strconv"

	"github.com/shopspring/decimal"

	"github.com/vicionpower/vp-engine/internal/simulator"
)

func main() {
	var (
		periods       = flag.Int("periods", 52, "number of binary periods to simulate")
		initial       = flag.Int("initial", 10000, "initial affiliates (excluding root)")
		growth        = flag.Float64("growth", 0.0, "growth rate per period as fraction of size")
		seed          = flag.Int64("seed", 42, "RNG seed for reproducibility")
		shockPeriod   = flag.Int("shock-period", 0, "period to apply an inflow shock (0 = none)")
		shockMult     = flag.Float64("shock-mult", 1.0, "inflow multiplier on shock period (e.g. 0.5)")
		alpha         = flag.String("alpha", "", "override treasury alpha (e.g. 0.40)")
		kpkg          = flag.String("kpkg", "", "override package lifetime cap factor (e.g. 1.8)")
		kuser         = flag.String("kuser", "", "override daily cap factor (e.g. 3.0)")
		csvOut        = flag.String("csv", "", "write per-period results to CSV file")
		jsonOut       = flag.String("json", "", "write per-period results to JSON file")
		reportJSONOut = flag.String("report-json", "", "write disbursement report summary to JSON file")
		quiet         = flag.Bool("quiet", false, "suppress per-period stdout log")

		// Preset v2 (ADR-0017/0018): candados + carrera de rangos + fundadores
		// + regalía gen-2 + yield + puntos, con la config recomendada
		// (plan_config v2-candados). Gate de lanzamiento: θ_min ≥ 0.85.
		v2          = flag.Bool("v2", false, "enable full v2 plan: R1 P-C + yield + points + ranks + founders + royalty")
		founderFrac = flag.Float64("founder-frac", -1, "override founder fraction (0..1); -1 = preset default")
		compliance  = flag.Float64("compliance", -1, "override R1 repurchase compliance prob (0..1); -1 = default")
		noRanks     = flag.Bool("no-ranks", false, "disable rank career (isolate its θ impact)")
		rankCuotas  = flag.Int("rank-installments", 0, "mitigación B: pagar bonos de rango en N cuotas (0 = preset)")
		rankCadence = flag.Int("rank-cadence", 0, "períodos entre cuotas de rango (0 = preset, 4 ≈ mensual)")
		noRoyalty   = flag.Bool("no-royalty", false, "disable gen-2 royalty")
		founderRate = flag.String("founder-rate", "", "override founder binary matched rate (e.g. 0.04)")
	)
	flag.Parse()

	scenario := simulator.Default()
	scenario.Periods = *periods
	scenario.InitialAffiliates = *initial
	scenario.GrowthRate = *growth
	scenario.Seed = *seed
	if *shockPeriod > 0 {
		scenario.InflowShock = map[int]float64{*shockPeriod: *shockMult}
	}
	if *v2 {
		// Espejo de plan_config v2-candados (seed_plan_config_v2.sql).
		scenario.Plan.DepthRepurchaseEnabled = true
		scenario.Plan.PurchaseStalePeriods = 4
		scenario.Plan.PauseMode = "reduce"
		scenario.Plan.YieldEnabled = true
		scenario.Plan.PointsBonusEnabled = true
		scenario.Plan.RanksEnabled = true
		scenario.Plan.RankInstallments = 4 // Mitigación B (decidida 2026-06-05)
		scenario.Plan.RankInstallmentCadence = 4
		scenario.Plan.RoyaltyEnabled = true
		scenario.Plan.FounderFraction = 1.0 // lanzamiento: todos fundadores
	}
	if *founderFrac >= 0 {
		scenario.Plan.FounderFraction = *founderFrac
	}
	if *compliance >= 0 {
		scenario.Plan.RepurchaseComplianceProb = *compliance
	}
	if *noRanks {
		scenario.Plan.RanksEnabled = false
	}
	if *rankCuotas > 0 {
		scenario.Plan.RankInstallments = *rankCuotas
	}
	if *rankCadence > 0 {
		scenario.Plan.RankInstallmentCadence = *rankCadence
	}
	if *noRoyalty {
		scenario.Plan.RoyaltyEnabled = false
	}
	if *founderRate != "" {
		v, err := decimal.NewFromString(*founderRate)
		if err != nil {
			die(2, "invalid --founder-rate: %v", err)
		}
		scenario.Plan.FounderBinaryMatchedRate = v
	}
	if *alpha != "" {
		v, err := decimal.NewFromString(*alpha)
		if err != nil {
			die(2, "invalid --alpha: %v", err)
		}
		scenario.Plan.TreasuryAlpha = v
	}
	if *kpkg != "" {
		v, err := decimal.NewFromString(*kpkg)
		if err != nil {
			die(2, "invalid --kpkg: %v", err)
		}
		scenario.Plan.LifetimeCapFactor = v
	}
	if *kuser != "" {
		v, err := decimal.NewFromString(*kuser)
		if err != nil {
			die(2, "invalid --kuser: %v", err)
		}
		scenario.Plan.DailyCapFactor = v
	}

	var sink = os.Stdout
	if *quiet {
		sink = nil
	}

	fmt.Printf("vp-sim — ADR-0012 stress test\n")
	fmt.Printf("  α=%s K_pkg=%s K_user=%s D=%d β=%d\n",
		scenario.Plan.TreasuryAlpha.String(),
		scenario.Plan.LifetimeCapFactor.String(),
		scenario.Plan.DailyCapFactor.String(),
		scenario.Plan.DepthCap, scenario.Plan.CarryDecayPeriods)
	fmt.Printf("  periods=%d  initial=%d  growth=%.2f  shock=%v\n\n",
		scenario.Periods, scenario.InitialAffiliates, scenario.GrowthRate, scenario.InflowShock)

	results, err := simulator.RunScenario(scenario, sink)
	if err != nil {
		die(2, "scenario failed: %v", err)
	}

	report := simulator.BuildDisbursementReport(results)
	summary := report.Summary
	streams := summary.Streams

	fmt.Printf("\n══ AGGREGATE ══\n")
	fmt.Printf("  cumulative inflows      : $%s\n", summary.Inflows.StringFixed(2))
	fmt.Printf("  total distributed       : $%s (%.2f%%)\n",
		summary.TotalDistributed.StringFixed(2),
		pctOf(summary.TotalDistributed, summary.Inflows))
	fmt.Printf("  company fund retained   : $%s (%.2f%%)\n",
		summary.CompanyFund.StringFixed(2),
		pctOf(summary.CompanyFund, summary.Inflows))
	fmt.Printf("  worst theta             : %s\n", summary.WorstTheta.StringFixed(4))
	fmt.Printf("  solvency breaches       : %d / %d periods\n", summary.SolvencyBreaches, *periods)

	fmt.Printf("\n══ DISBURSEMENT BREAKDOWN ══\n")
	fmt.Printf("  binary tree paid        : $%s\n", streams.BinaryTree.StringFixed(2))
	fmt.Printf("  rank bonuses paid       : $%s  (hitos alcanzados: %d)\n",
		streams.Ranks.StringFixed(2), summary.RanksAchieved)
	fmt.Printf("  yield R2 paid           : $%s\n", streams.Yield.StringFixed(2))
	fmt.Printf("  points R3 paid          : $%s\n", streams.Points.StringFixed(2))
	fmt.Printf("  referral paid           : $%s\n", streams.Referral.StringFixed(2))
	fmt.Printf("  royalty paid            : $%s\n", streams.Royalty.StringFixed(2))
	if streams.ReleasedCarry.Sign() > 0 {
		fmt.Printf("  released paused carry   : $%s\n", streams.ReleasedCarry.StringFixed(2))
	}
	if streams.Other.Sign() > 0 {
		fmt.Printf("  other distributed       : $%s\n", streams.Other.StringFixed(2))
	}
	if *v2 {
		gate := "PASS"
		if summary.WorstTheta.LessThan(decimal.RequireFromString("0.85")) {
			gate = "FAIL"
		}
		fmt.Printf("  launch gate θ≥0.85      : %s\n", gate)
	}

	if *csvOut != "" {
		if err := writeCSV(*csvOut, results); err != nil {
			die(2, "write csv: %v", err)
		}
	}
	if *jsonOut != "" {
		if err := writeJSON(*jsonOut, results); err != nil {
			die(2, "write json: %v", err)
		}
	}
	if *reportJSONOut != "" {
		if err := writeReportJSON(*reportJSONOut, report); err != nil {
			die(2, "write report json: %v", err)
		}
	}

	if summary.SolvencyBreaches > 0 {
		os.Exit(1)
	}
}

func die(code int, format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(code)
}

func pctOf(part, whole decimal.Decimal) float64 {
	if whole.IsZero() {
		return 0
	}
	r, _ := part.Div(whole).Mul(decimal.NewFromInt(100)).Float64()
	return r
}

func writeCSV(path string, results []simulator.PeriodResult) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	w := csv.NewWriter(f)
	defer w.Flush()
	_ = w.Write([]string{"period", "new_affiliates", "inflows", "events",
		"candidates", "projected", "theta", "binary_paid", "total_paid", "margin",
		"company_fund", "cumulative_company_fund",
		"package_caps", "daily_caps", "carry_expired", "solvent",
		"yield_paid", "points_paid", "rank_paid", "referral_paid",
		"royalty_paid", "released_carry_paid", "ranks_achieved"})
	for _, r := range results {
		_ = w.Write([]string{
			strconv.Itoa(r.Period),
			strconv.Itoa(r.NewAffiliates),
			r.Inflows.StringFixed(2),
			strconv.Itoa(r.Events),
			strconv.Itoa(r.Candidates),
			r.ProjectedOutflows.StringFixed(2),
			r.Theta.StringFixed(6),
			r.BinaryPaid.StringFixed(2),
			r.TotalPaid.StringFixed(2),
			r.Margin.StringFixed(2),
			r.CompanyFund.StringFixed(2),
			r.CumulativeCompanyFund.StringFixed(2),
			strconv.Itoa(r.Breakage.PackageCapHits),
			strconv.Itoa(r.Breakage.DailyCapHits),
			r.Breakage.CarryExpiredUSD.StringFixed(2),
			strconv.FormatBool(r.SolvencyOK),
			r.YieldPaid.StringFixed(2),
			r.PointsBonusPaid.StringFixed(2),
			r.RankBonusPaid.StringFixed(2),
			r.ReferralPaid.StringFixed(2),
			r.RoyaltyPaid.StringFixed(2),
			r.ReleasedCarryPaid.StringFixed(2),
			strconv.Itoa(r.RanksAchieved),
		})
	}
	return nil
}

func writeJSON(path string, results []simulator.PeriodResult) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	return enc.Encode(results)
}

func writeReportJSON(path string, report simulator.DisbursementReport) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	return enc.Encode(report)
}
