package payments

import (
	"context"
	"testing"
)

// TestBuildNetworkMetrics_Integration validates the BuildNetworkMetrics builder
// against a live Postgres container.  Requires Docker; skipped under -short.
//
// Fixture:
//   - One company root affiliate (parent_id IS NULL) with
//       left_pv_lifetime=100, right_pv_lifetime=40,
//       left_count=2, right_count=1
//   - Two active persons.
//   - One unpaid rank_bonus_installment of $25 (seeds affiliate_rank_achieved first).
//
// Assertions:
//   - m.TotalMembers >= 1
//   - m.LeftVolume >= m.RightVolume  (left leg is the strong leg: 100 > 40)
//   - rx.LiabilityUSD is non-zero  (the $25 installment)
func TestBuildNetworkMetrics_Integration(t *testing.T) {
	if testing.Short() {
		t.Skip("needs DB (Docker); skipped under -short")
	}

	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	// ── seed ────────────────────────────────────────────────────────────────
	// Two active persons.
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		OVERRIDING SYSTEM VALUE VALUES
		  (10, 'Alice', 'Net', 'alice@t.local', '0', 'active'),
		  (11, 'Bob',   'Net', 'bob@t.local',   '0', 'active');
	`); err != nil {
		t.Fatalf("seed persons: %v", err)
	}

	// Company root affiliate: parent_id IS NULL, position IS NULL.
	// We manually set denormalized leg aggregates to known values so assertions
	// are deterministic without triggering the full tree_event machinery.
	var rootID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.affiliate (
		  person_id, parent_id, position, status, path, depth,
		  left_count, right_count, left_pv_lifetime, right_pv_lifetime
		) VALUES (10, NULL, NULL, 'active', ''::ltree, 0, 2, 1, 100, 40)
		RETURNING id
	`).Scan(&rootID); err != nil {
		t.Fatalf("seed root affiliate: %v", err)
	}

	// Rank 1 (BRONZE) is seeded by schema_ranks.sql; we need affiliate_rank_achieved
	// as a parent FK before inserting a rank_bonus_installment.
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.affiliate_rank_achieved
		  (affiliate_id, rank_id, achieved_at, source,
		   bonus_amount_usd, net_amount_usd)
		VALUES ($1, 1, now(), 'earned', 100.00, 100.00)
	`, rootID); err != nil {
		t.Fatalf("seed affiliate_rank_achieved: %v", err)
	}

	// One unpaid installment of $25.
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.rank_bonus_installment
		  (affiliate_id, rank_id, installment_no, amount_usd, due_at)
		VALUES ($1, 1, 1, 25.00, now())
	`, rootID); err != nil {
		t.Fatalf("seed rank_bonus_installment: %v", err)
	}

	// ── exercise ─────────────────────────────────────────────────────────────
	store := NewStore(pool)
	m, rx, err := store.BuildNetworkMetrics(ctx)
	if err != nil {
		t.Fatalf("BuildNetworkMetrics: %v", err)
	}

	// ── assert ───────────────────────────────────────────────────────────────
	if m.TotalMembers < 1 {
		t.Fatalf("TotalMembers=%d, want >= 1", m.TotalMembers)
	}
	// Exact counts from the fixture above.
	if m.ActiveMembers != 2 {
		t.Fatalf("ActiveMembers = %d, want 2", m.ActiveMembers)
	}
	if rx.PendingInstallments != 1 {
		t.Fatalf("PendingInstallments = %d, want 1", rx.PendingInstallments)
	}
	// Left leg is the strong leg (100 > 40); LeftVolume must be larger.
	if m.LeftVolume < m.RightVolume {
		t.Fatalf("expected LeftVolume(%.2f) >= RightVolume(%.2f): weak leg should be right", m.LeftVolume, m.RightVolume)
	}
	if rx.LiabilityUSD.IsZero() {
		t.Fatalf("LiabilityUSD should be non-zero (seeded $25 installment)")
	}
	t.Logf("metrics: total=%d active=%d left=%.0f right=%.0f fund=%.2f projected=%.2f theta=%.4f",
		m.TotalMembers, m.ActiveMembers, m.LeftVolume, m.RightVolume,
		m.CompanyFund, m.ProjectedOutflows, m.WorstTheta)
	t.Logf("rank exposure: pending=%d liability=%s ratio=%.4f",
		rx.PendingInstallments, rx.LiabilityUSD.String(), rx.ExposureRatio)
}
