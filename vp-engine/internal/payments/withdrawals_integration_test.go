package payments

import (
	"context"
	"errors"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// itoa formatea un int64 en base 10 (helper para construir external_ref en tests).
func itoa(n int64) string { return strconv.FormatInt(n, 10) }

// Valida la solicitud de retiro: mínimo $100, tope = disponible, descuento de
// pendientes e inserción en mlm.withdrawal_request. Requiere Docker.
func TestRequestWithdrawal_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	// Miembro con afiliado, wallet USD y una comisión madurada de $500.
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.country (id, iso2, name_es, name_en) VALUES (1,'CO','Colombia','Colombia');
		INSERT INTO mlm.asset (id, symbol, name, is_fiat, decimals) VALUES (1,'USD','US Dollar',true,2);
		INSERT INTO mlm.concept (id, kind, name_es, name_en, factor, requires_pair, active)
		  VALUES (11,'binary_bonus','Bono','Bonus',1,false,true);
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE VALUES (1,'Mem','Ber','member@test.local','0','active');
	`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	var affID, walletID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.affiliate (person_id, parent_id, position, status, path, depth)
		VALUES (1, NULL, NULL, 'active', ''::ltree, 0) RETURNING id`).Scan(&affID); err != nil {
		t.Fatalf("affiliate: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.wallet (affiliate_id, asset_id, address, balance) VALUES ($1,1,'usd-1',0) RETURNING id`, affID).Scan(&walletID); err != nil {
		t.Fatalf("wallet: %v", err)
	}
	var txnID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.transaction (external_ref, description, status, initiated_by_person_id)
		VALUES ('seed:bonus1','bono test','posted',1) RETURNING id`).Scan(&txnID); err != nil {
		t.Fatalf("txn: %v", err)
	}
	// Comisión madurada (available_at ayer), no congelada.
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.wallet_movement (transaction_id, wallet_id, affiliate_id, concept_id, amount, posted_at, available_at)
		VALUES ($1,$2,$3,11,500,now(),current_date - 1)`, txnID, walletID, affID); err != nil {
		t.Fatalf("movement: %v", err)
	}

	store := NewStore(pool)
	const email = "member@test.local"
	const bank = "Banco X, cuenta 123456, titular Member"

	// Mínimo: $50 → rechazado.
	if _, err := store.RequestWithdrawal(ctx, email, "50", bank); !errors.Is(err, ErrMinWithdrawal) {
		t.Fatalf("min: got %v, want ErrMinWithdrawal", err)
	}
	// Excede disponible: $600 → insuficiente.
	if _, err := store.RequestWithdrawal(ctx, email, "600", bank); !errors.Is(err, ErrInsufficient) {
		t.Fatalf("over: got %v, want ErrInsufficient", err)
	}
	// Éxito: $200.
	res, err := store.RequestWithdrawal(ctx, email, "200", bank)
	if err != nil || res.Status != "requested" || res.ID == 0 {
		t.Fatalf("success: res=%+v err=%v", res, err)
	}
	// Pendiente descuenta: quedan $300; pedir $400 → insuficiente.
	if _, err := store.RequestWithdrawal(ctx, email, "400", bank); !errors.Is(err, ErrInsufficient) {
		t.Fatalf("pending-aware: got %v, want ErrInsufficient", err)
	}

	// Resumen refleja disponible neto = 300 y 1 retiro.
	sum, err := store.GetMemberSummary(ctx, email)
	if err != nil {
		t.Fatalf("summary: %v", err)
	}
	if sum.AvailableForWithdrawal != "300.00" {
		t.Fatalf("available = %s, want 300.00", sum.AvailableForWithdrawal)
	}
	if len(sum.Withdrawals) != 1 || sum.Withdrawals[0].Status != "requested" {
		t.Fatalf("withdrawals = %+v", sum.Withdrawals)
	}
}

