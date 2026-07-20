package withdrawals

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

// ErrInvalidTransition señala que el cambio de estado solicitado no es válido
// desde el estado actual (o ya fue aplicado). Es culpa del cliente ⇒ 409. Se
// distingue explícitamente de un fallo de infraestructura (Postgres caído, etc.),
// que debe salir como 500: reportar "transición rechazada" ante una caída le
// mentiría al admin sobre el estado real del dinero.
var ErrInvalidTransition = errors.New("transición de retiro inválida")

// IsAdmin indica si la persona con ese email tiene is_admin=true en mlm.person
// (admins concedidos desde el panel, migración 47). Copia de
// payments.Store.IsAdmin: email inexistente ⇒ (false, nil); error de consulta ⇒
// se propaga para que el handler falle cerrado con 500.
func (s *Store) IsAdmin(ctx context.Context, email string) (bool, error) {
	var admin bool
	err := s.db.QueryRow(ctx,
		`SELECT COALESCE(is_admin,false) FROM mlm.person WHERE lower(email)=lower($1) LIMIT 1`,
		email).Scan(&admin)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("is_admin: %w", err)
	}
	return admin, nil
}

// AdminWithdrawal es una solicitud de retiro en la vista admin.
//
// El pago externo es MANUAL: el admin aprieta "Pagar", el sistema debita el
// BRUTO (amount_usd) y después un humano transfiere el NETO a la cuenta BMP del
// afiliado. Para poder hacerlo necesita saber cuánto transferir (net_usd) y a
// qué correo (bmp_email_used) — sin eso, todo el mecanismo del vínculo BMP se
// pierde justo en el último tramo. bmp_status/bmp_verified_at completan el
// cuadro: dicen si el candado dejará pagar antes de intentarlo.
//
// Los campos se AGREGAN; ninguno reemplaza a los previos. Ver también el
// contrato congelado de las claves de la RESPUESTA en handleAdminWithdrawals.
type AdminWithdrawal struct {
	ID        int64  `json:"id"`
	Member    string `json:"member"`
	Email     string `json:"email"`
	AmountUSD string `json:"amount_usd"`
	Status    string `json:"status"`
	BankInfo  string `json:"bank_info"`
	CreatedAt string `json:"created_at"`

	// Aritmética del retiro: amount_usd (bruto) = fee_usd + net_usd.
	FeeUSD string `json:"fee_usd"`
	NetUSD string `json:"net_usd"`

	// Estado del candado BMP. Vacío ⇒ nunca se verificó (fila histórica o
	// solicitud creada con el cliente BMP deshabilitado).
	BMPStatus     string `json:"bmp_status"`
	BMPEmailUsed  string `json:"bmp_email_used"`
	BMPVerifiedAt string `json:"bmp_verified_at"`
}

// ListWithdrawals lista solicitudes (filtrable por status) paginadas.
func (s *Store) ListWithdrawals(ctx context.Context, status string, limit, offset int) ([]AdminWithdrawal, int64, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	var total int64
	if err := s.db.QueryRow(ctx, `
		SELECT count(*) FROM mlm.withdrawal_request wr
		 WHERE ($1='' OR wr.status::text=$1)
	`, status).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count withdrawals: %w", err)
	}
	rows, err := s.db.Query(ctx, `
		SELECT wr.id, trim(p.first_name||' '||p.last_name) AS member, p.email,
		       wr.amount_usd::text, wr.status::text, COALESCE(wr.comments,''),
		       to_char(wr.created_at,'YYYY-MM-DD"T"HH24:MI:SSZ'),
		       COALESCE(wr.fee_usd::text,''), COALESCE(wr.net_usd::text,''),
		       COALESCE(wr.bmp_status,''), COALESCE(wr.bmp_email_used,''),
		       COALESCE(to_char(wr.bmp_verified_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'')
		  FROM mlm.withdrawal_request wr
		  JOIN mlm.affiliate a ON a.id=wr.affiliate_id
		  JOIN mlm.person p    ON p.id=a.person_id
		 WHERE ($1='' OR wr.status::text=$1)
		 ORDER BY wr.created_at DESC
		 LIMIT $2 OFFSET $3
	`, status, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("list withdrawals: %w", err)
	}
	defer rows.Close()
	out := []AdminWithdrawal{}
	for rows.Next() {
		var w AdminWithdrawal
		if err := rows.Scan(&w.ID, &w.Member, &w.Email, &w.AmountUSD, &w.Status, &w.BankInfo, &w.CreatedAt,
			&w.FeeUSD, &w.NetUSD, &w.BMPStatus, &w.BMPEmailUsed, &w.BMPVerifiedAt); err != nil {
			return nil, 0, err
		}
		out = append(out, w)
	}
	return out, total, rows.Err()
}

