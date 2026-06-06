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
