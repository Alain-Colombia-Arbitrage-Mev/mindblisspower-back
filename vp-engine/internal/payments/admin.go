package payments

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

var ErrNotAdmin = errors.New("not an admin")

// IsAdmin verifica si el email corresponde a un admin (mlm.person.is_admin).
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

// AdminUser es una fila de la tabla de usuarios del panel.
type AdminUser struct {
	PersonID       int64  `json:"person_id"`
	Name           string `json:"name"`
	Email          string `json:"email"`
	Status         string `json:"status"`
	Blocked        bool   `json:"blocked"`
	Rank           string `json:"rank"`
	LeftCount      int64  `json:"left_count"`
	RightCount     int64  `json:"right_count"`
	TotalPaidUSD   string `json:"total_paid_usd"`
	ActivePackages int    `json:"active_packages"`
	Positioned     bool   `json:"positioned"`
}

// ListUsers devuelve usuarios paginados + total (filtrable por q en email/nombre).
func (s *Store) ListUsers(ctx context.Context, q string, limit, offset int) ([]AdminUser, int64, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	var total int64
	if err := s.db.QueryRow(ctx, `
		SELECT count(*) FROM mlm.person p
		 WHERE ($1='' OR p.email ILIKE '%'||$1||'%' OR (p.first_name||' '||p.last_name) ILIKE '%'||$1||'%')
	`, q).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count users: %w", err)
	}

	rows, err := s.db.Query(ctx, `
		SELECT p.id,
		       trim(p.first_name||' '||p.last_name) AS name,
		       p.email, p.status::text, COALESCE(p.blacklisted,false),
		       COALESCE(r.name_es,'—') AS rank,
		       COALESCE(a.left_count,0), COALESCE(a.right_count,0),
		       (a.id IS NOT NULL) AS positioned,
		       COALESCE((SELECT SUM(amount_usd+fee_usd) FROM payments.purchase_intent pi
		                  WHERE lower(pi.user_id)=lower(p.email) AND pi.status IN ('paid','activated')),0)::text AS total_paid,
		       COALESCE((SELECT count(*) FROM mlm.affiliate_package ap
		                  WHERE ap.affiliate_id=a.id AND ap.status='active'),0) AS active_packages
		  FROM mlm.person p
		  LEFT JOIN mlm.affiliate a ON a.person_id=p.id
		  LEFT JOIN mlm.rank r      ON r.id=a.current_rank_id
		 WHERE ($1='' OR p.email ILIKE '%'||$1||'%' OR (p.first_name||' '||p.last_name) ILIKE '%'||$1||'%')
		 ORDER BY p.id DESC
		 LIMIT $2 OFFSET $3
	`, q, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("list users: %w", err)
	}
	defer rows.Close()

	out := []AdminUser{}
	for rows.Next() {
		var u AdminUser
		if err := rows.Scan(&u.PersonID, &u.Name, &u.Email, &u.Status, &u.Blocked, &u.Rank,
			&u.LeftCount, &u.RightCount, &u.Positioned, &u.TotalPaidUSD, &u.ActivePackages); err != nil {
			return nil, 0, fmt.Errorf("scan user: %w", err)
		}
		out = append(out, u)
	}
	return out, total, rows.Err()
}

// ProductSales: total vendido por producto (vía Stripe, status activated).
type ProductSales struct {
	PackageID  int    `json:"package_id"`
	Name       string `json:"name"`
	AmountUSD  string `json:"amount_usd"`
	Sold       int64  `json:"sold"`
	RevenueUSD string `json:"revenue_usd"`
}

// AdminSummary agrega ventas por producto + totales.
type AdminSummary struct {
	Products      []ProductSales `json:"products"`
	TotalSold     int64          `json:"total_sold"`
	TotalRevenUSD string         `json:"total_revenue_usd"`
	TotalUsers    int64          `json:"total_users"`
	BlockedUsers  int64          `json:"blocked_users"`
}

