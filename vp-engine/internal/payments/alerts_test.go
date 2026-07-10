package payments

// alerts_test.go — Integration tests for EvaluateAlerts against a live Postgres
// container (testcontainers, Docker pg17).
//
// Run with:
//
//	go test ./internal/payments/ -run TestEvaluateAlerts -v -count=1
//
// Skip when Docker is not available:
//
//	go test ./internal/payments/ -short
//
// Test scenarios:
//   1. Breach creates exactly one open alert with correct signal/severity/metric.
//   2. Idempotency: calling EvaluateAlerts twice with the same breach does NOT
//      create a duplicate open alert; count stays 1.
//   3. Auto-resolve: after the breach clears, the open alert flips to 'resolved'.
//   4. Acknowledged alerts: an acknowledged alert is left alone while the signal
//      still breaches; no new open duplicate is inserted.

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// alertMigrationSQL is the DDL from 20_alert_event.sql, inlined so we don't
// need to modify the shared testhelpers to include it.
const alertMigrationSQL = `
SET search_path = mlm, public;

CREATE TABLE IF NOT EXISTS mlm.alert_event (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  signal          text   NOT NULL,
  severity        text   NOT NULL CHECK (severity IN ('info','warning','critical')),
  metric_value    numeric(20,4),
  threshold       numeric(20,4),
  detail          text   NOT NULL,
  payload         jsonb  NOT NULL DEFAULT '{}'::jsonb,
  status          text   NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  acknowledged_by bigint REFERENCES mlm.person(id),
  acknowledged_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS alert_event_open_signal_idx
  ON mlm.alert_event(signal) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS alert_event_status_idx
  ON mlm.alert_event(status, created_at DESC);
`

// setupAlertContainer starts a Postgres container with all required schemas
// plus mlm.alert_event, then returns a Store and cleanup func.
func setupAlertContainer(t *testing.T) (*Store, func()) {
	t.Helper()
	if testing.Short() {
		t.Skip("needs Docker; skipped under -short")
	}

	pool, cleanupPool := pgContainer(t)

	// Apply alert_event DDL on top of the existing schema.
	ctx := context.Background()
	root := findRepoRoot(t)
	alertSQL, err := os.ReadFile(filepath.Join(root, "_meta", "migration", "20_alert_event.sql"))
	if err != nil {
		// File not found — use the inlined constant (same content).
		alertSQL = []byte(alertMigrationSQL)
	}
	if err := applySchema(ctx, pool, stripPsqlMeta(string(alertSQL))); err != nil {
		cleanupPool()
		t.Fatalf("apply 20_alert_event.sql: %v", err)
	}

	store := NewStore(pool)
	cleanup := func() { cleanupPool() }
	return store, cleanup
}

