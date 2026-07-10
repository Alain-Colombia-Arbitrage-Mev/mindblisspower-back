package payments

import (
	"context"
	"testing"
)

// TestRunSustainabilityScenarios runs the Monte Carlo sustainability runner
// against a live Postgres container.  Requires Docker; skipped under -short.
//
// Fixture: seeds a minimal plan_config (v2-test-sustainability) so that
// LoadActivePlanConfig returns real data.  The test validates that both the
// "modesto" and "estres" scenarios return coherent summaries (Periods > 0,
// 0 ≤ WorstTheta ≤ 1, correct names).
func TestRunSustainabilityScenarios(t *testing.T) {
	if testing.Short() {
		t.Skip("needs DB (Docker); skipped under -short")
	}

	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	// ── seed a minimal plan_config so LoadActivePlanConfig finds one ─────────
	//
	// We insert directly, bypassing the approval trigger, because the test
	// container has no approval_request table pre-populated and no admin person.
	// We need a valid created_by_person_id, so we create a throwaway admin person
	// first and set the bypass GUC.
	var adminID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.person (first_name, last_name, email, phone_number, status, is_admin)
		VALUES ('Test', 'Admin', 'admin@sustainability.local', '0', 'active', true)
		RETURNING id
	`).Scan(&adminID); err != nil {
		t.Fatalf("seed admin person: %v", err)
	}

	// The plan_config insert requires bypass_approval GUC. We need a real
	// transaction so that SET LOCAL persists within the same session for the INSERT.
	txSeed, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin seed tx: %v", err)
	}
	defer txSeed.Rollback(ctx) //nolint:errcheck

	if _, err := txSeed.Exec(ctx, `SET LOCAL app.bypass_approval = 'on'`); err != nil {
		t.Fatalf("bypass approval: %v", err)
	}

	if _, err := txSeed.Exec(ctx, `
		INSERT INTO mlm.plan_config (
			version_label, effective_from,
			block_size, bonus_per_block, depth_cap,
			daily_cap_factor, lifetime_cap_factor, treasury_alpha,
			carry_decay_days, qualified_directs_left, qualified_directs_right,
			period_cap_factor,
			depth_repurchase_enabled, repurchase_threshold, purchase_stale_periods,
			pause_mode, pause_reduction_factor, paused_carry_decay_periods,
			renewal_cost_factor,
			yield_enabled, yield_annual_rate, yield_cadence_periods,
			capital_lock_periods,
			points_enabled, points_per_block, points_dollars_per_point, points_cadence_periods,
			ranks_enabled, rank_installments, rank_installment_cadence,
			royalty_enabled, royalty_rate, royalty_generation, referral_rate,
			founder_enrollment_open, founder_referral_rate, founder_binary_matched_rate,
			cd_lock_days, cd_qualified_directs, cd_same_tier_required,
			directs_active_required, retirement_age, retirement_early_penalty,
			created_by_person_id, notes
		) VALUES (
			'v2-test-sustainability', now(),
			500, 10.00, 10,
			3.0, 2.0, 0.45,
			14, 1, 1,
			0.50,
			true, 10, 4,
			'reduce', 0.50, 4,
			0.10,
			true, 0.25, 4,
			52,
			true, 1.00, 1.00, 4,
			true, 4, 4,
			true, 0.05, 2, 0,
			true, 0.10, 0.10,
			365, 2, true,
			true, 65, 0.10,
			$1, 'test sustainability fixture'
		)
	`, adminID); err != nil {
		t.Fatalf("seed plan_config: %v", err)
	}
	if err := txSeed.Commit(ctx); err != nil {
		t.Fatalf("commit seed tx: %v", err)
	}

	// ── exercise ──────────────────────────────────────────────────────────────
	store := NewStore(pool)
	res, err := store.RunSustainabilityScenarios(ctx)
	if err != nil {
		t.Fatal(err)
	}

	// ── assert ────────────────────────────────────────────────────────────────
	if len(res) != 2 {
		t.Fatalf("esperaba modesto+estres, got %d", len(res))
	}
	for _, r := range res {
		if r.Periods <= 0 || r.WorstTheta < 0 || r.WorstTheta > 1 {
			t.Fatalf("%s incoherente: %+v", r.Name, r)
		}
		if r.Name != "modesto" && r.Name != "estres" {
			t.Fatalf("nombre inesperado: %q (esperado modesto|estres)", r.Name)
		}
	}
	if res[0].Name != "modesto" {
		t.Fatalf("primer resultado debe ser modesto, got %q", res[0].Name)
	}
	if res[1].Name != "estres" {
		t.Fatalf("segundo resultado debe ser estres, got %q", res[1].Name)
	}

	for _, r := range res {
		t.Logf("scenario=%s periods=%d solvent=%v worst_theta=%.4f margin=%.4f streams=%v",
			r.Name, r.Periods, r.Solvent, r.WorstTheta, r.Margin, r.Streams)
	}
}
