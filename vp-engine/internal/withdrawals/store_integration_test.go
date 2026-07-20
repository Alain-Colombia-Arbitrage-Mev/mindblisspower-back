package withdrawals

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
)

// itoa formatea un int64 en base 10 (helper para construir external_ref en tests).
func itoa(n int64) string { return strconv.FormatInt(n, 10) }

// queryAvailableForWithdrawal replica el invariante que internal/payments.GetMemberSummary
// exponía como AvailableForWithdrawal: AvailableBalanceSQL (disponible bruto,
// madurado, no congelado, excluye compra/fee) MENOS retiros pendientes
// (PendingWithdrawalsSQL, status requested/approved), con piso en 0 — misma
// fórmula que member.go:255-260. GetMemberSummary vive en internal/payments y
// NO se migra a internal/withdrawals; este helper consulta directamente las
// constantes SQL de balance.go para preservar el invariante en los tests
// migrados sin depender de ese símbolo.
func queryAvailableForWithdrawal(t *testing.T, ctx context.Context, pool *pgxpool.Pool, walletID, affID int64) string {
	t.Helper()
	var availStr, pendingStr string
	if err := pool.QueryRow(ctx, AvailableBalanceSQL, walletID).Scan(&availStr); err != nil {
		t.Fatalf("available: %v", err)
	}
	if err := pool.QueryRow(ctx, PendingWithdrawalsSQL, affID).Scan(&pendingStr); err != nil {
		t.Fatalf("pending: %v", err)
	}
	avail, _ := decimal.NewFromString(availStr)
	pending, _ := decimal.NewFromString(pendingStr)
	forWd := avail.Sub(pending)
	if forWd.IsNegative() {
		forWd = decimal.Zero
	}
	return forWd.StringFixed(2)
}

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

	// Mismo invariante que antes verificaba GetMemberSummary.AvailableForWithdrawal:
	// disponible bruto (AvailableBalanceSQL=500) menos el retiro pendiente
	// ($200 'requested', vía PendingWithdrawalsSQL) = 300.
	if avail := queryAvailableForWithdrawal(t, ctx, pool, walletID, affID); avail != "300.00" {
		t.Fatalf("available = %s, want 300.00", avail)
	}
	// Mismo invariante que antes verificaba sum.Withdrawals: existe exactamente
	// 1 solicitud para el afiliado, en estado 'requested'.
	var wCount int
	var wStatus string
	if err := pool.QueryRow(ctx, `
		SELECT count(*), max(status::text) FROM mlm.withdrawal_request WHERE affiliate_id=$1
	`, affID).Scan(&wCount, &wStatus); err != nil {
		t.Fatalf("withdrawals: %v", err)
	}
	if wCount != 1 || wStatus != "requested" {
		t.Fatalf("withdrawals count=%d status=%s, want 1/requested", wCount, wStatus)
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

	// I3: el error de una transición inválida DEBE ser identificable como
	// ErrInvalidTransition — es lo que el handler traduce a 409; cualquier otro
	// error (Postgres caído) sale como 500.
	if err := store.SetWithdrawalStatus(ctx, wrID, "no_existe", admin); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("status desconocido: err = %v, want ErrInvalidTransition", err)
	}

	// requested → paid: salto inválido (exige approved antes).
	if err := store.SetWithdrawalStatus(ctx, wrID, "paid", admin); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("requested->paid: err = %v, want ErrInvalidTransition (falta approved)", err)
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
	if err := store.SetWithdrawalStatus(ctx, wrID, "paid", admin); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("paid->paid: err = %v, want ErrInvalidTransition (re-pago)", err)
	}
	// paid → rejected: inválido.
	if err := store.SetWithdrawalStatus(ctx, wrID, "rejected", admin); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("paid->rejected: err = %v, want ErrInvalidTransition", err)
	}

	// C3: Store.IsAdmin es la tercera vía de isAdminEmail (admins concedidos
	// desde el panel, mlm.person.is_admin). Se valida contra la base real porque
	// es SQL copiado de payments.Store.IsAdmin.
	if ok, err := store.IsAdmin(ctx, admin); err != nil || ok {
		t.Fatalf("IsAdmin(is_admin=false) = %v, %v; want false, nil", ok, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE mlm.person SET is_admin=true WHERE lower(email)=lower($1)`, admin); err != nil {
		t.Fatalf("grant admin: %v", err)
	}
	// Case-insensitive: el email llega del token/BFF sin normalizar.
	if ok, err := store.IsAdmin(ctx, "ADMIN@Test.Local"); err != nil || !ok {
		t.Fatalf("IsAdmin(is_admin=true) = %v, %v; want true, nil", ok, err)
	}
	// Email inexistente ⇒ (false, nil): NO es un error de infraestructura.
	if ok, err := store.IsAdmin(ctx, "fantasma@test.local"); err != nil || ok {
		t.Fatalf("IsAdmin(inexistente) = %v, %v; want false, nil", ok, err)
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

	// Estado inicial: disponible = $500. Mismo invariante que antes verificaba
	// GetMemberSummary.AvailableForWithdrawal (sin retiros pendientes todavía,
	// PendingWithdrawalsSQL=0, así que coincide con el bruto de AvailableBalanceSQL).
	if avail := queryAvailableForWithdrawal(t, ctx, pool, walletID, affID); avail != "500.00" {
		t.Fatalf("disponible inicial = %s, want 500.00", avail)
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

	// (b) Disponible cae del $500 al $300 (500 comisión − 200 débito). El retiro
	// ya está 'paid' (no cuenta en PendingWithdrawalsSQL), así que el débito -200
	// posteado en mlm.wallet_movement se refleja directo en AvailableBalanceSQL.
	if avail := queryAvailableForWithdrawal(t, ctx, pool, walletID, affID); avail != "300.00" {
		t.Fatalf("disponible tras pago = %s, want 300.00", avail)
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

// El rastro de QUIÉN APROBÓ debe sobrevivir al pago. approved_by_person_id se
// escribía con COALESCE(subquery-por-email-del-actor, valor-anterior) en TODAS
// las transiciones; como todo admin tiene fila en mlm.person, el subquery nunca
// daba NULL y el pago siempre pisaba al aprobador con el pagador. Si aprobador y
// pagador eran personas distintas, la evidencia de four-eyes se perdía para
// siempre. Acá se aprueba con A y se paga con B, y la columna debe seguir en A.
//
// Antes de este test ningún test leía approved_by_person_id — por eso el defecto
// pasó inadvertido.
func TestSetWithdrawalStatus_PreservesApprover(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	// Dos admins DISTINTOS, ambos con fila en mlm.person (que es justo la razón
	// por la que el COALESCE viejo siempre sobrescribía).
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.country (id, iso2, name_es, name_en) VALUES (1,'CO','Colombia','Colombia');
		INSERT INTO mlm.asset (id, symbol, name, is_fiat, decimals) VALUES (1,'USD','US Dollar',true,2);
		INSERT INTO mlm.concept (id, kind, name_es, name_en, factor, requires_pair, active)
		  VALUES (11,'binary_bonus','Bono','Bonus',1,false,true);
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE VALUES (1,'Mem','Ber','member@test.local','0','active');
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status, is_admin)
		  OVERRIDING SYSTEM VALUE VALUES (2,'Ada','Aprueba','approver@test.local','1','active',true);
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status, is_admin)
		  OVERRIDING SYSTEM VALUE VALUES (3,'Beto','Paga','payer@test.local','2','active',true);
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
		INSERT INTO mlm.wallet (affiliate_id, asset_id, address, balance)
		VALUES ($1,1,'usd-1',0) RETURNING id`, affID).Scan(&walletID); err != nil {
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

	res, err := store.RequestWithdrawal(ctx, "member@test.local", "200", "Banco X, cuenta 123456")
	if err != nil {
		t.Fatalf("request: %v", err)
	}

	// Aprueba A (person_id=2).
	if err := store.SetWithdrawalStatus(ctx, res.ID, "approved", "approver@test.local"); err != nil {
		t.Fatalf("approve: %v", err)
	}
	var approver *int64
	if err := pool.QueryRow(ctx,
		`SELECT approved_by_person_id FROM mlm.withdrawal_request WHERE id=$1`, res.ID).Scan(&approver); err != nil {
		t.Fatalf("leer aprobador: %v", err)
	}
	if approver == nil || *approver != 2 {
		t.Fatalf("tras approve, approved_by_person_id = %v, want 2 (el aprobador)", approver)
	}

	// Paga B (person_id=3). NO debe tocar la columna.
	if err := store.SetWithdrawalStatus(ctx, res.ID, "paid", "payer@test.local"); err != nil {
		t.Fatalf("pay: %v", err)
	}

	var after *int64
	var status string
	if err := pool.QueryRow(ctx,
		`SELECT approved_by_person_id, status::text FROM mlm.withdrawal_request WHERE id=$1`,
		res.ID).Scan(&after, &status); err != nil {
		t.Fatalf("leer tras pago: %v", err)
	}
	if status != "paid" {
		t.Fatalf("status = %q, want paid", status)
	}
	if after == nil {
		t.Fatal("approved_by_person_id = NULL tras el pago, want 2 (el aprobador)")
	}
	if *after == 3 {
		t.Fatalf("approved_by_person_id = 3 (el PAGADOR): el pago pisó el rastro del aprobador")
	}
	if *after != 2 {
		t.Fatalf("approved_by_person_id = %d, want 2 (el aprobador)", *after)
	}

	// El pago sí ocurrió (el test no pasa por no haber pagado): un débito posteado.
	if n := countWithdrawalDebits(t, pool, ctx, res.ID); n != 1 {
		t.Fatalf("débitos del retiro = %d, want 1", n)
	}
}

// La migración 49 deja las columnas disponibles con los defaults correctos.
func TestMigration49_ColumnsAndDefaults(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	var feePct string
	if err := pool.QueryRow(ctx, `
		SELECT column_default FROM information_schema.columns
		 WHERE table_schema='mlm' AND table_name='withdrawal_request'
		   AND column_name='fee_pct'`).Scan(&feePct); err != nil {
		t.Fatalf("fee_pct default: %v", err)
	}
	if !strings.Contains(feePct, "0.04") {
		t.Fatalf("fee_pct default = %q, want contiene 0.04", feePct)
	}

	for _, col := range []string{"bmp_verified_at", "bmp_status", "bmp_email_used", "fee_usd", "net_usd"} {
		var n int
		if err := pool.QueryRow(ctx, `
			SELECT count(*) FROM information_schema.columns
			 WHERE table_schema='mlm' AND table_name='withdrawal_request' AND column_name=$1`,
			col).Scan(&n); err != nil {
			t.Fatalf("check %s: %v", col, err)
		}
		if n != 1 {
			t.Fatalf("columna %s ausente", col)
		}
	}
}

// El default de fee_pct debe leer EXACTAMENTE 0.0400 (numeric(5,4)), no solo
// "contener" 0.04 como substring — un INSERT que omite fee_pct debe heredar
// la fracción de comisión correcta.
func TestMigration49_FeePctDefaultValue(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.country (id, iso2, name_es, name_en) VALUES (1,'CO','Colombia','Colombia');
		INSERT INTO mlm.asset (id, symbol, name, is_fiat, decimals) VALUES (1,'USD','US Dollar',true,2);
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE VALUES (1,'Mem','Ber','member49@test.local','0','active');
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
		INSERT INTO mlm.wallet (affiliate_id, asset_id, address, balance) VALUES ($1,1,'usd-1',0) RETURNING id`,
		affID).Scan(&walletID); err != nil {
		t.Fatalf("wallet: %v", err)
	}

	var wrID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.withdrawal_request (affiliate_id, wallet_id, amount_usd, status)
		VALUES ($1,$2,200,'requested') RETURNING id`, affID, walletID).Scan(&wrID); err != nil {
		t.Fatalf("withdrawal: %v", err)
	}

	var feePct decimal.Decimal
	if err := pool.QueryRow(ctx,
		`SELECT fee_pct FROM mlm.withdrawal_request WHERE id=$1`, wrID).Scan(&feePct); err != nil {
		t.Fatalf("read fee_pct: %v", err)
	}
	if got := feePct.StringFixed(4); got != "0.0400" {
		t.Fatalf("fee_pct default = %s, want 0.0400", got)
	}
}

