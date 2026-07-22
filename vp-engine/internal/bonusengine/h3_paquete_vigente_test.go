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
// registra compras ($6000) de cID y dID (concepto 1004) con sus tree_event
// pv_credit correspondientes (generan los bloques binarios de B), y corre
// el cierre. Devuelve el error de CloseBinaryPeriod para que el llamador
// decida cómo fallar.
//
// El monto ($6000, no $1000) es deliberado: B es FUNDADOR, así que su gross
// binario usa founder_binary_matched_rate (10% del matched volume) en vez de
// bonus_per_block. Con matched=6000 → 60 bloques → gross=$600. Ese monto es
// el mínimo necesario para que el test de acoplamiento
// (TestH3_TriggerAndEngineResolveSamePackage_NoCapBreach) sea significativo:
// con matched=1000 (gross=$100) el pago no cruza NINGUNO de los dos period-caps
// posibles (viejo: 0.5×$1000=$500; vigente: 0.5×$5000=$2500), así que el
// trigger nunca abortaría el cierre sin importar qué paquete resuelva — el
// test pasaría siempre, incluso con el trigger viejo (falso verde). Con
// $600 sí cruza el cap viejo (500) pero no el vigente (2500): el trigger
// viejo aborta con 'Daily cap breach' y el nuevo no, que es exactamente el
// acoplamiento que este test debe verificar.
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
			SELECT $1, w.id, $2, 1004, 6000, $3
			  FROM mlm.wallet w WHERE w.affiliate_id = $2`,
			txnID, buyer, inWindow); err != nil {
			t.Fatalf("purchase movement: %v", err)
		}
	}

	// Eventos PV: C y D acreditan 6000 a su línea (trigger actualiza
	// lifetimes de B).
	for i, src := range []int64{cID, dID} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO mlm.tree_event (external_ref, kind, affiliate_id,
			  pv_delta_left, pv_delta_right, occurred_at)
			VALUES ($1, 'pv_credit', $2, 6000, 0, $3)`,
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

// El binario (Task 2) ya resuelve el pack nuevo $5000 y calcula el period-cap
// contra ese monto. Si el trigger fn_enforce_daily_cap sigue resolviendo el pack
// viejo $1000, valida el pago contra un period-cap más chico y hace
// RAISE EXCEPTION 'Daily cap breach' → aborta el cierre. Este test verifica que
// el cierre COMPLETA sin excepción cuando ambos resuelven el mismo paquete.
//
// Con el trigger viejo (placeholder / ORDER BY id LIMIT 1) este test FALLA con
// la excepción del trigger. Con la migración 51 PASA.
func TestH3_TriggerAndEngineResolveSamePackage_NoCapBreach(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	_, _, bID, cID, dID := seedV2Tree(t, ctx, pool)

	var oldAP int64
	if err := pool.QueryRow(ctx, `
		SELECT id FROM mlm.affiliate_package
		 WHERE affiliate_id=$1 AND package_id=1 AND status='active'
		 ORDER BY id ASC LIMIT 1`, bID).Scan(&oldAP); err != nil {
		t.Fatalf("localizar pack viejo: %v", err)
	}
	exhaustPackageCap(t, ctx, pool, oldAP)
	seedExtraPackage(t, ctx, pool, bID, 2, 5000)

	// Ejecutar el cierre. Debe completar SIN error de "Daily cap breach".
	if err := runH3Close(t, ctx, pool, cID, dID); err != nil {
		t.Fatalf("el cierre abortó (¿trigger resuelve otro paquete?): %v", err)
	}
}

