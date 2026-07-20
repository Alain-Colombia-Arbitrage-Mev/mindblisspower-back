package withdrawals

import (
	"context"
	"errors"
	"testing"
)

// D10: un afiliado baneado DESPUÉS de solicitar no puede ser pagado. Este es el
// hueco que la Task 5 cierra: el chequeo al solicitar pasó limpio, así que sin
// el candado en SetWithdrawalStatus el admin podría pagarle igual.
func TestSetWithdrawalStatus_BannedAfterRequest_BlocksPay(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.country (id, iso2, name_es, name_en) VALUES (1,'CO','Colombia','Colombia');
		INSERT INTO mlm.asset (id, symbol, name, is_fiat, decimals) VALUES (1,'USD','US Dollar',true,2);
		INSERT INTO mlm.concept (id, kind, name_es, name_en, factor, requires_pair, active)
		  VALUES (11,'binary_bonus','Bono','Bonus',1,false,true);
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE VALUES (1,'Mem','Ber','banned@test.local','0','active');
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

	// Solicita estando limpio, y el admin aprueba.
	res, err := store.RequestWithdrawal(ctx, "banned@test.local", "200", "Banco X, cuenta 123456")
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if err := store.SetWithdrawalStatus(ctx, res.ID, "approved", "admin@test.local"); err != nil {
		t.Fatalf("approve: %v", err)
	}

	// Lo banean DESPUÉS de solicitar y aprobar.
	if _, err := pool.Exec(ctx, `UPDATE mlm.person SET blacklisted = true WHERE id = 1`); err != nil {
		t.Fatalf("ban: %v", err)
	}

	// Pagar debe fallar con ErrSuspended.
	err = store.SetWithdrawalStatus(ctx, res.ID, "paid", "admin@test.local")
	if !errors.Is(err, ErrSuspended) {
		t.Fatalf("pay err = %v, want ErrSuspended", err)
	}

	// El estado NO avanzó: sigue en 'approved' (el admin puede resolverlo luego).
	var status string
	if err := pool.QueryRow(ctx,
		`SELECT status::text FROM mlm.withdrawal_request WHERE id=$1`, res.ID).Scan(&status); err != nil {
		t.Fatalf("status: %v", err)
	}
	if status != "approved" {
		t.Fatalf("status = %q, want approved", status)
	}

	// Y NO salió dinero: cero débitos ligados a este retiro...
	if n := countWithdrawalDebits(t, pool, ctx, res.ID); n != 0 {
		t.Fatalf("débitos del retiro %d = %d, want 0", res.ID, n)
	}
	// ...ni ningún débito de retiro en toda la base (concepto 1013).
	var debits int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM mlm.wallet_movement WHERE concept_id = $1`,
		withdrawalDebitConceptID).Scan(&debits); err != nil {
		t.Fatalf("count debits: %v", err)
	}
	if debits != 0 {
		t.Fatalf("debits = %d, want 0", debits)
	}

	// Cancelar SÍ debe seguir permitido: el candado es sólo para 'paid'.
	if err := store.SetWithdrawalStatus(ctx, res.ID, "cancelled", "admin@test.local"); err != nil {
		t.Fatalf("cancel de un baneado debió permitirse, err = %v", err)
	}
}

// PersonSuspendedByWithdrawalID contra Postgres real. Existe sobre todo como
// regresión de la AMBIGÜEDAD DE `status`: withdrawal_request, affiliate y person
// tienen las tres una columna `status`, así que un predicado sin calificar por
// alias rompe esta consulta con JOIN (Postgres 42702, "column reference status
// is ambiguous"). Con el candado fail-closed ese error se traduce en pagos
// legítimos bloqueados, así que la calificación NO es cosmética.
//
// Cubre las tres respuestas: limpio ⇒ false, baneado ⇒ true, retiro inexistente
// ⇒ (false, nil). Ninguna debe devolver error.
func TestPersonSuspendedByWithdrawalID_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.country (id, iso2, name_es, name_en) VALUES (1,'CO','Colombia','Colombia');
		INSERT INTO mlm.asset (id, symbol, name, is_fiat, decimals) VALUES (1,'USD','US Dollar',true,2);
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE VALUES (1,'Mem','Ber','wr@test.local','0','active');
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
		INSERT INTO mlm.wallet (affiliate_id, asset_id, address, balance)
		VALUES ($1,1,'usd-1',0) RETURNING id`, affID).Scan(&walletID); err != nil {
		t.Fatalf("wallet: %v", err)
	}
	// El retiro queda en 'requested' y el afiliado en 'active': si el predicado
	// no calificara las columnas, `status` podría resolver a cualquiera de las
	// tres tablas. Postgres no adivina — aborta con 42702.
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.withdrawal_request (affiliate_id, wallet_id, amount_usd, status, comments)
		VALUES ($1,$2,200,'requested','Banco X') RETURNING id`, affID, walletID).Scan(&wrID); err != nil {
		t.Fatalf("withdrawal: %v", err)
	}

	store := NewStore(pool)

	// Limpio ⇒ false. Si la consulta fuera ambigua, acá ya saldría error.
	susp, err := store.PersonSuspendedByWithdrawalID(ctx, wrID)
	if err != nil {
		t.Fatalf("limpio: %v", err)
	}
	if susp {
		t.Fatal("susp = true para persona limpia, want false")
	}

	// blacklisted ⇒ true.
	if _, err := pool.Exec(ctx, `UPDATE mlm.person SET blacklisted = true WHERE id = 1`); err != nil {
		t.Fatalf("ban: %v", err)
	}
	susp, err = store.PersonSuspendedByWithdrawalID(ctx, wrID)
	if err != nil {
		t.Fatalf("baneado: %v", err)
	}
	if !susp {
		t.Fatal("susp = false para blacklisted, want true")
	}

	// La otra mitad del predicado: status='suspended' sin blacklisted.
	if _, err := pool.Exec(ctx,
		`UPDATE mlm.person SET blacklisted = false, status = 'suspended' WHERE id = 1`); err != nil {
		t.Fatalf("suspend: %v", err)
	}
	susp, err = store.PersonSuspendedByWithdrawalID(ctx, wrID)
	if err != nil {
		t.Fatalf("suspendido: %v", err)
	}
	if !susp {
		t.Fatal("susp = false para status='suspended', want true")
	}

	// Retiro inexistente ⇒ (false, nil): no hay a quién bloquear y la transición
	// fallará después con ErrInvalidTransition, que es el error correcto.
	missing, err := store.PersonSuspendedByWithdrawalID(ctx, 999999)
	if err != nil {
		t.Fatalf("inexistente: %v", err)
	}
	if missing {
		t.Fatal("susp = true para retiro inexistente, want false")
	}
}

// Dominio COMPLETO de mlm.person_status cruzado con blacklisted. Se enumeran
// los cinco valores del enum (_meta/schema_mlm.sql:129) en vez de sólo las ramas
// que el predicado tiene escritas hoy: probar únicamente las ramas existentes es
// como se coló el defecto original — el predicado sólo miraba 'suspended' y
// nadie preguntó qué pasaba con 'banned'.
//
// Si algún día se agrega un valor al enum, este test NO lo detecta solo; la
// defensa es la lista de abajo, que debe revisarse junto con el enum.
func TestPersonSuspendedByEmail_EnumDomain(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE VALUES (1,'E','N','enum@test.local','0','active');
	`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	store := NewStore(pool)

	cases := []struct {
		status      string
		blacklisted bool
		want        bool
		why         string
	}{
		// Cuentas vigentes y limpias: deben poder cobrar.
		{"active", false, false, "cuenta vigente"},
		{"pending", false, false, "alta sin completar, pero no sancionada"},

		// Sancionadas por status: no cobran.
		{"suspended", false, true, "baja temporal"},
		{"banned", false, true, "baja definitiva; el caso legacy del defecto"},
		{"deleted", false, true, "cuenta eliminada"},

		// El flag manda por sí solo, sea cual sea el status.
		{"active", true, true, "blacklisted pesa aunque el status esté activo"},
		{"pending", true, true, "blacklisted pesa aunque el status esté pendiente"},
		{"suspended", true, true, "ambas mitades del predicado a la vez"},
		{"banned", true, true, "ambas mitades del predicado a la vez"},
		{"deleted", true, true, "ambas mitades del predicado a la vez"},
	}

	for _, tc := range cases {
		name := tc.status
		if tc.blacklisted {
			name += "+blacklisted"
		}
		t.Run(name, func(t *testing.T) {
			if _, err := pool.Exec(ctx,
				`UPDATE mlm.person SET status=$1::mlm.person_status, blacklisted=$2 WHERE id=1`,
				tc.status, tc.blacklisted); err != nil {
				t.Fatalf("set estado: %v", err)
			}
			got, err := store.PersonSuspendedByEmail(ctx, "enum@test.local")
			if err != nil {
				t.Fatalf("check: %v", err)
			}
			if got != tc.want {
				t.Fatalf("status=%q blacklisted=%v ⇒ suspended=%v, want %v (%s)",
					tc.status, tc.blacklisted, got, tc.want, tc.why)
			}
		})
	}
}

