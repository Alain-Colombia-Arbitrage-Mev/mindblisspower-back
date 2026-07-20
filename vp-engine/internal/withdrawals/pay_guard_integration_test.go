package withdrawals

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// approvedWithdrawal deja un retiro en 'approved' SIN verificación BMP elegible:
// RequestWithdrawal marca la fila 'unavailable'. Es el estado del que parte todo
// pago real, y el punto donde el candado tiene que morder.
//
// Que 'approved' funcione sin verificación BMP también es parte del contrato:
// el candado es SÓLO para 'paid'. Aprobar, rechazar y cancelar no sacan dinero y
// deben seguir disponibles para que el admin pueda resolver el caso.
func approvedWithdrawal(t *testing.T, store *Store, email string) int64 {
	t.Helper()
	ctx := context.Background()
	res, err := store.RequestWithdrawal(ctx, email, "200", "Banco X, cuenta 123456")
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if err := store.SetWithdrawalStatus(ctx, res.ID, "approved", "admin@test.local"); err != nil {
		t.Fatalf("approve: %v", err)
	}
	return res.ID
}

// Sin verificación BMP elegible, pagar se rechaza y no se postea débito.
func TestPay_NotEligible_Rejected(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "ne@test.local", "1000")

	store := NewStore(pool)
	id := approvedWithdrawal(t, store, "ne@test.local")

	// La solicitud quedó 'unavailable' (RequestWithdrawal sin BMP).
	err := store.SetWithdrawalStatus(ctx, id, "paid", "admin@test.local")
	if !errors.Is(err, ErrBMPNotEligible) {
		t.Fatalf("err = %v, want ErrBMPNotEligible", err)
	}
	assertNoDebit(t, pool, id)
	assertStatus(t, pool, id, "approved")
}

// bmp_status NULL (fila histórica, anterior a la migración 49) también se
// rechaza: la ausencia de verificación NO es permiso.
func TestPay_NullBMPStatus_Rejected(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "null@test.local", "1000")

	store := NewStore(pool)
	id := approvedWithdrawal(t, store, "null@test.local")

	if _, err := pool.Exec(ctx, `
		UPDATE mlm.withdrawal_request
		   SET bmp_status=NULL, bmp_verified_at=NULL WHERE id=$1`, id); err != nil {
		t.Fatalf("null verification: %v", err)
	}

	err := store.SetWithdrawalStatus(ctx, id, "paid", "admin@test.local")
	if !errors.Is(err, ErrBMPNotEligible) {
		t.Fatalf("err = %v, want ErrBMPNotEligible", err)
	}
	assertNoDebit(t, pool, id)
}

// bmp_status='allowed' pero bmp_verified_at NULL ⇒ vencida. Un 'allowed' sin
// fecha no se puede fechar, así que no se puede considerar fresco.
func TestPay_AllowedWithoutTimestamp_Rejected(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "nots@test.local", "1000")

	store := NewStore(pool)
	id := approvedWithdrawal(t, store, "nots@test.local")

	if _, err := pool.Exec(ctx, `
		UPDATE mlm.withdrawal_request
		   SET bmp_status='allowed', bmp_verified_at=NULL WHERE id=$1`, id); err != nil {
		t.Fatalf("clear timestamp: %v", err)
	}

	err := store.SetWithdrawalStatus(ctx, id, "paid", "admin@test.local")
	if !errors.Is(err, ErrBMPStale) {
		t.Fatalf("err = %v, want ErrBMPStale", err)
	}
	assertNoDebit(t, pool, id)
}

// Verificación elegible pero vieja (>15 min) ⇒ rechazado.
func TestPay_StaleVerification_Rejected(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "stale@test.local", "1000")

	store := NewStore(pool)
	id := approvedWithdrawal(t, store, "stale@test.local")

	if _, err := pool.Exec(ctx, `
		UPDATE mlm.withdrawal_request
		   SET bmp_status='allowed', bmp_verified_at = now() - interval '16 minutes'
		 WHERE id=$1`, id); err != nil {
		t.Fatalf("age verification: %v", err)
	}

	err := store.SetWithdrawalStatus(ctx, id, "paid", "admin@test.local")
	if !errors.Is(err, ErrBMPStale) {
		t.Fatalf("err = %v, want ErrBMPStale", err)
	}
	assertNoDebit(t, pool, id)
	assertStatus(t, pool, id, "approved")
}

