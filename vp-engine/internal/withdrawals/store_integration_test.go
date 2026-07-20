package withdrawals

import (
	"context"
	"errors"
	"strconv"
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