func (s *Store) AdminSummary(ctx context.Context) (AdminSummary, error) {
	var sum AdminSummary
	rows, err := s.db.Query(ctx, `
		SELECT pk.id, pk.name, pk.amount_usd::text,
		       COALESCE(count(pi.id) FILTER (WHERE pi.status='activated'),0) AS sold,
		       COALESCE(SUM(pi.amount_usd+pi.fee_usd) FILTER (WHERE pi.status='activated'),0)::text AS revenue
		  FROM mlm.package pk
		  LEFT JOIN payments.purchase_intent pi ON pi.package_id=pk.id
		 WHERE pk.is_active
		 GROUP BY pk.id, pk.name, pk.amount_usd
		 ORDER BY pk.amount_usd
	`)
	if err != nil {
		return sum, fmt.Errorf("product sales: %w", err)
	}
	defer rows.Close()
	sum.Products = []ProductSales{}
	for rows.Next() {
		var p ProductSales
		if err := rows.Scan(&p.PackageID, &p.Name, &p.AmountUSD, &p.Sold, &p.RevenueUSD); err != nil {
			return sum, err
		}
		sum.Products = append(sum.Products, p)
	}
	if err := rows.Err(); err != nil {
		return sum, err
	}

	_ = s.db.QueryRow(ctx, `
		SELECT COALESCE(count(*) FILTER (WHERE status='activated'),0),
		       COALESCE(SUM(amount_usd+fee_usd) FILTER (WHERE status='activated'),0)::text
		  FROM payments.purchase_intent`).Scan(&sum.TotalSold, &sum.TotalRevenUSD)
	_ = s.db.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE blacklisted) FROM mlm.person`).
		Scan(&sum.TotalUsers, &sum.BlockedUsers)
	if sum.TotalRevenUSD == "" {
		sum.TotalRevenUSD = "0"
	}
	return sum, nil
}

// AdminPayment es un pago de NUESTRO endpoint (payments.purchase_intent).
type AdminPayment struct {
	ID              string `json:"id"`
	Email           string `json:"email"`
	Name            string `json:"name"`
	PackageID       int    `json:"package_id"`
	AmountUSD       string `json:"amount_usd"`
	FeeUSD          string `json:"fee_usd"`
	TotalUSD        string `json:"total_usd"`
	Status          string `json:"status"`
	PaymentIntentID string `json:"payment_intent_id"`
	CreatedAt       string `json:"created_at"`
	PaidAt          string `json:"paid_at"`
}

// ListPayments lista los pagos hechos por NUESTRO checkout/webhook
// (tabla payments.purchase_intent) — no incluye otros endpoints de Stripe.
func (s *Store) ListPayments(ctx context.Context, status, q string, limit, offset int) ([]AdminPayment, int64, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	var total int64
	if err := s.db.QueryRow(ctx, `
		SELECT count(*) FROM payments.purchase_intent
		 WHERE ($1='' OR status=$1) AND ($2='' OR lower(user_id) ILIKE '%'||lower($2)||'%')
	`, status, q).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count payments: %w", err)
	}
	rows, err := s.db.Query(ctx, `
		SELECT pi.id::text, pi.user_id,
		       COALESCE((SELECT trim(p.first_name||' '||p.last_name) FROM mlm.person p WHERE p.id=pi.person_id),''),
		       pi.package_id, pi.amount_usd::text, pi.fee_usd::text, (pi.amount_usd+pi.fee_usd)::text,
		       pi.status, COALESCE(pi.stripe_payment_intent_id,''),
		       to_char(pi.created_at,'YYYY-MM-DD"T"HH24:MI:SSZ'),
		       COALESCE(to_char(pi.paid_at,'YYYY-MM-DD"T"HH24:MI:SSZ'),'')
		  FROM payments.purchase_intent pi
		 WHERE ($1='' OR pi.status=$1) AND ($2='' OR lower(pi.user_id) ILIKE '%'||lower($2)||'%')
		 ORDER BY pi.created_at DESC
		 LIMIT $3 OFFSET $4
	`, status, q, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("list payments: %w", err)
	}
	defer rows.Close()
	out := []AdminPayment{}
	for rows.Next() {
		var p AdminPayment
		if err := rows.Scan(&p.ID, &p.Email, &p.Name, &p.PackageID, &p.AmountUSD, &p.FeeUSD, &p.TotalUSD,
			&p.Status, &p.PaymentIntentID, &p.CreatedAt, &p.PaidAt); err != nil {
			return nil, 0, err
		}
		out = append(out, p)
	}
	return out, total, rows.Err()
}

// ResolveSponsorByCode mapea un código de referido (invitation_link) al
// affiliate_id del referidor. Devuelve nil si no existe.
func (s *Store) ResolveSponsorByCode(ctx context.Context, code string) (*int64, error) {
	if code == "" {
		return nil, nil
	}
	var id int64
	err := s.db.QueryRow(ctx,
		`SELECT id FROM mlm.affiliate WHERE invitation_link = $1 LIMIT 1`, code).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("resolve sponsor by code: %w", err)
	}
	return &id, nil
}

// AdminWithdrawal es una solicitud de retiro para el panel.
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
// factor=-1, requires_pair=false). Sembrado en schema_payouts_v1.3.sql y en la
// migración _meta/migration/40_withdrawal_concept.sql. El asiento es de una sola
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
		return fmt.Errorf("invalid status %q", status)
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
		return fmt.Errorf("invalid transition to %q for withdrawal %d (current status not in %v)", status, id, allowedPrior)
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

	s.cache.del(ctx, "fin:admin")
	s.cache.PublishEvent(ctx, "withdrawal."+status, map[string]any{"withdrawal_id": id, "by": adminEmail})
	return nil
}

// SetBlocked bloquea/desbloquea un usuario (blacklisted + status).
func (s *Store) SetBlocked(ctx context.Context, personID int64, blocked bool) error {
	status := "active"
	if blocked {
		status = "suspended"
	}
	_, err := s.db.Exec(ctx, `
		UPDATE mlm.person
		   SET blacklisted=$2,
		       status=$3::mlm.person_status,
		       updated_at=now()
		 WHERE id=$1
	`, personID, blocked, status)
	if err != nil {
		return fmt.Errorf("set blocked: %w", err)
	}
	return nil
}