// Justo DENTRO de la ventana (14 min) ⇒ paga. Ata el borde por el otro lado: sin
// esto, un candado que rechazara todo pasaría igual los tests de rechazo.
func TestPay_WithinFreshnessWindow_Succeeds(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "edge@test.local", "1000")

	store := NewStore(pool)
	id := approvedWithdrawal(t, store, "edge@test.local")

	if _, err := pool.Exec(ctx, `
		UPDATE mlm.withdrawal_request
		   SET bmp_status='allowed', bmp_verified_at = now() - interval '14 minutes'
		 WHERE id=$1`, id); err != nil {
		t.Fatalf("age verification: %v", err)
	}

	if err := store.SetWithdrawalStatus(ctx, id, "paid", "admin@test.local"); err != nil {
		t.Fatalf("pay dentro de la ventana: %v", err)
	}
	assertStatus(t, pool, id, "paid")
}

// Si la LECTURA de la verificación falla por infraestructura, no se paga. Un
// Postgres intermitente (o un drift de schema como el que simula este test
// renombrando la columna) no puede ser la vía por la que sale dinero sin
// verificar. Se asserta el efecto que importa: sin débito y sin avanzar de
// estado — no basta con que devuelva "algún" error.
func TestPay_VerificationQueryFails_FailsClosed(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "dberr@test.local", "1000")

	store := NewStore(pool)
	id := approvedWithdrawal(t, store, "dberr@test.local")

	// Verificación elegible y fresca: si el candado leyera bien, pagaría. Lo
	// único que lo impide es que la consulta se rompa.
	if err := store.RefreshBMPVerification(ctx, id, BMPVerification{
		CanWithdraw: true, CheckedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("refresh: %v", err)
	}

	// Se rompe SÓLO la lectura del candado: el UPDATE de estado y el posteo del
	// débito no tocan bmp_status, así que seguirían funcionando. Si el candado
	// fuera fail-open, el pago pasaría.
	if _, err := pool.Exec(ctx,
		`ALTER TABLE mlm.withdrawal_request RENAME COLUMN bmp_status TO bmp_status_broken`); err != nil {
		t.Fatalf("romper columna: %v", err)
	}

	err := store.SetWithdrawalStatus(ctx, id, "paid", "admin@test.local")
	if err == nil {
		t.Fatal("err = nil con la lectura de verificación rota; want fail-closed")
	}
	assertNoDebit(t, pool, id)
	assertStatus(t, pool, id, "approved")
}

// Verificación elegible y fresca ⇒ paga y postea el débito por el BRUTO.
func TestPay_FreshAndEligible_Succeeds(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "ok@test.local", "1000")

	store := NewStore(pool)
	id := approvedWithdrawal(t, store, "ok@test.local")

	if err := store.RefreshBMPVerification(ctx, id, BMPVerification{
		CanWithdraw: true, UserID: "u-1", CheckedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("refresh: %v", err)
	}

	if err := store.SetWithdrawalStatus(ctx, id, "paid", "admin@test.local"); err != nil {
		t.Fatalf("pay: %v", err)
	}

	var amount string
	if err := pool.QueryRow(ctx, `
		SELECT wm.amount::text FROM mlm.wallet_movement wm
		 WHERE wm.concept_id = 1013`).Scan(&amount); err != nil {
		t.Fatalf("debit: %v", err)
	}
	// El débito es por el BRUTO ($200), no por el neto ($192).
	if amount != "-200.00000000" {
		t.Fatalf("debit = %s, want -200.00000000", amount)
	}
}

