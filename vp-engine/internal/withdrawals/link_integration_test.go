package withdrawals

import (
	"context"
	"errors"
	"testing"
	"time"
)

// El vínculo nace 'pending_admin' y NO se usa hasta ser aprobado.
func TestRequestBMPLink_StartsPendingAndUnusable(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "link@test.local", "1000")

	store := NewStore(pool)
	v := BMPVerification{Exists: true, CanWithdraw: true, UserID: "u-9", CheckedAt: time.Now().UTC()}

	id, err := store.RequestBMPLink(ctx, "link@test.local", "otro@bmp.com", "1.2.3.4", v)
	if err != nil {
		t.Fatalf("request link: %v", err)
	}
	if id == 0 {
		t.Fatal("id = 0")
	}

	// Aún NO hay email aprobado.
	got, err := store.ApprovedBMPEmail(ctx, "link@test.local")
	if err != nil {
		t.Fatalf("approved email: %v", err)
	}
	if got != "" {
		t.Fatalf("approved email = %q, want vacío", got)
	}

	// El bmp_user_id que devolvió BMP queda anclado para auditoría: el email
	// puede cambiar en BMP, el userId no.
	var userID string
	if err := pool.QueryRow(ctx,
		`SELECT COALESCE(bmp_user_id,'') FROM mlm.bmp_account_link WHERE id=$1`, id).Scan(&userID); err != nil {
		t.Fatalf("leer bmp_user_id: %v", err)
	}
	if userID != "u-9" {
		t.Fatalf("bmp_user_id = %q, want u-9", userID)
	}

	// Y la IP del solicitante también.
	var ip string
	if err := pool.QueryRow(ctx,
		`SELECT COALESCE(host(requested_from_ip),'') FROM mlm.bmp_account_link WHERE id=$1`, id).Scan(&ip); err != nil {
		t.Fatalf("leer requested_from_ip: %v", err)
	}
	if ip != "1.2.3.4" {
		t.Fatalf("requested_from_ip = %q, want 1.2.3.4", ip)
	}
}

// Una segunda solicitud pendiente del mismo afiliado se rechaza.
func TestRequestBMPLink_OnlyOnePending(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "dup@test.local", "1000")

	store := NewStore(pool)
	v := BMPVerification{Exists: true, CanWithdraw: true, CheckedAt: time.Now().UTC()}

	if _, err := store.RequestBMPLink(ctx, "dup@test.local", "a@bmp.com", "1.2.3.4", v); err != nil {
		t.Fatalf("first: %v", err)
	}
	_, err := store.RequestBMPLink(ctx, "dup@test.local", "b@bmp.com", "1.2.3.4", v)
	if !errors.Is(err, ErrLinkPending) {
		t.Fatalf("err = %v, want ErrLinkPending", err)
	}
}

