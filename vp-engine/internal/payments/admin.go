package payments

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

var ErrNotAdmin = errors.New("not an admin")

// mpCodeRe reconoce el código canónico MP{affiliateID} (decimal) generado por
// GetMemberContext, para poder resolverlo por id aunque invitation_link no se
// haya persistido todavía.
var mpCodeRe = regexp.MustCompile(`^[Mm][Pp]([0-9]+)$`)

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
		       COALESCE(count(pi.id) FILTER (WHERE pi.status='activated' AND pi.stripe_present IS DISTINCT FROM false),0) AS sold,
		       COALESCE(SUM(pi.amount_usd+pi.fee_usd) FILTER (WHERE pi.status='activated' AND pi.stripe_present IS DISTINCT FROM false),0)::text AS revenue
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

	// Excluir cargos no verificados en Stripe live (stripe_present=false, p.ej.
	// transacciones de prueba) del total de ingresos y ventas.
	_ = s.db.QueryRow(ctx, `
		SELECT COALESCE(count(*) FILTER (WHERE status='activated' AND stripe_present IS DISTINCT FROM false),0),
		       COALESCE(SUM(amount_usd+fee_usd) FILTER (WHERE status='activated' AND stripe_present IS DISTINCT FROM false),0)::text
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

// ResolveSponsorByCode mapea un código de referido al affiliate_id del referidor.
// Robusto ante las distintas formas del código para que un link compartido
// siempre resuelva:
//  1. match exacto de invitation_link (códigos legacy "@handle" y "MP{id}" persistidos)
//  2. match case-insensitive de invitation_link (por si el @handle vino con otra caja)
//  3. fallback "MP{affiliateID}" → affiliate.id (código canónico aunque no se haya persistido)
//
// Devuelve nil si el código no corresponde a ningún afiliado.
func (s *Store) ResolveSponsorByCode(ctx context.Context, code string) (*int64, error) {
	code = strings.TrimSpace(code)
	if code == "" {
		return nil, nil
	}

	// 1) match exacto
	var id int64
	err := s.db.QueryRow(ctx,
		`SELECT id FROM mlm.affiliate WHERE invitation_link = $1 LIMIT 1`, code).Scan(&id)
	if err == nil {
		return &id, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("resolve sponsor by code: %w", err)
	}

	// 2) match case-insensitive
	err = s.db.QueryRow(ctx,
		`SELECT id FROM mlm.affiliate WHERE lower(invitation_link) = lower($1) LIMIT 1`, code).Scan(&id)
	if err == nil {
		return &id, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("resolve sponsor by code (ci): %w", err)
	}

	// 3) fallback MP{affiliateID}
	if m := mpCodeRe.FindStringSubmatch(code); m != nil {
		if n, perr := strconv.ParseInt(m[1], 10, 64); perr == nil {
			err = s.db.QueryRow(ctx,
				`SELECT id FROM mlm.affiliate WHERE id = $1`, n).Scan(&id)
			if err == nil {
				return &id, nil
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return nil, fmt.Errorf("resolve sponsor by mp code: %w", err)
			}
		}
	}

	return nil, nil
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
