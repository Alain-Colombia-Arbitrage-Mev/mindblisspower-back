package withdrawals

import (
	"context"
	"errors"
	"testing"
)

// El escenario que dejaba la wallet en negativo: el retiro se aprueba con saldo
// suficiente y, DESPUÉS, ops congela los movimientos del afiliado por sospecha
// de fraude. Sin re-validar al pagar, el UPDATE posteaba el débito igual
// (fn_validate_movement sólo mira el signo del monto, no que la wallet quede
// no-negativa) y la wallet terminaba en -$200.
func TestPay_FrozenAfterApproval_Rejected(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "frozen@test.local", "1000")

	store := NewStore(pool)
	id := approvedWithdrawal(t, store, "frozen@test.local")
	grantFreshBMP(t, store, id)

	// Ops congela: el saldo disponible pasa a 0 (AvailableBalanceSQL excluye los
	// movimientos congelados). El retiro ya aprobado sigue en pie.
	if _, err := pool.Exec(ctx, `
		UPDATE mlm.wallet_movement wm SET is_frozen = true
		  FROM mlm.wallet w
		 WHERE w.id = wm.wallet_id
		   AND w.affiliate_id = (SELECT affiliate_id FROM mlm.withdrawal_request WHERE id=$1)`,
		id); err != nil {
		t.Fatalf("congelar movimientos: %v", err)
	}

	err := store.SetWithdrawalStatus(ctx, id, "paid", "admin@test.local")
	if !errors.Is(err, ErrInsufficientAtPay) {
		t.Fatalf("err = %v, want ErrInsufficientAtPay", err)
	}
	// Ni débito ni avance de estado: el admin conserva la fila para resolverla.
	assertNoDebit(t, pool, id)
	assertStatus(t, pool, id, "approved")

	// Y la wallet NO quedó en negativo.
	var bal string
	if err := pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(wm.amount),0)::text
		  FROM mlm.wallet_movement wm
		  JOIN mlm.withdrawal_request wr ON wr.wallet_id = wm.wallet_id
		 WHERE wr.id = $1`, id).Scan(&bal); err != nil {
		t.Fatalf("leer saldo: %v", err)
	}
	if bal != "1000.00000000" {
		t.Fatalf("saldo = %s, want 1000.00000000 (sin débito)", bal)
	}
}

// La re-validación NO puede restar el propio retiro dos veces. Este retiro está
// en 'approved', así que YA figura entre los pendientes: si el cálculo usara
// `disponible - pendientes` sin excluirlo, un afiliado con exactamente el saldo
// justo vería su pago rechazado.
//
// Saldo $200, retiro $200: pasa el filo de la navaja.
func TestPay_ExactBalance_DoesNotDoubleCountItself(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "exact@test.local", "200")

	store := NewStore(pool)
	id := approvedWithdrawal(t, store, "exact@test.local") // pide 200
	grantFreshBMP(t, store, id)

	if err := store.SetWithdrawalStatus(ctx, id, "paid", "admin@test.local"); err != nil {
		t.Fatalf("pago con saldo exacto debió pasar: %v", err)
	}
	assertStatus(t, pool, id, "paid")
}

// Un SEGUNDO retiro pendiente del mismo afiliado sí reserva saldo: pagar el
// primero no puede ignorar lo que el segundo tiene apartado.
//
// Saldo $300, dos retiros de $200. Al pagar el primero: 200 > 300 - 200 ⇒ se
// rechaza. (Ambos pasaron la validación al solicitar sólo porque el segundo se
// inserta acá directo, saltándose RequestWithdrawal — que lo habría rebotado.)
func TestPay_OtherPendingWithdrawalStillReservesBalance(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	affID, walletID := seedMemberWithBalance(t, pool, "two@test.local", "300")

	store := NewStore(pool)
	id := approvedWithdrawal(t, store, "two@test.local") // 200, approved
	grantFreshBMP(t, store, id)

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.withdrawal_request
		  (affiliate_id, wallet_id, amount_usd, status, comments, fee_pct, fee_usd, net_usd)
		VALUES ($1, $2, 200, 'requested', 'Banco Y, cuenta 999999', 0.04, 8, 192)`,
		affID, walletID); err != nil {
		t.Fatalf("segundo retiro: %v", err)
	}

	err := store.SetWithdrawalStatus(ctx, id, "paid", "admin@test.local")
	if !errors.Is(err, ErrInsufficientAtPay) {
		t.Fatalf("err = %v, want ErrInsufficientAtPay", err)
	}
	assertNoDebit(t, pool, id)
	assertStatus(t, pool, id, "approved")
}