// RefreshBMPVerification persiste el MOTIVO cuando BMP no habilita: la cola
// admin tiene que poder decir por qué, no sólo que no se puede pagar.
func TestRefreshBMPVerification_PersistsBlockReason(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "reason@test.local", "1000")

	store := NewStore(pool)
	id := approvedWithdrawal(t, store, "reason@test.local")

	if err := store.RefreshBMPVerification(ctx, id, BMPVerification{
		CanWithdraw: false, BlockReason: BlockKYCPending, CheckedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("refresh: %v", err)
	}

	var status string
	if err := pool.QueryRow(ctx,
		`SELECT bmp_status FROM mlm.withdrawal_request WHERE id=$1`, id).Scan(&status); err != nil {
		t.Fatalf("leer bmp_status: %v", err)
	}
	if status != BlockKYCPending {
		t.Fatalf("bmp_status = %q, want %q", status, BlockKYCPending)
	}
	// Y una verificación fresca pero NO elegible sigue sin habilitar el pago.
	if err := store.SetWithdrawalStatus(ctx, id, "paid", "admin@test.local"); !errors.Is(err, ErrBMPNotEligible) {
		t.Fatalf("err = %v, want ErrBMPNotEligible", err)
	}
	assertNoDebit(t, pool, id)
}

// Un segundo 'paid' no puede doble-postear.
func TestPay_Idempotent(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "idem@test.local", "1000")

	store := NewStore(pool)
	id := approvedWithdrawal(t, store, "idem@test.local")
	if err := store.RefreshBMPVerification(ctx, id, BMPVerification{
		CanWithdraw: true, CheckedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if err := store.SetWithdrawalStatus(ctx, id, "paid", "admin@test.local"); err != nil {
		t.Fatalf("pay 1: %v", err)
	}
	// Segundo intento: transición inválida (ya está 'paid').
	if err := store.SetWithdrawalStatus(ctx, id, "paid", "admin@test.local"); err == nil {
		t.Fatal("segundo pay no falló")
	}

	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM mlm.wallet_movement WHERE concept_id = 1013`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Fatalf("débitos = %d, want 1", n)
	}
}

// Un retiro rechazado no deja fee cobrado ni débito.
func TestReject_NoFeeCharged(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "rej@test.local", "1000")

	store := NewStore(pool)
	res, err := store.RequestWithdrawal(ctx, "rej@test.local", "200", "Banco X, cuenta 123456")
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if err := store.SetWithdrawalStatus(ctx, res.ID, "rejected", "admin@test.local"); err != nil {
		t.Fatalf("reject: %v", err)
	}
	assertNoDebit(t, pool, res.ID)
}

// El candado NO aplica a las transiciones que no mueven dinero. Sin verificación
// BMP elegible, aprobar / rechazar / cancelar tienen que seguir funcionando: si
// el candado se disparara acá, un afiliado sin cuenta BMP dejaría al admin sin
// forma de resolver su solicitud.
func TestNonPayTransitions_NotGuardedByBMP(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "trans@test.local", "5000")
	store := NewStore(pool)

	// requested → approved, sin verificación BMP.
	r1, err := store.RequestWithdrawal(ctx, "trans@test.local", "200", "Banco X, cuenta 123456")
	if err != nil {
		t.Fatalf("request 1: %v", err)
	}
	if err := store.SetWithdrawalStatus(ctx, r1.ID, "approved", "admin@test.local"); err != nil {
		t.Fatalf("approve sin BMP debió permitirse: %v", err)
	}
	// approved → cancelled, sin verificación BMP.
	if err := store.SetWithdrawalStatus(ctx, r1.ID, "cancelled", "admin@test.local"); err != nil {
		t.Fatalf("cancel sin BMP debió permitirse: %v", err)
	}

	// requested → rejected, sin verificación BMP.
	r2, err := store.RequestWithdrawal(ctx, "trans@test.local", "200", "Banco X, cuenta 123456")
	if err != nil {
		t.Fatalf("request 2: %v", err)
	}
	if err := store.SetWithdrawalStatus(ctx, r2.ID, "rejected", "admin@test.local"); err != nil {
		t.Fatalf("reject sin BMP debió permitirse: %v", err)
	}

	assertNoDebit(t, pool, r1.ID)
}

// ---------------------------------------------------------------------------
// Interruptor de despliegue: WITHDRAWALS_REQUIRE_BMP
// ---------------------------------------------------------------------------

// Con el interruptor en true (default), el retiro sin verificación válida NO se
// paga. Es el mismo escenario que el de abajo, montado idéntico, para que la
// única variable entre ambos sea la bandera.
func TestPay_RequireBMPTrue_Rejects(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "flagon@test.local", "1000")

	store := NewStore(pool)
	store.SetRequireBMP(true)
	id := approvedWithdrawal(t, store, "flagon@test.local")

	if err := store.SetWithdrawalStatus(ctx, id, "paid", "admin@test.local"); !errors.Is(err, ErrBMPNotEligible) {
		t.Fatalf("err = %v, want ErrBMPNotEligible", err)
	}
	assertNoDebit(t, pool, id)
	assertStatus(t, pool, id, "approved")
}

// Con el interruptor en false, EL MISMO retiro se paga — y bmp_status queda
// persistido igual, para que la cola admin siga mostrando el estado real del
// afiliado aunque el candado no esté bloqueando.
func TestPay_RequireBMPFalse_PaysAndStillPersistsStatus(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "flagoff@test.local", "1000")

	store := NewStore(pool)
	store.SetRequireBMP(false)
	id := approvedWithdrawal(t, store, "flagoff@test.local")

	if err := store.SetWithdrawalStatus(ctx, id, "paid", "admin@test.local"); err != nil {
		t.Fatalf("con WITHDRAWALS_REQUIRE_BMP=false el pago debió pasar: %v", err)
	}
	assertStatus(t, pool, id, "paid")

	// El débito sí se posteó (se pagó de verdad, no se saltó la contabilidad).
	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM mlm.wallet_movement WHERE concept_id = 1013`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Fatalf("débitos = %d, want 1", n)
	}

	// Y el estado BMP real sigue visible: el interruptor apaga el BLOQUEO, no la
	// observabilidad.
	var status *string
	if err := pool.QueryRow(ctx,
		`SELECT bmp_status FROM mlm.withdrawal_request WHERE id=$1`, id).Scan(&status); err != nil {
		t.Fatalf("leer bmp_status: %v", err)
	}
	if status == nil || *status != BlockUnavailable {
		t.Fatalf("bmp_status = %v, want %q persistido pese al interruptor", status, BlockUnavailable)
	}
}