// withdrawalDebitConceptID es el concepto de DÉBITO de retiro (kind='withdrawal',
// factor=-1, requires_pair=false). Sembrado en _meta/schema_payouts_v1.3.sql:335
// y en _meta/migration/40_withdrawal_concept.sql. El asiento es de una sola
// vía: el dinero sale del sistema (banco/crypto), sin contra-crédito interno.
const withdrawalDebitConceptID = 1013

// SetWithdrawalStatus cambia el estado de una solicitud (aprobar/rechazar/pagar/
// cancelar) y registra quién aprobó. Al transicionar a 'paid' — y SÓLO entonces —
// postea el DÉBITO contable (mlm.transaction + mlm.wallet_movement negativo) en
// la MISMA transacción que el cambio de estado, cerrando la brecha de doble-gasto
// C1: sin ese débito el saldo del miembro nunca bajaba y la misma comisión podía
// retirarse otra vez. El flujo hoy es admin-manual (no hay liquidación on-chain):
// por eso el débito se postea aquí y NO vía el stub NATS de walletbridge (ese es
// para un flujo on-chain futuro; ver walletbridge/bridge.go).
//
// withdrawalTransitions define las transiciones VÁLIDAS: target -> estados-previos
// permitidos. Cualquier otra se rechaza (four-eyes: pagar exige aprobar antes;
// no re-pagar un 'paid'; no reactivar un 'rejected').
var withdrawalTransitions = map[string][]string{
	"approved":  {"requested"},
	"rejected":  {"requested"},
	"paid":      {"approved"},
	"cancelled": {"requested", "approved"},
}

// BMPFreshness: antigüedad máxima aceptable de la verificación BMP al pagar.
// Entre la solicitud y el pago pasan días, y en el medio la cuenta BMP puede
// desactivarse, perder el KYC o quedar restringida. Una verificación de la
// semana pasada no dice nada sobre si el dinero llegará hoy.
const BMPFreshness = 15 * time.Minute

var (
	// ErrBMPNotEligible: la última verificación BMP no habilita el pago (o no
	// hay ninguna). Es una decisión de política, no una falla ⇒ 409, no 500.
	ErrBMPNotEligible = errors.New("cuenta BMP no habilitada para recibir")
	// ErrBMPStale: la verificación existe y es favorable, pero está vencida.
	ErrBMPStale = errors.New("verificación BMP vencida")
	// ErrInsufficientAtPay: al momento de pagar, el saldo disponible ya no cubre
	// el retiro aprobado. Es DISTINTO de ErrInsufficient (que rechaza al
	// SOLICITAR): acá el afiliado sí tenía el saldo cuando pidió, y algo lo quitó
	// entre la aprobación y el pago — típicamente ops congelando movimientos
	// (wallet_movement.is_frozen) por sospecha de fraude. El admin necesita ver
	// esa diferencia: no es "pediste de más", es "el saldo cambió, revisá por qué".
	ErrInsufficientAtPay = errors.New("saldo disponible insuficiente al momento de pagar")
)