// C2: el guard de transición sólo permite requested→approved→paid (y rejected/
// cancelled desde estados válidos). Rechaza saltos (requested→paid) y re-pagos
// (paid→paid). Requiere Docker.
func TestSetWithdrawalStatus_TransitionGuard_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.country (id, iso2, name_es, name_en) VALUES (1,'CO','Colombia','Colombia');
		INSERT INTO mlm.asset (id, symbol, name, is_fiat, decimals) VALUES (1,'USD','US Dollar',true,2);
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE VALUES (1,'Adm','In','admin@test.local','0','active');
	`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	var affID, walletID, wrID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.affiliate (person_id, parent_id, position, status, path, depth)
		VALUES (1, NULL, NULL, 'active', ''::ltree, 0) RETURNING id`).Scan(&affID); err != nil {
		t.Fatalf("affiliate: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.wallet (affiliate_id, asset_id, address, balance) VALUES ($1,1,'usd-1',0) RETURNING id`, affID).Scan(&walletID); err != nil {
		t.Fatalf("wallet: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.withdrawal_request (affiliate_id, wallet_id, amount_usd, status)
		VALUES ($1,$2,200,'requested') RETURNING id`, affID, walletID).Scan(&wrID); err != nil {
		t.Fatalf("withdrawal: %v", err)
	}

	store := NewStore(pool)
	const admin = "admin@test.local"

	// requested → paid: salto inválido (exige approved antes).
	if err := store.SetWithdrawalStatus(ctx, wrID, "paid", admin); err == nil {
		t.Fatal("requested->paid debió fallar (falta approved)")
	}
	// requested → approved: ok.
	if err := store.SetWithdrawalStatus(ctx, wrID, "approved", admin); err != nil {
		t.Fatalf("requested->approved: %v", err)
	}
	// approved → paid: ok.
	if err := store.SetWithdrawalStatus(ctx, wrID, "paid", admin); err != nil {
		t.Fatalf("approved->paid: %v", err)
	}
	// paid → paid: re-pago, inválido.
	if err := store.SetWithdrawalStatus(ctx, wrID, "paid", admin); err == nil {
		t.Fatal("paid->paid debió fallar (re-pago)")
	}
	// paid → rejected: inválido.
	if err := store.SetWithdrawalStatus(ctx, wrID, "rejected", admin); err == nil {
		t.Fatal("paid->rejected debió fallar")
	}

	var final string
	if err := pool.QueryRow(ctx, `SELECT status::text FROM mlm.withdrawal_request WHERE id=$1`, wrID).Scan(&final); err != nil {
		t.Fatalf("read final: %v", err)
	}
	if final != "paid" {
		t.Fatalf("estado final = %s, want paid", final)
	}
}

// C1: al marcar 'paid', SetWithdrawalStatus postea el DÉBITO contable en la misma
// transacción, de modo que el saldo disponible BAJA por el monto pagado y la misma
// comisión no puede retirarse dos veces. Verifica: (a) exactamente un
// wallet_movement NEGATIVO con external_ref='withdrawal:<id>'; (b) el disponible
// cae por el monto pagado; (c) re-pagar es idempotente (sin segundo débito, además
// bloqueado por el guard C2); (d) un retiro NO aprobado no puede pagarse.
// Requiere Docker.
func TestSetWithdrawalStatus_PostsDebit_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	// Miembro con afiliado, wallet USD y una comisión madurada de $500.
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.country (id, iso2, name_es, name_en) VALUES (1,'CO','Colombia','Colombia');
		INSERT INTO mlm.asset (id, symbol, name, is_fiat, decimals) VALUES (1,'USD','US Dollar',true,2);
		INSERT INTO mlm.concept (id, kind, name_es, name_en, factor, requires_pair, active)
		  VALUES (11,'binary_bonus','Bono','Bonus',1,false,true);
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE VALUES (1,'Mem','Ber','member@test.local','0','active');
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE VALUES (2,'Adm','In','admin@test.local','0','active');
	`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	var affID, walletID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.affiliate (person_id, parent_id, position, status, path, depth)
		VALUES (1, NULL, NULL, 'active', ''::ltree, 0) RETURNING id`).Scan(&affID); err != nil {
		t.Fatalf("affiliate: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.wallet (affiliate_id, asset_id, address, balance) VALUES ($1,1,'usd-1',0) RETURNING id`, affID).Scan(&walletID); err != nil {
		t.Fatalf("wallet: %v", err)
	}
	var txnID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.transaction (external_ref, description, status, initiated_by_person_id)
		VALUES ('seed:bonus1','bono test','posted',1) RETURNING id`).Scan(&txnID); err != nil {
		t.Fatalf("txn: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.wallet_movement (transaction_id, wallet_id, affiliate_id, concept_id, amount, posted_at, available_at)
		VALUES ($1,$2,$3,11,500,now(),current_date - 1)`, txnID, walletID, affID); err != nil {
		t.Fatalf("movement: %v", err)
	}

	store := NewStore(pool)
	const member = "member@test.local"
	const admin = "admin@test.local"
	const bank = "Banco X, cuenta 123456, titular Member"

	// Estado inicial: disponible = $500.
	if sum, err := store.GetMemberSummary(ctx, member); err != nil {
		t.Fatalf("summary inicial: %v", err)
	} else if sum.AvailableForWithdrawal != "500.00" {
		t.Fatalf("disponible inicial = %s, want 500.00", sum.AvailableForWithdrawal)
	}

	// Solicitar $200.
	res, err := store.RequestWithdrawal(ctx, member, "200", bank)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	wrID := res.ID

	// (d) Un retiro NO aprobado (status 'requested') no puede pagarse.
	if err := store.SetWithdrawalStatus(ctx, wrID, "paid", admin); err == nil {
		t.Fatal("requested->paid debió fallar (falta approved)")
	}
	// Y NO debió postear ningún débito.
	if n := countWithdrawalDebits(t, pool, ctx, wrID); n != 0 {
		t.Fatalf("débitos tras pago inválido = %d, want 0", n)
	}

	// Aprobar y pagar.
	if err := store.SetWithdrawalStatus(ctx, wrID, "approved", admin); err != nil {
		t.Fatalf("approve: %v", err)
	}
	if err := store.SetWithdrawalStatus(ctx, wrID, "paid", admin); err != nil {
		t.Fatalf("pay: %v", err)
	}

	// (a) Exactamente un wallet_movement negativo con external_ref='withdrawal:<id>'.
	extRef := "withdrawal:" + itoa(wrID)
	var cnt int
	var amt string
	if err := pool.QueryRow(ctx, `
		SELECT count(*), COALESCE(SUM(wm.amount),0)::text
		  FROM mlm.wallet_movement wm
		  JOIN mlm.transaction t ON t.id = wm.transaction_id
		 WHERE t.external_ref = $1`, extRef).Scan(&cnt, &amt); err != nil {
		t.Fatalf("count debit: %v", err)
	}
	if cnt != 1 {
		t.Fatalf("movimientos con %s = %d, want 1", extRef, cnt)
	}
	if amt != "-200.00000000" {
		t.Fatalf("monto del débito = %s, want -200.00000000", amt)
	}

	// (b) Disponible cae del $500 al $300 (500 comisión − 200 débito).
	sum, err := store.GetMemberSummary(ctx, member)
	if err != nil {
		t.Fatalf("summary tras pago: %v", err)
	}
	if sum.AvailableForWithdrawal != "300.00" {
		t.Fatalf("disponible tras pago = %s, want 300.00", sum.AvailableForWithdrawal)
	}

	// (c) Re-pagar es idempotente: el guard C2 lo bloquea Y no se postea 2º débito.
	if err := store.SetWithdrawalStatus(ctx, wrID, "paid", admin); err == nil {
		t.Fatal("paid->paid debió fallar (re-pago)")
	}
	if n := countWithdrawalDebits(t, pool, ctx, wrID); n != 1 {
		t.Fatalf("débitos tras re-pago = %d, want 1 (idempotente)", n)
	}
}

// countWithdrawalDebits cuenta wallet_movements ligados al external_ref del retiro.
func countWithdrawalDebits(t *testing.T, pool *pgxpool.Pool, ctx context.Context, wrID int64) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, `
		SELECT count(*)
		  FROM mlm.wallet_movement wm
		  JOIN mlm.transaction t ON t.id = wm.transaction_id
		 WHERE t.external_ref = $1`, "withdrawal:"+itoa(wrID)).Scan(&n); err != nil {
		t.Fatalf("count withdrawal debits: %v", err)
	}
	return n
}