// ensurePlanConfig inserts a minimal plan_config (and the prerequisite person)
// if none exists. Returns the plan_config id. Uses the same INSERT pattern as
// bonusengine/testhelpers_test.go (bypass_approval session variable).
func ensurePlanConfig(t *testing.T, pool *pgxpool.Pool) int64 {
	t.Helper()
	ctx := context.Background()

	// A plan_config needs created_by_person_id. Insert a minimal admin person.
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		OVERRIDING SYSTEM VALUE
		VALUES (1, 'Admin', 'Test', 'admin@t.local', '0000000000', 'active')
		ON CONFLICT DO NOTHING
	`); err != nil {
		t.Fatalf("ensurePlanConfig person: %v", err)
	}

	var pcID int64
	// Try to get an existing one first.
	_ = pool.QueryRow(ctx, `SELECT id FROM mlm.plan_config ORDER BY effective_from DESC LIMIT 1`).Scan(&pcID)
	if pcID > 0 {
		return pcID
	}

	// Insert fresh — must bypass the approval trigger (same pattern as bonusengine tests).
	if _, err := pool.Exec(ctx, `
		BEGIN;
		SET LOCAL app.bypass_approval = 'on';
		INSERT INTO mlm.plan_config (
		  version_label, effective_from,
		  block_size, bonus_per_block, depth_cap,
		  daily_cap_factor, lifetime_cap_factor, treasury_alpha, carry_decay_days,
		  qualified_directs_left, qualified_directs_right, created_by_person_id)
		VALUES ('v1-alerttest', now() - interval '1 year',
		  100, 10.00, 10,
		  3.0, 2.0, 0.45, 14,
		  0, 0, 1);
		COMMIT;
	`); err != nil {
		t.Fatalf("ensurePlanConfig insert: %v", err)
	}

	if err := pool.QueryRow(ctx,
		`SELECT id FROM mlm.plan_config WHERE version_label = 'v1-alerttest'`,
	).Scan(&pcID); err != nil {
		t.Fatalf("ensurePlanConfig retrieve id: %v", err)
	}
	return pcID
}

// seedLowTheta seeds a closed binary period with the given theta value so that
// GetSolvency returns it in Recent[]. Used to trigger the theta signal.
//
// The v_period_solvency view reads mlm.binary_period + mlm.plan_config, so we
// need both. We insert a minimal plan_config (if not already present) and a
// closed period with the given theta.
func seedLowTheta(t *testing.T, pool *pgxpool.Pool, theta float64) {
	t.Helper()
	ctx := context.Background()

	pcID := ensurePlanConfig(t, pool)

	// Insert a closed period with the desired theta.
	// closed_at is required by period_closed_has_data CHECK constraint.
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.binary_period
		  (period_start, period_end, status, plan_config_id,
		   inflows_total, projected_outflows, theta, total_paid, closed_at)
		VALUES (
		  now() - interval '14 days',
		  now() - interval '7 days',
		  'closed',
		  $1,
		  1000.00,
		  1000.00 * $2,
		  $2,
		  1000.00 * $2,
		  now()
		)
		ON CONFLICT (period_start, period_end) DO UPDATE
		  SET theta = EXCLUDED.theta,
		      total_paid = EXCLUDED.total_paid,
		      projected_outflows = EXCLUDED.projected_outflows
	`, pcID, theta); err != nil {
		t.Fatalf("seed binary_period theta=%.4f: %v", theta, err)
	}
}

// countAlertsBySignalStatus returns (count, severity, status) for the most recent
// alert_event row matching signal, ordered by created_at DESC.
func queryLatestAlert(t *testing.T, pool *pgxpool.Pool, signal string) (count int, severity, status string) {
	t.Helper()
	ctx := context.Background()
	if err := pool.QueryRow(ctx, `
		SELECT count(*), COALESCE(max(severity),''), COALESCE(max(status),'')
		  FROM mlm.alert_event
		 WHERE signal = $1
	`, signal).Scan(&count, &severity, &status); err != nil {
		t.Fatalf("query alert %s: %v", signal, err)
	}
	return
}