// Aprobado por un admin, el email pasa a ser el usado para verificar.
func TestReviewBMPLink_ApproveMakesItActive(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "ok@test.local", "1000")
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.person (first_name, last_name, email, phone_number, status)
		VALUES ('Ad','Min','admin@test.local','0','active')`); err != nil {
		t.Fatalf("seed admin: %v", err)
	}

	store := NewStore(pool)
	v := BMPVerification{Exists: true, CanWithdraw: true, UserID: "u-7", CheckedAt: time.Now().UTC()}
	id, err := store.RequestBMPLink(ctx, "ok@test.local", "alterno@bmp.com", "1.2.3.4", v)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if err := store.ReviewBMPLink(ctx, id, true, "admin@test.local", "verificado por soporte"); err != nil {
		t.Fatalf("approve: %v", err)
	}

	got, err := store.ApprovedBMPEmail(ctx, "ok@test.local")
	if err != nil {
		t.Fatalf("approved email: %v", err)
	}
	if got != "alterno@bmp.com" {
		t.Fatalf("approved email = %q, want alterno@bmp.com", got)
	}

	// El rastro de auditoría quedó grabado sobre la fila revisada.
	var reviewer, note string
	if err := pool.QueryRow(ctx, `
		SELECT COALESCE(p.email,''), COALESCE(l.review_note,'')
		  FROM mlm.bmp_account_link l
		  LEFT JOIN mlm.person p ON p.id = l.reviewed_by_person_id
		 WHERE l.id=$1`, id).Scan(&reviewer, &note); err != nil {
		t.Fatalf("leer auditoría: %v", err)
	}
	if reviewer != "admin@test.local" || note != "verificado por soporte" {
		t.Fatalf("auditoría = %q/%q, want admin@test.local/verificado por soporte", reviewer, note)
	}
}

// ReviewBMPLink SOLO transiciona desde 'pending_admin': una segunda revisión no
// reescribe la auditoría de la primera.
func TestReviewBMPLink_OnlyFromPending(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "twice@test.local", "1000")
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.person (first_name, last_name, email, phone_number, status)
		VALUES ('Ad','Min','admin@test.local','0','active')`); err != nil {
		t.Fatalf("seed admin: %v", err)
	}

	store := NewStore(pool)
	v := BMPVerification{Exists: true, CanWithdraw: true, CheckedAt: time.Now().UTC()}
	id, err := store.RequestBMPLink(ctx, "twice@test.local", "alterno@bmp.com", "1.2.3.4", v)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if err := store.ReviewBMPLink(ctx, id, true, "admin@test.local", "aprobado"); err != nil {
		t.Fatalf("approve: %v", err)
	}

	// Segunda revisión sobre el mismo vínculo: debe rebotar.
	if err := store.ReviewBMPLink(ctx, id, false, "admin@test.local", "me arrepentí"); err == nil {
		t.Fatal("una segunda revisión reescribió un vínculo ya resuelto")
	}

	// Y ni el estado ni la nota original cambiaron.
	var status, note string
	if err := pool.QueryRow(ctx,
		`SELECT status::text, COALESCE(review_note,'') FROM mlm.bmp_account_link WHERE id=$1`, id).
		Scan(&status, &note); err != nil {
		t.Fatalf("leer estado: %v", err)
	}
	if status != "approved" || note != "aprobado" {
		t.Fatalf("estado/nota = %q/%q, want approved/aprobado", status, note)
	}
}

// Rechazado ⇒ no queda activo, y se puede volver a solicitar.
func TestReviewBMPLink_RejectAllowsRetry(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "rj@test.local", "1000")
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.person (first_name, last_name, email, phone_number, status)
		VALUES ('Ad','Min','admin@test.local','0','active')`); err != nil {
		t.Fatalf("seed admin: %v", err)
	}

	store := NewStore(pool)
	v := BMPVerification{Exists: true, CanWithdraw: true, CheckedAt: time.Now().UTC()}
	id, err := store.RequestBMPLink(ctx, "rj@test.local", "malo@bmp.com", "1.2.3.4", v)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if err := store.ReviewBMPLink(ctx, id, false, "admin@test.local", "no coincide titular"); err != nil {
		t.Fatalf("reject: %v", err)
	}

	got, err := store.ApprovedBMPEmail(ctx, "rj@test.local")
	if err != nil {
		t.Fatalf("approved email: %v", err)
	}
	if got != "" {
		t.Fatalf("approved email = %q, want vacío", got)
	}
	// Se puede volver a solicitar.
	if _, err := store.RequestBMPLink(ctx, "rj@test.local", "bueno@bmp.com", "1.2.3.4", v); err != nil {
		t.Fatalf("retry: %v", err)
	}
}

// No se vincula un email que BMP no reconoce: llenaría la cola admin de basura.
func TestRequestBMPLink_RejectsUnknownBMPEmail(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "unk@test.local", "1000")

	store := NewStore(pool)
	notFound := BMPVerification{Exists: false, BlockReason: BlockNotRegistered, CheckedAt: time.Now().UTC()}
	if _, err := store.RequestBMPLink(ctx, "unk@test.local", "fantasma@bmp.com", "1.2.3.4", notFound); err == nil {
		t.Fatal("se aceptó un email que BMP no reconoce")
	}
	// Y no quedó nada encolado.
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM mlm.bmp_account_link`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Fatalf("filas encoladas = %d, want 0", n)
	}
}

