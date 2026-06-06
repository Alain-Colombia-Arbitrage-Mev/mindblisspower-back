package simulator

import (
	"github.com/shopspring/decimal"
)

// PlanConfig mirrors mlm.plan_config row v1-conservative (ADR-0012 §1).
// All fields explicit so the simulator can sweep parameters without DB.
type PlanConfig struct {
	BlockSize             int             // B — points per block (default 500)
	BonusPerBlock         decimal.Decimal // r — USD per block ($10)
	DepthCap              int             // D — max ancestor levels (10)
	DailyCapFactor        decimal.Decimal // K_user × rank.bonus (3.0)
	LifetimeCapFactor     decimal.Decimal // K_pkg × package_price (2.0)
	TreasuryAlpha         decimal.Decimal // α — max bonus / inflows (0.45)
	CarryDecayPeriods     int             // β — carry expires after N periods (≈14d weekly ≈ 2 periods)
	QualifiedDirectsLeft  int             // Q_L (1)
	QualifiedDirectsRight int             // Q_R (1)
	// Daily-rank bonus baseline for K_user. The real plan ties this to rank;
	// for simulator we accept a single number (e.g. $500/day base).
	RankBonusBase decimal.Decimal

	// R1 — depth-based repurchase rule (ADR-0013).
	// When ON, affiliates whose MaxDownlineDepth crossed a multiple of
	// RepurchaseThreshold must have a fresh purchase recorded after the
	// crossing to keep receiving bonuses.
	DepthRepurchaseEnabled bool
	// Multiple at which the rule fires (default 10 per ADR-0013).
	RepurchaseThreshold int
	// Probability that a triggered affiliate actually repurchases on the
	// period the rule asks them to. 1.0 = perfect compliance; 0.0 = nobody
	// ever repurchases. Real-world is somewhere in 0.5–0.9.
	RepurchaseComplianceProb float64
	// PauseMode: how unqualified affiliates' bonuses are handled.
	//   "skip"   = P-A: ancestor not enumerated, payment forfeited.
	//   "carry"  = P-B: ancestor enumerated but net goes to PausedCarry,
	//              released on next compliance. Carry decays per
	//              PausedCarryDecayPeriods.
	//   "reduce" = P-C: ancestor paid, but net × PauseReductionFactor.
	PauseMode string
	// For P-C: multiplier applied to net when ancestor unqualified.
	// 0.5 = pays half. Default 0.5.
	PauseReductionFactor decimal.Decimal
	// For P-B: how many periods PausedCarry sits before expiring.
	// Default 4 (~1 month on weekly cadence).
	PausedCarryDecayPeriods int

	// R1-stale: intermittent compliance. If > 0, any affiliate whose
	// LastPurchaseAt is older than this many periods is auto-promoted to
	// "needs repurchase" at the start of the next period, regardless of
	// depth threshold. Lets the simulator exercise pause/recover cycles.
	// 0 = disabled (default).
	PurchaseStalePeriods int

	// RenewalCostFactor: cost of a R1-compliance "renewal" as a fraction
	// of the affiliate's active PackagePrice. The previous model used a
	// full random PackagePrice (overestimated inflows). Renewal is a
	// re-qualification fee, not an upgrade. Default 0 — renewals reset
	// LastPurchaseAt without adding inflow; the 5%/period ongoing
	// contribution already represents recurring activity.
	// Set e.g. 0.05 to model an explicit renewal charge of 5% of package.
	RenewalCostFactor decimal.Decimal

	// T3 / period cap. ADR-0014 — leadership ranks removed.
	// Cap now = PeriodCapFactor × PackagePrice per affiliate per period.
	// Larger packages → larger cap. Documented in docs/topes_diarios.md.
	// If 0, falls back to the legacy DailyCapFactor × RankBonusBase.
	PeriodCapFactor decimal.Decimal

	// R2 — 25% annual yield, gated on "2 directos balanced" (one direct
	// sponsored affiliate on each side of the binary). ADR-0015.
	// Paid every YieldCadencePeriods periods (4 ≈ monthly when weekly).
	YieldEnabled        bool
	YieldAnnualRate     decimal.Decimal // 0.25 = 25% / year
	YieldCadencePeriods int             // 4 = monthly when periods are weekly

	// Lock period on initial capital (package). Capital cannot be withdrawn
	// for this many periods after deposit. Reported via PeriodResult.
	// LockedCapital — doesn't affect θ, but affects liquidity reporting.
	// Default 52 (12 months on weekly cadence). 0 = no lock.
	CapitalLockPeriods int

	// R3 — points bonus. ADR-0016. Each closed binary block awards
	// PointsPerBlock points (default 1.0). Points accrue per affiliate and
	// pay out every PointsCadencePeriods at PointsDollarsPerPoint USD each.
	// Subject to T1 + T2 + T3 (same caps as binary block bonus). See
	// docs/bonos_puntos.md for rationale.
	PointsBonusEnabled    bool
	PointsPerBlock        decimal.Decimal // points granted per binary block closed
	PointsDollarsPerPoint decimal.Decimal // $ per point at cadence payout
	PointsCadencePeriods  int             // 4 = monthly when weekly

	// Carrera de rangos (ADR-0017/0018). Bono one-time fijo al cruzar cada
	// hito de puntos-por-pierna acumulados. T1 sólo (entra a θ, bypassa
	// T2/T3). RankDefs: tabla real de 14 (DefaultRankDefs).
	RanksEnabled bool
	RankDefs     []RankDef

	// Mitigación B (plan integral §5.4, decidida 2026-06-05): el bono de
	// rango se paga en RankInstallments cuotas iguales, una cada
	// RankInstallmentCadence períodos desde el ascenso. Suaviza la
	// "avalancha de rangos" (miles de Bronce/Plata simultáneos hunden θ).
	// El hito queda alcanzado al cruzar; sólo el PAGO se difiere.
	// 1 = pago único (sin mitigación). Aplica a TODOS los rangos: la
	// avalancha la causan los hitos chicos en masa, no los grandes.
	RankInstallments        int
	RankInstallmentCadence  int

	// Fundadores (ADR-0018). FounderFraction = probabilidad de que un nuevo
	// afiliado pertenezca a la cohorte fundadora (1.0 = lanzamiento v2.0:
	// todos fundadores). El binario del fundador paga
	// FounderBinaryMatchedRate × matched volume (en vez de $/bloque) y su
	// bono referido usa FounderReferralRate.
	FounderFraction          float64
	FounderBinaryMatchedRate decimal.Decimal // 0.10 = 10% del matched
	FounderReferralRate      decimal.Decimal // 0.10 de cada pago del directo
	// Referido para NO fundadores (pendiente de definir; default 0).
	ReferralRate decimal.Decimal

	// Regalía gen-2 (ADR-0018): % de cada pago de la 2ª generación de
	// patrocinio. T1 sólo.
	RoyaltyEnabled bool
	RoyaltyRate    decimal.Decimal // 0.05
}

