package bonusengine

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
)

// seedV2Tree arma el árbol del caso E2E v2:
//
//	root ── A (L, sponsor root) ── B (L, sponsor A, FUNDADOR, pack $1000)
//	                                ├─ C (L, sponsor B, pack $1000)
//	                                └─ D (R, sponsor B, pack $1000)
//
// Devuelve los ids (root, A, B, C, D).
func seedV2Tree(t *testing.T, ctx context.Context, pool *pgxpool.Pool) (root, aID, bID, cID, dID int64) {
	t.Helper()

	// Catalogs mínimos. Los conceptos v2 (1001-1012) ya vienen del schema
	// v1.2/v1.3; el binario (kind=binary_bonus) hay que sembrarlo.
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.country (id, iso2, name_es, name_en) VALUES (1, 'CO', 'Colombia', 'Colombia');
		INSERT INTO mlm.asset (id, symbol, name, is_fiat, decimals) VALUES (1, 'USD', 'US Dollar', true, 2);
		INSERT INTO mlm.concept (id, kind, name_es, name_en, factor, requires_pair, active) VALUES
		  (11, 'binary_bonus', 'Bono binario', 'Binary bonus', 1, false, true);
		INSERT INTO mlm.package (id, name, amount_usd, pv, type) VALUES
		  (1, 'Pack 1000', 1000, 1000, 'enrollment');
	`); err != nil {
		t.Fatalf("catalogs: %v", err)
	}

	for i := 1; i <= 5; i++ {
		if _, err := pool.Exec(ctx, `
			INSERT INTO mlm.person (first_name, last_name, email, phone_number, status)
			VALUES ($1, 'test', $2, '0', 'active')`,
			fmt.Sprintf("p%d", i), fmt.Sprintf("p%d@t.local", i)); err != nil {
			t.Fatalf("person %d: %v", i, err)
		}
	}

	mustAff := func(person int, parent *int64, pos, path string, depth int, sponsor *int64, founder bool) int64 {
		var id int64
		if err := pool.QueryRow(ctx, `
			INSERT INTO mlm.affiliate
			  (person_id, parent_id, position, sponsor_id, status, path, depth, is_founder)
			VALUES ($1, $2, NULLIF($3,'')::mlm.tree_position, $4, 'active', $5::ltree, $6, $7)
			RETURNING id`,
			person, parent, pos, sponsor, path, depth, founder).Scan(&id); err != nil {
			t.Fatalf("affiliate p%d: %v", person, err)
		}
		return id
	}

	root = mustAff(1, nil, "", "1", 0, nil, false)
	aID = mustAff(2, &root, "L", "1.L_2", 1, &root, false)
	bID = mustAff(3, &aID, "L", "1.L_2.L_3", 2, &aID, true) // FUNDADOR
	cID = mustAff(4, &bID, "L", "1.L_2.L_3.L_4", 3, &bID, false)
	dID = mustAff(5, &bID, "R", "1.L_2.L_3.R_5", 3, &bID, false)

	// Wallets USD para todos.
	for _, id := range []int64{root, aID, bID, cID, dID} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO mlm.wallet (affiliate_id, asset_id, address, balance)
			VALUES ($1, 1, $2, 0)`, id, fmt.Sprintf("w-%d", id)); err != nil {
			t.Fatalf("wallet %d: %v", id, err)
		}
	}

	// Paquetes activos para B (cobra binario/rangos/yield) y C/D (gate de
	// directos activos + compradores).
	for _, id := range []int64{bID, cID, dID} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO mlm.affiliate_package (affiliate_id, package_id, status, activated_at)
			VALUES ($1, 1, 'active', now())`, id); err != nil {
			t.Fatalf("package aff=%d: %v", id, err)
		}
	}

	// Plan v2: todos los streams activos, cadencias en 1 para que disparen
	// en el primer cierre. R1 apagado (su gate se prueba aparte).
	if _, err := pool.Exec(ctx, `
		BEGIN;
		SET LOCAL app.bypass_approval = 'on';
		INSERT INTO mlm.plan_config (
		  version_label, effective_from, block_size, bonus_per_block, depth_cap,
		  daily_cap_factor, lifetime_cap_factor, treasury_alpha, carry_decay_days,
		  qualified_directs_left, qualified_directs_right, created_by_person_id,
		  period_cap_factor,
		  yield_enabled, yield_annual_rate, yield_cadence_periods,
		  points_enabled, points_per_block, points_dollars_per_point, points_cadence_periods,
		  ranks_enabled,
		  royalty_enabled, royalty_rate, royalty_generation,
		  referral_rate, founder_enrollment_open, founder_referral_rate,
		  founder_binary_matched_rate, directs_active_required)
		VALUES ('v2-test', now(), 100, 2.00, 10, 3.0, 2.0, 0.45, 14, 0, 0, 1,
		  0.5,
		  true, 0.25, 1,
		  true, 1.00, 1.00, 1,
		  true,
		  true, 0.05, 2,
		  0, true, 0.10,
		  0.10, false);
		COMMIT;`); err != nil {
		t.Fatalf("plan v2-test: %v", err)
	}

	return root, aID, bID, cID, dID
}

// TestCloseBinaryPeriod_V2Streams: cierre E2E con todos los streams v2.
//
// Esperado con θ=1 (inflows $2000, projected $370.83 < $900 = 45%×2000):
//
//	binario B (fundador) : 10% × 1000 matched = $100.00
//	rango B (Bronce)     : min(1000,1000) ≥ 1000 → $100.00 one-time
//	yield B (R2)         : 1000 × 0.25/12 = $20.83
//	referido B (gen-1)   : 10% fundador × compras de C y D... C y D son
//	                       directos de B → 10% × $2000 = $200.00... ver abajo
//	regalía A (gen-2)    : 5% × $2000 = $100.00
func TestCloseBinaryPeriod_V2Streams(t *testing.T) {
	if testing.Short() {
		t.Skip("requires docker / testcontainers")
	}
	ctx := context.Background()
	pool, cleanup := pgContainer(t)
	defer cleanup()

	_, aID, bID, cID, dID := seedV2Tree(t, ctx, pool)

	now := time.Now().UTC()
	pStart := now.Add(-7 * 24 * time.Hour)
	var pid int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.binary_period (plan_config_id, period_start, period_end, status)
		SELECT id, $1, $2, 'open' FROM mlm.plan_config WHERE version_label='v2-test'
		RETURNING id`, pStart, now).Scan(&pid); err != nil {
		t.Fatalf("period: %v", err)
	}

	inWindow := now.Add(-1 * time.Hour)

	// Compras de C y D ($1000 c/u) → inflows. Concepto 1004 (renovación,
	// kind=package_purchase, factor +1, seed v1.2).
	for i, buyer := range []int64{cID, dID} {
		var txnID string
		if err := pool.QueryRow(ctx, `
			INSERT INTO mlm.transaction (external_ref, description, status, posted_at)
			VALUES ($1, 'compra test', 'posted', $2) RETURNING id`,
			fmt.Sprintf("test:purchase:%d", i), inWindow).Scan(&txnID); err != nil {
			t.Fatalf("purchase txn: %v", err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO mlm.wallet_movement
			  (transaction_id, wallet_id, affiliate_id, concept_id, amount, posted_at)
			SELECT $1, w.id, $2, 1004, 1000, $3
			  FROM mlm.wallet w WHERE w.affiliate_id = $2`,
			txnID, buyer, inWindow); err != nil {
			t.Fatalf("purchase movement: %v", err)
		}
	}

	// Eventos PV: C y D acreditan 1000 a su línea (trigger actualiza
	// lifetimes: B queda 1000/1000; A 2000/0).
	for i, src := range []int64{cID, dID} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO mlm.tree_event (external_ref, kind, affiliate_id,
			  pv_delta_left, pv_delta_right, occurred_at)
			VALUES ($1, 'pv_credit', $2, 1000, 0, $3)`,
			fmt.Sprintf("test:pv:%d", i), src, inWindow); err != nil {
			t.Fatalf("tree_event: %v", err)
		}
	}

	eng := newTestEngine(pool)
	if err := eng.CloseBinaryPeriod(ctx, pid); err != nil {
		t.Fatalf("close: %v", err)
	}

	// θ debe ser 1 (projected << α × inflows).
	var theta, totalPaid decimal.Decimal
	if err := pool.QueryRow(ctx,
		"SELECT theta, total_paid FROM mlm.binary_period WHERE id=$1", pid).
		Scan(&theta, &totalPaid); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if !theta.Equal(decimal.NewFromInt(1)) {
		t.Fatalf("theta esperado 1, fue %s (total_paid=%s)", theta, totalPaid)
	}

	sumByConcept := func(kind string, affID int64) decimal.Decimal {
		var v decimal.Decimal
		if err := pool.QueryRow(ctx, `
			SELECT COALESCE(sum(wm.amount), 0)
			  FROM mlm.wallet_movement wm
			  JOIN mlm.concept c ON c.id = wm.concept_id
			 WHERE c.kind = $1 AND wm.affiliate_id = $2`, kind, affID).Scan(&v); err != nil {
			t.Fatalf("sum %s aff=%d: %v", kind, affID, err)
		}
		return v
	}

	// Binario fundador: 10% × 1000 matched = $100 (estándar habría sido 10
	// bloques × $2 = $20).
	if got := sumByConcept("binary_bonus", bID); !got.Equal(decimal.RequireFromString("100")) {
		t.Errorf("binario fundador B esperado $100, fue %s", got)
	}

	// Rango Bronce (1000 cada pierna) para B — Mitigación B: bono $100 en
	// 4 cuotas; en este cierre se paga sólo la primera ($25).
	if got := sumByConcept("rank_bonus", bID); !got.Equal(decimal.RequireFromString("25")) {
		t.Errorf("cuota 1 de Bronce B esperada $25, fue %s", got)
	}
	var achieved int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM mlm.affiliate_rank_achieved
		 WHERE affiliate_id = $1 AND source = 'earned'`, bID).Scan(&achieved); err != nil {
		t.Fatal(err)
	}
	if achieved != 1 {
		t.Errorf("B debía tener 1 hito earned (Bronce), tiene %d", achieved)
	}
	// Calendario: 4 cuotas de $25, exactamente 1 liquidada.
	var nInst, nPaid int
	if err := pool.QueryRow(ctx, `
		SELECT count(*), count(paid_at)
		  FROM mlm.rank_bonus_installment
		 WHERE affiliate_id = $1 AND rank_id = 1`, bID).Scan(&nInst, &nPaid); err != nil {
		t.Fatal(err)
	}
	if nInst != 4 || nPaid != 1 {
		t.Errorf("esperaba 4 cuotas / 1 pagada, hubo %d/%d", nInst, nPaid)
	}
	// current_rank_id sincronizado por trigger.
	var curRank *int16
	if err := pool.QueryRow(ctx,
		"SELECT current_rank_id FROM mlm.affiliate WHERE id=$1", bID).Scan(&curRank); err != nil {
		t.Fatal(err)
	}
	if curRank == nil || *curRank != 1 {
		t.Errorf("current_rank_id de B debía ser 1 (BRONZE), es %v", curRank)
	}

	// Yield R2 para B (gate: C activo en L, D activo en R): 1000×0.25/12.
	if got := sumByConcept("r2_yield", bID); !got.Equal(decimal.RequireFromString("20.83")) {
		t.Errorf("yield B esperado $20.83, fue %s", got)
	}

	// Referido fundador 10% de las compras de C y D → B.
	if got := sumByConcept("direct_bonus", bID); !got.Equal(decimal.RequireFromString("200")) {
		t.Errorf("referido B esperado $200, fue %s", got)
	}

	// Regalía gen-2 5% de las compras de C y D → A.
	if got := sumByConcept("royalty", aID); !got.Equal(decimal.RequireFromString("100")) {
		t.Errorf("regalía A esperada $100, fue %s", got)
	}

	// Puntos R3: acumulados post-cierre = 10 bloques × θ=1 × 1 pt.
	var pts decimal.Decimal
	if err := pool.QueryRow(ctx,
		"SELECT points_accrued FROM mlm.affiliate_payout_state WHERE affiliate_id=$1",
		bID).Scan(&pts); err != nil {
		t.Fatalf("payout_state: %v", err)
	}
	if !pts.Equal(decimal.RequireFromString("10")) {
		t.Errorf("points_accrued de B esperado 10, fue %s", pts)
	}

	// Liquidación: todo bono lleva available_at (= cierre de mes + 1m + 1d).
	var nullAvail int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM mlm.wallet_movement wm
		  JOIN mlm.concept c ON c.id = wm.concept_id
		 WHERE c.kind IN ('binary_bonus','r2_yield','rank_bonus','royalty','direct_bonus')
		   AND wm.available_at IS NULL`).Scan(&nullAvail); err != nil {
		t.Fatal(err)
	}
	if nullAvail != 0 {
		t.Errorf("%d movimientos de bono sin available_at (liquidación +1m+1d)", nullAvail)
	}

	// total_paid coherente: binario 100 + cuota rango 25 + yield 20.83
	// + referido 200 + regalía 100 = 445.83.
	if want := decimal.RequireFromString("445.83"); !totalPaid.Equal(want) {
		t.Errorf("total_paid esperado %s, fue %s", want, totalPaid)
	}

	// Invariantes T1-T4 en OK tras el cierre.
	rows, err := pool.Query(ctx, "SELECT invariant, status FROM mlm.fn_check_payout_invariants()")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var name, st string
		if err := rows.Scan(&name, &st); err != nil {
			t.Fatal(err)
		}
		if st != "OK" {
			t.Errorf("invariante %s = %s tras cierre v2", name, st)
		}
	}

	// Idempotencia: segundo cierre no duplica nada.
	if err := eng.CloseBinaryPeriod(ctx, pid); err != nil {
		t.Fatalf("re-close: %v", err)
	}
	if got := sumByConcept("rank_bonus", bID); !got.Equal(decimal.RequireFromString("25")) {
		t.Errorf("re-close duplicó la cuota de rango: %s", got)
	}
}

