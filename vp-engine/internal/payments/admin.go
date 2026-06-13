package payments

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
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

// SetWithdrawalStatus cambia el estado de una solicitud (aprobar/rechazar/pagar/
// cancelar) y registra quién aprobó. NOTA: marcar 'paid' NO postea aún el débito
// contable (wallet_movement) — eso lo hace el motor; aquí solo el estado/auditoría.
func (s *Store) SetWithdrawalStatus(ctx context.Context, id int64, status, adminEmail string) error {
	switch status {
	case "approved", "rejected", "paid", "cancelled":
	default:
		return fmt.Errorf("invalid status %q", status)
	}
	_, err := s.db.Exec(ctx, `
		UPDATE mlm.withdrawal_request
		   SET status=$2::mlm.withdrawal_status,
		       approved_by_person_id = COALESCE(
		         (SELECT id FROM mlm.person WHERE lower(email)=lower($3) LIMIT 1),
		         approved_by_person_id),
		       updated_at=now()
		 WHERE id=$1
	`, id, status, adminEmail)
	if err != nil {
		return fmt.Errorf("set withdrawal status: %w", err)
	}
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