// El backfill de la migración 49 (fee_pct=0, fee_usd=0, net_usd=amount_usd
// WHERE fee_usd IS NULL) debe cubrir filas "viejas" (sin fee calculado) sin
// pisar filas que YA tienen un fee real calculado — incluso si la migración
// se re-aplica después de que existan retiros con fee real.
//
// pgContainer ya aplica la migración 49 una vez al levantar el schema. Este
// test simula el escenario temporal completo:
//  1. Una fila "vieja" se inserta SIN fee (como si fuera anterior a la
//     migración, o insertada por código que aún no calcula fee_usd).
//  2. Una fila "nueva" se inserta CON fee real ya calculado (como hará el
//     código de cobro de fee una vez implementado).
//  3. Se re-aplica la migración 49 completa contra el mismo pool.
//  4. Se verifica: la fila vieja queda backfillada (fee_usd=0,
//     net_usd=amount_usd); la fila nueva NO se toca.
func TestMigration49_BackfillDoesNotOverwriteRealFees(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.country (id, iso2, name_es, name_en) VALUES (1,'CO','Colombia','Colombia');
		INSERT INTO mlm.asset (id, symbol, name, is_fiat, decimals) VALUES (1,'USD','US Dollar',true,2);
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE VALUES (1,'Mem','Ber','member49b@test.local','0','active');
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
		INSERT INTO mlm.wallet (affiliate_id, asset_id, address, balance) VALUES ($1,1,'usd-1',0) RETURNING id`,
		affID).Scan(&walletID); err != nil {
		t.Fatalf("wallet: %v", err)
	}

	// (1) Fila vieja: sin fee_usd (columna nace NULL, sin default).
	var oldID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.withdrawal_request (affiliate_id, wallet_id, amount_usd, status)
		VALUES ($1,$2,200,'paid') RETURNING id`, affID, walletID).Scan(&oldID); err != nil {
		t.Fatalf("old withdrawal: %v", err)
	}
	var oldFeeUSDNull bool
	if err := pool.QueryRow(ctx,
		`SELECT fee_usd IS NULL FROM mlm.withdrawal_request WHERE id=$1`, oldID).Scan(&oldFeeUSDNull); err != nil {
		t.Fatalf("check old fee_usd: %v", err)
	}
	if !oldFeeUSDNull {
		t.Fatalf("precondición rota: fila vieja ya tiene fee_usd no-NULL")
	}

	// (2) Fila nueva: con fee real ya calculado (4% de 200 = 8.00; neto 192.00).
	var newID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.withdrawal_request
		  (affiliate_id, wallet_id, amount_usd, status, fee_pct, fee_usd, net_usd)
		VALUES ($1,$2,200,'requested',0.04,8.00,192.00) RETURNING id`,
		affID, walletID).Scan(&newID); err != nil {
		t.Fatalf("new withdrawal: %v", err)
	}

	// (3) Re-aplicar la migración 49 completa (no sólo el UPDATE) contra el
	// mismo pool — así se prueba idempotencia real de principio a fin.
	root := findRepoRoot(t)
	sql, err := os.ReadFile(filepath.Join(root, "_meta/migration/49_withdrawal_bmp_and_fee.sql"))
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	if err := applySchema(ctx, pool, stripPsqlMeta(string(sql))); err != nil {
		t.Fatalf("re-apply migration 49: %v", err)
	}

	// (4a) Fila vieja: backfillada.
	var oldFeePct, oldFeeUSD, oldNetUSD decimal.Decimal
	if err := pool.QueryRow(ctx, `
		SELECT fee_pct, fee_usd, net_usd FROM mlm.withdrawal_request WHERE id=$1`,
		oldID).Scan(&oldFeePct, &oldFeeUSD, &oldNetUSD); err != nil {
		t.Fatalf("read old after re-apply: %v", err)
	}
	if !oldFeePct.IsZero() {
		t.Fatalf("fila vieja: fee_pct = %s, want 0", oldFeePct)
	}
	if !oldFeeUSD.IsZero() {
		t.Fatalf("fila vieja: fee_usd = %s, want 0", oldFeeUSD)
	}
	if oldNetUSD.StringFixed(2) != "200.00" {
		t.Fatalf("fila vieja: net_usd = %s, want 200.00 (= amount_usd)", oldNetUSD)
	}

	// (4b) Fila nueva: intacta, el re-apply NO debió pisar el fee real.
	var newFeePct, newFeeUSD, newNetUSD decimal.Decimal
	if err := pool.QueryRow(ctx, `
		SELECT fee_pct, fee_usd, net_usd FROM mlm.withdrawal_request WHERE id=$1`,
		newID).Scan(&newFeePct, &newFeeUSD, &newNetUSD); err != nil {
		t.Fatalf("read new after re-apply: %v", err)
	}
	if newFeePct.StringFixed(4) != "0.0400" {
		t.Fatalf("fila nueva: fee_pct = %s, want 0.0400 (no debió tocarse)", newFeePct)
	}
	if newFeeUSD.StringFixed(2) != "8.00" {
		t.Fatalf("fila nueva: fee_usd = %s, want 8.00 (no debió tocarse)", newFeeUSD)
	}
	if newNetUSD.StringFixed(2) != "192.00" {
		t.Fatalf("fila nueva: net_usd = %s, want 192.00 (no debió tocarse)", newNetUSD)
	}
}

// El índice parcial sobre bmp_status (filtrado a status requested/approved)
// se crea con sintaxis válida y es usable.
func TestMigration49_PartialIndexExists(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	var n int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM pg_indexes
		 WHERE schemaname='mlm' AND tablename='withdrawal_request'
		   AND indexname='withdrawal_request_bmp_status_idx'`).Scan(&n); err != nil {
		t.Fatalf("check index: %v", err)
	}
	if n != 1 {
		t.Fatalf("índice withdrawal_request_bmp_status_idx ausente")
	}
}
