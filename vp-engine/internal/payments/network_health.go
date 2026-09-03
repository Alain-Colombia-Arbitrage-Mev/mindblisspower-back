package payments

// network_health.go — BuildNetworkMetrics
//
// Assembles a networkintel.NetworkMetrics snapshot from live DB data plus the
// existing finance/solvency queries, and computes a RankExposure summary.
//
// Company-root identification:
//   Prefer the configured company root when the caller has it. If historical
//   data does not have a formal parent_id IS NULL root, fall back to detached
//   or top visible nodes so the dashboard does not report empty legs while the
//   tree has placed affiliates.
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
func (s *Store) BuildNetworkMetrics(ctx context.Context, companyRootOpt ...int64) (networkintel.NetworkMetrics, RankExposure, error) {
	var m networkintel.NetworkMetrics
	var companyRoot int64
	if len(companyRootOpt) > 0 {
		companyRoot = companyRootOpt[0]
	}

	// ── 1. Network counts and binary-leg volumes ────────────────────────────
	//
	// TotalMembers:  every affiliate row (placed in the tree).
	// ActiveMembers: persons with status='active' (persons, not affiliates).
	// LeftMembers/RightMembers: the root affiliate(s) left_count/right_count —
	//   these are denormalized accumulators maintained by the tree_event trigger
	//   and represent the full network split, not per-affiliate subtotals.
	// LeftVolume/RightVolume: analogous for lifetime PV.
	//
	// Root selection mirrors the admin tree explorer: configured root first,
	// detached roots second, then orphan/top visible nodes as a legacy fallback.
	var leftVolStr, rightVolStr string
	err := s.db.QueryRow(ctx, `
		WITH visible_affiliates AS (
		  SELECT a.id, a.parent_id, COALESCE(a.depth, 0) AS depth
		    FROM mlm.affiliate a
		    JOIN mlm.person p ON p.id = a.person_id
		   WHERE a.status::text <> 'deleted'
		     AND p.status::text <> 'deleted'
		),
		configured_root AS (
		  SELECT id, 0 AS priority, depth
		    FROM visible_affiliates
		   WHERE id = $1
		     AND $1 > 0
		),
		detached_roots AS (
		  SELECT id, 1 AS priority, depth
		    FROM visible_affiliates
		   WHERE parent_id IS NULL
		     AND NOT EXISTS (SELECT 1 FROM configured_root)
		),
		orphan_roots AS (
		  SELECT a.id, 2 AS priority, a.depth
		    FROM visible_affiliates a
		    LEFT JOIN visible_affiliates parent ON parent.id = a.parent_id
		   WHERE parent.id IS NULL
		     AND NOT EXISTS (SELECT 1 FROM configured_root)
		     AND NOT EXISTS (SELECT 1 FROM detached_roots)
		   ORDER BY a.depth, a.id
		   LIMIT 25
		),
		depth_roots AS (
		  SELECT id, 3 AS priority, depth
		    FROM visible_affiliates
		   WHERE NOT EXISTS (SELECT 1 FROM configured_root)
		     AND NOT EXISTS (SELECT 1 FROM detached_roots)
		     AND NOT EXISTS (SELECT 1 FROM orphan_roots)
		   ORDER BY depth, id
		   LIMIT 25
		),
		root_ids AS (
		  SELECT DISTINCT ON (id) id, priority, depth
		    FROM (
		      SELECT * FROM configured_root
		      UNION ALL
		      SELECT * FROM detached_roots
		      UNION ALL
		      SELECT * FROM orphan_roots
		      UNION ALL
		      SELECT * FROM depth_roots
		    ) candidates
		   ORDER BY id, priority, depth
		),
		selected_roots AS (
		  SELECT id
		    FROM root_ids
		   ORDER BY priority, depth, id
		   LIMIT 25
		)
		SELECT
		  (SELECT count(*) FROM mlm.affiliate)                     AS total_members,
		  (SELECT count(*) FROM mlm.person WHERE status = 'active') AS active_members,
		  COALESCE(SUM(a.left_count),  0)                          AS left_members,
		  COALESCE(SUM(a.right_count), 0)                          AS right_members,
		  COALESCE(SUM(a.left_pv_lifetime),  0)::text              AS left_volume,
		  COALESCE(SUM(a.right_pv_lifetime), 0)::text              AS right_volume
		  FROM mlm.affiliate a
		  JOIN selected_roots sr ON sr.id = a.id
	`, companyRoot).Scan(
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
