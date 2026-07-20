package withdrawals

import (
	"context"
	"testing"
	"time"
)

// La cola admin tiene que traer lo necesario para EJECUTAR el pago externo, que
// es manual: cuánto transferir (net_usd) y a qué correo BMP (bmp_email_used).
// Con sólo amount_usd + status, el admin debita el bruto y después no tiene de
// dónde sacar el destino — el vínculo BMP se pierde en el último tramo.
//
// Se verifican también fee_usd y el par bmp_status/bmp_verified_at, que le dicen
// al admin si el candado dejará pagar ANTES de intentarlo.
func TestListWithdrawals_ExposesPayoutFields(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "list@test.local", "1000")

	store := NewStore(pool)
	checked := time.Now().UTC()
	res, err := store.RequestWithdrawalWithBMP(ctx, "list@test.local", "200", "Banco X, cuenta 123456",
		"alterno@bmp.com", BMPVerification{Exists: true, CanWithdraw: true, UserID: "u-l", CheckedAt: checked})
	if err != nil {
		t.Fatalf("request: %v", err)
	}

	items, total, err := store.ListWithdrawals(ctx, "", 25, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if total != 1 || len(items) != 1 {
		t.Fatalf("total=%d len=%d, want 1/1", total, len(items))
	}
	w := items[0]
	if w.ID != res.ID {
		t.Fatalf("id = %d, want %d", w.ID, res.ID)
	}

	// Los campos preexistentes siguen intactos: los nuevos se AGREGAN.
	if w.AmountUSD != "200.00" || w.Status != "requested" || w.Email != "list@test.local" {
		t.Fatalf("campos previos alterados: amount=%q status=%q email=%q", w.AmountUSD, w.Status, w.Email)
	}

	// 4% de $200 = $8 de fee, $192 netos. Es lo que el admin debe transferir.
	if w.FeeUSD != "8.00" {
		t.Fatalf("fee_usd = %q, want %q", w.FeeUSD, "8.00")
	}
	if w.NetUSD != "192.00" {
		t.Fatalf("net_usd = %q, want %q", w.NetUSD, "192.00")
	}
	// Y a dónde: el correo BMP con el que se verificó, no el de sesión.
	if w.BMPEmailUsed != "alterno@bmp.com" {
		t.Fatalf("bmp_email_used = %q, want %q", w.BMPEmailUsed, "alterno@bmp.com")
	}
	if w.BMPStatus != "allowed" {
		t.Fatalf("bmp_status = %q, want %q", w.BMPStatus, "allowed")
	}
	if w.BMPVerifiedAt != checked.Format("2006-01-02T15:04:05Z") {
		t.Fatalf("bmp_verified_at = %q, want %q", w.BMPVerifiedAt, checked.Format("2006-01-02T15:04:05Z"))
	}
}

// Fila sin verificación BMP: los campos nuevos salen como cadena vacía, no
// rompen el scan ni emiten null. Cubre las filas históricas (anteriores a la
// migración 49) y las creadas con el cliente BMP deshabilitado.
func TestListWithdrawals_NullBMPFieldsBecomeEmpty(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "listnull@test.local", "1000")

	store := NewStore(pool)
	res, err := store.RequestWithdrawal(ctx, "listnull@test.local", "200", "Banco X, cuenta 123456")
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE mlm.withdrawal_request
		   SET bmp_status=NULL, bmp_verified_at=NULL, bmp_email_used=NULL,
		       fee_usd=NULL, net_usd=NULL
		 WHERE id=$1`, res.ID); err != nil {
		t.Fatalf("nullify: %v", err)
	}

	items, _, err := store.ListWithdrawals(ctx, "", 25, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("len = %d, want 1", len(items))
	}
	w := items[0]
	for name, got := range map[string]string{
		"fee_usd": w.FeeUSD, "net_usd": w.NetUSD, "bmp_status": w.BMPStatus,
		"bmp_email_used": w.BMPEmailUsed, "bmp_verified_at": w.BMPVerifiedAt,
	} {
		if got != "" {
			t.Fatalf("%s = %q, want cadena vacía", name, got)
		}
	}
}
