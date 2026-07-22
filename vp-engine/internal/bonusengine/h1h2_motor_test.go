package bonusengine

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
)

// runH1H2Close crea un período abierto que cubre [now-7d, now], siembra inflows
// y PV (compras de C y D) para generar bloques binarios, y cierra el período.
// Devuelve el error del cierre. Cadencia de puntos = 1 en el plan de test (los
// puntos se pagan cada cierre), para que el segundo cierre sea de cadencia.
func runH1H2Close(t *testing.T, ctx context.Context, pool *pgxpool.Pool, eng *Engine, cID, dID int64, offsetDays int) error {
	t.Helper()
	now := time.Now().UTC().AddDate(0, 0, offsetDays)
	pStart := now.AddDate(0, 0, -7)
	var pid int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.binary_period (plan_config_id, period_start, period_end, status)
		SELECT id, $1, $2, 'open' FROM mlm.plan_config WHERE version_label='v2-test'
		RETURNING id`, pStart, now).Scan(&pid); err != nil {
		t.Fatalf("period: %v", err)
	}
	inWindow := now.AddDate(0, 0, -1)
	for i, buyer := range []int64{cID, dID} {
		var txnID string
		if err := pool.QueryRow(ctx, `
			INSERT INTO mlm.transaction (external_ref, description, status, posted_at)
			VALUES ($1, 'compra', 'posted', $2) RETURNING id`,
			timeKey("h1h2:buy", i, offsetDays), inWindow).Scan(&txnID); err != nil {
			t.Fatalf("buy txn: %v", err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO mlm.wallet_movement (transaction_id, wallet_id, affiliate_id, concept_id, amount, posted_at)
			SELECT $1, w.id, $2, 1004, 1000, $3 FROM mlm.wallet w WHERE w.affiliate_id=$2`,
			txnID, buyer, inWindow); err != nil {
			t.Fatalf("buy mov: %v", err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO mlm.tree_event (external_ref, kind, affiliate_id, pv_delta_left, pv_delta_right, occurred_at)
			VALUES ($1, 'pv_credit', $2, 1000, 0, $3)`,
			timeKey("h1h2:pv", i, offsetDays), buyer, inWindow); err != nil {
			t.Fatalf("pv: %v", err)
		}
	}
	return eng.CloseBinaryPeriod(ctx, pid)
}

func timeKey(prefix string, i, off int) string {
	return prefix + ":" + decimal.NewFromInt(int64(off)).String() + ":" + decimal.NewFromInt(int64(i)).String()
}

// Los puntos acumulados en el período de cadencia NO se destruyen: se difieren
// y se pagan en el cierre siguiente. Con el bug (AccruePoints antes de
// PayV2Streams) el reset borra los puntos que ESE MISMO cierre acaba de
// acumular.
//
// Con cadencia=1, ComputeV2Streams calcula qué pagar leyendo points_accrued
// TAL COMO ESTABA AL INICIO del cierre (antes de que este período acumule
// nada). Por eso el cierre 1 no paga nada (parte de 0) pero deja P0 acumulado;
// el cierre 2 SÍ paga P0 (ese pago no depende del orden del reorden, porque
// v2.Points ya se calculó con el snapshot de ANTES del bloque binario/AccruePoints
// de este período) — con el bug, el reset de PayV2Streams borra points_accrued
// por completo, incluyendo P1 que AccruePoints acaba de sumar ANTES del pago
// (orden buggy: Accrue→Pay). Esa destrucción de P1 sólo se revela cuando P1
// debería pagarse en el CIERRE 3: con el bug, points_accrued llegó a 0 destruido
// y el cierre 3 no tiene nada previo que pagar (paga 0 extra); con el fix, P1
// sobrevivió y el cierre 3 lo paga. Por eso este test encadena TRES cierres y
// compara el crecimiento de "pagado por puntos" entre el cierre 2 y el 3, no
// entre el 1 y el 2 (esa comparación es idéntica con o sin el bug, ver nota
// en el reporte).
func TestH2_CadencePeriodPointsNotDestroyed(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	_, _, bID, cID, dID := seedV2Tree(t, ctx, pool)
	eng := newTestEngine(pool)

	// Los 3 cierres van en offsets -14, -7, 0 (en vez de 0, +7, +14): las
	// tres ventanas de 7 días quedan igual de no-solapadas y en el MISMO
	// orden temporal, pero ninguna posted_at cae en el futuro respecto al
	// reloj real (wallet_movement_date_sane exige posted_at <= now()+7d;
	// con offsets crecientes el 3er cierre violaba esa constraint).

	// Cierre 1: B acumula P0 por sus bloques binarios; cadencia=1 pero
	// points_accrued arranca en 0, así que ComputeV2Streams no paga nada
	// todavía (snapshot previo al cierre está vacío).
	if err := runH1H2Close(t, ctx, pool, eng, cID, dID, -14); err != nil {
		t.Fatalf("cierre 1: %v", err)
	}
	paid1 := sumPointsPaid(t, ctx, pool, bID)
	accrued1 := pointsAccrued(t, ctx, pool, bID)
	if !accrued1.GreaterThan(decimal.Zero) {
		t.Fatalf("tras cierre 1, points_accrued de B = %s; el seed no genera puntos (precondición del test rota)", accrued1)
	}

	// Cierre 2 (semana siguiente): ComputeV2Streams paga P0 (snapshot previo
	// al cierre). B genera MÁS bloques → P1. Con el bug, AccruePoints corre
	// antes de PayV2Streams: P1 se suma a points_accrued y el reset de
	// PayV2Streams (que paga y limpia P0) borra P0+P1 en vez de sólo P0.
	if err := runH1H2Close(t, ctx, pool, eng, cID, dID, -7); err != nil {
		t.Fatalf("cierre 2: %v", err)
	}
	paid2 := sumPointsPaid(t, ctx, pool, bID)
	accrued2 := pointsAccrued(t, ctx, pool, bID)
	if !paid2.GreaterThan(paid1) {
		t.Fatalf("puntos pagados tras cierre 2 (%s) no crecieron respecto al cierre 1 (%s): P0 no se pagó", paid2, paid1)
	}

	// Cierre 3 (otra semana más): si P1 sobrevivió al reset del cierre 2
	// (fix), ComputeV2Streams lo ve como snapshot previo y lo paga aquí,
	// así que paid3 > paid2. Si P1 fue destruido (bug), el reset del cierre 2
	// dejó points_accrued=0 y el cierre 3 no tiene nada previo que pagar por
	// puntos: paid3 == paid2.
	if err := runH1H2Close(t, ctx, pool, eng, cID, dID, 0); err != nil {
		t.Fatalf("cierre 3: %v", err)
	}
	paid3 := sumPointsPaid(t, ctx, pool, bID)

	t.Logf("accrued1=%s accrued2=%s paid1=%s paid2=%s paid3=%s", accrued1, accrued2, paid1, paid2, paid3)

	if !paid3.GreaterThan(paid2) {
		t.Fatalf("puntos pagados tras cierre 3 (%s) no crecieron respecto al cierre 2 (%s): "+
			"P1 (los puntos acumulados en el propio cierre 2, período de cadencia) fueron destruidos por el reset "+
			"de PayV2Streams en vez de diferirse al cierre siguiente", paid3, paid2)
	}
}

func sumPointsPaid(t *testing.T, ctx context.Context, pool *pgxpool.Pool, affID int64) decimal.Decimal {
	t.Helper()
	var s string
	if err := pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(wm.amount),0)::text
		  FROM mlm.wallet_movement wm
		  JOIN mlm.transaction tx ON tx.id = wm.transaction_id
		  JOIN mlm.wallet w ON w.id = wm.wallet_id
		 WHERE w.affiliate_id=$1 AND tx.external_ref LIKE 'r3:%'`, affID).Scan(&s); err != nil {
		t.Fatalf("sum points: %v", err)
	}
	d, _ := decimal.NewFromString(s)
	return d
}

