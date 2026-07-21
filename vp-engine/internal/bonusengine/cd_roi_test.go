package bonusengine

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
)

// bizTZ es la zona de negocio del plan; las fechas de los CD son de Bogota.
// Los tests siembran y afirman en esta zona, NO en el TimeZone de la sesión
// Postgres (UTC), que es un detalle de infraestructura.
const bizTZ = DefaultTimezone

// seedCD crea person+affiliate (root, sin parent) con una wallet USD y un
// investment_cd con principal/tier dados, start_at hace `daysAgo` días y sin
// devengo previo. Devuelve el cd_id y el affiliate_id.
//
// start_at/matures_at se anclan a MEDIANOCHE DE UNA FECHA BOGOTA explícita
// (no a `now() - N días`): así el conteo de días queda atado a la semántica de
// negocio y no a la hora en que corra la suite.
func seedCD(t *testing.T, ctx context.Context, pool *pgxpool.Pool, email string, principal float64, tierID int, daysAgo, lockDays int) (cdID, affID int64) {
	t.Helper()
	// Catalogs mínimos (idempotentes entre llamadas).
	_, _ = pool.Exec(ctx, `INSERT INTO mlm.country (id, iso2, name_es, name_en) VALUES (1,'CO','Colombia','Colombia') ON CONFLICT DO NOTHING`)
	_, _ = pool.Exec(ctx, `INSERT INTO mlm.asset (id, symbol, name, is_fiat, decimals) VALUES (1,'USD','US Dollar',true,2) ON CONFLICT DO NOTHING`)

	var personID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.person (first_name, last_name, email, phone_number, status)
		VALUES ('cd','test',$1,'0000000000','active') RETURNING id`, email).Scan(&personID); err != nil {
		t.Fatalf("person: %v", err)
	}
	// path/depth los llena el trigger trg_affiliate_path (BEFORE INSERT).
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.affiliate (person_id, parent_id, position, status, current_rank_id)
		VALUES ($1, NULL, NULL, 'active', 1) RETURNING id`, personID).Scan(&affID); err != nil {
		t.Fatalf("affiliate: %v", err)
	}
	_, _ = pool.Exec(ctx, `INSERT INTO mlm.wallet (affiliate_id, asset_id, address, balance) VALUES ($1,1,$2,0)`, affID, fmt.Sprintf("w%d", affID))

	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.investment_cd (affiliate_id, principal_usd, roi_tier_id, start_at, matures_at)
		VALUES ($1, $2, $3,
		        ((((now() AT TIME ZONE $5)::date - $4::int))::timestamp AT TIME ZONE $5),
		        ((((now() AT TIME ZONE $5)::date + $6::int))::timestamp AT TIME ZONE $5))
		RETURNING id`, affID, principal, tierID, daysAgo, bizTZ, lockDays).Scan(&cdID); err != nil {
		t.Fatalf("investment_cd: %v", err)
	}
	return cdID, affID
}

// expectedROI deriva el devengo esperado del CATÁLOGO (mlm.cd_roi_tier) en vez
// de escribir la cifra a mano: el test verifica la propiedad "devengo diario
// proporcional" (principal × tasa_anual / 365 × días) y no se rompe si alguien
// cambia una tasa del catálogo.
func expectedROI(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tierID int, principal float64, days int, qualified bool) string {
	t.Helper()
	col := "base_annual_rate"
	if qualified {
		col = "qualified_annual_rate"
	}
	var rate decimal.Decimal
	if err := pool.QueryRow(ctx,
		`SELECT `+col+` FROM mlm.cd_roi_tier WHERE id = $1`, tierID).Scan(&rate); err != nil {
		t.Fatalf("tier %d %s: %v", tierID, col, err)
	}
	if rate.Sign() <= 0 {
		t.Fatalf("tier %d tiene %s = %s (esperaba > 0)", tierID, col, rate)
	}
	return decimal.NewFromFloat(principal).Mul(rate).
		Div(decimal.NewFromInt(365)).
		Mul(decimal.NewFromInt(int64(days))).RoundDown(2).StringFixed(2)
}

// bogotaDate renderiza una columna timestamptz como fecha de calendario BOGOTA,
// independiente del TimeZone de la sesión.
func bogotaDate(t *testing.T, ctx context.Context, pool *pgxpool.Pool, query string, args ...any) string {
	t.Helper()
	var s string
	if err := pool.QueryRow(ctx, query, args...).Scan(&s); err != nil {
		t.Fatalf("bogotaDate %q: %v", query, err)
	}
	return s
}

// TestCDROIAccrual_Base verifica el devengo a tasa base (sin directos
// calificantes): principal 500, tier 1, 10 días. El valor esperado sale del
// catálogo (500 × base_annual_rate / 365 × 10).
func TestCDROIAccrual_Base(t *testing.T) {
	ctx := context.Background()
	pool, cleanup := pgContainer(t)
	defer cleanup()
	eng := newTestEngine(pool)

	const days = 10
	cdID, affID := seedCD(t, ctx, pool, "base@t.local", 500, 1, days, 365)
	want := expectedROI(t, ctx, pool, 1, 500, days, false)

	res, err := eng.AccrueCDROIDaily(ctx)
	if err != nil {
		t.Fatalf("accrue: %v", err)
	}
	if res.Posted != 1 {
		t.Fatalf("expected 1 posted, got %d", res.Posted)
	}
	if got := res.TotalUSD.StringFixed(2); got != want {
		t.Fatalf("expected %s base ROI (%d días a tasa base tier 1), got %s", want, days, got)
	}

	// El movimiento queda BLOQUEADO hasta matures_at (no madurado todavía).
	// Ambas fechas se comparan en zona Bogota: available_at es una fecha de
	// negocio, no la proyección UTC de matures_at.
	avail := bogotaDate(t, ctx, pool, `
		SELECT to_char(available_at,'YYYY-MM-DD') FROM mlm.wallet_movement
		 WHERE affiliate_id=$1 AND concept_id=1006 LIMIT 1`, affID)
	matures := bogotaDate(t, ctx, pool, `
		SELECT to_char(matures_at AT TIME ZONE $2,'YYYY-MM-DD')
		  FROM mlm.investment_cd WHERE id=$1`, cdID, bizTZ)
	if avail != matures {
		t.Fatalf("ROI available_at (%s) debe = matures_at Bogota (%s) [bloqueado 365d]", avail, matures)
	}

	// roi_accrued_usd y last_accrual_date actualizados.
	var accrued decimal.Decimal
	var lastNull bool
	_ = pool.QueryRow(ctx, `SELECT roi_accrued_usd, last_accrual_date IS NULL FROM mlm.investment_cd WHERE id=$1`, cdID).Scan(&accrued, &lastNull)
	if accrued.StringFixed(2) != want || lastNull {
		t.Fatalf("read model mal: accrued=%s (esperaba %s) lastNull=%v", accrued.StringFixed(2), want, lastNull)
	}
}

// TestCDROIAccrual_Idempotent: re-correr el mismo día no duplica.
func TestCDROIAccrual_Idempotent(t *testing.T) {
	ctx := context.Background()
	pool, cleanup := pgContainer(t)
	defer cleanup()
	eng := newTestEngine(pool)

	_, affID := seedCD(t, ctx, pool, "idem@t.local", 1000, 2, 5, 365)

	if _, err := eng.AccrueCDROIDaily(ctx); err != nil {
		t.Fatalf("run1: %v", err)
	}
	res2, err := eng.AccrueCDROIDaily(ctx)
	if err != nil {
		t.Fatalf("run2: %v", err)
	}
	if res2.Posted != 0 {
		t.Fatalf("re-run mismo día NO debe postear, got %d", res2.Posted)
	}
	var n int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM mlm.wallet_movement WHERE affiliate_id=$1 AND concept_id=1006`, affID).Scan(&n)
	if n != 1 {
		t.Fatalf("esperaba 1 movimiento tras 2 corridas, got %d", n)
	}
}