// El escenario EXACTO del defecto, de extremo a extremo: una persona cargada
// desde el backup legacy con status='banned' y blacklisted=false (02_postload
// mapea idstatus 3004/8004 a 'banned' sin tocar el flag). Con el predicado viejo
// pasaba el candado como limpia y el admin le pagaba.
func TestSetWithdrawalStatus_LegacyBannedStatus_BlocksPay(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.country (id, iso2, name_es, name_en) VALUES (1,'CO','Colombia','Colombia');
		INSERT INTO mlm.asset (id, symbol, name, is_fiat, decimals) VALUES (1,'USD','US Dollar',true,2);
		INSERT INTO mlm.concept (id, kind, name_es, name_en, factor, requires_pair, active)
		  VALUES (11,'binary_bonus','Bono','Bonus',1,false,true);
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE VALUES (1,'Leg','Acy','legacy@test.local','0','active');
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

	res, err := store.RequestWithdrawal(ctx, "legacy@test.local", "200", "Banco X, cuenta 123456")
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if err := store.SetWithdrawalStatus(ctx, res.ID, "approved", "admin@test.local"); err != nil {
		t.Fatalf("approve: %v", err)
	}

	// Baja legacy: status='banned' y el flag EXPRESAMENTE en false, que es lo que
	// deja la carga del backup. blacklisted=false no puede ser un permiso de pago.
	if _, err := pool.Exec(ctx,
		`UPDATE mlm.person SET status='banned', blacklisted=false WHERE id = 1`); err != nil {
		t.Fatalf("ban legacy: %v", err)
	}
	var blk bool
	if err := pool.QueryRow(ctx, `SELECT blacklisted FROM mlm.person WHERE id=1`).Scan(&blk); err != nil {
		t.Fatalf("verificar flag: %v", err)
	}
	if blk {
		t.Fatal("el fixture debe tener blacklisted=false; si no, el test pasaría por la otra mitad del predicado")
	}

	if err := store.SetWithdrawalStatus(ctx, res.ID, "paid", "admin@test.local"); !errors.Is(err, ErrSuspended) {
		t.Fatalf("pay err = %v, want ErrSuspended", err)
	}

	// El retiro sigue en 'approved' y NO se posteó débito (concepto 1013).
	var status string
	if err := pool.QueryRow(ctx,
		`SELECT status::text FROM mlm.withdrawal_request WHERE id=$1`, res.ID).Scan(&status); err != nil {
		t.Fatalf("status: %v", err)
	}
	if status != "approved" {
		t.Fatalf("status = %q, want approved", status)
	}
	if n := countWithdrawalDebits(t, pool, ctx, res.ID); n != 0 {
		t.Fatalf("débitos del retiro %d = %d, want 0", res.ID, n)
	}
	var debits int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM mlm.wallet_movement WHERE concept_id = $1`,
		withdrawalDebitConceptID).Scan(&debits); err != nil {
		t.Fatalf("count debits: %v", err)
	}
	if debits != 0 {
		t.Fatalf("debits = %d, want 0", debits)
	}
}

// status='suspended' bloquea igual que blacklisted: son las dos mitades del
// mismo predicado, y sólo probar blacklisted dejaría la otra sin cubrir.
func TestPersonSuspendedByEmail_StatusSuspended(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE VALUES (1,'S','U','susp@test.local','0','suspended');
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE VALUES (2,'O','K','clean@test.local','0','active');
	`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	store := NewStore(pool)

	susp, err := store.PersonSuspendedByEmail(ctx, "susp@test.local")
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if !susp {
		t.Fatal("susp = false, want true")
	}

	// Control: una persona activa y limpia no debe dar positivo.
	clean, err := store.PersonSuspendedByEmail(ctx, "clean@test.local")
	if err != nil {
		t.Fatalf("check clean: %v", err)
	}
	if clean {
		t.Fatal("clean = true, want false")
	}

	// Email inexistente ⇒ (false, nil), no error.
	missing, err := store.PersonSuspendedByEmail(ctx, "nadie@test.local")
	if err != nil {
		t.Fatalf("check missing: %v", err)
	}
	if missing {
		t.Fatal("missing = true, want false")
	}
}