// El interruptor NO afecta al candado de baneados: con REQUIRE_BMP=false, un
// baneado sigue sin cobrar.
func TestPay_RequireBMPFalse_StillBlocksBanned(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "flagban@test.local", "1000")

	store := NewStore(pool)
	store.SetRequireBMP(false)
	id := approvedWithdrawal(t, store, "flagban@test.local")

	if _, err := pool.Exec(ctx,
		`UPDATE mlm.person SET blacklisted = true WHERE email='flagban@test.local'`); err != nil {
		t.Fatalf("ban: %v", err)
	}

	if err := store.SetWithdrawalStatus(ctx, id, "paid", "admin@test.local"); !errors.Is(err, ErrSuspended) {
		t.Fatalf("err = %v, want ErrSuspended (el interruptor NO desactiva el candado de baneados)", err)
	}
	assertNoDebit(t, pool, id)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func assertNoDebit(t *testing.T, pool *pgxpool.Pool, id int64) {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM mlm.wallet_movement WHERE concept_id = 1013`).Scan(&n); err != nil {
		t.Fatalf("count debits: %v", err)
	}
	if n != 0 {
		t.Fatalf("débitos = %d, want 0 (retiro %d)", n, id)
	}
}

// assertStatus verifica que el retiro quedó en el estado esperado. Un rechazo
// del candado tiene que dejar la fila en 'approved': si además la moviera, el
// admin perdería la posibilidad de resolver el caso.
func assertStatus(t *testing.T, pool *pgxpool.Pool, id int64, want string) {
	t.Helper()
	var got string
	if err := pool.QueryRow(context.Background(),
		`SELECT status::text FROM mlm.withdrawal_request WHERE id=$1`, id).Scan(&got); err != nil {
		t.Fatalf("leer status: %v", err)
	}
	if got != want {
		t.Fatalf("status = %q, want %q", got, want)
	}
}