// V1Conservative returns the plan parameters from ADR-0012 §1.
func V1Conservative() PlanConfig {
	return PlanConfig{
		BlockSize:             500,
		BonusPerBlock:         decimal.RequireFromString("10.00"),
		DepthCap:              10,
		DailyCapFactor:        decimal.RequireFromString("3.0"),
		LifetimeCapFactor:     decimal.RequireFromString("2.0"),
		TreasuryAlpha:         decimal.RequireFromString("0.45"),
		CarryDecayPeriods:     2,
		QualifiedDirectsLeft:  1,
		QualifiedDirectsRight: 1,
		RankBonusBase:         decimal.RequireFromString("500.00"),
		// R1 default OFF — opt-in via scenario for backwards compatibility
		// with existing simulations. Set true to enable ADR-0013.
		DepthRepurchaseEnabled:   false,
		RepurchaseThreshold:      10,
		RepurchaseComplianceProb: 0.75,
		PauseMode:                "skip",
		PauseReductionFactor:     decimal.RequireFromString("0.5"),
		PausedCarryDecayPeriods:  4,
		PurchaseStalePeriods:     0, // off; opt-in
		RenewalCostFactor:        decimal.RequireFromString("0.10"), // ADR-0015: 10% del paquete
		PeriodCapFactor:          decimal.RequireFromString("0.5"),
		YieldEnabled:             false, // opt-in per ADR-0015
		YieldAnnualRate:          decimal.RequireFromString("0.25"),
		YieldCadencePeriods:      4, // monthly on weekly periods
		CapitalLockPeriods:       52, // 12 months on weekly cadence
		PointsBonusEnabled:       false,
		PointsPerBlock:           decimal.RequireFromString("1"),
		PointsDollarsPerPoint:    decimal.RequireFromString("1"),
		PointsCadencePeriods:     4, // monthly on weekly cadence
		// Carrera de rangos — opt-in (ADR-0017/0018); tabla real precargada.
		RanksEnabled:           false,
		RankDefs:               DefaultRankDefs(),
		RankInstallments:       1, // pago único; mitigación B opt-in
		RankInstallmentCadence: 4, // cuotas mensuales en cadencia semanal
		// Fundadores — opt-in; tasas spec 2026-06-04 (10%/10%).
		FounderFraction:          0,
		FounderBinaryMatchedRate: decimal.RequireFromString("0.10"),
		FounderReferralRate:      decimal.RequireFromString("0.10"),
		ReferralRate:             decimal.Zero,
		// Regalía gen-2 — opt-in; 5% spec 2026-06-04.
		RoyaltyEnabled: false,
		RoyaltyRate:    decimal.RequireFromString("0.05"),
	}
}

// Scenario controls a single Monte Carlo run.
type Scenario struct {
	// Population
	InitialAffiliates int   // starting tree size (excluding root)
	Periods           int   // number of binary periods to simulate
	Seed              int64 // deterministic RNG

	// Growth: new enrollments per period as fraction of current size.
	// 0.0 = no growth (steady-state, the canonical T7 stress test).
	GrowthRate float64

	// Package mix: drawn from this set with uniform probability.
	// Each entry: USD price → PV points (1:1 typical for fast simplicity).
	PackagePrices []decimal.Decimal

	// Inflow shock: map period→multiplier. e.g. {30: 0.5} drops inflows
	// at period 30 by 50%. Useful for stress-testing economic downturn.
	InflowShock map[int]float64

	// Plan parameters (allow sweeping α, K_pkg, etc.).
	Plan PlanConfig

	// Placement strategy: weak-leg | random | always-left. Empty = weak-leg.
	Strategy string

	// Sponsor selection: uniform | power-law. Empty = uniform.
	SponsorDistribution string
	// Power-law exponent. 0=uniform, 1=proportional, 2=heavily skewed.
	// Real MLM data fits 1.2-1.8 (a few whales recruit most of the tree).
	SponsorPowerLawAlpha float64
}

// Default returns a baseline steady-state scenario.
func Default() Scenario {
	return Scenario{
		InitialAffiliates: 10_000,
		Periods:           52, // 1 year of weekly periods
		Seed:              42,
		GrowthRate:        0.0, // stationary — the strict T7 test
		PackagePrices: []decimal.Decimal{
			decimal.RequireFromString("100"),
			decimal.RequireFromString("500"),
			decimal.RequireFromString("1000"),
			decimal.RequireFromString("2500"),
		},
		InflowShock: nil,
		Plan:        V1Conservative(),
	}
}
