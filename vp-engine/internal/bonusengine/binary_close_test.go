package bonusengine

import (
	"context"
	"testing"
	"time"

	"github.com/shopspring/decimal"
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

func TestCloseBinaryPeriod_RoutesBannedBranchPayoutToCompany(t *testing.T) {
	if testing.Short() {
		t.Skip("requires docker / testcontainers")
	}
	ctx := context.Background()
	pool, cleanup := pgContainer(t)
	defer cleanup()

	root, leftID, rightID := seedMinimalTree(t, ctx, pool)

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.affiliate_package (affiliate_id, package_id, status, activated_at)
		VALUES ($1, 1, 'active', now())`, root); err != nil {
		t.Fatalf("root package: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE mlm.person p
		   SET blacklisted = true
		  FROM mlm.affiliate a
		 WHERE a.id = $1
		   AND p.id = a.person_id`, root); err != nil {
		t.Fatalf("blacklist root branch: %v", err)
	}

	companyPersonID := int64(99)
	companyAffiliateID := int64(999)
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		OVERRIDING SYSTEM VALUE
		VALUES ($1, 'Company', 'Root', 'company-root@t.local', '0', 'active');
		INSERT INTO mlm.affiliate (id, person_id, parent_id, position, status, current_rank_id, path, depth)
		OVERRIDING SYSTEM VALUE
		VALUES ($2, $1, NULL, NULL, 'active', 1, '999'::ltree, 0);
		INSERT INTO mlm.wallet (affiliate_id, asset_id, address, balance)
		VALUES ($2, 1, 'company-usd', 0)`,
		companyPersonID, companyAffiliateID); err != nil {
		t.Fatalf("company root: %v", err)
	}

	now := time.Now().UTC()
	pStart := now.Add(-7 * 24 * time.Hour)
	var pid int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.binary_period (plan_config_id, period_start, period_end, status)
		SELECT id, $1, $2, 'open' FROM mlm.plan_config WHERE version_label='v1-test'
		RETURNING id`, pStart, now).Scan(&pid); err != nil {
		t.Fatalf("period: %v", err)
	}
	inWindow := now.Add(-1 * time.Hour)

	for _, src := range []int64{leftID, rightID} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO mlm.tree_event (external_ref, kind, affiliate_id,
			  pv_delta_left, pv_delta_right, occurred_at)
			VALUES ($1, 'pv_credit', $2, 500, 0, $3)`,
			"test:pv:route:"+decimal.NewFromInt(src).String(), src, inWindow); err != nil {
			t.Fatalf("tree_event src=%d: %v", src, err)
		}
	}

	eng := newTestEngine(pool)
	eng.companyRootAffiliateID = companyAffiliateID
	if err := eng.CloseBinaryPeriod(ctx, pid); err != nil {
		t.Fatalf("close: %v", err)
	}

	sum := func(affID int64) decimal.Decimal {
		var v decimal.Decimal
		if err := pool.QueryRow(ctx, `
			SELECT COALESCE(sum(wm.amount), 0)
			  FROM mlm.wallet_movement wm
			  JOIN mlm.concept c ON c.id = wm.concept_id
			 WHERE c.kind = 'binary_bonus'
			   AND wm.affiliate_id = $1`, affID).Scan(&v); err != nil {
			t.Fatalf("sum aff=%d: %v", affID, err)
		}
		return v
	}
	if got := sum(root); !got.IsZero() {
		t.Fatalf("banned original affiliate must not receive binary payout, got %s", got)
	}
	if got := sum(companyAffiliateID); !got.Equal(decimal.RequireFromString("50.00")) {
		t.Fatalf("company must receive redirected binary payout, got %s", got)
	}

	var paidRoot decimal.Decimal
	if err := pool.QueryRow(ctx, `
		SELECT paid_total
		  FROM mlm.package_cap_state pcs
		  JOIN mlm.affiliate_package ap ON ap.id = pcs.affiliate_package_id
		 WHERE ap.affiliate_id = $1`, root).Scan(&paidRoot); err != nil {
		t.Fatalf("root cap state: %v", err)
	}
	if !paidRoot.Equal(decimal.RequireFromString("50.00")) {
		t.Fatalf("original package cap must be consumed by redirected payout, got %s", paidRoot)
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
