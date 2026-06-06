package simulator

import "github.com/shopspring/decimal"

// DisbursementStreams separates every money-out stream simulated for a period.
// This is the business-facing view of PeriodResult.TotalPaid.
type DisbursementStreams struct {
	BinaryTree    decimal.Decimal
	Yield         decimal.Decimal
	Points        decimal.Decimal
	Ranks         decimal.Decimal
	Referral      decimal.Decimal
	Royalty       decimal.Decimal
	ReleasedCarry decimal.Decimal
	Other         decimal.Decimal
}

func (s DisbursementStreams) Total() decimal.Decimal {
	return decimal.Zero.
		Add(s.BinaryTree).
		Add(s.Yield).
		Add(s.Points).
		Add(s.Ranks).
		Add(s.Referral).
		Add(s.Royalty).
		Add(s.ReleasedCarry).
		Add(s.Other)
}

func (s DisbursementStreams) add(o DisbursementStreams) DisbursementStreams {
	s.BinaryTree = s.BinaryTree.Add(o.BinaryTree)
	s.Yield = s.Yield.Add(o.Yield)
	s.Points = s.Points.Add(o.Points)
	s.Ranks = s.Ranks.Add(o.Ranks)
	s.Referral = s.Referral.Add(o.Referral)
	s.Royalty = s.Royalty.Add(o.Royalty)
	s.ReleasedCarry = s.ReleasedCarry.Add(o.ReleasedCarry)
	s.Other = s.Other.Add(o.Other)
	return s
}

// PeriodDisbursement is the reconciliation for one simulated binary close:
// inflows = total distributed + company fund.
type PeriodDisbursement struct {
	Period                int
	Inflows               decimal.Decimal
	Streams               DisbursementStreams
	TotalDistributed      decimal.Decimal
	CompanyFund           decimal.Decimal
	CumulativeCompanyFund decimal.Decimal
	DistributionRate      decimal.Decimal
	CompanyFundRate       decimal.Decimal
}

type DisbursementSummary struct {
	Periods          int
	Inflows          decimal.Decimal
	Streams          DisbursementStreams
	TotalDistributed decimal.Decimal
	CompanyFund      decimal.Decimal
	DistributionRate decimal.Decimal
	CompanyFundRate  decimal.Decimal
	WorstTheta       decimal.Decimal
	SolvencyBreaches int
	RanksAchieved    int
}

type DisbursementReport struct {
	Periods []PeriodDisbursement
	Summary DisbursementSummary
}

func BuildDisbursementReport(results []PeriodResult) DisbursementReport {
	report := DisbursementReport{
		Periods: make([]PeriodDisbursement, 0, len(results)),
		Summary: DisbursementSummary{
			Periods: len(results),
		},
	}
	if len(results) > 0 {
		report.Summary.WorstTheta = decimal.NewFromInt(1)
	}

	cumulativeCompanyFund := decimal.Zero
	for _, r := range results {
		streams := disbursementStreamsFromResult(r)
		companyFund := r.Margin
		cumulativeCompanyFund = cumulativeCompanyFund.Add(companyFund)

		report.Periods = append(report.Periods, PeriodDisbursement{
			Period:                r.Period,
			Inflows:               r.Inflows,
			Streams:               streams,
			TotalDistributed:      r.TotalPaid,
			CompanyFund:           companyFund,
			CumulativeCompanyFund: cumulativeCompanyFund,
			DistributionRate:      ratio(r.TotalPaid, r.Inflows),
			CompanyFundRate:       ratio(companyFund, r.Inflows),
		})

		report.Summary.Inflows = report.Summary.Inflows.Add(r.Inflows)
		report.Summary.Streams = report.Summary.Streams.add(streams)
		report.Summary.TotalDistributed = report.Summary.TotalDistributed.Add(r.TotalPaid)
		report.Summary.CompanyFund = report.Summary.CompanyFund.Add(companyFund)
		if r.Theta.LessThan(report.Summary.WorstTheta) {
			report.Summary.WorstTheta = r.Theta
		}
		if !r.SolvencyOK {
			report.Summary.SolvencyBreaches++
		}
		report.Summary.RanksAchieved = r.RanksAchieved
	}

	report.Summary.DistributionRate = ratio(report.Summary.TotalDistributed, report.Summary.Inflows)
	report.Summary.CompanyFundRate = ratio(report.Summary.CompanyFund, report.Summary.Inflows)
	return report
}

func disbursementStreamsFromResult(r PeriodResult) DisbursementStreams {
	streams := DisbursementStreams{
		BinaryTree:    r.BinaryPaid,
		Yield:         r.YieldPaid,
		Points:        r.PointsBonusPaid,
		Ranks:         r.RankBonusPaid,
		Referral:      r.ReferralPaid,
		Royalty:       r.RoyaltyPaid,
		ReleasedCarry: r.ReleasedCarryPaid,
	}
	known := streams.Total()
	if r.TotalPaid.GreaterThan(known) {
		streams.Other = r.TotalPaid.Sub(known)
	}
	return streams
}

func ratio(part, whole decimal.Decimal) decimal.Decimal {
	if whole.IsZero() {
		return decimal.Zero
	}
	return part.Div(whole).Round(6)
}