// La cola admin lista lo pendiente con los datos que el revisor necesita.
func TestListPendingBMPLinks(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "q1@test.local", "1000")
	seedMemberWithBalance(t, pool, "q2@test.local", "1000")

	store := NewStore(pool)
	v := BMPVerification{Exists: true, CanWithdraw: true, UserID: "u-1", CheckedAt: time.Now().UTC()}
	if _, err := store.RequestBMPLink(ctx, "q1@test.local", "uno@bmp.com", "1.2.3.4", v); err != nil {
		t.Fatalf("q1: %v", err)
	}
	id2, err := store.RequestBMPLink(ctx, "q2@test.local", "dos@bmp.com", "1.2.3.4", v)
	if err != nil {
		t.Fatalf("q2: %v", err)
	}

	items, total, err := store.ListPendingBMPLinks(ctx, 25, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if total != 2 || len(items) != 2 {
		t.Fatalf("total/len = %d/%d, want 2/2", total, len(items))
	}

	// Un vínculo ya revisado sale de la cola.
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.person (first_name, last_name, email, phone_number, status)
		VALUES ('Ad','Min','admin@test.local','0','active')`); err != nil {
		t.Fatalf("seed admin: %v", err)
	}
	if err := store.ReviewBMPLink(ctx, id2, true, "admin@test.local", ""); err != nil {
		t.Fatalf("approve: %v", err)
	}
	items, total, err = store.ListPendingBMPLinks(ctx, 25, 0)
	if err != nil {
		t.Fatalf("list 2: %v", err)
	}
	if total != 1 || len(items) != 1 || items[0].BMPEmail != "uno@bmp.com" {
		t.Fatalf("cola tras revisar = %d/%v", total, items)
	}
}

// Los índices parciales únicos son de la BASE, no del código: se prueban con
// INSERTs directos, saltándose las validaciones de Go.
func TestBMPLinkPartialUniqueIndexes(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	affID, _ := seedMemberWithBalance(t, pool, "idx@test.local", "1000")

	ins := func(status string) error {
		_, err := pool.Exec(ctx, `
			INSERT INTO mlm.bmp_account_link (affiliate_id, bmp_email, status)
			VALUES ($1, $2, $3::mlm.bmp_link_status)`, affID, status+"@bmp.com", status)
		return err
	}

	// Un solo 'pending_admin' por afiliado.
	if err := ins("pending_admin"); err != nil {
		t.Fatalf("primer pending: %v", err)
	}
	if err := ins("pending_admin"); err == nil {
		t.Fatal("la base aceptó un SEGUNDO 'pending_admin' para el mismo afiliado")
	}

	// Un solo 'approved' por afiliado.
	if err := ins("approved"); err != nil {
		t.Fatalf("primer approved: %v", err)
	}
	if err := ins("approved"); err == nil {
		t.Fatal("la base aceptó un SEGUNDO 'approved' para el mismo afiliado")
	}

	// 'rejected' no participa de ningún índice único: el historial se conserva.
	if err := ins("rejected"); err != nil {
		t.Fatalf("primer rejected: %v", err)
	}
	if err := ins("rejected"); err != nil {
		t.Fatalf("segundo rejected (debe permitirse): %v", err)
	}
}

// ---------------------------------------------------------------------------
// EmailByWithdrawalID: precedencia bmp_email_used → vínculo aprobado → persona
// ---------------------------------------------------------------------------

// El escenario que bloqueaba retiros para siempre: afiliado con vínculo BMP
// APROBADO que solicita mientras BMP no está disponible (timeout transitorio, o
// —el caso del despliegue inicial— cliente BMP deshabilitado por falta de
// credenciales). bmp_email_used queda NULL, y al pagar hay que verificar contra
// el correo VINCULADO, no contra el de sesión: BMP no conoce el de sesión y
// responde 'not_registered', dejando el retiro impagable de forma permanente.
func TestEmailByWithdrawalID_FallsBackToApprovedLink(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "fb@test.local", "1000")

	store := NewStore(pool)
	v := BMPVerification{Exists: true, CanWithdraw: true, UserID: "u-fb", CheckedAt: time.Now().UTC()}
	linkID, err := store.RequestBMPLink(ctx, "fb@test.local", "alterno@bmp.com", "1.2.3.4", v)
	if err != nil {
		t.Fatalf("request link: %v", err)
	}
	if err := store.ReviewBMPLink(ctx, linkID, true, "admin@test.local", "ok"); err != nil {
		t.Fatalf("approve link: %v", err)
	}

	// RequestWithdrawal (sin BMP) deja bmp_email_used NULL — exactamente lo que
	// pasa con el cliente BMP deshabilitado.
	res, err := store.RequestWithdrawal(ctx, "fb@test.local", "200", "Banco X, cuenta 123456")
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	var used *string
	if err := pool.QueryRow(ctx,
		`SELECT bmp_email_used FROM mlm.withdrawal_request WHERE id=$1`, res.ID).Scan(&used); err != nil {
		t.Fatalf("leer bmp_email_used: %v", err)
	}
	if used != nil {
		t.Fatalf("bmp_email_used = %q, want NULL (premisa del test)", *used)
	}

	got, err := store.EmailByWithdrawalID(ctx, res.ID)
	if err != nil {
		t.Fatalf("email by withdrawal: %v", err)
	}
	if got != "alterno@bmp.com" {
		t.Fatalf("email = %q, want %q (el vínculo aprobado, no el de sesión)", got, "alterno@bmp.com")
	}
}

// bmp_email_used persistido GANA sobre el vínculo aprobado: es el correo con el
// que BMP efectivamente respondió al solicitar.
func TestEmailByWithdrawalID_PersistedWins(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "pw@test.local", "1000")

	store := NewStore(pool)
	v := BMPVerification{Exists: true, CanWithdraw: true, UserID: "u-pw", CheckedAt: time.Now().UTC()}
	linkID, err := store.RequestBMPLink(ctx, "pw@test.local", "vinculo@bmp.com", "1.2.3.4", v)
	if err != nil {
		t.Fatalf("request link: %v", err)
	}
	if err := store.ReviewBMPLink(ctx, linkID, true, "admin@test.local", "ok"); err != nil {
		t.Fatalf("approve link: %v", err)
	}

	res, err := store.RequestWithdrawalWithBMP(ctx, "pw@test.local", "200", "Banco X, cuenta 123456",
		"usado@bmp.com", v)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	got, err := store.EmailByWithdrawalID(ctx, res.ID)
	if err != nil {
		t.Fatalf("email by withdrawal: %v", err)
	}
	if got != "usado@bmp.com" {
		t.Fatalf("email = %q, want %q (bmp_email_used tiene precedencia)", got, "usado@bmp.com")
	}
}

// Sin vínculo y sin bmp_email_used ⇒ el email de la persona.
func TestEmailByWithdrawalID_FallsBackToPerson(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	seedMemberWithBalance(t, pool, "np@test.local", "1000")

	store := NewStore(pool)
	res, err := store.RequestWithdrawal(ctx, "np@test.local", "200", "Banco X, cuenta 123456")
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	got, err := store.EmailByWithdrawalID(ctx, res.ID)
	if err != nil {
		t.Fatalf("email by withdrawal: %v", err)
	}
	if got != "np@test.local" {
		t.Fatalf("email = %q, want %q", got, "np@test.local")
	}
}
