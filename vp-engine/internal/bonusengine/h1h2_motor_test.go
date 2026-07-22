package bonusengine

import (
	"context"
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