// TestCDROIAccrual_Qualified: con 1 directo activo a cada lado (tier ≥), aplica
// la tasa calificada del tier 2 sobre 1000 durante 10 días.
func TestCDROIAccrual_Qualified(t *testing.T) {
	ctx := context.Background()
	pool, cleanup := pgContainer(t)
	defer cleanup()
	eng := newTestEngine(pool)

	const days = 10
	cdID, ownerAff := seedCD(t, ctx, pool, "owner@t.local", 1000, 2, days, 365)
	want := expectedROI(t, ctx, pool, 2, 1000, days, true)

	// Dos directos (sponsor = owner) colocados en el subtree, uno a cada pierna,
	// cada uno con un CD activo de tier ≥ 2 → califican el uplift. El trigger
	// trg_affiliate_path llena path/depth (owner.path.<side>_<id>).
	for _, side := range []string{"L", "R"} {
		var pid, aid int64
		_ = pool.QueryRow(ctx, `INSERT INTO mlm.person (first_name,last_name,email,phone_number,status)
			VALUES ('d','t',$1,'0','active') RETURNING id`, side+"@t.local").Scan(&pid)
		if err := pool.QueryRow(ctx, `
			INSERT INTO mlm.affiliate (person_id, parent_id, position, sponsor_id, status, current_rank_id)
			VALUES ($1,$2,$3,$2,'active',1) RETURNING id`, pid, ownerAff, side).Scan(&aid); err != nil {
			t.Fatalf("direct %s: %v", side, err)
		}
		// CD del directo: arranca HOY (Bogota) → no devenga en esta corrida.
		_, _ = pool.Exec(ctx, `
			INSERT INTO mlm.investment_cd (affiliate_id, principal_usd, roi_tier_id, start_at, matures_at)
			VALUES ($1, 1000, 2,
			        (((now() AT TIME ZONE $2)::date)::timestamp AT TIME ZONE $2),
			        (((now() AT TIME ZONE $2)::date + 365)::timestamp AT TIME ZONE $2))`, aid, bizTZ)
	}

	res, err := eng.AccrueCDROIDaily(ctx)
	if err != nil {
		t.Fatalf("accrue: %v", err)
	}
	var ownerROI decimal.Decimal
	_ = pool.QueryRow(ctx, `SELECT roi_accrued_usd FROM mlm.investment_cd WHERE id=$1`, cdID).Scan(&ownerROI)
	if ownerROI.StringFixed(2) != want {
		t.Fatalf("esperaba ROI calificado %s (qualified_annual_rate tier 2, %d días), got %s — ¿v_cd_qualification?",
			want, days, ownerROI.StringFixed(2))
	}
	if res.Posted < 1 {
		t.Fatalf("esperaba al menos 1 movimiento")
	}
}

