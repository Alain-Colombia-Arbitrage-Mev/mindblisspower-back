package bonusengine

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// seedExtraPackage inserta un affiliate_package activo adicional para un afiliado
// (con su package en el catálogo si no existe) y devuelve el affiliate_package_id.
// El trigger trg_init_package_cap crea automáticamente el package_cap_state
// (cap = lifetime_cap_factor × amount_usd).
func seedExtraPackage(t *testing.T, ctx context.Context, pool *pgxpool.Pool, affID, packageID int64, amountUSD int) int64 {
	t.Helper()
	// NOTA: no reusar el mismo parámetro entre contextos de tipo distinto
	// (text para el nombre, numeric para amount_usd, integer para pv) —
	// Postgres exige un único tipo deducido por parámetro y falla con
	// "inconsistent types deduced" si dos usos piden tipos distintos. Se
	// arma el nombre en Go y amount_usd/pv van cada uno en su propio
	// parámetro (aunque compartan valor).
	name := fmt.Sprintf("Pack %d", amountUSD)
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.package (id, name, amount_usd, pv, type)
		VALUES ($1, $2, $3, $4, 'enrollment')
		ON CONFLICT (id) DO NOTHING`, packageID, name, amountUSD, amountUSD); err != nil {
		t.Fatalf("seed package %d: %v", packageID, err)
	}
	var apID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.affiliate_package (affiliate_id, package_id, status, activated_at)
		VALUES ($1, $2, 'active', now()) RETURNING id`, affID, packageID).Scan(&apID); err != nil {
		t.Fatalf("seed affiliate_package aff=%d pkg=%d: %v", affID, packageID, err)
	}
	return apID
}

// exhaustPackageCap marca el package_cap_state de un affiliate_package como
// agotado: paid_total = cap_total y closed_at = now(). Simula un paquete cuyo
// cap de por vida (T2) ya se consumió por completo.
func exhaustPackageCap(t *testing.T, ctx context.Context, pool *pgxpool.Pool, affiliatePackageID int64) {
	t.Helper()
	ct, err := pool.Exec(ctx, `
		UPDATE mlm.package_cap_state
		   SET paid_total = cap_total, closed_at = now()
		 WHERE affiliate_package_id = $1`, affiliatePackageID)
	if err != nil {
		t.Fatalf("exhaust cap ap=%d: %v", affiliatePackageID, err)
	}
	if ct.RowsAffected() != 1 {
		t.Fatalf("exhaust cap ap=%d: filas afectadas = %d, want 1", affiliatePackageID, ct.RowsAffected())
	}
}

// runH3Close replica el patrón de disparo de cierre de
// TestCloseBinaryPeriod_V2Streams (binary_close_v2_test.go): abre un
// binary_period sobre el plan_config 'v2-test' sembrado por seedV2Tree,
// registra compras ($1000) de cID y dID (concepto 1004) con sus tree_event
// pv_credit correspondientes (generan los bloques binarios de B), y corre
// el cierre. Devuelve el error de CloseBinaryPeriod para que el llamador
// decida cómo fallar.
func runH3Close(t *testing.T, ctx context.Context, pool *pgxpool.Pool, cID, dID int64) error {
	t.Helper()

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
			VALUES ($1, 'compra test h3', 'posted', $2) RETURNING id`,
			fmt.Sprintf("test:h3:purchase:%d", i), inWindow).Scan(&txnID); err != nil {
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
	// lifetimes de B).
	for i, src := range []int64{cID, dID} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO mlm.tree_event (external_ref, kind, affiliate_id,
			  pv_delta_left, pv_delta_right, occurred_at)
			VALUES ($1, 'pv_credit', $2, 1000, 0, $3)`,
			fmt.Sprintf("test:h3:pv:%d", i), src, inWindow); err != nil {
			t.Fatalf("tree_event: %v", err)
		}
	}

	eng := newTestEngine(pool)
	return eng.CloseBinaryPeriod(ctx, pid)
}

// El afiliado B (de seedV2Tree) tiene el pack $1000 inicial. Le agotamos ese cap
// y le damos un pack $5000 nuevo con cap abierto. Tras el cierre, B debe ganar
// bonos binarios contra el cap del $5000, NO cero.
//
// Con el código actual (resuelve el pack más viejo) este test FALLA: B resuelve
// el $1000 agotado → gross forzado a 0 → no gana.
func TestH3_BinaryEarnsAgainstNewestOpenPackage(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	_, _, bID, cID, dID := seedV2Tree(t, ctx, pool)

	// Agotar el pack $1000 inicial de B (package_id=1, su affiliate_package).
	var oldAP int64
	if err := pool.QueryRow(ctx, `
		SELECT id FROM mlm.affiliate_package
		 WHERE affiliate_id=$1 AND package_id=1 AND status='active'
		 ORDER BY id ASC LIMIT 1`, bID).Scan(&oldAP); err != nil {
		t.Fatalf("localizar pack viejo de B: %v", err)
	}
	exhaustPackageCap(t, ctx, pool, oldAP)

	// Pack $5000 nuevo con cap abierto.
	seedExtraPackage(t, ctx, pool, bID, 2, 5000)

	if err := runH3Close(t, ctx, pool, cID, dID); err != nil {
		t.Fatalf("close: %v", err)
	}

	// Verificar: B ganó bonos binarios (concepto binary_bonus) en este período.
	var paidToB string
	if err := pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(wm.amount),0)::text
		  FROM mlm.wallet_movement wm
		  JOIN mlm.concept c ON c.id = wm.concept_id
		  JOIN mlm.wallet w ON w.id = wm.wallet_id
		 WHERE w.affiliate_id = $1 AND c.kind = 'binary_bonus'`, bID).Scan(&paidToB); err != nil {
		t.Fatalf("sumar binario de B: %v", err)
	}
	if paidToB == "0" || paidToB == "0.00000000" {
		t.Fatalf("B ganó %s en binario, want > 0 (el bug lo congela en 0 resolviendo el pack viejo agotado)", paidToB)
	}
}
