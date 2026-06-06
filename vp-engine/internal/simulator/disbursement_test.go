package simulator

import "testing"

func TestBuildDisbursementReportBalancesTreeRanksAndCompanyFund(t *testing.T) {
	results := []PeriodResult{
		{
			Period:            1,
			Inflows:           d("100"),
			BinaryPaid:        d("10"),
			YieldPaid:         d("3"),
			PointsBonusPaid:   d("2"),
			RankBonusPaid:     d("5"),
			ReferralPaid:      d("4"),
			RoyaltyPaid:       d("1"),
			ReleasedCarryPaid: d("0"),
			TotalPaid:         d("25"),
			Margin:            d("75"),
			Theta:             d("1"),
			SolvencyOK:        true,
			RanksAchieved:     2,
		},
		{
			Period:            2,
			Inflows:           d("200"),
			BinaryPaid:        d("20"),
			YieldPaid:         d("0"),
			PointsBonusPaid:   d("5"),
			RankBonusPaid:     d("10"),
			ReferralPaid:      d("0"),
			RoyaltyPaid:       d("0"),
			ReleasedCarryPaid: d("5"),
			TotalPaid:         d("40"),
			Margin:            d("160"),
			Theta:             d("0.8"),
			SolvencyOK:        false,
			RanksAchieved:     3,
		},
	}

	report := BuildDisbursementReport(results)

	if report.Summary.Periods != 2 {
		t.Fatalf("periods = %d, want 2", report.Summary.Periods)
	}
	if !report.Summary.Inflows.Equal(d("300")) {
		t.Fatalf("inflows = %s, want 300", report.Summary.Inflows)
	}
	if !report.Summary.Streams.BinaryTree.Equal(d("30")) {
		t.Fatalf("binary tree paid = %s, want 30", report.Summary.Streams.BinaryTree)
	}
	if !report.Summary.Streams.Ranks.Equal(d("15")) {
		t.Fatalf("rank bonuses paid = %s, want 15", report.Summary.Streams.Ranks)
	}
	if !report.Summary.TotalDistributed.Equal(d("65")) {
		t.Fatalf("distributed = %s, want 65", report.Summary.TotalDistributed)
	}
	if !report.Summary.CompanyFund.Equal(d("235")) {
		t.Fatalf("company fund = %s, want 235", report.Summary.CompanyFund)
	}
	if !report.Summary.WorstTheta.Equal(d("0.8")) {
		t.Fatalf("worst theta = %s, want 0.8", report.Summary.WorstTheta)
	}
	if report.Summary.SolvencyBreaches != 1 {
		t.Fatalf("solvency breaches = %d, want 1", report.Summary.SolvencyBreaches)
	}
	if report.Summary.RanksAchieved != 3 {
		t.Fatalf("ranks achieved = %d, want 3", report.Summary.RanksAchieved)
	}
	if !report.Periods[1].CumulativeCompanyFund.Equal(d("235")) {
		t.Fatalf("period 2 cumulative fund = %s, want 235", report.Periods[1].CumulativeCompanyFund)
	}
}