// TestCDROIAccrual_Matures: un CD cuyo matures_at ya pasó se marca 'matured' y
// devenga solo hasta el vencimiento.
func TestCDROIAccrual_Matures(t *testing.T) {
	ctx := context.Background()
	pool, cleanup := pgContainer(t)
	defer cleanup()
	eng := newTestEngine(pool)

	// start hace 400 días, lock 365 → ya venció hace 35 días.
	cdID, _ := seedCD(t, ctx, pool, "mat@t.local", 500, 1, 400, -35)

	res, err := eng.AccrueCDROIDaily(ctx)
	if err != nil {
		t.Fatalf("accrue: %v", err)
	}
	if res.Matured != 1 {
		t.Fatalf("esperaba 1 CD matured, got %d", res.Matured)
	}
	var status string
	_ = pool.QueryRow(ctx, `SELECT status FROM mlm.investment_cd WHERE id=$1`, cdID).Scan(&status)
	if status != "matured" {
		t.Fatalf("esperaba status matured, got %s", status)
	}
	// Devengó exactamente start→vencimiento (365 días), no start→hoy (400).
	want := expectedROI(t, ctx, pool, 1, 500, 365, false)
	var accrued decimal.Decimal
	_ = pool.QueryRow(ctx, `SELECT roi_accrued_usd FROM mlm.investment_cd WHERE id=$1`, cdID).Scan(&accrued)
	if accrued.StringFixed(2) != want {
		t.Fatalf("el devengo debe cortarse en matures_at: esperaba %s (365 días), got %s", want, accrued.StringFixed(2))
	}
}

