package withdrawals

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// ErrSuspended: la persona está baneada o suspendida y no puede mover dinero.
var ErrSuspended = errors.New("cuenta suspendida")

// suspendedPredicate es la definición ÚNICA de "no puede mover dinero" en este
// paquete. NOTA: vp-payments (internal/payments/blacklist_admin.go:140) tiene
// hoy una versión INCOMPLETA de este mismo predicado — sólo 'suspended'. No se
// importa ni se unifica porque payments importa este paquete (un import inverso
// crearía un ciclo) y porque ampliarlo allá cambia el bloqueo de registro y de
// compras, que es una decisión aparte. Si se unifican, que sea hacia esta.
//
// Cubre TRES de los cinco valores de mlm.person_status ('pending','active',
// 'suspended','banned','deleted'; _meta/schema_mlm.sql:129), no sólo
// 'suspended':
//
//   - 'suspended': baja temporal decidida por la empresa.
//   - 'banned': baja definitiva. IMPRESCINDIBLE por el origen LEGACY — la carga
//     del backup produce filas con status='banned' y blacklisted=false, porque
//     el status se mapea desde idstatus (3004 y 8004 ⇒ 'banned';
//     _meta/migration/02_postload.sql:155 y :218) mientras que `blacklisted` se
//     llena por separado desde staging.person.blacklist (línea 162). Con el
//     predicado viejo esas personas pasaban el candado como limpias y se les
//     podía pagar un retiro.
//   - 'deleted': cuenta dada de baja; no hay a quién pagarle.
//
// 'active' y 'pending' NO bloquean: son cuentas vigentes (pending es alta sin
// completar, y su retiro fallará más adelante por saldo, no por candado).
//
// Recibe el alias de mlm.person y CALIFICA ambas columnas: sin calificar,
// `status` es ambiguo en la consulta con JOIN (withdrawal_request, affiliate y
// person tienen las tres una columna `status`) y Postgres rechaza la query con
// 42702. Ese error, con el candado fail-closed, se traduce en pagos bloqueados.
func suspendedPredicate(alias string) string {
	return `COALESCE(` + alias + `.blacklisted,false) OR ` +
		alias + `.status IN ('suspended','banned','deleted')`
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
