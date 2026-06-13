package payments

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

// MemberPayment es una compra hecha por el miembro (payments.purchase_intent).
type MemberPayment struct {
	PurchaseID  string `json:"purchase_id"`
	PackageID   int    `json:"package_id"`
	AmountUSD   string `json:"amount_usd"`   // valor del pack
	FeeUSD      string `json:"fee_usd"`      // 1% activación
	TotalUSD    string `json:"total_usd"`    // cobrado
	Status      string `json:"status"`       // created|paid|activated|needs_placement|...
	CreatedAt   string `json:"created_at"`
	PaidAt      string `json:"paid_at,omitempty"`
	ActivatedAt string `json:"activated_at,omitempty"`
}

// MemberWithdrawal es una solicitud de retiro del miembro.
type MemberWithdrawal struct {
	ID        int64  `json:"id"`
	AmountUSD string `json:"amount_usd"`
	Status    string `json:"status"`
	CreatedAt string `json:"created_at"`
}

// MemberSummary: lo que ve el miembro — sus pagos + posición + comisiones.
type MemberSummary struct {
	Positioned            bool               `json:"positioned"`
	AffiliateID           *int64             `json:"affiliate_id,omitempty"`
	ActivePackages        int                `json:"active_packages"`
	Payments              []MemberPayment    `json:"payments"`
	CommissionAvailable   string             `json:"commission_available_usd"`    // madurado, no congelado
	CommissionMaturing    string             `json:"commission_maturing_usd"`     // créditos que aún no maduran
	AvailableForWithdrawal string            `json:"available_for_withdrawal_usd"` // disponible − retiros pendientes
	MinWithdrawalUSD      int                `json:"min_withdrawal_usd"`
	Withdrawals           []MemberWithdrawal `json:"withdrawals"`
}

// GetMemberSummary arma el resumen para el miembro identificado por email.
func (s *Store) GetMemberSummary(ctx context.Context, email string) (MemberSummary, error) {
	var out MemberSummary

	// Identidad → person + affiliate.
	var personID int64
	var affiliateID *int64
	err := s.db.QueryRow(ctx, `
		SELECT p.id, a.id
		  FROM mlm.person p
		  LEFT JOIN mlm.affiliate a ON a.person_id = p.id
		 WHERE lower(p.email) = lower($1)
		 LIMIT 1
	`, email).Scan(&personID, &affiliateID)
	if errors.Is(err, pgx.ErrNoRows) {
		return MemberSummary{}, ErrBuyerNotFound
	}
	if err != nil {
		return MemberSummary{}, fmt.Errorf("resolve member: %w", err)
	}
	out.AffiliateID = affiliateID
	out.Positioned = affiliateID != nil

	// Pagos del miembro (por email; user_id guarda el email).
	rows, err := s.db.Query(ctx, `
		SELECT id::text, package_id, amount_usd::text, fee_usd::text,
		       (amount_usd + fee_usd)::text, status,
		       to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSZ'),
		       COALESCE(to_char(paid_at, 'YYYY-MM-DD"T"HH24:MI:SSZ'), ''),
		       COALESCE(to_char(activated_at, 'YYYY-MM-DD"T"HH24:MI:SSZ'), '')
		  FROM payments.purchase_intent
		 WHERE lower(user_id) = lower($1)
		 ORDER BY created_at DESC
		 LIMIT 100
	`, email)
	if err != nil {
		return MemberSummary{}, fmt.Errorf("list payments: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var p MemberPayment
		if err := rows.Scan(&p.PurchaseID, &p.PackageID, &p.AmountUSD, &p.FeeUSD, &p.TotalUSD,
			&p.Status, &p.CreatedAt, &p.PaidAt, &p.ActivatedAt); err != nil {
			return MemberSummary{}, fmt.Errorf("scan payment: %w", err)
		}
		out.Payments = append(out.Payments, p)
	}
	if err := rows.Err(); err != nil {
		return MemberSummary{}, err
	}
	if out.Payments == nil {
		out.Payments = []MemberPayment{}
	}

	// Sin posición → sin paquetes ni comisiones.
	out.CommissionAvailable = "0.00"
	out.CommissionMaturing = "0.00"
	out.AvailableForWithdrawal = "0.00"
	out.MinWithdrawalUSD = MinWithdrawalUSD
	out.Withdrawals = []MemberWithdrawal{}
	if affiliateID == nil {
		return out, nil
	}

	// Paquetes activos.
	if err := s.db.QueryRow(ctx, `
		SELECT count(*) FROM mlm.affiliate_package
		 WHERE affiliate_id = $1 AND status = 'active'
	`, *affiliateID).Scan(&out.ActivePackages); err != nil {
		return MemberSummary{}, fmt.Errorf("count packages: %w", err)
	}

	// Comisiones: sobre los movimientos del afiliado.
	//   disponible = madurado (available_at <= hoy o NULL) y no congelado (incluye
	//                netos de retiros, que son débitos).
	//   madurando  = créditos con available_at futuro.
	// Nota: la elegibilidad final de retiro la gobierna el motor de bonos/liquidación;
	// esto es la vista contable del wallet del miembro.
	err = s.db.QueryRow(ctx, `
		SELECT
		  COALESCE(SUM(amount) FILTER (
		     WHERE NOT is_frozen AND (available_at IS NULL OR available_at <= current_date)
		  ), 0)::text,
		  COALESCE(SUM(amount) FILTER (
		     WHERE NOT is_frozen AND available_at > current_date AND amount > 0
		  ), 0)::text
		  FROM mlm.wallet_movement
		 WHERE affiliate_id = $1
	`, *affiliateID).Scan(&out.CommissionAvailable, &out.CommissionMaturing)
	if err != nil {
		return MemberSummary{}, fmt.Errorf("commissions: %w", err)
	}

	// Retiros del miembro + disponible neto de pendientes.
	wrows, err := s.db.Query(ctx, `
		SELECT id, amount_usd::text, status::text,
		       to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSZ')
		  FROM mlm.withdrawal_request
		 WHERE affiliate_id = $1
		 ORDER BY created_at DESC LIMIT 50
	`, *affiliateID)
	if err != nil {
		return MemberSummary{}, fmt.Errorf("list withdrawals: %w", err)
	}
	defer wrows.Close()
	pending := decimal.Zero
	for wrows.Next() {
		var wd MemberWithdrawal
		if err := wrows.Scan(&wd.ID, &wd.AmountUSD, &wd.Status, &wd.CreatedAt); err != nil {
			return MemberSummary{}, fmt.Errorf("scan withdrawal: %w", err)
		}
		if wd.Status == "requested" || wd.Status == "approved" {
			if a, e := decimal.NewFromString(wd.AmountUSD); e == nil {
				pending = pending.Add(a)
			}
		}
		out.Withdrawals = append(out.Withdrawals, wd)
	}
	if err := wrows.Err(); err != nil {
		return MemberSummary{}, err
	}
	if out.Withdrawals == nil {
		out.Withdrawals = []MemberWithdrawal{}
	}

	avail, _ := decimal.NewFromString(out.CommissionAvailable)
	forWd := avail.Sub(pending)
	if forWd.IsNegative() {
		forWd = decimal.Zero
	}
	out.AvailableForWithdrawal = forWd.StringFixed(2)

	return out, nil
}