func TestCloseBinaryPeriod_BinaryRequiresSponsoredDirectsByLeg(t *testing.T) {
	if testing.Short() {
		t.Skip("requires docker / testcontainers")
	}
	ctx := context.Background()
	pool, cleanup := pgContainer(t)
	defer cleanup()

	_, aID, bID, cID, dID := seedV2Tree(t, ctx, pool)

	// C y D siguen siendo hijos binarios inmediatos de B, pero ya no son
	// patrocinados directos de B. Esto reproduce el spillover: estructura
	// binaria llena sin actividad comercial propia en ambas piernas.
	if _, err := pool.Exec(ctx,
		"UPDATE mlm.affiliate SET sponsor_id = $1 WHERE id IN ($2, $3)",
		aID, cID, dID); err != nil {
		t.Fatalf("move sponsors to A: %v", err)
	}

	if _, err := pool.Exec(ctx, `
		BEGIN;
		SET LOCAL app.bypass_approval = 'on';
		UPDATE mlm.plan_config
		   SET qualified_directs_left = 1,
		       qualified_directs_right = 1,
		       yield_enabled = false,
		       points_enabled = false,
		       ranks_enabled = false,
		       royalty_enabled = false,
		       referral_rate = 0,
		       founder_referral_rate = 0
		 WHERE version_label = 'v2-test';
		COMMIT;`); err != nil {
		t.Fatalf("tighten plan gates: %v", err)
	}

	now := time.Now().UTC()
	pStart := now.Add(-7 * 24 * time.Hour)
	var pid int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.binary_period (plan_config_id, period_start, period_end, status)
		SELECT id, $1, $2, 'open' FROM mlm.plan_config WHERE version_label='v2-test'
		RETURNING id`, pStart, now).Scan(&pid); err != nil {
		t.Fatalf("period: %v", err)
	}
	inWindow := now.Add(-1 * time.Hour)

	for i, buyer := range []int64{cID, dID} {
		var txnID string
		if err := pool.QueryRow(ctx, `
			INSERT INTO mlm.transaction (external_ref, description, status, posted_at)
			VALUES ($1, 'compra spillover test', 'posted', $2) RETURNING id`,
			fmt.Sprintf("test:spillover:purchase:%d", i), inWindow).Scan(&txnID); err != nil {
			t.Fatalf("purchase txn: %v", err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO mlm.wallet_movement
			  (transaction_id, wallet_id, affiliate_id, concept_id, amount, posted_at)
			SELECT $1, w.id, $2, 1004, 1000, $3
			  FROM mlm.wallet w WHERE w.affiliate_id = $2`,
			txnID, buyer, inWindow); err != nil {
			t.Fatalf("purchase movement: %v", err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO mlm.tree_event (external_ref, kind, affiliate_id,
			  pv_delta_left, pv_delta_right, occurred_at)
			VALUES ($1, 'pv_credit', $2, 1000, 0, $3)`,
			fmt.Sprintf("test:spillover:pv:%d", i), buyer, inWindow); err != nil {
			t.Fatalf("tree_event: %v", err)
		}
	}

	eng := newTestEngine(pool)
	if err := eng.CloseBinaryPeriod(ctx, pid); err != nil {
		t.Fatalf("close: %v", err)
	}

	var binaryPaid decimal.Decimal
	if err := pool.QueryRow(ctx, `
		SELECT COALESCE(sum(wm.amount), 0)
		  FROM mlm.wallet_movement wm
		  JOIN mlm.concept c ON c.id = wm.concept_id
		 WHERE c.kind = 'binary_bonus' AND wm.affiliate_id = $1`, bID).Scan(&binaryPaid); err != nil {
		t.Fatalf("sum binary bonus: %v", err)
	}
	if !binaryPaid.IsZero() {
		t.Fatalf("B should not earn binary from spillover-only children; got %s", binaryPaid)
	}
}
