package payments

// network_health.go — BuildNetworkMetrics
//
// Assembles a networkintel.NetworkMetrics snapshot from live DB data plus the
// existing finance/solvency queries, and computes a RankExposure summary.
//
// Company-root identification:
//   The binary tree may have a single company-root affiliate (parent_id IS NULL,
//   position IS NULL) or, rarely, a small forest if ops ever created two detached
//   roots.  We SUM left_count/right_count/left_pv_lifetime/right_pv_lifetime over
//   ALL root affiliates (WHERE parent_id IS NULL).  In the normal single-root case
//   this is identical to querying by companyRoot id; it stays correct for a forest
//   without requiring the Handler's companyRoot int64 to be threaded into Store.
//
// Field mapping from AdminFinance / Solvency:
//   CompanyFund       ← AdminFinance.TreasuryUSD          (string, parse to float64)
//   ProjectedOutflows ← Solvency.Current.ProjectedUSD     (string, parse to float64; 0 if no open period)
//   WorstTheta        ← min(Theta) over Solvency.Recent   (the tightest closed period; 1.0 if no history)

import (
	"context"
	"fmt"
	"math"
	"strconv"

	"github.com/shopspring/decimal"
	"github.com/vicionpower/vp-engine/internal/networkintel"
)

// RankExposure summarises unpaid rank-bonus installments.
type RankExposure struct {
	PendingInstallments int             `json:"pending_installments"`
	LiabilityUSD        decimal.Decimal `json:"liability_usd"`
	ExposureRatio       float64         `json:"exposure_ratio"` // liability / inflows; 0 if inflows == 0
}

// BuildNetworkMetrics assembles a networkintel.NetworkMetrics value plus a
// RankExposure snapshot from live DB data.
//
// It reuses GetAdminFinance and GetSolvency (cache-aside, no extra queries)
// and adds two targeted SQL reads: one for network member/volume counts from
// the tree root(s), and one for unpaid rank-bonus installments.
func (s *Store) BuildNetworkMetrics(ctx context.Context) (networkintel.NetworkMetrics, RankExposure, error) {
	var m networkintel.NetworkMetrics

	// ── 1. Network counts and binary-leg volumes ────────────────────────────
	//
	// TotalMembers:  every affiliate row (placed in the tree).
	// ActiveMembers: persons with status='active' (persons, not affiliates).
	// LeftMembers/RightMembers: the root affiliate(s) left_count/right_count —
	//   these are denormalized accumulators maintained by the tree_event trigger
	//   and represent the full network split, not per-affiliate subtotals.
	// LeftVolume/RightVolume: analogous for lifetime PV.
	//
	// We aggregate over WHERE parent_id IS NULL (all roots) so the query is
	// correct for both single-root and multi-root (forest) deployments.
	var leftVolStr, rightVolStr string
	err := s.db.QueryRow(ctx, `
		SELECT
		  (SELECT count(*) FROM mlm.affiliate)                     AS total_members,
		  (SELECT count(*) FROM mlm.person WHERE status = 'active') AS active_members,
		  COALESCE(SUM(left_count),  0)                            AS left_members,
		  COALESCE(SUM(right_count), 0)                            AS right_members,
		  COALESCE(SUM(left_pv_lifetime),  0)::text                AS left_volume,
		  COALESCE(SUM(right_pv_lifetime), 0)::text                AS right_volume
		  FROM mlm.affiliate
		 WHERE parent_id IS NULL
	`).Scan(
		&m.TotalMembers,
		&m.ActiveMembers,
		&m.LeftMembers,
		&m.RightMembers,
		&leftVolStr,
		&rightVolStr,
	)
	if err != nil {
		return m, RankExposure{}, fmt.Errorf("network metrics: %w", err)
	}
	v, err := strconv.ParseFloat(leftVolStr, 64)
	if err != nil {
		return m, RankExposure{}, fmt.Errorf("parse left_volume %q: %w", leftVolStr, err)
	}
	m.LeftVolume = v

	v, err = strconv.ParseFloat(rightVolStr, 64)
	if err != nil {
		return m, RankExposure{}, fmt.Errorf("parse right_volume %q: %w", rightVolStr, err)
	}
	m.RightVolume = v

	// ── 2. Finance & solvency — reuse cached queries ────────────────────────
	fin, err := s.GetAdminFinance(ctx)
	if err != nil {
		return m, RankExposure{}, fmt.Errorf("admin finance: %w", err)
	}
	sol, err := s.GetSolvency(ctx)
	if err != nil {
		return m, RankExposure{}, fmt.Errorf("solvency: %w", err)
	}

	// CompanyFund ← TreasuryUSD (retained company cash ≈ inflows − commissions − paid withdrawals).
	// Parse failure is non-fatal: TreasuryUSD can legitimately be empty/absent before any period
	// closes.  We default to 0 and log the error rather than hard-failing the whole snapshot.
	if v, err2 := strconv.ParseFloat(fin.TreasuryUSD, 64); err2 == nil {
		m.CompanyFund = v
	} else if fin.TreasuryUSD != "" {
		// Non-empty string that fails to parse: propagate — default-to-zero would silently mislead the advisor.
		return m, RankExposure{}, fmt.Errorf("parse company_fund %q: %w", fin.TreasuryUSD, err2)
	}

	// ProjectedOutflows ← current open period's projected_outflows (string).
	// Falls back to 0 when no open period exists yet.
	if sol.Current != nil {
		// Same non-fatal treatment: absence of an open period is normal; a non-empty unparseable
		// string is unexpected but should not abort the snapshot.
		if v, err2 := strconv.ParseFloat(sol.Current.ProjectedUSD, 64); err2 == nil {
			m.ProjectedOutflows = v
		} else if sol.Current.ProjectedUSD != "" {
			// Non-empty string that fails to parse: propagate — default-to-zero would silently mislead the advisor.
			return m, RankExposure{}, fmt.Errorf("parse projected_outflows %q: %w", sol.Current.ProjectedUSD, err2)
		}
	}

	// WorstTheta ← minimum theta across all closed periods (heaviest throttle seen).
	// 1.0 (no throttle) when there is no history.
	m.WorstTheta = 1.0
	for _, p := range sol.Recent {
		if p.Theta == nil {
			continue
		}
		if t, err2 := strconv.ParseFloat(*p.Theta, 64); err2 == nil {
			m.WorstTheta = math.Min(m.WorstTheta, t)
		}
	}

	// ── 3. Rank-bonus exposure ───────────────────────────────────────────────
	var rx RankExposure
	var liabilityStr string
	if err := s.db.QueryRow(ctx, `
		SELECT count(*), COALESCE(SUM(amount_usd), 0)::text
		  FROM mlm.rank_bonus_installment
		 WHERE paid_at IS NULL
	`).Scan(&rx.PendingInstallments, &liabilityStr); err != nil {
		return m, RankExposure{}, fmt.Errorf("rank exposure: %w", err)
	}
	rx.LiabilityUSD, err = decimal.NewFromString(liabilityStr)
	if err != nil {
		return m, RankExposure{}, fmt.Errorf("parse rank liability %q: %w", liabilityStr, err)
	}

	if inflows, err2 := strconv.ParseFloat(fin.InflowsUSD, 64); err2 == nil && inflows > 0 {
		liab, _ := rx.LiabilityUSD.Float64()
		rx.ExposureRatio = liab / inflows
	}

	return m, rx, nil
}
