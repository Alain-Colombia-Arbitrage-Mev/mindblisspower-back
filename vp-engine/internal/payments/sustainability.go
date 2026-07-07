package payments

import (
	"context"
	"fmt"

	"github.com/vicionpower/vp-engine/internal/bonusengine"
	"github.com/vicionpower/vp-engine/internal/simulator"
)

// ScenarioResult holds the Monte Carlo sustainability output for one scenario.
type ScenarioResult struct {
	Name       string             `json:"name"`        // "modesto" | "estres"
	Periods    int                `json:"periods"`
	Solvent    bool               `json:"solvent"`      // SolvencyBreaches == 0
	WorstTheta float64            `json:"worst_theta"`
	Margin     float64            `json:"margin"`       // CompanyFundRate
	Streams    map[string]float64 `json:"streams"`      // binario/yield/puntos/rango/referido/regalia
}

// RunSustainabilityScenarios executes the Monte Carlo simulator for two
// scenarios ("modesto" and "estres") using the REAL active plan parameters
// loaded from mlm.plan_config.  Returns [modesto, estres].
//
// The simulator works from InitialAffiliates = 10,000 (a synthetic population
// representative of the plan dynamics — NOT the full 121k production tree).
func (s *Store) RunSustainabilityScenarios(ctx context.Context) ([]ScenarioResult, error) {
	// ── 1. Load the active plan config from DB ────────────────────────────────
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("sustainability: begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	bePlan, err := bonusengine.LoadActivePlanConfig(ctx, tx)
	if err != nil {
		return nil, fmt.Errorf("sustainability: load plan_config: %w", err)
	}
	_ = tx.Rollback(ctx) // read-only — rollback immediately after load

	// ── 2. Map bonusengine.PlanConfig → simulator.PlanConfig ─────────────────
	//
	// We start from simulator.Default().Plan (V1Conservative) and overwrite with
	// the real DB values.  Fields that have no equivalent in plan_config are left
	// at their Default values and documented below.
	simPlan := simulator.V1Conservative()

	// Direct 1:1 mappings
	simPlan.BlockSize = bePlan.BlockSize
	simPlan.BonusPerBlock = bePlan.BonusPerBlock
	simPlan.DepthCap = bePlan.DepthCap
	simPlan.DailyCapFactor = bePlan.DailyCapFactor
	simPlan.LifetimeCapFactor = bePlan.LifetimeCapFactor
	simPlan.TreasuryAlpha = bePlan.TreasuryAlpha
	simPlan.QualifiedDirectsLeft = bePlan.QualifiedDirectsL
	simPlan.QualifiedDirectsRight = bePlan.QualifiedDirectsR
	simPlan.PeriodCapFactor = bePlan.PeriodCapFactor

	// R1 (recompra / ADR-0013)
	simPlan.DepthRepurchaseEnabled = bePlan.DepthRepurchaseEnabled
	simPlan.RepurchaseThreshold = bePlan.RepurchaseThreshold
	simPlan.PurchaseStalePeriods = bePlan.PurchaseStalePeriods
	simPlan.PauseMode = bePlan.PauseMode
	simPlan.PauseReductionFactor = bePlan.PauseReductionFactor
	simPlan.PausedCarryDecayPeriods = bePlan.PausedCarryDecayPeriods
	simPlan.RenewalCostFactor = bePlan.RenewalCostFactor

	// R2 yield (ADR-0015)
	simPlan.YieldEnabled = bePlan.YieldEnabled
	simPlan.YieldAnnualRate = bePlan.YieldAnnualRate
	simPlan.YieldCadencePeriods = bePlan.YieldCadencePeriods
	simPlan.CapitalLockPeriods = bePlan.CapitalLockPeriods

	// R3 points (ADR-0016)
	// bonusengine uses PointsEnabled; simulator uses PointsBonusEnabled
	simPlan.PointsBonusEnabled = bePlan.PointsEnabled
	simPlan.PointsPerBlock = bePlan.PointsPerBlock
	simPlan.PointsDollarsPerPoint = bePlan.PointsDollarsPerPoint
	simPlan.PointsCadencePeriods = bePlan.PointsCadencePeriods

	// Carrera de rangos (ADR-0017/0018)
	simPlan.RanksEnabled = bePlan.RanksEnabled
	simPlan.RankInstallments = bePlan.RankInstallments
	simPlan.RankInstallmentCadence = bePlan.RankInstallmentCadence
	// simPlan.RankDefs stays at DefaultRankDefs() — plan_config has no equivalent column

	// Regalía + referido (ADR-0018)
	simPlan.RoyaltyEnabled = bePlan.RoyaltyEnabled
	simPlan.RoyaltyRate = bePlan.RoyaltyRate
	simPlan.ReferralRate = bePlan.ReferralRate

	// Fundadores (ADR-0018)
	// bonusengine uses FounderEnrollmentOpen; simulator uses FounderFraction
	// FounderEnrollmentOpen=true → all new enrollments are founders (FounderFraction=1.0)
	// FounderEnrollmentOpen=false → no founders (FounderFraction=0)
	if bePlan.FounderEnrollmentOpen {
		simPlan.FounderFraction = 1.0
	} else {
		simPlan.FounderFraction = 0.0
	}
	simPlan.FounderReferralRate = bePlan.FounderReferralRate
	simPlan.FounderBinaryMatchedRate = bePlan.FounderBinaryMatchedRate

	// carry decay: bonusengine stores carry_decay_days (int); simulator uses
	// CarryDecayPeriods (int, in number of periods = weeks).  Convert days→weeks.
	if bePlan.CarryDecayDays > 0 {
		simPlan.CarryDecayPeriods = bePlan.CarryDecayDays / 7
		if simPlan.CarryDecayPeriods < 1 {
			simPlan.CarryDecayPeriods = 1
		}
	}

	// Fields with NO equivalent in plan_config (left at V1Conservative defaults):
	//   simPlan.RankBonusBase     — no equivalent in plan_config
	//   simPlan.RepurchaseComplianceProb — no equivalent in plan_config
	//   simPlan.RankDefs          — no equivalent (DB column); DefaultRankDefs() is used

	// ── 3. Build the two scenarios ────────────────────────────────────────────
	base := simulator.Default()
	base.Plan = simPlan
	base.Periods = 52
	// InitialAffiliates: use a representative but test-friendly population.
	// The simulator's insertion sort is O(n²); 1,000 affiliates keeps each
	// 52-period run well under 10 seconds.  The plan dynamics (θ, caps, streams)
	// are identical regardless of tree size.
	base.InitialAffiliates = 1_000
	base.GrowthRate = 0.01 // modesto: 1% growth per period

	stress := base
	stress.GrowthRate = 0.05                            // agresivo: 5% per period
	stress.InflowShock = map[int]float64{26: 0.5}       // −50% shock at mid-run (period 26)

	// ── 4. Run each scenario ─────────────────────────────────────────────────
	modResult, err := runScenario(base, "modesto")
	if err != nil {
		return nil, fmt.Errorf("sustainability: run modesto: %w", err)
	}
	estResult, err := runScenario(stress, "estres")
	if err != nil {
		return nil, fmt.Errorf("sustainability: run estres: %w", err)
	}

	return []ScenarioResult{modResult, estResult}, nil
}

// runScenario executes one Monte Carlo scenario and converts the
// DisbursementReport into a ScenarioResult.
func runScenario(sc simulator.Scenario, name string) (ScenarioResult, error) {
	results, err := simulator.RunScenario(sc, nil)
	if err != nil {
		return ScenarioResult{}, fmt.Errorf("RunScenario %s: %w", name, err)
	}
	rep := simulator.BuildDisbursementReport(results)
	sum := rep.Summary

	worstTheta, _ := sum.WorstTheta.Float64()
	margin, _ := sum.CompanyFundRate.Float64()

	streams := map[string]float64{
		"binario":  float64Val(sum.Streams.BinaryTree),
		"yield":    float64Val(sum.Streams.Yield),
		"puntos":   float64Val(sum.Streams.Points),
		"rango":    float64Val(sum.Streams.Ranks),
		"referido": float64Val(sum.Streams.Referral),
		"regalia":  float64Val(sum.Streams.Royalty),
	}

	return ScenarioResult{
		Name:       name,
		Periods:    sum.Periods,
		Solvent:    sum.SolvencyBreaches == 0,
		WorstTheta: worstTheta,
		Margin:     margin,
		Streams:    streams,
	}, nil
}

// float64Val converts a decimal.Decimal to float64, returning 0 on failure.
func float64Val(d interface{ Float64() (float64, bool) }) float64 {
	v, _ := d.Float64()
	return v
}
