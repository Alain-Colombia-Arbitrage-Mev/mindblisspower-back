package withdrawals

import (
	"context"
	"errors"
	"fmt"

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
type AdminWithdrawal struct {
	ID        int64  `json:"id"`
	Member    string `json:"member"`
	Email     string `json:"email"`
	AmountUSD string `json:"amount_usd"`
	Status    string `json:"status"`
	BankInfo  string `json:"bank_info"`
	CreatedAt string `json:"created_at"`
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
		       to_char(wr.created_at,'YYYY-MM-DD"T"HH24:MI:SSZ')
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
		if err := rows.Scan(&w.ID, &w.Member, &w.Email, &w.AmountUSD, &w.Status, &w.BankInfo, &w.CreatedAt); err != nil {
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
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op tras Commit

	// Guard de transición + idempotencia: sólo actualiza si el estado ACTUAL es
	// uno de los permitidos. RowsAffected==0 ⇒ transición inválida o ya aplicada
	// (evita re-pagos y saltos de estado que corromperían four-eyes/finanzas).
	// RETURNING trae wallet_id + amount_usd del renglón transicionado para postear
	// el débito con datos autoritativos (sin segundo round-trip ni race).
	var walletID int64
	var amountUSD string
	err = tx.QueryRow(ctx, `
		UPDATE mlm.withdrawal_request
		   SET status=$2::mlm.withdrawal_status,
		       approved_by_person_id = COALESCE(
		         (SELECT id FROM mlm.person WHERE lower(email)=lower($3) LIMIT 1),
		         approved_by_person_id),
		       updated_at=now()
		 WHERE id=$1 AND status::text = ANY($4)
		RETURNING wallet_id, amount_usd::text
	`, id, status, adminEmail, allowedPrior).Scan(&walletID, &amountUSD)
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
	// madurado y disponible de inmediato (posted_at = available_at = now()).
	if status == "paid" {
		amt, derr := decimal.NewFromString(amountUSD)
		if derr != nil {
			return fmt.Errorf("parse amount_usd %q: %w", amountUSD, derr)
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