// poolWithSessionTimezone abre un pool contra la misma DB pero forzando el
// TimeZone de la SESIÓN Postgres. Sirve para probar que el motor no depende de
// él (producción lo fija en UTC; ver internal/shared/db/pool.go).
func poolWithSessionTimezone(t *testing.T, ctx context.Context, connString, tz string) *pgxpool.Pool {
	t.Helper()
	cfg, err := pgxpool.ParseConfig(connString)
	if err != nil {
		t.Fatalf("parse dsn: %v", err)
	}
	cfg.ConnConfig.RuntimeParams["timezone"] = tz
	p, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("pool tz=%s: %v", tz, err)
	}
	return p
}

// TestCDROIAccrual_SessionTimezoneInvariant es el test de regresión del bug de
// zona horaria: el devengo debe dar EXACTAMENTE lo mismo sea cual sea el
// TimeZone de la sesión Postgres. El bug original mezclaba "hoy" en Bogota con
// `cd.start_at::date` resuelto en la zona de la sesión (UTC), lo que desfasaba
// `days` en un día.
//
// Nota sobre la elección de zonas: con start_at anclado a medianoche Bogota
// (= 05:00Z), las fechas UTC y Bogota COINCIDEN, así que UTC vs Bogota solo
// delataría el bug en la franja 19:00–23:59 Bogota. Por eso la tabla incluye
// zonas con offset fuera de ±5h (Pacific/Pago_Pago = UTC−11, Pacific/Kiritimati
// = UTC+14): con el código roto al menos una de ellas cae en otra fecha de
// calendario y el test falla A CUALQUIER HORA.
func TestCDROIAccrual_SessionTimezoneInvariant(t *testing.T) {
	ctx := context.Background()
	pool, cleanup := pgContainer(t)
	defer cleanup()
	dsn := pool.Config().ConnString()

	const (
		days      = 10
		principal = 500.0
		tierID    = 1
	)
	want := expectedROI(t, ctx, pool, tierID, principal, days, false)

	sessionTZs := []string{
		"UTC",                // el de producción (shared/db/pool.go)
		bizTZ,                // el de negocio
		"Pacific/Pago_Pago",  // UTC−11
		"Pacific/Kiritimati", // UTC+14
	}

	for i, tz := range sessionTZs {
		tzPool := poolWithSessionTimezone(t, ctx, dsn, tz)
		eng := newTestEngine(tzPool)

		// Un CD idéntico por zona. Los CD de iteraciones previas ya devengaron
		// hoy → los salta la idempotencia, así que res.TotalUSD aísla el nuevo.
		seedCD(t, ctx, tzPool, fmt.Sprintf("tz%d@t.local", i), principal, tierID, days, 365)

		res, err := eng.AccrueCDROIDaily(ctx)
		tzPool.Close()
		if err != nil {
			t.Fatalf("accrue con session TimeZone=%s: %v", tz, err)
		}
		if res.Posted != 1 {
			t.Fatalf("session TimeZone=%s: esperaba 1 posteo (el CD nuevo), got %d", tz, res.Posted)
		}
		if got := res.TotalUSD.StringFixed(2); got != want {
			t.Fatalf("el devengo depende del TimeZone de la sesión: con TimeZone=%s dio %s, esperaba %s (%d días). "+
				"Las fechas del CD son de %s y deben castearse en esa zona, no en la de la sesión.",
				tz, got, want, days, bizTZ)
		}
	}
}
