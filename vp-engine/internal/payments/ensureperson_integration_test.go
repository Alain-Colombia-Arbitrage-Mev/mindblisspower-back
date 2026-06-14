package payments

import (
	"context"
	"testing"
)

// TestEnsurePerson_Integration: crea la persona si no existe (idempotente) y
// parte el nombre; un 2º llamado devuelve el MISMO id.
func TestEnsurePerson_Integration(t *testing.T) {
	ctx := context.Background()
	pool, cleanup := pgContainer(t)
	defer cleanup()
	store := NewStore(pool)

	id1, err := store.EnsurePerson(ctx, "nuevo@t.local", "Ana María Pérez", "+573001112233")
	if err != nil {
		t.Fatalf("ensure1: %v", err)
	}
	if id1 == 0 {
		t.Fatal("id vacío")
	}
	var first, last, phone string
	_ = pool.QueryRow(ctx, `SELECT first_name, last_name, phone_number FROM mlm.person WHERE id=$1`, id1).Scan(&first, &last, &phone)
	if first != "Ana" || last != "María Pérez" || phone != "+573001112233" {
		t.Fatalf("split/phone mal: %s / %s / %s", first, last, phone)
	}
	// Idempotente: mismo email → mismo id, no duplica.
	id2, err := store.EnsurePerson(ctx, "NUEVO@t.local", "otro", "")
	if err != nil {
		t.Fatalf("ensure2: %v", err)
	}
	if id2 != id1 {
		t.Fatalf("idempotencia rota: %d != %d", id2, id1)
	}
	var n int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM mlm.person WHERE lower(email)='nuevo@t.local'`).Scan(&n)
	if n != 1 {
		t.Fatalf("esperaba 1 persona, hay %d", n)
	}
	// Sin nombre → usa la parte local del email.
	id3, _ := store.EnsurePerson(ctx, "solo.local@t.local", "", "")
	var f3 string
	_ = pool.QueryRow(ctx, `SELECT first_name FROM mlm.person WHERE id=$1`, id3).Scan(&f3)
	if f3 != "solo.local" {
		t.Fatalf("fallback de nombre mal: %s", f3)
	}
}