func pointsAccrued(t *testing.T, ctx context.Context, pool *pgxpool.Pool, affID int64) decimal.Decimal {
	t.Helper()
	var s string
	if err := pool.QueryRow(ctx, `
		SELECT COALESCE(points_accrued,0)::text
		  FROM mlm.affiliate_payout_state WHERE affiliate_id=$1`, affID).Scan(&s); err != nil {
		t.Fatalf("points_accrued: %v", err)
	}
	d, _ := decimal.NewFromString(s)
	return d
}

// seedAffiliateWithCD crea person+affiliate+wallet USD, un mlm.package (id
// explícito, la PK no es identity) con amount_usd = packageAmount, un
// mlm.affiliate_package 'active' ligado a ese package (el trigger
// trg_init_package_cap crea mlm.package_cap_state con cap_total =
// packageAmount × lifetime_cap_factor — 2.0 por defecto sin plan_config
// vigente, ver schema_payouts.sql fn_init_package_cap), y un
// mlm.investment_cd 'active' con affiliate_package_id ligado a ese paquete,
// principal_usd = cdPrincipal (deliberadamente independiente de packageAmount
// para poder construir tramos de ROI grandes contra un cap chico en los
// tests de capado), roi_tier_id = tierID, start_at hace `daysAgo` días
// (Bogota, medianoche — mismo patrón que seedCD en cd_roi_test.go),
// matures_at en `lockDays` días, last_accrual_date NULL (nunca devengó).
// Devuelve el affiliate_id y el affiliate_package_id.
func seedAffiliateWithCD(t *testing.T, ctx context.Context, pool *pgxpool.Pool, email string, packageID int, packageAmount, cdPrincipal float64, tierID int, daysAgo, lockDays int) (affID, apID int64) {
	t.Helper()
	_, _ = pool.Exec(ctx, `INSERT INTO mlm.country (id, iso2, name_es, name_en) VALUES (1,'CO','Colombia','Colombia') ON CONFLICT DO NOTHING`)
	_, _ = pool.Exec(ctx, `INSERT INTO mlm.asset (id, symbol, name, is_fiat, decimals) VALUES (1,'USD','US Dollar',true,2) ON CONFLICT DO NOTHING`)

	var personID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.person (first_name, last_name, email, phone_number, status)
		VALUES ('cap','test',$1,'0000000000','active') RETURNING id`, email).Scan(&personID); err != nil {
		t.Fatalf("person: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.affiliate (person_id, parent_id, position, status, current_rank_id)
		VALUES ($1, NULL, NULL, 'active', 1) RETURNING id`, personID).Scan(&affID); err != nil {
		t.Fatalf("affiliate: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.wallet (affiliate_id, asset_id, address, balance) VALUES ($1,1,$2,0)`,
		affID, fmt.Sprintf("cap-w%d", affID)); err != nil {
		t.Fatalf("wallet: %v", err)
	}

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.package (id, name, amount_usd, pv, type)
		VALUES ($1, 'Cap-Test', $2, 1, 'enrollment') ON CONFLICT (id) DO NOTHING`,
		packageID, packageAmount); err != nil {
		t.Fatalf("package: %v", err)
	}

	// affiliate_package activo → trg_init_package_cap (AFTER INSERT ... status
	// active) crea la fila en mlm.package_cap_state.
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.affiliate_package (
			affiliate_id, package_id, status, payment_method, transaction_hash,
			pv_remaining, activated_at, current_period_date)
		VALUES ($1, $2, 'active', 'stripe', $3, 0, now(), (now() AT TIME ZONE $4)::date)
		RETURNING id`, affID, packageID, fmt.Sprintf("cap-test:%d", affID), bizTZ).Scan(&apID); err != nil {
		t.Fatalf("affiliate_package: %v", err)
	}

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.investment_cd (affiliate_id, affiliate_package_id, principal_usd, roi_tier_id, start_at, matures_at)
		VALUES ($1, $2, $3, $4,
		        ((((now() AT TIME ZONE $6)::date - $5::int))::timestamp AT TIME ZONE $6),
		        ((((now() AT TIME ZONE $6)::date + $7::int))::timestamp AT TIME ZONE $6))`,
		affID, apID, cdPrincipal, tierID, daysAgo, bizTZ, lockDays); err != nil {
		t.Fatalf("investment_cd: %v", err)
	}
	return affID, apID
}

// El ROI del CD consume el cap de por vida del paquete que lo originó, y se capa
// al remaining. Con el bug (ROI no toca package_cap_state) paid_total no cambia.
func TestH1_ROIConsumesPackageCap(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	// package_id=900: cap chico (amount_usd=100 → cap_total=200 con el factor
	// default 2.0), CD principal=100 tier 1, arrancó hace 10 días.
	_, apID := seedAffiliateWithCD(t, ctx, pool, "roicap1@t.local", 900, 100, 100, 1, 10, 365)

	var capBefore, paidBefore string
	if err := pool.QueryRow(ctx, `SELECT cap_total::text, paid_total::text FROM mlm.package_cap_state WHERE affiliate_package_id=$1`, apID).Scan(&capBefore, &paidBefore); err != nil {
		t.Fatalf("cap state before: %v", err)
	}

	eng := newTestEngine(pool)
	if _, err := eng.AccrueCDROIDaily(ctx); err != nil {
		t.Fatalf("accrue roi: %v", err)
	}

	var paidAfter string
	if err := pool.QueryRow(ctx, `SELECT paid_total::text FROM mlm.package_cap_state WHERE affiliate_package_id=$1`, apID).Scan(&paidAfter); err != nil {
		t.Fatalf("cap state after: %v", err)
	}

	pb, _ := decimal.NewFromString(paidBefore)
	pa, _ := decimal.NewFromString(paidAfter)
	if !pa.GreaterThan(pb) {
		t.Fatalf("paid_total no subió con el ROI (%s → %s): el ROI no consume cap", paidBefore, paidAfter)
	}
	// El ROI no debe exceder el cap.
	cap, _ := decimal.NewFromString(capBefore)
	if pa.GreaterThan(cap) {
		t.Fatalf("paid_total %s excede cap_total %s: el ROI no se capó", paidAfter, capBefore)
	}
}

// Un CD cuyo tramo de ROI excede el remaining del cap: el ROI posteado se capa
// EXACTAMENTE al remaining (no lo excede, no aborta la transacción), y el
// paquete queda cerrado (paid_total == cap_total, closed_at set por
// fn_enforce_package_cap).
func TestH1_ROICappedAtRemaining(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	// package_id=901: amount_usd=100 → cap_total=200. CD principal=100000
	// tier 5 (base_annual_rate 0.25 igual en todos los tiers del seed), 30
	// días de devengo pendiente → gross bruto ≈ 100000×0.25/365×30 ≈ 2054.79,
	// muy por encima de cualquier remaining chico.
	affID, apID := seedAffiliateWithCD(t, ctx, pool, "roicap2@t.local", 901, 100, 100000, 5, 30, 365)

	// Casi lleno: deja remaining=10 (paid_total=190 de un cap_total=200).
	if _, err := pool.Exec(ctx, `UPDATE mlm.package_cap_state SET paid_total = 190 WHERE affiliate_package_id=$1`, apID); err != nil {
		t.Fatalf("prime cap state: %v", err)
	}

	eng := newTestEngine(pool)
	res, err := eng.AccrueCDROIDaily(ctx)
	if err != nil {
		t.Fatalf("accrue roi: %v", err)
	}
	if res.Posted != 1 {
		t.Fatalf("esperaba 1 movimiento posteado, got %d", res.Posted)
	}

	var movedAmount string
	if err := pool.QueryRow(ctx, `
		SELECT amount::text FROM mlm.wallet_movement
		 WHERE affiliate_id=$1 AND concept_id=1006 LIMIT 1`, affID).Scan(&movedAmount); err != nil {
		t.Fatalf("movimiento roi: %v", err)
	}
	// amount es numeric(20,8) → ::text trae 8 decimales; comparar por valor,
	// no por string literal.
	moved, err := decimal.NewFromString(movedAmount)
	if err != nil {
		t.Fatalf("parse moved amount %q: %v", movedAmount, err)
	}
	if moved.StringFixed(2) != "10.00" {
		t.Fatalf("el ROI posteado debe capar al remaining exacto (10.00), got %s (el tramo bruto ~2054.79 sin capar)", moved.StringFixed(2))
	}

	var capTotal, paidTotal string
	var closedAt *time.Time
	if err := pool.QueryRow(ctx, `
		SELECT cap_total::text, paid_total::text, closed_at
		  FROM mlm.package_cap_state WHERE affiliate_package_id=$1`, apID).Scan(&capTotal, &paidTotal, &closedAt); err != nil {
		t.Fatalf("cap state after: %v", err)
	}
	if paidTotal != capTotal {
		t.Fatalf("paid_total (%s) debe quedar == cap_total (%s): el paquete se agotó exactamente", paidTotal, capTotal)
	}
	if closedAt == nil {
		t.Fatalf("package_cap_state.closed_at debe quedar seteado (cap agotado, trg_enforce_package_cap auto-close)")
	}
}
