package payments

import (
	"context"
	"testing"
)

// TestGetAdminFinance_TreasurySubtractsNetWithdrawals verifica el bug de
// tesorería reportado: el afiliado solicita el BRUTO (amount_usd) y se le
// debita el bruto de su wallet interna, pero de la CAJA REAL solo sale el
// NETO (net_usd = amount_usd - fee_usd) hacia BMP — el fee (4%) se queda en
// la empresa. Restar amount_usd (bruto) en el cálculo de tesorería subestima
// la caja real en exactamente Σfee_usd.
//
// Fixture (bruto y neto DELIBERADAMENTE distintos para que el test falle si
// alguien vuelve a restar el bruto):
//   - Entrante: 1 purchase_intent 'paid' de amount_usd=5000.00 + fee_usd=50.00
//     ⇒ InflowsUSD = 5050.00.
//   - Sin comisiones distribuidas (ningún wallet_movement) ⇒ ese término es 0.
//   - Retiros:
//     w1 'paid'      amount=1000.00 fee=40.00 net=960.00 (fee real, 4%)
//     w2 'paid'      amount= 500.00 fee=20.00 net=480.00 (fee real, 4%)
//     w3 'paid'      amount= 200.00 fee= 0.00 net=200.00 (histórico backfill migración 49)
//     w4 'requested' amount= 300.00 fee=12.00 net=288.00 (NO debe contar en nada pagado)
//     w5 'approved'  amount= 250.00 fee=10.00 net=240.00 (NO debe contar en nada pagado)
//     w6 'rejected'  amount= 150.00 fee= 6.00  net=144.00 (excluido)
//     w7 'cancelled' amount=  90.00 fee= 3.60  net= 86.40 (excluido)
//
// Esperado:
//   - WithdrawalFeeIncomeUSD = 40.00+20.00+0.00 = 60.00 (SOLO 'paid').
//   - TreasuryUSD = 5050.00 − 0 − (960.00+480.00+200.00) = 5050.00 − 1640.00 = 3410.00.
//     Si el cálculo restara el BRUTO en su lugar, daría
//     5050.00 − (1000.00+500.00+200.00) = 5050.00 − 1700.00 = 3350.00 (mal, $60 de menos).
func TestGetAdminFinance_TreasurySubtractsNetWithdrawals(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.country (id, iso2, name_es, name_en) VALUES (1,'CO','Colombia','Colombia');
		INSERT INTO mlm.asset (id, symbol, name, is_fiat, decimals) VALUES (1,'USD','US Dollar',true,2);
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE VALUES (1,'Aff','Iliate','aff@t.local','0','active');
	`); err != nil {
		t.Fatalf("seed catálogos: %v", err)
	}

	var affID, walletID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.affiliate (person_id, parent_id, position, status, path, depth)
		VALUES (1, NULL, NULL, 'active', ''::ltree, 0) RETURNING id`).Scan(&affID); err != nil {
		t.Fatalf("seed affiliate: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.wallet (affiliate_id, asset_id, address, balance)
		VALUES ($1,1,'usd-'||$1::bigint::text,0) RETURNING id`, affID).Scan(&walletID); err != nil {
		t.Fatalf("seed wallet: %v", err)
	}

	// Entrante: un pack pagado de $5000 + $50 de fee de manejo.
	if _, err := pool.Exec(ctx, `
		INSERT INTO payments.purchase_intent
		  (user_id, person_id, affiliate_id, sponsor_affiliate_id, package_id, pv,
		   amount_usd, fee_usd, total_cents, currency, status, stripe_session_id, stripe_present)
		VALUES ('aff@t.local', 1, $1, NULL, 1001, 2500, 5000.00, 50.00, 505000, 'usd', 'paid', 'cs_fin_1', true)
	`, affID); err != nil {
		t.Fatalf("seed purchase_intent: %v", err)
	}

	// Retiros: bruto/fee/neto explícitos por fila (no dependemos del trigger de
	// cálculo de fee — este test es sobre el REPORTE, no sobre CalcFee).
	rows := []struct {
		status           string
		amount, fee, net string
	}{
		{"paid", "1000.00", "40.00", "960.00"},
		{"paid", "500.00", "20.00", "480.00"},
		{"paid", "200.00", "0.00", "200.00"}, // histórico: backfill migración 49
		{"requested", "300.00", "12.00", "288.00"},
		{"approved", "250.00", "10.00", "240.00"},
		{"rejected", "150.00", "6.00", "144.00"},
		{"cancelled", "90.00", "3.60", "86.40"},
	}
	for _, r := range rows {
		if _, err := pool.Exec(ctx, `
			INSERT INTO mlm.withdrawal_request
			  (affiliate_id, wallet_id, amount_usd, status, fee_pct, fee_usd, net_usd)
			VALUES ($1,$2,$3,$4,0.04,$5,$6)`,
			affID, walletID, r.amount, r.status, r.fee, r.net); err != nil {
			t.Fatalf("seed withdrawal_request(%s): %v", r.status, err)
		}
	}

	store := NewStore(pool)
	f, err := store.GetAdminFinance(ctx)
	if err != nil {
		t.Fatalf("GetAdminFinance: %v", err)
	}

	if f.InflowsUSD != "5050.00" {
		t.Fatalf("InflowsUSD = %q, want %q", f.InflowsUSD, "5050.00")
	}

	// Ingreso por comisión de retiro: SOLO 'paid'. Ni requested, ni approved,
	// ni rejected, ni cancelled deben aportar aunque tengan fee_usd > 0.
	if f.WithdrawalFeeIncomeUSD != "60.00" {
		t.Fatalf("WithdrawalFeeIncomeUSD = %q, want %q (solo retiros 'paid': 40+20+0)",
			f.WithdrawalFeeIncomeUSD, "60.00")
	}

	// WithdrawalsPaidUSD sigue siendo el BRUTO (lo debitado de la wallet interna).
	if f.WithdrawalsPaidUSD != "1700.00" {
		t.Fatalf("WithdrawalsPaidUSD = %q, want %q (bruto: 1000+500+200)",
			f.WithdrawalsPaidUSD, "1700.00")
	}

	// El corazón del fix: la tesorería debe reflejar la salida NETA (1640.00),
	// no la bruta (1700.00). Con el bug (restar bruto) esto daría "3350.00".
	if f.TreasuryUSD != "3410.00" {
		t.Fatalf("TreasuryUSD = %q, want %q (entrante 5050.00 - comisiones 0 - retiros NETOS 1640.00; "+
			"si el cálculo restara el bruto daría 3350.00, mal por el fee de $60 que nunca salió de caja)",
			f.TreasuryUSD, "3410.00")
	}
}

// TestGetAdminFinance_NullNetUSDFallsBackToGross cubre la fila "intermedia"
// documentada en la migración 49: un binario viejo, en la ventana de deploy,
// puede insertar un retiro 'paid' sin fee_usd/net_usd (ambos nacen NULL, sin
// default — no hay backfill retroactivo para ellas). Ante esa incertidumbre,
// el cálculo de tesorería debe asumir que no se cobró fee (neto = bruto) en
// vez de tratar el NULL como 0 (lo que inflaría la tesorería reportada).
func TestGetAdminFinance_NullNetUSDFallsBackToGross(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.country (id, iso2, name_es, name_en) VALUES (1,'CO','Colombia','Colombia');
		INSERT INTO mlm.asset (id, symbol, name, is_fiat, decimals) VALUES (1,'USD','US Dollar',true,2);
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE VALUES (1,'Aff','Iliate','aff2@t.local','0','active');
	`); err != nil {
		t.Fatalf("seed catálogos: %v", err)
	}

	var affID, walletID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.affiliate (person_id, parent_id, position, status, path, depth)
		VALUES (1, NULL, NULL, 'active', ''::ltree, 0) RETURNING id`).Scan(&affID); err != nil {
		t.Fatalf("seed affiliate: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.wallet (affiliate_id, asset_id, address, balance)
		VALUES ($1,1,'usd-'||$1::bigint::text,0) RETURNING id`, affID).Scan(&walletID); err != nil {
		t.Fatalf("seed wallet: %v", err)
	}

	// Entrante conocido para poder aislar el término de retiros.
	if _, err := pool.Exec(ctx, `
		INSERT INTO payments.purchase_intent
		  (user_id, person_id, affiliate_id, sponsor_affiliate_id, package_id, pv,
		   amount_usd, fee_usd, total_cents, currency, status, stripe_session_id, stripe_present)
		VALUES ('aff2@t.local', 1, $1, NULL, 1001, 500, 1000.00, 10.00, 101000, 'usd', 'paid', 'cs_fin_2', true)
	`, affID); err != nil {
		t.Fatalf("seed purchase_intent: %v", err)
	}

	// Fila "intermedia": paid, sin fee_usd/net_usd (columnas nacen NULL). El
	// CHECK de la migración 49 lo permite explícitamente (fee_usd IS NULL).
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.withdrawal_request (affiliate_id, wallet_id, amount_usd, status)
		VALUES ($1,$2,300.00,'paid')`, affID, walletID); err != nil {
		t.Fatalf("seed withdrawal_request NULL fee/net: %v", err)
	}

	store := NewStore(pool)
	f, err := store.GetAdminFinance(ctx)
	if err != nil {
		t.Fatalf("GetAdminFinance: %v", err)
	}

	// fee_usd NULL no debe sumar a WithdrawalFeeIncomeUSD (SUM ignora NULL).
	// COALESCE(SUM(...),0)::text renderiza "0" (no "0.00") cuando el SUM da
	// NULL — mismo patrón ya usado por el resto de los agregados de este
	// archivo (p.ej. WithdrawalsPendingUSD sin filas pendientes).
	if f.WithdrawalFeeIncomeUSD != "0" {
		t.Fatalf("WithdrawalFeeIncomeUSD = %q, want %q (fee_usd NULL no debe contarse como ingreso)",
			f.WithdrawalFeeIncomeUSD, "0")
	}

	// Tesorería: 1010.00 (inflow) − 0 (comisiones) − 300.00 (COALESCE(net_usd,
	// amount_usd) ⇒ neto asumido = bruto, ya que no consta fee real) = 710.00.
	if f.TreasuryUSD != "710.00" {
		t.Fatalf("TreasuryUSD = %q, want %q (net_usd NULL debe caer a amount_usd, no a 0)",
			f.TreasuryUSD, "710.00")
	}
}
