package bonusengine

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
)

// seedCD crea person+affiliate (root, sin parent) con una wallet USD y un
// investment_cd con principal/tier dados, start_at hace `daysAgo` días y sin
// devengo previo. Devuelve el cd_id y el affiliate_id.
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
		VALUES ($1, $2, $3, now() - ($4 * interval '1 day'), now() + ($5 * interval '1 day'))
		RETURNING id`, affID, principal, tierID, daysAgo, lockDays).Scan(&cdID); err != nil {
		t.Fatalf("investment_cd: %v", err)
	}
	return cdID, affID
}

// TestCDROIAccrual_Base verifica el devengo a tasa base (sin directos calificantes):
// principal 500, tier 1 (base 25%), 10 días → 500*0.25/365*10 = 3.42.
func TestCDROIAccrual_Base(t *testing.T) {
	ctx := context.Background()
	pool, cleanup := pgContainer(t)
	defer cleanup()
	eng := newTestEngine(pool)

	cdID, affID := seedCD(t, ctx, pool, "base@t.local", 500, 1, 10, 365)

	res, err := eng.AccrueCDROIDaily(ctx)
	if err != nil {
		t.Fatalf("accrue: %v", err)
	}
	if res.Posted != 1 {
		t.Fatalf("expected 1 posted, got %d", res.Posted)
	}
	// 500 * 0.25 / 365 * 10 = 3.4246… → RoundDown(2) = 3.42
	if got := res.TotalUSD.StringFixed(2); got != "3.42" {
		t.Fatalf("expected 3.42 base ROI, got %s", got)
	}

	// El movimiento queda BLOQUEADO hasta matures_at (no madurado todavía).
	var avail string
	if err := pool.QueryRow(ctx, `
		SELECT to_char(available_at,'YYYY-MM-DD') FROM mlm.wallet_movement
		 WHERE affiliate_id=$1 AND concept_id=1006 LIMIT 1`, affID).Scan(&avail); err != nil {
		t.Fatalf("movement: %v", err)
	}
	var matures string
	_ = pool.QueryRow(ctx, `SELECT to_char(matures_at,'YYYY-MM-DD') FROM mlm.investment_cd WHERE id=$1`, cdID).Scan(&matures)
	if avail != matures {
		t.Fatalf("ROI available_at (%s) debe = matures_at (%s) [bloqueado 365d]", avail, matures)
	}

	// roi_accrued_usd y last_accrual_date actualizados.
	var accrued decimal.Decimal
	var lastNull bool
	_ = pool.QueryRow(ctx, `SELECT roi_accrued_usd, last_accrual_date IS NULL FROM mlm.investment_cd WHERE id=$1`, cdID).Scan(&accrued, &lastNull)
	if accrued.StringFixed(2) != "3.42" || lastNull {
		t.Fatalf("read model mal: accrued=%s lastNull=%v", accrued.StringFixed(2), lastNull)
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
// la tasa calificada. principal 1000, tier 2 (base 25% / qualified 35%), 10 días
// → 1000*0.35/365*10 = 9.58.
func TestCDROIAccrual_Qualified(t *testing.T) {
	ctx := context.Background()
	pool, cleanup := pgContainer(t)
	defer cleanup()
	eng := newTestEngine(pool)

	cdID, ownerAff := seedCD(t, ctx, pool, "owner@t.local", 1000, 2, 10, 365)

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
		_, _ = pool.Exec(ctx, `INSERT INTO mlm.investment_cd (affiliate_id, principal_usd, roi_tier_id, matures_at)
			VALUES ($1, 1000, 2, now()+interval '365 days')`, aid)
	}

	res, err := eng.AccrueCDROIDaily(ctx)
	if err != nil {
		t.Fatalf("accrue: %v", err)
	}
	// Owner: 1000*0.35/365*10 = 9.589 → 9.58. (Los directos tienen CD de hoy → días=0.)
	var ownerROI decimal.Decimal
	_ = pool.QueryRow(ctx, `SELECT roi_accrued_usd FROM mlm.investment_cd WHERE id=$1`, cdID).Scan(&ownerROI)
	if ownerROI.StringFixed(2) != "9.58" {
		t.Fatalf("esperaba ROI calificado 9.58 (tasa 35%%), got %s — ¿v_cd_qualification?", ownerROI.StringFixed(2))
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
}