func countOpenAlerts(t *testing.T, pool *pgxpool.Pool, signal string) int {
	t.Helper()
	ctx := context.Background()
	var n int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM mlm.alert_event WHERE signal = $1 AND status = 'open'
	`, signal).Scan(&n); err != nil {
		t.Fatalf("countOpenAlerts %s: %v", signal, err)
	}
	return n
}

// ── Test 1: Breach creates one open alert with correct signal/severity ────────

func TestEvaluateAlerts_ThetaBreach_CreatesAlert(t *testing.T) {
	store, cleanup := setupAlertContainer(t)
	defer cleanup()

	pool := store.db
	ctx := context.Background()

	// Seed theta below critical threshold (0.60).
	seedLowTheta(t, pool, 0.45)

	openCount, err := store.EvaluateAlerts(ctx)
	if err != nil {
		t.Fatalf("EvaluateAlerts: %v", err)
	}

	// Must have at least 1 open alert (theta is always breached with theta=0.45).
	if openCount < 1 {
		t.Fatalf("expected at least 1 open alert, got %d", openCount)
	}

	// Verify the theta alert specifically.
	n := countOpenAlerts(t, pool, signalTheta)
	if n != 1 {
		t.Fatalf("expected exactly 1 open theta alert, got %d", n)
	}

	// Verify severity = critical (0.45 < thetaCritical=0.60).
	var sev string
	if err := pool.QueryRow(ctx,
		`SELECT severity FROM mlm.alert_event WHERE signal = $1 AND status = 'open'`,
		signalTheta,
	).Scan(&sev); err != nil {
		t.Fatalf("query theta alert severity: %v", err)
	}
	if sev != severityCritical {
		t.Fatalf("theta alert severity = %q, want %q (theta=0.45 < critical threshold %.2f)",
			sev, severityCritical, thetaCritical)
	}

	t.Logf("OK: theta breach (theta=0.45) → 1 open critical alert; total open=%d", openCount)
}

// ── Test 2: Idempotency — same breach twice → still 1 open alert ─────────────

func TestEvaluateAlerts_Idempotency(t *testing.T) {
	store, cleanup := setupAlertContainer(t)
	defer cleanup()

	pool := store.db
	ctx := context.Background()

	// Seed theta well below warning threshold.
	seedLowTheta(t, pool, 0.55) // 0.55 < 0.60 critical

	// First run.
	if _, err := store.EvaluateAlerts(ctx); err != nil {
		t.Fatalf("EvaluateAlerts run 1: %v", err)
	}
	n1 := countOpenAlerts(t, pool, signalTheta)
	if n1 != 1 {
		t.Fatalf("after run 1: expected 1 open theta alert, got %d", n1)
	}

	// Second run with same metrics — must not duplicate.
	if _, err := store.EvaluateAlerts(ctx); err != nil {
		t.Fatalf("EvaluateAlerts run 2: %v", err)
	}
	n2 := countOpenAlerts(t, pool, signalTheta)
	if n2 != 1 {
		t.Fatalf("after run 2: expected still 1 open theta alert (idempotency), got %d", n2)
	}

	// Also verify total theta rows (should still be 1, not 2).
	total, _, _ := queryLatestAlert(t, pool, signalTheta)
	if total != 1 {
		t.Fatalf("total theta alert_event rows = %d, want 1 (idempotency violation)", total)
	}

	t.Logf("OK: two runs with same breach → exactly 1 open theta alert (idempotent)")
}

// ── Test 3: Auto-resolve — breach clears → alert flips to 'resolved' ─────────

func TestEvaluateAlerts_AutoResolve(t *testing.T) {
	store, cleanup := setupAlertContainer(t)
	defer cleanup()

	pool := store.db
	ctx := context.Background()

	// Phase 1: seed a critical theta breach and run evaluator.
	seedLowTheta(t, pool, 0.45)

	if _, err := store.EvaluateAlerts(ctx); err != nil {
		t.Fatalf("EvaluateAlerts (breach phase): %v", err)
	}
	if n := countOpenAlerts(t, pool, signalTheta); n != 1 {
		t.Fatalf("breach phase: expected 1 open theta alert, got %d", n)
	}

	// Phase 2: delete the breaching period so theta defaults to 1.0 (no history
	// in Recent → WorstTheta stays 1.0, no breach). Then re-evaluate.
	if _, err := pool.Exec(ctx,
		`DELETE FROM mlm.binary_period WHERE status = 'closed'`,
	); err != nil {
		t.Fatalf("delete periods: %v", err)
	}
	// Invalidate solvency cache (the Store uses a Cache object; in tests it's nil
	// so no Redis, GetSolvency always queries DB).

	if _, err := store.EvaluateAlerts(ctx); err != nil {
		t.Fatalf("EvaluateAlerts (resolve phase): %v", err)
	}

	// The open alert should now be resolved.
	if n := countOpenAlerts(t, pool, signalTheta); n != 0 {
		t.Fatalf("resolve phase: expected 0 open theta alerts after clear, got %d", n)
	}

	// The row should exist as 'resolved'.
	var status string
	if err := pool.QueryRow(ctx,
		`SELECT status FROM mlm.alert_event WHERE signal = $1 ORDER BY updated_at DESC LIMIT 1`,
		signalTheta,
	).Scan(&status); err != nil {
		t.Fatalf("query theta alert status after resolve: %v", err)
	}
	if status != "resolved" {
		t.Fatalf("expected status='resolved' after clear, got %q", status)
	}

	t.Logf("OK: breach cleared → theta alert auto-resolved")
}

// ── Test 4: Acknowledged alert is left alone while signal still breaches ──────

func TestEvaluateAlerts_AcknowledgedNotDuplicated(t *testing.T) {
	store, cleanup := setupAlertContainer(t)
	defer cleanup()

	pool := store.db
	ctx := context.Background()

	// Phase 1: create an open alert via breach.
	seedLowTheta(t, pool, 0.50) // 0.50 < critical 0.60

	if _, err := store.EvaluateAlerts(ctx); err != nil {
		t.Fatalf("EvaluateAlerts (breach): %v", err)
	}
	if n := countOpenAlerts(t, pool, signalTheta); n != 1 {
		t.Fatalf("expected 1 open alert, got %d", n)
	}

	// Phase 2: admin acknowledges the alert (simulates POST /alerts/{id}/ack).
	if _, err := pool.Exec(ctx,
		`UPDATE mlm.alert_event
		    SET status = 'acknowledged', acknowledged_at = now(), updated_at = now()
		  WHERE signal = $1 AND status = 'open'`,
		signalTheta,
	); err != nil {
		t.Fatalf("ack alert: %v", err)
	}

	// Verify: 0 open, 1 acknowledged.
	if n := countOpenAlerts(t, pool, signalTheta); n != 0 {
		t.Fatalf("after ack: expected 0 open alerts, got %d", n)
	}

	// Phase 3: re-evaluate with the same breach still present.
	// The evaluator must NOT insert a new open row (operator is already aware).
	if _, err := store.EvaluateAlerts(ctx); err != nil {
		t.Fatalf("EvaluateAlerts (post-ack): %v", err)
	}

	// Still 0 open alerts for theta.
	if n := countOpenAlerts(t, pool, signalTheta); n != 0 {
		t.Fatalf("post-ack: expected 0 new open alerts (acknowledged row left alone), got %d", n)
	}

	// Total rows for theta = 1 (no new insert).
	total, _, _ := queryLatestAlert(t, pool, signalTheta)
	if total != 1 {
		t.Fatalf("post-ack: total theta rows = %d, want 1 (no new insert expected)", total)
	}

	t.Logf("OK: acknowledged alert left intact while signal still breaches — no new open duplicate")
}

// ── Test 5: Leg skew signal ───────────────────────────────────────────────────

func TestEvaluateAlerts_LegSkewBreach(t *testing.T) {
	store, cleanup := setupAlertContainer(t)
	defer cleanup()

	pool := store.db
	ctx := context.Background()

	// Seed a heavily skewed tree: root affiliate with 95% of volume on one side.
	// left_pv_lifetime=950, right_pv_lifetime=50 → left = 95%, right = 5%
	// skew = max(950,50)/(950+50) = 0.95 > legSkewCritical (0.92).
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		OVERRIDING SYSTEM VALUE VALUES
		  (20, 'Test', 'Left', 'testleft@t.local', '0', 'active')
		ON CONFLICT DO NOTHING;

		INSERT INTO mlm.affiliate
		  (person_id, parent_id, position, status, path, depth,
		   left_count, right_count, left_pv_lifetime, right_pv_lifetime)
		VALUES
		  (20, NULL, NULL, 'active', ''::ltree, 0, 95, 5, 950, 50)
		ON CONFLICT DO NOTHING;
	`); err != nil {
		t.Fatalf("seed skewed tree: %v", err)
	}

	if _, err := store.EvaluateAlerts(ctx); err != nil {
		t.Fatalf("EvaluateAlerts: %v", err)
	}

	// Leg skew should be open+critical.
	n := countOpenAlerts(t, pool, signalLegSkew)
	if n != 1 {
		t.Fatalf("expected 1 open leg_skew alert, got %d", n)
	}
	var sev string
	if err := pool.QueryRow(ctx,
		`SELECT severity FROM mlm.alert_event WHERE signal = $1 AND status = 'open'`,
		signalLegSkew,
	).Scan(&sev); err != nil {
		t.Fatalf("query leg_skew severity: %v", err)
	}
	if sev != severityCritical {
		t.Fatalf("leg_skew severity = %q, want %q (skew=0.95 > critical=0.92)", sev, severityCritical)
	}
	t.Logf("OK: leg_skew 0.95 > critical (0.92) → 1 open critical alert")
}

