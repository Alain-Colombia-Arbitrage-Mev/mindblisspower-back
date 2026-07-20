package withdrawals

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// ErrSuspended: la persona está baneada o suspendida y no puede mover dinero.
var ErrSuspended = errors.New("cuenta suspendida")

// suspendedPredicate es la definición ÚNICA de "baneado" en este paquete,
// idéntica a la que usa vp-payments (internal/payments/blacklist_admin.go:140).
// Se replica en vez de importarse porque payments importa este paquete: un
// import inverso crearía un ciclo. Si cambia allá, cambia acá.
//
// Recibe el alias de mlm.person y CALIFICA ambas columnas: sin calificar,
// `status` es ambiguo en la consulta con JOIN (withdrawal_request, affiliate y
// person tienen las tres una columna `status`) y Postgres rechaza la query con
// 42702. Ese error, con el candado fail-closed, se traduce en pagos bloqueados.
func suspendedPredicate(alias string) string {
	return `COALESCE(` + alias + `.blacklisted,false) OR ` + alias + `.status='suspended'`
}

// PersonSuspendedByEmail: ¿la persona está baneada/suspendida? false si no existe
// (no hay a quién bloquear; el flujo que sigue fallará por sí solo).
func (s *Store) PersonSuspendedByEmail(ctx context.Context, email string) (bool, error) {
	var susp bool
	err := s.db.QueryRow(ctx,
		`SELECT `+suspendedPredicate("p")+`
		   FROM mlm.person p WHERE lower(p.email)=lower($1) LIMIT 1`, email).Scan(&susp)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("person suspended by email: %w", err)
	}
	return susp, nil
}

// PersonSuspendedByWithdrawalID resuelve el dueño de la solicitud y responde si
// está baneado. Se usa al PAGAR, donde el request del admin no trae el email del
// miembro: la identidad autoritativa es la del renglón de retiro.
func (s *Store) PersonSuspendedByWithdrawalID(ctx context.Context, id int64) (bool, error) {
	var susp bool
	err := s.db.QueryRow(ctx, `
		SELECT `+suspendedPredicate("p")+`
		  FROM mlm.withdrawal_request wr
		  JOIN mlm.affiliate a ON a.id = wr.affiliate_id
		  JOIN mlm.person p    ON p.id = a.person_id
		 WHERE wr.id = $1`, id).Scan(&susp)
	if errors.Is(err, pgx.ErrNoRows) {
		// Sin solicitud no hay a quién pagar: la transición fallará después con
		// ErrInvalidTransition, que es el error correcto para ese caso.
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("person suspended by withdrawal: %w", err)
	}
	return susp, nil
}
