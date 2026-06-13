// Package simulate exposes a POST /simulate HTTP handler that runs a Monte
// Carlo solvency what-if of the binary plan with caller-supplied parameter
// overrides.  It is entirely in-memory — no database access.
package simulate

import (
	"encoding/json"
	"net/http"

	"github.com/rs/zerolog"
	"github.com/shopspring/decimal"

	"github.com/vicionpower/vp-engine/internal/simulator"
)

// Handler serves POST /simulate.
type Handler struct {
	log zerolog.Logger
}

// NewHandler creates a Handler with the given logger.
func NewHandler(log zerolog.Logger) *Handler {
	return &Handler{
		log: log.With().Str("component", "simulate").Logger(),
	}
}

// SimulateRequest is the JSON body accepted by POST /simulate.
type SimulateRequest struct {
	// Overrides maps PlanConfig / Scenario field names to their new values
	// expressed as strings (e.g. "0.45").  Unknown keys are collected into
	// the response Warnings slice; they do NOT cause a 400.
	Overrides map[string]string `json:"overrides"`
	// Periods is the number of binary periods to simulate.  Defaults to 52,
	// clamped to [1, 520].
	Periods int `json:"periods"`
	// Seed is the RNG seed for reproducibility.  Defaults to 42.
	Seed int64 `json:"seed"`
}

// SimulateResponse is the JSON body returned on a successful 200.
type SimulateResponse struct {
	// WorstTheta is the minimum theta observed across all simulated periods.
	WorstTheta float64 `json:"worst_theta"`
	// Solvent is true iff every period passed T1 (no solvency breach).
	Solvent bool `json:"solvent"`
	// Margin is the aggregate operating margin expressed as a fraction of
	// total inflows (i.e. CompanyFundRate from the disbursement summary).
	Margin float64 `json:"margin"`
	// Periods echoes the number of periods actually simulated.
	Periods int `json:"periods"`
	// Warnings lists override keys that are not mapped to any simulator field.
	Warnings []string `json:"warnings"`
}

// setJSONHeaders mirrors the convention in internal/networkintel/http.go.
func setJSONHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setJSONHeaders(w)

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req SimulateRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		http.Error(w, "invalid simulate payload: "+err.Error(), http.StatusBadRequest)
		return
	}

	// Default / clamp periods.
	if req.Periods <= 0 {
		req.Periods = 52
	}
	if req.Periods > 520 {
		req.Periods = 520
	}
	// Default seed.
	if req.Seed == 0 {
		req.Seed = 42
	}

	// Build scenario: v2 candados preset (mirrors cmd/vp-sim --v2).
	// Use 1 000 initial affiliates by default so HTTP calls finish in < 2 s;
	// callers who need the full 10 000-node tree can override via
	// "initial_affiliates".
	scenario := simulator.Default()
	scenario.InitialAffiliates = 1_000
	scenario.Periods = req.Periods
	scenario.Seed = req.Seed

	// v2 candados preset — mirrors the block in cmd/vp-sim main() exactly.
	scenario.Plan.DepthRepurchaseEnabled = true
	scenario.Plan.PurchaseStalePeriods = 4
	scenario.Plan.PauseMode = "reduce"
	scenario.Plan.YieldEnabled = true
	scenario.Plan.PointsBonusEnabled = true
	scenario.Plan.RanksEnabled = true
	scenario.Plan.RankInstallments = 4
	scenario.Plan.RankInstallmentCadence = 4
	scenario.Plan.RoyaltyEnabled = true
	scenario.Plan.FounderFraction = 1.0

	// Apply caller overrides and collect warnings for unknown keys.
	warnings := applyOverrides(&scenario, req.Overrides)

	// Run the simulation (nil writer = quiet, no stdout output).
	results, err := simulator.RunScenario(scenario, nil)
	if err != nil {
		h.log.Error().Err(err).Msg("scenario run failed")
		http.Error(w, "simulation error: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Derive metrics from disbursement report (same as cmd/vp-sim output).
	report := simulator.BuildDisbursementReport(results)
	summary := report.Summary

	worstTheta, _ := summary.WorstTheta.Float64()
	margin, _ := summary.CompanyFundRate.Float64()

	resp := SimulateResponse{
		WorstTheta: worstTheta,
		Solvent:    summary.SolvencyBreaches == 0,
		Margin:     margin,
		Periods:    req.Periods,
		Warnings:   warnings,
	}
	if resp.Warnings == nil {
		resp.Warnings = []string{}
	}

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}

// knownOverrideKeys is the set of keys applyOverrides handles.  Any key NOT
// in this set is returned as a warning.
var knownOverrideKeys = map[string]bool{
	"treasury_alpha":      true,
	"lifetime_cap_factor": true,
	"daily_cap_factor":    true,
	"founder_frac":        true,
	"compliance":          true,
	"rank_installments":   true,
	"rank_cadence":        true,
	"founder_rate":        true,
	"initial_affiliates":  true,
}

// applyOverrides maps string keys to Scenario / PlanConfig fields, mirroring
// the flag-to-field mapping in cmd/vp-sim/main.go.  It returns the list of
// unrecognised keys as warnings.
func applyOverrides(s *simulator.Scenario, overrides map[string]string) []string {
	var warnings []string
	for key, val := range overrides {
		switch key {
		case "treasury_alpha":
			v, err := decimal.NewFromString(val)
			if err == nil {
				s.Plan.TreasuryAlpha = v
			}
		case "lifetime_cap_factor":
			v, err := decimal.NewFromString(val)
			if err == nil {
				s.Plan.LifetimeCapFactor = v
			}
		case "daily_cap_factor":
			v, err := decimal.NewFromString(val)
			if err == nil {
				s.Plan.DailyCapFactor = v
			}
		case "founder_frac":
			v, err := decimal.NewFromString(val)
			if err == nil {
				f, _ := v.Float64()
				s.Plan.FounderFraction = f
			}
		case "compliance":
			v, err := decimal.NewFromString(val)
			if err == nil {
				f, _ := v.Float64()
				s.Plan.RepurchaseComplianceProb = f
			}
		case "rank_installments":
			v, err := decimal.NewFromString(val)
			if err == nil {
				s.Plan.RankInstallments = int(v.IntPart())
			}
		case "rank_cadence":
			v, err := decimal.NewFromString(val)
			if err == nil {
				s.Plan.RankInstallmentCadence = int(v.IntPart())
			}
		case "founder_rate":
			v, err := decimal.NewFromString(val)
			if err == nil {
				s.Plan.FounderBinaryMatchedRate = v
			}
		case "initial_affiliates":
			v, err := decimal.NewFromString(val)
			if err == nil && v.IntPart() >= 1 {
				s.InitialAffiliates = int(v.IntPart())
			}
		default:
			warnings = append(warnings, "field "+key+" not simulated")
		}
	}
	return warnings
}