// Mismo bug que el binario, en el stream de puntos R3: con pack viejo agotado +
// pack nuevo abierto, el afiliado con points_accrued > 0 debe cobrar puntos
// contra el cap del paquete nuevo, no cero.
//
// Con el código actual (v2_streams resuelve el más viejo) FALLA: pkgID resuelve
// el $1000 agotado → pkgRem 0 → continue.
func TestH3_PointsEarnAgainstNewestOpenPackage(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	_, _, bID, cID, dID := seedV2Tree(t, ctx, pool)

	var oldAP int64
	if err := pool.QueryRow(ctx, `
		SELECT id FROM mlm.affiliate_package
		 WHERE affiliate_id=$1 AND package_id=1 AND status='active'
		 ORDER BY id ASC LIMIT 1`, bID).Scan(&oldAP); err != nil {
		t.Fatalf("localizar pack viejo: %v", err)
	}
	exhaustPackageCap(t, ctx, pool, oldAP)
	seedExtraPackage(t, ctx, pool, bID, 2, 5000)

	// Sembrar points_accrued para B (simula puntos ya devengados por bloques).
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.affiliate_payout_state (affiliate_id, points_accrued)
		VALUES ($1, 50)
		ON CONFLICT (affiliate_id) DO UPDATE SET points_accrued = 50`, bID); err != nil {
		t.Fatalf("sembrar puntos: %v", err)
	}

	// Ejecutar el cierre (mismo disparo real que Task 1/2).
	if err := runH3Close(t, ctx, pool, cID, dID); err != nil {
		t.Fatalf("close: %v", err)
	}

	// B debe haber cobrado puntos: el ExtRef de los movimientos de puntos R3
	// es "r3:<period>:<aff>" (v2_streams.go, ExtRef del stream de puntos).
	var paidPoints string
	if err := pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(wm.amount),0)::text
		  FROM mlm.wallet_movement wm
		  JOIN mlm.transaction tx ON tx.id = wm.transaction_id
		  JOIN mlm.wallet w ON w.id = wm.wallet_id
		 WHERE w.affiliate_id = $1 AND tx.external_ref LIKE 'r3:%'`, bID).Scan(&paidPoints); err != nil {
		t.Fatalf("sumar puntos de B: %v", err)
	}
	if paidPoints == "0" || paidPoints == "0.00000000" {
		t.Fatalf("B cobró %s en puntos, want > 0 (bug: resuelve el pack viejo agotado)", paidPoints)
	}
}