// RefreshBMPVerification persiste una verificación recién obtenida. La llama el
// handler justo antes de pagar, FUERA de la transacción del pago: consultar a un
// tercero con una transacción de Postgres abierta la mantiene viva durante todo
// el round-trip HTTP y, bajo carga, encadena bloqueos sobre la misma fila.
//
// Si BMP no responde, el handler NO llama a esto: la verificación vieja queda
// intacta y el candado la rechaza por vencida o por no elegible. Fail-closed por
// omisión — no hay camino en el que un tercero caído habilite un pago.
func (s *Store) RefreshBMPVerification(ctx context.Context, id int64, v BMPVerification) error {
	status := v.BlockReason
	if v.CanWithdraw {
		status = "allowed"
	}
	if _, err := s.db.Exec(ctx, `
		UPDATE mlm.withdrawal_request
		   SET bmp_status=$2, bmp_verified_at=$3, updated_at=now()
		 WHERE id=$1`, id, status, v.CheckedAt); err != nil {
		return fmt.Errorf("refresh bmp verification: %w", err)
	}
	return nil
}

// assertBMPFresh valida que la última verificación habilite el pago Y esté
// dentro de la ventana de frescura.
//
// FAIL-CLOSED en las tres ramas: si la consulta falla se devuelve error (no se
// paga); si bmp_status es NULL o distinto de 'allowed' se devuelve
// ErrBMPNotEligible; si bmp_verified_at es NULL, futura, o más vieja que
// BMPFreshness se devuelve ErrBMPStale. Ninguna combinación devuelve nil sin
// evidencia positiva y fresca de que BMP habilita.
//
// La rama "futura" existe porque time.Since(futuro) da un valor NEGATIVO, que
// pasaría el chequeo "< BMPFreshness" y dejaría el pago habilitado
// indefinidamente. bmp_verified_at siempre lo fija este proceso con
// time.Now().UTC(), así que no es alcanzable por el camino normal — pero sí por
// una escritura manual a la base o un salto de reloj, y el candado no puede
// depender de que eso no pase.
func (s *Store) assertBMPFresh(ctx context.Context, id int64) error {
	var status *string
	var verifiedAt *time.Time
	if err := s.db.QueryRow(ctx, `
		SELECT bmp_status, bmp_verified_at
		  FROM mlm.withdrawal_request WHERE id=$1`, id).Scan(&status, &verifiedAt); err != nil {
		return fmt.Errorf("lectura de verificación BMP (fail-closed): %w", err)
	}
	if status == nil || *status != "allowed" {
		return ErrBMPNotEligible
	}
	if verifiedAt == nil {
		return ErrBMPStale
	}
	age := time.Since(*verifiedAt)
	if age < 0 || age > BMPFreshness {
		return ErrBMPStale
	}
	return nil
}

