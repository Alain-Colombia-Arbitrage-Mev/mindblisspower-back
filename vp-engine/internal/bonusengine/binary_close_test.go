package bonusengine

import (
	"context"
	"testing"
	"time"
)

// TestCloseBinaryPeriod_Empty: período sin eventos ni inflows → snapshot vacío,
// theta=1, total_paid=0, status=closed. Cubre el caso base (idempotencia trivial).
func TestCloseBinaryPeriod_Empty(t *testing.T) {
	if testing.Short() {
		t.Skip("requires docker / testcontainers")
	}
	ctx := context.Background()
	pool, cleanup := pgContainer(t)
	defer cleanup()

	seedMinimalTree(t, ctx, pool)

	// Crear un período abierto.
	now := time.Now().UTC()
	var pid int64
	err := pool.QueryRow(ctx, `
		INSERT INTO mlm.binary_period (plan_config_id, period_start, period_end, status)
		SELECT id, $1, $2, 'open' FROM mlm.plan_config WHERE version_label='v1-test'
		RETURNING id`, now.Add(-7*24*time.Hour), now).Scan(&pid)
	if err != nil {
		t.Fatalf("create period: %v", err)
	}

	eng := newTestEngine(pool)
	if err := eng.CloseBinaryPeriod(ctx, pid); err != nil {
		t.Fatalf("close: %v", err)
	}

	var status string
	var totalPaid float64
	if err := pool.QueryRow(ctx,
		"SELECT status, COALESCE(total_paid,0) FROM mlm.binary_period WHERE id=$1",
		pid).Scan(&status, &totalPaid); err != nil {
		t.Fatalf("verify: %v", err)
	}
	if status != "closed" {
		t.Fatalf("expected status=closed, got %s", status)
	}
	if totalPaid != 0 {
		t.Fatalf("expected total_paid=0, got %f", totalPaid)
	}
}

// TestCloseBinaryPeriod_Idempotent: cerrar dos veces no duplica pagos.
func TestCloseBinaryPeriod_Idempotent(t *testing.T) {
	if testing.Short() {
		t.Skip("requires docker / testcontainers")
	}
	ctx := context.Background()
	pool, cleanup := pgContainer(t)
	defer cleanup()

	seedMinimalTree(t, ctx, pool)

	now := time.Now().UTC()
	var pid int64
	err := pool.QueryRow(ctx, `
		INSERT INTO mlm.binary_period (plan_config_id, period_start, period_end, status)
		SELECT id, $1, $2, 'open' FROM mlm.plan_config WHERE version_label='v1-test'
		RETURNING id`, now.Add(-7*24*time.Hour), now).Scan(&pid)
	if err != nil {
		t.Fatalf("period: %v", err)
	}

	eng := newTestEngine(pool)
	if err := eng.CloseBinaryPeriod(ctx, pid); err != nil {
		t.Fatalf("first close: %v", err)
	}
	// Segunda corrida sobre período cerrado: debe ser no-op silencioso.
	if err := eng.CloseBinaryPeriod(ctx, pid); err != nil {
		t.Fatalf("second close should be no-op: %v", err)
	}
	var n int
	if err := pool.QueryRow(ctx,
		"SELECT count(*) FROM mlm.binary_block_payment WHERE binary_period_id=$1",
		pid).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Fatalf("expected 0 payments (no events), got %d", n)
	}
}

// TestInvariants_AllOK_OnFreshDB: con DB recién creada (sin eventos),
// las 4 invariantes deben estar en OK.
func TestInvariants_AllOK_OnFreshDB(t *testing.T) {
	if testing.Short() {
		t.Skip("requires docker / testcontainers")
	}
	ctx := context.Background()
	pool, cleanup := pgContainer(t)
	defer cleanup()
	seedMinimalTree(t, ctx, pool)

	rows, err := pool.Query(ctx, "SELECT invariant, status FROM mlm.fn_check_payout_invariants()")
	if err != nil {
		t.Fatalf("query invariants: %v", err)
	}
	defer rows.Close()

	count := 0
	for rows.Next() {
		var name, status string
		if err := rows.Scan(&name, &status); err != nil {
			t.Fatal(err)
		}
		if status != "OK" {
			t.Errorf("invariant %s = %s (expected OK)", name, status)
		}
		count++
	}
	if count != 4 {
		t.Fatalf("expected 4 invariants, got %d", count)
	}
}