// GARANTÍA DEL DUEÑO (spec §4): el fix H3 (resolver el paquete VIGENTE en vez
// del más viejo para T2/T3) no debe alterar el rango de carrera ni el
// nivel/posición del afiliado.
//
// ranks_enabled queda ENCENDIDO (es el default de seedV2Tree) — apagarlo,
// como hacía la versión anterior de este test, vuelve el aserto una
// tautología: con ranks apagado current_rank_id nunca puede cambiar (el
// INSERT a affiliate_rank_achieved vive dentro de `if plan.RanksEnabled`,
// v2_streams.go:256) y además B arranca con current_rank_id=NULL, así que
// "nil == nil" no prueba nada. Revertir el fix H3 deja este test en PASS de
// todos modos — no protege la garantía.
//
// El rango se calcula EXCLUSIVAMENTE de left/right_pv_lifetime + baseline
// vs rank.required_points (schema_ranks.sql §3/§4) — nunca referencia qué
// affiliate_package se resolvió para bonos. runH3Close acredita $6000 fijos
// a cada pierna de B vía tree_event (pv_credit de C y D), sin importar la
// estructura de paquetes de B. Por eso el fix H3 estructuralmente no puede
// tocar el rango, y esta prueba lo demuestra por COMPARACIÓN (Opción A, la
// más fuerte): dos afiliados B independientes, mismo volumen entrante
// ($6000/$6000 vía runH3Close), uno en el escenario H3 (pack $1000 agotado +
// pack $5000 nuevo abierto) y otro de control (un solo pack $1000, intacto).
// Si la resolución de paquete contaminara el cálculo de rango, divergirían
// aquí; con el fix correcto (y con el bug original) ambos llegan al MISMO
// current_rank_id — GOLD (5000 ≤ 6000 < 10000 PLATINUM) — porque el rango
// depende sólo del PV, no del paquete. Se usan dos contenedores Postgres
// independientes (no dos llamadas a seedV2Tree sobre el mismo pool) porque
// seedV2Tree inserta un plan_config con version_label='v2-test' fijo; una
// segunda llamada en el mismo pool duplicaría la fila y volvería ambiguo
// runH3Close.
//
// depth/path se conservan como defensa barata adicional (antes/después del
// cierre en el escenario H3): un cierre nunca los toca, aunque no son la
// señal principal de esta garantía.
func TestH3_RankAndLevelUnchanged(t *testing.T) {
	ctx := context.Background()

	type snap struct {
		rankID *int64
		depth  int
		path   string
	}
	readSnap := func(pool *pgxpool.Pool, affID int64) snap {
		t.Helper()
		var s snap
		if err := pool.QueryRow(ctx, `
			SELECT current_rank_id, depth, path::text
			  FROM mlm.affiliate WHERE id=$1`, affID).Scan(&s.rankID, &s.depth, &s.path); err != nil {
			t.Fatalf("leer afiliado: %v", err)
		}
		return s
	}

	// ---- Escenario H3: pack $1000 agotado + pack $5000 nuevo abierto ------
	poolH3, cleanupH3 := pgContainer(t)
	defer cleanupH3()
	_, _, bH3, cH3, dH3 := seedV2Tree(t, ctx, poolH3)

	var oldAP int64
	if err := poolH3.QueryRow(ctx, `
		SELECT id FROM mlm.affiliate_package
		 WHERE affiliate_id=$1 AND package_id=1 AND status='active'
		 ORDER BY id ASC LIMIT 1`, bH3).Scan(&oldAP); err != nil {
		t.Fatalf("localizar pack viejo de B: %v", err)
	}
	exhaustPackageCap(t, ctx, poolH3, oldAP)
	seedExtraPackage(t, ctx, poolH3, bH3, 2, 5000)

	beforeH3 := readSnap(poolH3, bH3)
	if err := runH3Close(t, ctx, poolH3, cH3, dH3); err != nil {
		t.Fatalf("close H3: %v", err)
	}
	afterH3 := readSnap(poolH3, bH3)

	if beforeH3.depth != afterH3.depth {
		t.Fatalf("depth cambió: %d → %d", beforeH3.depth, afterH3.depth)
	}
	if beforeH3.path != afterH3.path {
		t.Fatalf("path cambió: %q → %q", beforeH3.path, afterH3.path)
	}

	// ---- Escenario control: un solo pack $1000, intacto -------------------
	poolCtl, cleanupCtl := pgContainer(t)
	defer cleanupCtl()
	_, _, bCtl, cCtl, dCtl := seedV2Tree(t, ctx, poolCtl)

	if err := runH3Close(t, ctx, poolCtl, cCtl, dCtl); err != nil {
		t.Fatalf("close control: %v", err)
	}
	afterCtl := readSnap(poolCtl, bCtl)

	// GARANTÍA: mismo volumen entrante en ambos escenarios ⇒ mismo rango,
	// sin importar qué paquete resolvió el fix H3 para bonos. Se exige
	// además que ninguno quede NULL: si el volumen sembrado no cruzara
	// ningún umbral, ambos lados serían nil==nil y el aserto de igualdad
	// quedaría vacío otra vez.
	if afterH3.rankID == nil || afterCtl.rankID == nil {
		t.Fatalf("current_rank_id quedó NULL (H3=%v, control=%v); la garantía necesita volumen que cruce un umbral de rango real",
			afterH3.rankID, afterCtl.rankID)
	}
	if *afterH3.rankID != *afterCtl.rankID {
		t.Fatalf("current_rank_id diverge entre escenarios: H3=%d, control=%d (la resolución de paquete-vigente contaminó el rango)",
			*afterH3.rankID, *afterCtl.rankID)
	}
}