func (s *Store) SetWithdrawalStatus(ctx context.Context, id int64, status, adminEmail string) error {
	allowedPrior, ok := withdrawalTransitions[status]
	if !ok {
		return fmt.Errorf("%w: status %q desconocido", ErrInvalidTransition, status)
	}

	// D10: los baneados no cobran. El chequeo al SOLICITAR (handleWithdraw) no
	// alcanza — a quien lo banean DESPUÉS de solicitar hay que congelarle el
	// dinero ya pedido. Va ANTES de abrir la transacción (nada que revertir) y
	// SÓLO para 'paid': aprobar/rechazar/cancelar no sacan dinero y deben seguir
	// disponibles para que el admin resuelva el caso.
	//
	// FAIL-CLOSED a propósito: si la consulta falla por infraestructura NO se
	// paga. Un Postgres intermitente no puede ser la vía por la que sale dinero
	// hacia un baneado; el admin reintenta. (Al solicitar el modo es el opuesto,
	// fail-open; ver handleWithdraw en http.go.)
	if status == "paid" {
		susp, serr := s.PersonSuspendedByWithdrawalID(ctx, id)
		if serr != nil {
			return fmt.Errorf("chequeo de suspensión (fail-closed): %w", serr)
		}
		if susp {
			s.log.Warn().Int64("withdrawal_id", id).Str("by", adminEmail).
				Msg("pago bloqueado: cuenta suspendida/baneada")
			return ErrSuspended
		}

		// Candado BMP, también fail-closed y también SÓLO para 'paid'. El orden
		// importa: primero el baneo (barato y local), después BMP (lee una fila
		// que el handler acaba de refrescar contra un tercero). Igual que el
		// anterior, va ANTES de abrir la transacción: nada que revertir.
		//
		// El interruptor WITHDRAWALS_REQUIRE_BMP sólo decide si este resultado
		// BLOQUEA. La verificación se hace y se persiste en ambos modos, así que
		// la cola admin muestra el estado real del afiliado aunque el candado
		// esté desactivado. El candado de baneados de arriba NO tiene interruptor.
		if berr := s.assertBMPFresh(ctx, id); berr != nil {
			if s.requireBMP {
				s.log.Warn().Err(berr).Int64("withdrawal_id", id).Str("by", adminEmail).
					Msg("pago bloqueado: verificación BMP no elegible o vencida")
				return berr
			}
			s.log.Warn().Err(berr).Int64("withdrawal_id", id).Str("by", adminEmail).
				Msg("candado BMP DESACTIVADO (WITHDRAWALS_REQUIRE_BMP=false): se paga pese a la verificación")
		}
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op tras Commit

	// Guard de transición + idempotencia: sólo actualiza si el estado ACTUAL es
	// uno de los permitidos. Si ninguna fila matchea, el RETURNING no produce
	// renglón y el Scan devuelve pgx.ErrNoRows ⇒ transición inválida o ya aplicada
	// (evita re-pagos y saltos de estado que corromperían four-eyes/finanzas).
	// RETURNING trae wallet_id + affiliate_id + amount_usd del renglón
	// transicionado para postear el débito y re-validar el saldo con datos
	// autoritativos (sin segundo round-trip ni race).
	//
	// approved_by_person_id se escribe SÓLO en la transición a 'approved'. $3 es
	// el email del actor de ESTA transición, así que al pagar es el PAGADOR: como
	// todo admin tiene fila en mlm.person, el subquery siempre resolvía non-NULL y
	// el COALESCE anterior siempre sobrescribía, borrando al aprobador cuando
	// aprobador y pagador eran distintos. El CASE deja la columna intacta en
	// 'paid'/'rejected'/'cancelled' y conserva el rastro de four-eyes.
	//
	// (Que el pagador DEBA ser distinto del aprobador es una regla de política
	// aparte, aún sin decidir; acá sólo se preserva la evidencia para poder
	// auditarlo.)
	var walletID, affiliateID int64
	var amountUSD string
	err = tx.QueryRow(ctx, `
		UPDATE mlm.withdrawal_request
		   SET status=$2::mlm.withdrawal_status,
		       approved_by_person_id = CASE
		         WHEN $2 = 'approved' THEN COALESCE(
		           (SELECT id FROM mlm.person WHERE lower(email)=lower($3) LIMIT 1),
		           approved_by_person_id)
		         ELSE approved_by_person_id
		       END,
		       updated_at=now()
		 WHERE id=$1 AND status::text = ANY($4)
		RETURNING wallet_id, affiliate_id, amount_usd::text
	`, id, status, adminEmail, allowedPrior).Scan(&walletID, &affiliateID, &amountUSD)
	if errors.Is(err, pgx.ErrNoRows) {
		// 0 filas afectadas ⇒ transición inválida o ya aplicada. No se postea nada.
		return fmt.Errorf("%w: a %q para el retiro %d (estado actual no está en %v)", ErrInvalidTransition, status, id, allowedPrior)
	}
	if err != nil {
		return fmt.Errorf("set withdrawal status: %w", err)
	}

	// Débito contable SÓLO al pagar. Idempotente por external_ref='withdrawal:<id>'
	// (UNIQUE en mlm.transaction): un segundo 'paid' del mismo id NO puede doble-
	// postear (ON CONFLICT DO NOTHING ⇒ sin fila de txn ⇒ sin movement). El guard
	// C2 arriba ya bloquea el segundo 'paid' de todos modos; esto es defensa en
	// profundidad a nivel contable. El monto va NEGATIVO (fn_validate_movement
	// exige amount<0 para conceptos factor=-1) contra la wallet USD del miembro,
	// madurado y disponible de inmediato (posted_at = now(), available_at =
	// current_date, o sea hoy — AvailableBalanceSQL cuenta como madurado todo
	// available_at <= current_date).
	if status == "paid" {
		amt, derr := decimal.NewFromString(amountUSD)
		if derr != nil {
			return fmt.Errorf("parse amount_usd %q: %w", amountUSD, derr)
		}

		// Re-validación de saldo DENTRO de la transacción del pago, antes de
		// postear el débito.
		//
		// El saldo se validaba SÓLO al solicitar, y entre aprobar y pagar pasan
		// días. El caso que importa: ops marca is_frozen=true sobre los movimientos
		// de un afiliado por sospecha de fraude (esa columna no tiene escritor en el
		// código; su uso previsto es manual). AvailableBalanceSQL excluye los
		// congelados, pero nada volvía a mirarlo al pagar: el UPDATE no consultaba
		// saldo y fn_validate_movement sólo verifica el SIGNO del monto, no que la
		// wallet quede no-negativa. La wallet terminaba en -$1000.
		//
		// Fórmula (ver PendingWithdrawalsExcludingSQL): este retiro ya figura entre
		// los pendientes por estar en 'approved', así que se lo excluye del agregado
		// en vez de restarlo dos veces.
		//
		//	monto <= disponible - (pendientes de OTROS retiros)
		//
		// Va dentro de la transacción a propósito: leer el saldo fuera dejaría una
		// ventana entre la lectura y el débito. Un error de la consulta aborta el
		// pago (fail-closed): no se debita contra un saldo que no se pudo leer.
		var availStr, pendingStr string
		if err := tx.QueryRow(ctx, AvailableBalanceSQL, walletID).Scan(&availStr); err != nil {
			return fmt.Errorf("re-validación de saldo al pagar (fail-closed): %w", err)
		}
		if err := tx.QueryRow(ctx, PendingWithdrawalsExcludingSQL, affiliateID, id).Scan(&pendingStr); err != nil {
			return fmt.Errorf("re-validación de pendientes al pagar (fail-closed): %w", err)
		}
		avail, aerr := decimal.NewFromString(availStr)
		if aerr != nil {
			return fmt.Errorf("parse disponible %q: %w", availStr, aerr)
		}
		pending, perr := decimal.NewFromString(pendingStr)
		if perr != nil {
			return fmt.Errorf("parse pendientes %q: %w", pendingStr, perr)
		}
		if amt.GreaterThan(avail.Sub(pending)) {
			s.log.Warn().Int64("withdrawal_id", id).Str("by", adminEmail).
				Str("amount", amt.String()).Str("available", avail.String()).
				Str("pending_otros", pending.String()).
				Msg("pago bloqueado: el saldo disponible ya no cubre el retiro")
			return ErrInsufficientAtPay
		}

		debit := amt.Neg()
		extRef := fmt.Sprintf("withdrawal:%d", id)
		if _, err := tx.Exec(ctx, `
			WITH txn AS (
			  INSERT INTO mlm.transaction (external_ref, description, status, posted_at)
			  VALUES ($1, 'Retiro pagado (débito)', 'posted', now())
			  ON CONFLICT (external_ref) DO NOTHING
			  RETURNING id)
			INSERT INTO mlm.wallet_movement
			  (transaction_id, wallet_id, affiliate_id, concept_id, amount, posted_at, available_at)
			SELECT t.id, w.id, w.affiliate_id, $3, $4, now(), current_date
			  FROM txn t
			  JOIN mlm.wallet w ON w.id = $2
		`, extRef, walletID, withdrawalDebitConceptID, debit); err != nil {
			return fmt.Errorf("post withdrawal debit: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}

	s.log.Info().Int64("withdrawal_id", id).Str("status", status).Str("by", adminEmail).Msg("withdrawal status changed")
	return nil
}
