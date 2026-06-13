package payments

import (
	"context"
	"errors"
	"testing"
)

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