// Consunción serial (ADR-0013): si TODOS los paquetes activos del afiliado
// tienen el cap agotado, no aparece en candidatos y no gana — debe recomprar.
// El fix NO debe hacer que "caiga" a un paquete cerrado ni sume caps.
func TestH3_AllPackagesExhausted_EarnsNothing(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	_, _, bID, cID, dID := seedV2Tree(t, ctx, pool)

	// Agotar el pack $1000 y un pack $5000 nuevo — ambos cerrados.
	var oldAP int64
	if err := pool.QueryRow(ctx, `
		SELECT id FROM mlm.affiliate_package
		 WHERE affiliate_id=$1 AND package_id=1 AND status='active'
		 ORDER BY id ASC LIMIT 1`, bID).Scan(&oldAP); err != nil {
		t.Fatalf("localizar pack viejo: %v", err)
	}
	exhaustPackageCap(t, ctx, pool, oldAP)
	newAP := seedExtraPackage(t, ctx, pool, bID, 2, 5000)
	exhaustPackageCap(t, ctx, pool, newAP)

	if err := runH3Close(t, ctx, pool, cID, dID); err != nil {
		t.Fatalf("close: %v", err)
	}

	var paidToB string
	if err := pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(wm.amount),0)::text
		  FROM mlm.wallet_movement wm
		  JOIN mlm.concept c ON c.id = wm.concept_id
		  JOIN mlm.wallet w ON w.id = wm.wallet_id
		 WHERE w.affiliate_id = $1 AND c.kind = 'binary_bonus'`, bID).Scan(&paidToB); err != nil {
		t.Fatalf("sumar binario: %v", err)
	}
	if paidToB != "0" && paidToB != "0.00000000" {
		t.Fatalf("B ganó %s con todos los paquetes agotados, want 0 (debe recomprar)", paidToB)
	}
}

// Caso de borde de la Task 2 (hallazgo de revisión): con DOS paquetes de B
// simultáneamente con cap ABIERTO (el viejo $1000 y un nuevo $6000, ninguno
// agotado), el motor debe resolver el MÁS NUEVO, no el más viejo por más que
// ambos estén disponibles.
//
// Señal elegida: el affiliate_package_id efectivamente registrado en el
// wallet_movement del bono binario de B (columna vicionario_package_id =
// c.AffiliatePackageID en binary_close.go), comparado contra el id del pack
// $6000 devuelto por seedExtraPackage. Se descartó comparar el monto pagado
// (viejo: period-cap T3 = 0.5×$1000=$500; nuevo: 0.5×$6000=$3000) porque el
// neto real = gross × θ, y θ (ComputeTheta) depende de projected/inflows del
// período — que a su vez depende de qué paquete resolvió el candidato — así
// que el dólar exacto no es una señal estable entre una corrida "buena" y una
// mutada; el affiliate_package_id sí lo es, sin ambigüedad.
func TestH3_TwoOpenPackages_PrefersNewest(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	_, _, bID, cID, dID := seedV2Tree(t, ctx, pool)

	// Pack $1000 original de B: se deja ABIERTO (no se agota).
	var oldAP int64
	if err := pool.QueryRow(ctx, `
		SELECT id FROM mlm.affiliate_package
		 WHERE affiliate_id=$1 AND package_id=1 AND status='active'
		 ORDER BY id ASC LIMIT 1`, bID).Scan(&oldAP); err != nil {
		t.Fatalf("localizar pack viejo de B: %v", err)
	}

	// Pack $6000 nuevo, TAMBIÉN abierto: dos paquetes con cap abierto al
	// mismo tiempo.
	newAP := seedExtraPackage(t, ctx, pool, bID, 2, 6000)

	if err := runH3Close(t, ctx, pool, cID, dID); err != nil {
		t.Fatalf("close: %v", err)
	}

	var usedAP int64
	if err := pool.QueryRow(ctx, `
		SELECT wm.vicionario_package_id
		  FROM mlm.wallet_movement wm
		  JOIN mlm.concept c ON c.id = wm.concept_id
		  JOIN mlm.wallet w ON w.id = wm.wallet_id
		 WHERE w.affiliate_id = $1 AND c.kind = 'binary_bonus'
		 ORDER BY wm.id LIMIT 1`, bID).Scan(&usedAP); err != nil {
		t.Fatalf("localizar affiliate_package_id usado por B: %v", err)
	}
	if usedAP != newAP {
		t.Fatalf("B resolvió affiliate_package_id=%d, want %d (el nuevo $6000 abierto); viejo abierto=%d",
			usedAP, newAP, oldAP)
	}
}

// Caso de la tabla spec §3 que ningún test cubría: viejo ABIERTO + nuevo
// AGOTADO → debe resolver el VIEJO (abierto), no el nuevo (cerrado).
//
// El pack $1000 original de B (package_id=1) se deja abierto. Se le agrega
// un pack $6000 nuevo (package_id=2, id mayor) y se agota su cap de
// inmediato. El filtro `cs.closed_at IS NULL` del LATERAL (candidate.go)
// descarta el nuevo agotado aunque tenga id mayor, y `ORDER BY ap2.id DESC`
// sobre lo que queda se queda con el viejo — el único abierto.
//
// Señal elegida (igual que TestH3_TwoOpenPackages_PrefersNewest): el
// affiliate_package_id efectivamente registrado en el wallet_movement del
// bono binario de B (vicionario_package_id), no el monto. Se descarta el
// monto porque el period-cap T3 del pack viejo ($1000 × 0.5 = $500) capa el
// gross de B (fundador, 10% × $6000 de matched = $600) a $500 — el dólar
// exacto es una señal derivada del cap, no de qué paquete resolvió; el id
// del paquete es la señal directa e inequívoca.
func TestH3_NewestExhausted_FallsBackToOpenOlder(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	_, _, bID, cID, dID := seedV2Tree(t, ctx, pool)

	// Pack $1000 original de B: se deja ABIERTO (no se agota).
	var oldAP int64
	if err := pool.QueryRow(ctx, `
		SELECT id FROM mlm.affiliate_package
		 WHERE affiliate_id=$1 AND package_id=1 AND status='active'
		 ORDER BY id ASC LIMIT 1`, bID).Scan(&oldAP); err != nil {
		t.Fatalf("localizar pack viejo de B: %v", err)
	}

	// Pack $6000 nuevo (id mayor), pero se agota de inmediato: queda cerrado.
	newAP := seedExtraPackage(t, ctx, pool, bID, 2, 6000)
	exhaustPackageCap(t, ctx, pool, newAP)

	if err := runH3Close(t, ctx, pool, cID, dID); err != nil {
		t.Fatalf("close: %v", err)
	}

	// B debe haber ganado algo > 0 (contra el viejo abierto, no 0 contra el
	// nuevo agotado).
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
		t.Fatalf("B ganó %s en binario, want > 0 (debe caer al viejo abierto, no quedar en 0 contra el nuevo agotado)", paidToB)
	}

	// Señal directa e inequívoca: el affiliate_package_id usado debe ser el
	// viejo abierto ($1000), NO el nuevo agotado ($6000).
	var usedAP int64
	if err := pool.QueryRow(ctx, `
		SELECT wm.vicionario_package_id
		  FROM mlm.wallet_movement wm
		  JOIN mlm.concept c ON c.id = wm.concept_id
		  JOIN mlm.wallet w ON w.id = wm.wallet_id
		 WHERE w.affiliate_id = $1 AND c.kind = 'binary_bonus'
		 ORDER BY wm.id LIMIT 1`, bID).Scan(&usedAP); err != nil {
		t.Fatalf("localizar affiliate_package_id usado por B: %v", err)
	}
	if usedAP != oldAP {
		t.Fatalf("B resolvió affiliate_package_id=%d, want %d (el viejo $1000 abierto); nuevo agotado=%d",
			usedAP, oldAP, newAP)
	}
}
