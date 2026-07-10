package networkintel

import "testing"

func TestDeterministicAnalysisFlagsWeakLegAndRisk(t *testing.T) {
	resp := DeterministicAnalysis(AnalysisRequest{
		Metrics: NetworkMetrics{
			TotalMembers:      20,
			ActiveMembers:     9,
			LeftMembers:       3,
			RightMembers:      17,
			LeftVolume:        1500,
			RightVolume:       18000,
			CompanyFund:       1000,
			ProjectedOutflows: 9000,
			WorstTheta:        0.7,
		},
	})

	if resp.WeakLeg != "left" {
		t.Fatalf("expected left weak leg, got %s", resp.WeakLeg)
	}
	if resp.RiskLevel != "alto" {
		t.Fatalf("expected high risk, got %s", resp.RiskLevel)
	}
	if resp.HealthScore >= 70 {
		t.Fatalf("expected degraded health score, got %d", resp.HealthScore)
	}
	if len(resp.Actions) == 0 {
		t.Fatal("expected recommended actions")
	}
}

func TestDeterministicAnalysis_RankExposureFinding(t *testing.T) {
	req := AnalysisRequest{Metrics: NetworkMetrics{
		TotalMembers: 100, ActiveMembers: 80, LeftVolume: 1000, RightVolume: 900,
		CompanyFund: 500, ProjectedOutflows: 400, WorstTheta: 0.9,
		RankLiabilityRatio: 0.8, // liability = 80% de inflows → riesgo
	}}
	resp := DeterministicAnalysis(req)
	found := false
	for _, f := range resp.Findings {
		if f.Area == "niveles" {
			found = true
		}
	}
	if !found {
		t.Fatal("esperaba un finding area=niveles por exposición alta de rangos")
	}
}

func TestDeterministicAnalysisBalancedTree(t *testing.T) {
	resp := DeterministicAnalysis(AnalysisRequest{
		Metrics: NetworkMetrics{
			TotalMembers:      12,
			ActiveMembers:     11,
			LeftMembers:       6,
			RightMembers:      6,
			LeftVolume:        6000,
			RightVolume:       6100,
			CompanyFund:       12000,
			ProjectedOutflows: 3000,
			WorstTheta:        0.93,
		},
	})

	if resp.RiskLevel != "bajo" {
		t.Fatalf("expected low risk, got %s", resp.RiskLevel)
	}
	if resp.HealthScore < 85 {
		t.Fatalf("expected healthy score, got %d", resp.HealthScore)
	}
}