// ── Test 6: Rank avalanche signal ─────────────────────────────────────────────

func TestEvaluateAlerts_RankAvalancheBreach(t *testing.T) {
	store, cleanup := setupAlertContainer(t)
	defer cleanup()

	pool := store.db
	ctx := context.Background()

	// Seed: large inflows so the exposure ratio is high.
	// We need: purchase_intent paid rows + affiliate_rank_achieved + unpaid installments.
	// inflows = 200, rank liability = 160 → ratio = 0.80 > critical (0.75).

	// Insert person + affiliate.
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		OVERRIDING SYSTEM VALUE VALUES (30, 'Rank', 'Test', 'rank@t.local', '0', 'active')
		ON CONFLICT DO NOTHING;
	`); err != nil {
		t.Fatalf("seed person: %v", err)
	}
	var affID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.affiliate
		  (person_id, parent_id, position, status, path, depth,
		   left_count, right_count, left_pv_lifetime, right_pv_lifetime)
		VALUES (30, NULL, NULL, 'active', ''::ltree, 0, 0, 0, 0, 0)
		RETURNING id
	`).Scan(&affID); err != nil {
		t.Fatalf("seed affiliate: %v", err)
	}

	// Insert a package and purchase_intent with $200 inflows.
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.package (id, name, amount_usd, pv, type, is_active)
		VALUES (99, 'Test Pack', 200.00, 200, 'enrollment', true)
		ON CONFLICT (id) DO NOTHING;
	`); err != nil {
		t.Fatalf("seed package: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO payments.purchase_intent
		  (user_id, person_id, package_id, pv, amount_usd, fee_usd, total_cents, currency, status)
		VALUES ('u_rank_test', 30, 99, 200, 200.00, 2.00, 20200, 'usd', 'paid')
	`); err != nil {
		t.Fatalf("seed purchase_intent: %v", err)
	}

	// Insert rank_achieved (FK required by rank_bonus_installment).
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.affiliate_rank_achieved
		  (affiliate_id, rank_id, achieved_at, source, bonus_amount_usd, net_amount_usd)
		VALUES ($1, 1, now(), 'earned', 160.00, 160.00)
	`, affID); err != nil {
		t.Fatalf("seed rank_achieved: %v", err)
	}

	// Insert 160 in unpaid installments.
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.rank_bonus_installment
		  (affiliate_id, rank_id, installment_no, amount_usd, due_at)
		VALUES ($1, 1, 1, 160.00, now())
	`, affID); err != nil {
		t.Fatalf("seed installment: %v", err)
	}

	if _, err := store.EvaluateAlerts(ctx); err != nil {
		t.Fatalf("EvaluateAlerts: %v", err)
	}

	n := countOpenAlerts(t, pool, signalRankAvalanche)
	if n != 1 {
		t.Fatalf("expected 1 open rank_avalanche alert, got %d", n)
	}
	var sev string
	if err := pool.QueryRow(ctx,
		`SELECT severity FROM mlm.alert_event WHERE signal = $1 AND status = 'open'`,
		signalRankAvalanche,
	).Scan(&sev); err != nil {
		t.Fatalf("query rank_avalanche severity: %v", err)
	}
	if sev != severityCritical {
		t.Fatalf("rank_avalanche severity = %q, want %q (ratio=0.80 > critical=0.75)",
			sev, severityCritical)
	}
	t.Logf("OK: rank_avalanche exposure=0.80 > critical (0.75) → 1 open critical alert")
}
