package withdrawals

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

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
// y en _meta/migration/40_withdrawal_concept.sql.
const withdrawalDebitConceptID = 1013

// withdrawalTransitions define las transiciones VÁLIDAS: target -> estados-previos
// permitidos (four-eyes: pagar exige aprobar antes; no re-pagar un 'paid'; no
// reactivar un 'rejected').
var withdrawalTransitions = map[string][]string{
	"approved":  {"requested"},
	"rejected":  {"requested"},
	"paid":      {"approved"},
	"cancelled": {"requested", "approved"},
}

// SetWithdrawalStatus cambia el estado de una solicitud. Al transicionar a
// 'paid' — y SÓLO entonces — postea el DÉBITO contable en la MISMA transacción
// que el cambio de estado, cerrando la brecha de doble-gasto C1.
func (s *Store) SetWithdrawalStatus(ctx context.Context, id int64, status, adminEmail string) error {
	allowedPrior, ok := withdrawalTransitions[status]
	if !ok {
		return fmt.Errorf("invalid status %q", status)
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

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
		return fmt.Errorf("invalid transition to %q for withdrawal %d (current status not in %v)", status, id, allowedPrior)
	}
	if err != nil {
		return fmt.Errorf("set withdrawal status: %w", err)
	}

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
