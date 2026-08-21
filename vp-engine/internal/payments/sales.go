package payments

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/shopspring/decimal"
)

const securityPendingChargeUSD = "70.00"

const riskChargeStatusesSQL = "'failed','refunded','security_blocked','disputed','chargeback'"

// SalesRow es el desglose de ventas de un paquete (tier de precio del producto
// Stripe PACK MINDBLISS) en el período consultado.
type SalesRow struct {
	PackageID   int64  `json:"package_id"`
	Name        string `json:"name"`
	AmountUSD   string `json:"amount_usd"`
	Created     int64  `json:"created"`
	Paid        int64  `json:"paid"`
	Activated   int64  `json:"activated"`
	RevenueUSD  string `json:"revenue_usd"` // suma de intents activados
	GrossUSD    string `json:"gross_usd"`   // amount+fee cobrado exitosamente
	RefundedUSD string `json:"refunded_usd"`
}

// SalesCashSummary muestra la caja Stripe del período consultado. Se calcula
// sobre cobros exitosos verificados: paid_at presente, no reembolsados y no
// marcados como inexistentes en Stripe live.
type SalesCashSummary struct {
	TotalStarted             int64  `json:"total_started"`
	SuccessfulCharges        int64  `json:"successful_charges"`
	ActivatedSales           int64  `json:"activated_sales"`
	PackageSalesUSD          string `json:"package_sales_usd"`
	ActivationFeesUSD        string `json:"activation_fees_usd"`
	GrossChargedUSD          string `json:"gross_charged_usd"`
	StripeFeeUSD             string `json:"stripe_fee_usd"`
	StripeSecurityReserveUSD string `json:"stripe_security_reserve_usd"`
	StripeReceivableUSD      string `json:"stripe_receivable_usd"`
	StripeReceivableETA      string `json:"stripe_receivable_eta"`
	PendingStripePayoutUSD   string `json:"pending_stripe_payout_usd"`
	AvailableAfterStripeUSD  string `json:"available_after_stripe_usd"`
	RefundedCharges          int64  `json:"refunded_charges"`
	RefundedUSD              string `json:"refunded_usd"`
}

// SecurityPendingChargeSummary totaliza las ventas con riesgo operativo que
// generan un cobro pendiente fijo de $70: rechazadas/fallidas, bloqueadas por
// seguridad, disputas, chargebacks y reembolsos.
type SecurityPendingChargeSummary struct {
	UnitChargeUSD     string `json:"unit_charge_usd"`
	AffectedSales     int64  `json:"affected_sales"`
	PendingChargeUSD  string `json:"pending_charge_usd"`
	FailedSales       int64  `json:"failed_sales"`
	SecurityBlocked   int64  `json:"security_blocked_sales"`
	DisputedSales     int64  `json:"disputed_sales"`
	ChargebackSales   int64  `json:"chargeback_sales"`
	RefundedSales     int64  `json:"refunded_sales"`
	ManualAdjustments int64  `json:"manual_adjustments"`
	ManualChargeUSD   string `json:"manual_charge_usd"`
}

type OperationalChargeAdjustment struct {
	ID             string `json:"id"`
	ChargeType     string `json:"charge_type"`
	Quantity       int64  `json:"quantity"`
	UnitAmountUSD  string `json:"unit_amount_usd"`
	TotalAmountUSD string `json:"total_amount_usd"`
	Reason         string `json:"reason"`
	CreatedBy      string `json:"created_by"`
	OccurredAt     string `json:"occurred_at"`
}

var (
	ErrOperationalChargeType     = errors.New("invalid operational charge type")
	ErrOperationalChargeQuantity = errors.New("invalid operational charge quantity")
	ErrOperationalChargeReason   = errors.New("operational charge reason required")
)

// SalesReport agrega ventas por paquete (solo membresías MindBliss: la fuente es
// payments.purchase_intent, que únicamente contiene checkouts del PACK MINDBLISS)
// desde `from`.
//   - Created  = total de intents iniciados en el período.
//   - Paid     = intents con dinero recibido (paid_at IS NOT NULL, excluye
//     reembolsados). NOTA: antes filtraba por status='paid', pero ese
//     estado es transitorio dentro de la tx de activación (created→
//     paid→activated) y casi nunca queda persistido → la columna daba
//     0 aunque hubiera ventas. paid_at es la señal correcta.
//   - Activated= intents colocados en el árbol (status='activated').
//   - Revenue  = suma de amount_usd de lo efectivamente cobrado (paid_at not null,
//     sin reembolsos), incluye pagos aún sin colocar (needs_placement).
func (s *Store) SalesReport(ctx context.Context, from time.Time) ([]SalesRow, error) {
	rows, err := s.reader().Query(ctx, `
		SELECT pk.id, pk.name, pk.amount_usd::text,
		       count(*),
		       count(*) FILTER (WHERE pi.paid_at IS NOT NULL AND pi.status NOT IN ('refunded','security_blocked','disputed','chargeback') AND pi.stripe_present IS DISTINCT FROM false),
		       count(*) FILTER (WHERE pi.status = 'activated' AND pi.stripe_present IS DISTINCT FROM false),
		       COALESCE(sum(pi.amount_usd) FILTER (WHERE pi.paid_at IS NOT NULL AND pi.status NOT IN ('refunded','security_blocked','disputed','chargeback') AND pi.stripe_present IS DISTINCT FROM false), 0)::text,
		       COALESCE(sum(pi.amount_usd + pi.fee_usd) FILTER (WHERE pi.paid_at IS NOT NULL AND pi.status NOT IN ('refunded','security_blocked','disputed','chargeback') AND pi.stripe_present IS DISTINCT FROM false), 0)::text,
		       COALESCE((sum(pi.total_cents) FILTER (WHERE pi.status = 'refunded'))::numeric / 100, 0)::text
		  FROM payments.purchase_intent pi
		  JOIN mlm.package pk ON pk.id = pi.package_id
		 WHERE pi.created_at >= $1
		 GROUP BY pk.id, pk.name, pk.amount_usd
		 ORDER BY pk.amount_usd`, from)
	if err != nil {
		return nil, fmt.Errorf("sales report: %w", err)
	}
	defer rows.Close()

	out := []SalesRow{}
	for rows.Next() {
		var r SalesRow
		if err := rows.Scan(&r.PackageID, &r.Name, &r.AmountUSD, &r.Created, &r.Paid, &r.Activated, &r.RevenueUSD, &r.GrossUSD, &r.RefundedUSD); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) SalesCashSummary(ctx context.Context, from time.Time) (SalesCashSummary, error) {
	var c SalesCashSummary
	if err := s.reader().QueryRow(ctx, `
		SELECT count(*),
		       count(*) FILTER (WHERE paid_at IS NOT NULL AND status NOT IN ('refunded','security_blocked','disputed','chargeback') AND stripe_present IS DISTINCT FROM false),
		       count(*) FILTER (WHERE status = 'activated' AND stripe_present IS DISTINCT FROM false),
		       COALESCE(sum(amount_usd) FILTER (WHERE paid_at IS NOT NULL AND status NOT IN ('refunded','security_blocked','disputed','chargeback') AND stripe_present IS DISTINCT FROM false), 0)::text,
		       COALESCE(sum(fee_usd) FILTER (WHERE paid_at IS NOT NULL AND status NOT IN ('refunded','security_blocked','disputed','chargeback') AND stripe_present IS DISTINCT FROM false), 0)::text,
		       COALESCE(sum(amount_usd + fee_usd) FILTER (WHERE paid_at IS NOT NULL AND status NOT IN ('refunded','security_blocked','disputed','chargeback') AND stripe_present IS DISTINCT FROM false), 0)::text,
		       COALESCE(round(sum(amount_usd + fee_usd) FILTER (WHERE paid_at IS NOT NULL AND status NOT IN ('refunded','security_blocked','disputed','chargeback') AND stripe_present IS DISTINCT FROM false) * 0.03, 2), 0)::text,
		       COALESCE(round(sum(amount_usd + fee_usd) FILTER (WHERE paid_at IS NOT NULL AND status NOT IN ('refunded','security_blocked','disputed','chargeback') AND stripe_present IS DISTINCT FROM false) * 0.30, 2), 0)::text,
		       COALESCE(round(sum(amount_usd + fee_usd) FILTER (WHERE paid_at IS NOT NULL AND status NOT IN ('refunded','security_blocked','disputed','chargeback') AND stripe_present IS DISTINCT FROM false) * 0.67, 2), 0)::text,
		       COALESCE(count(*) FILTER (WHERE status = 'refunded'),0),
		       COALESCE((sum(total_cents) FILTER (WHERE status = 'refunded'))::numeric / 100, 0)::text
		  FROM payments.purchase_intent
		 WHERE created_at >= $1
	`, from).Scan(
		&c.TotalStarted, &c.SuccessfulCharges, &c.ActivatedSales,
		&c.PackageSalesUSD, &c.ActivationFeesUSD, &c.GrossChargedUSD,
		&c.StripeFeeUSD, &c.StripeSecurityReserveUSD, &c.StripeReceivableUSD,
		&c.RefundedCharges, &c.RefundedUSD,
	); err != nil {
		return SalesCashSummary{}, fmt.Errorf("sales cash summary: %w", err)
	}
	c.StripeReceivableETA = "Periodo estimado: 2 semanas"
	c.PendingStripePayoutUSD = c.StripeReceivableUSD
	c.AvailableAfterStripeUSD = c.StripeReceivableUSD // alias legacy: no significa dinero ya disponible en banco
	return c, nil
}

func (s *Store) SecurityPendingChargeSummary(ctx context.Context, from time.Time) (SecurityPendingChargeSummary, error) {
	var c SecurityPendingChargeSummary
	c.UnitChargeUSD = securityPendingChargeUSD
	c.ManualChargeUSD = "0.00"
	if err := s.reader().QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE status IN (`+riskChargeStatusesSQL+`)),
		       COALESCE((count(*) FILTER (WHERE status IN (`+riskChargeStatusesSQL+`)) * 70.00)::numeric(14,2), 0)::text,
		       count(*) FILTER (WHERE status = 'failed'),
		       count(*) FILTER (WHERE status = 'security_blocked'),
		       count(*) FILTER (WHERE status = 'disputed'),
		       count(*) FILTER (WHERE status = 'chargeback'),
		       count(*) FILTER (WHERE status = 'refunded')
		  FROM payments.purchase_intent
		 WHERE created_at >= $1
	`, from).Scan(
		&c.AffectedSales, &c.PendingChargeUSD, &c.FailedSales, &c.SecurityBlocked,
		&c.DisputedSales, &c.ChargebackSales, &c.RefundedSales,
	); err != nil {
		return SecurityPendingChargeSummary{}, fmt.Errorf("security pending charges: %w", err)
	}
	manual, err := s.manualOperationalChargeSummary(ctx, from)
	if err != nil {
		return SecurityPendingChargeSummary{}, err
	}
	mergeSecurityChargeSummary(&c, manual)
	return c, nil
}

func mergeSecurityChargeSummary(dst *SecurityPendingChargeSummary, manual SecurityPendingChargeSummary) {
	if manual.AffectedSales == 0 {
		return
	}
	dst.AffectedSales += manual.AffectedSales
	dst.FailedSales += manual.FailedSales
	dst.SecurityBlocked += manual.SecurityBlocked
	dst.DisputedSales += manual.DisputedSales
	dst.ChargebackSales += manual.ChargebackSales
	dst.RefundedSales += manual.RefundedSales
	dst.ManualAdjustments += manual.AffectedSales
	dst.ManualChargeUSD = moneyAdd(dst.ManualChargeUSD, manual.PendingChargeUSD)
	dst.PendingChargeUSD = moneyAdd(dst.PendingChargeUSD, manual.PendingChargeUSD)
}

func (s *Store) manualOperationalChargeSummary(ctx context.Context, from time.Time) (SecurityPendingChargeSummary, error) {
	c, err := s.manualOperationalChargeTableSummary(ctx, from)
	if err != nil {
		return SecurityPendingChargeSummary{}, err
	}
	fallback, err := s.manualOperationalChargeAuditFallbackSummary(ctx, from)
	if err != nil {
		return SecurityPendingChargeSummary{}, err
	}
	mergeSecurityChargeSummary(&c, fallback)
	eventFallback, err := s.manualOperationalChargeEventFallbackSummary(ctx, from)
	if err != nil {
		return SecurityPendingChargeSummary{}, err
	}
	mergeSecurityChargeSummary(&c, eventFallback)
	c.ManualAdjustments = c.AffectedSales
	c.ManualChargeUSD = c.PendingChargeUSD
	return c, nil
}

func (s *Store) manualOperationalChargeTableSummary(ctx context.Context, from time.Time) (SecurityPendingChargeSummary, error) {
	var c SecurityPendingChargeSummary
	c.UnitChargeUSD = securityPendingChargeUSD
	c.ManualChargeUSD = "0.00"
	err := s.reader().QueryRow(ctx, `
		SELECT COALESCE(sum(quantity),0),
		       COALESCE(sum(total_amount_usd),0)::numeric(14,2)::text,
		       COALESCE(sum(quantity) FILTER (WHERE charge_type = 'failed'),0),
		       COALESCE(sum(quantity) FILTER (WHERE charge_type = 'security_blocked'),0),
		       COALESCE(sum(quantity) FILTER (WHERE charge_type = 'disputed'),0),
		       COALESCE(sum(quantity) FILTER (WHERE charge_type = 'chargeback'),0),
		       COALESCE(sum(quantity) FILTER (WHERE charge_type = 'refunded'),0)
		  FROM payments.operational_charge_adjustment
		 WHERE occurred_at >= $1
	`, from).Scan(
		&c.AffectedSales, &c.PendingChargeUSD, &c.FailedSales, &c.SecurityBlocked,
		&c.DisputedSales, &c.ChargebackSales, &c.RefundedSales,
	)
	if isOperationalChargeTableUnavailable(err) {
		c.PendingChargeUSD = "0.00"
		return c, nil
	}
	if err != nil {
		return SecurityPendingChargeSummary{}, fmt.Errorf("manual operational charges: %w", err)
	}
	c.ManualAdjustments = c.AffectedSales
	c.ManualChargeUSD = c.PendingChargeUSD
	return c, nil
}

func (s *Store) manualOperationalChargeAuditFallbackSummary(ctx context.Context, from time.Time) (SecurityPendingChargeSummary, error) {
	var c SecurityPendingChargeSummary
	c.UnitChargeUSD = securityPendingChargeUSD
	c.ManualChargeUSD = "0.00"
	err := s.db.QueryRow(ctx, `
		SELECT COALESCE(sum((after_data->>'quantity')::bigint),0),
		       COALESCE(sum((after_data->>'total_amount_usd')::numeric),0)::numeric(14,2)::text,
		       COALESCE(sum((after_data->>'quantity')::bigint) FILTER (WHERE after_data->>'charge_type' = 'failed'),0),
		       COALESCE(sum((after_data->>'quantity')::bigint) FILTER (WHERE after_data->>'charge_type' = 'security_blocked'),0),
		       COALESCE(sum((after_data->>'quantity')::bigint) FILTER (WHERE after_data->>'charge_type' = 'disputed'),0),
		       COALESCE(sum((after_data->>'quantity')::bigint) FILTER (WHERE after_data->>'charge_type' = 'chargeback'),0),
		       COALESCE(sum((after_data->>'quantity')::bigint) FILTER (WHERE after_data->>'charge_type' = 'refunded'),0)
		  FROM audit.activity_log
		 WHERE entity_type = 'payments.operational_charge_adjustment'
		   AND action = 'created'
		   AND occurred_at >= $1
		   AND after_data->>'source' = 'audit_fallback'
	`, from).Scan(
		&c.AffectedSales, &c.PendingChargeUSD, &c.FailedSales, &c.SecurityBlocked,
		&c.DisputedSales, &c.ChargebackSales, &c.RefundedSales,
	)
	if isOperationalChargeTableUnavailable(err) {
		c.PendingChargeUSD = "0.00"
		return c, nil
	}
	if err != nil {
		return SecurityPendingChargeSummary{}, fmt.Errorf("audit fallback operational charges: %w", err)
	}
	c.ManualAdjustments = c.AffectedSales
	c.ManualChargeUSD = c.PendingChargeUSD
	return c, nil
}

func (s *Store) manualOperationalChargeEventFallbackSummary(ctx context.Context, from time.Time) (SecurityPendingChargeSummary, error) {
	var c SecurityPendingChargeSummary
	c.UnitChargeUSD = securityPendingChargeUSD
	c.ManualChargeUSD = "0.00"
	err := s.db.QueryRow(ctx, `
		WITH parsed AS (
			SELECT split_part(type, ':', 2) AS charge_type,
			       split_part(type, ':', 3)::bigint AS quantity,
			       split_part(type, ':', 4)::numeric AS total_amount_usd
			  FROM payments.stripe_event
			 WHERE received_at >= $1
			   AND type LIKE 'manual_operational_charge:%'
			   AND split_part(type, ':', 3) ~ '^[0-9]+$'
			   AND split_part(type, ':', 4) ~ '^[0-9]+(\.[0-9]{1,2})?$'
		)
		SELECT COALESCE(sum(quantity),0),
		       COALESCE(sum(total_amount_usd),0)::numeric(14,2)::text,
		       COALESCE(sum(quantity) FILTER (WHERE charge_type = 'failed'),0),
		       COALESCE(sum(quantity) FILTER (WHERE charge_type = 'security_blocked'),0),
		       COALESCE(sum(quantity) FILTER (WHERE charge_type = 'disputed'),0),
		       COALESCE(sum(quantity) FILTER (WHERE charge_type = 'chargeback'),0),
		       COALESCE(sum(quantity) FILTER (WHERE charge_type = 'refunded'),0)
		  FROM parsed
	`, from).Scan(
		&c.AffectedSales, &c.PendingChargeUSD, &c.FailedSales, &c.SecurityBlocked,
		&c.DisputedSales, &c.ChargebackSales, &c.RefundedSales,
	)
	if isOperationalChargeTableUnavailable(err) {
		c.PendingChargeUSD = "0.00"
		return c, nil
	}
	if err != nil {
		return SecurityPendingChargeSummary{}, fmt.Errorf("event fallback operational charges: %w", err)
	}
	c.ManualAdjustments = c.AffectedSales
	c.ManualChargeUSD = c.PendingChargeUSD
	return c, nil
}

func (s *Store) RecordOperationalCharge(ctx context.Context, chargeType string, quantity int64, reason, adminEmail string, occurredAt time.Time) (OperationalChargeAdjustment, error) {
	chargeType = normalizeOperationalChargeType(chargeType)
	reason = strings.TrimSpace(reason)
	adminEmail = strings.ToLower(strings.TrimSpace(adminEmail))
	if !validOperationalChargeType(chargeType) {
		return OperationalChargeAdjustment{}, ErrOperationalChargeType
	}
	if quantity <= 0 || quantity > 10000 {
		return OperationalChargeAdjustment{}, ErrOperationalChargeQuantity
	}
	if len(reason) < 3 || len(reason) > 500 {
		return OperationalChargeAdjustment{}, ErrOperationalChargeReason
	}
	if occurredAt.IsZero() {
		occurredAt = time.Now().UTC()
	}

	out, err := s.recordOperationalChargeTable(ctx, chargeType, quantity, reason, adminEmail, occurredAt)
	if isOperationalChargeTableUnavailable(err) {
		out, err = s.recordOperationalChargeAuditFallback(ctx, chargeType, quantity, reason, adminEmail, occurredAt)
		if isOperationalChargeTableUnavailable(err) {
			return s.recordOperationalChargeEventFallback(ctx, chargeType, quantity, reason, adminEmail, occurredAt)
		}
	}
	return out, err
}

func (s *Store) recordOperationalChargeTable(ctx context.Context, chargeType string, quantity int64, reason, adminEmail string, occurredAt time.Time) (OperationalChargeAdjustment, error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return OperationalChargeAdjustment{}, fmt.Errorf("operational charge begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var out OperationalChargeAdjustment
	err = tx.QueryRow(ctx, `
		INSERT INTO payments.operational_charge_adjustment (
			charge_type, quantity, unit_amount_usd, reason, created_by, occurred_at
		) VALUES ($1, $2, $3::numeric, $4, $5, $6)
		RETURNING id::text, charge_type, quantity::bigint, unit_amount_usd::text,
		          total_amount_usd::text, reason, created_by,
		          to_char(occurred_at,'YYYY-MM-DD"T"HH24:MI:SSZ')
	`, chargeType, quantity, securityPendingChargeUSD, reason, adminEmail, occurredAt).Scan(
		&out.ID, &out.ChargeType, &out.Quantity, &out.UnitAmountUSD,
		&out.TotalAmountUSD, &out.Reason, &out.CreatedBy, &out.OccurredAt,
	)
	if err != nil {
		return OperationalChargeAdjustment{}, fmt.Errorf("insert operational charge: %w", err)
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO audit.activity_log (entity_type, entity_id, action, after_data)
		VALUES (
			'payments.operational_charge_adjustment',
			$1,
			'created',
			jsonb_build_object(
				'charge_type', $2::text,
				'quantity', $3::bigint,
				'unit_amount_usd', $4::text,
				'total_amount_usd', $5::text,
				'reason', $6::text,
				'created_by', $7::text,
				'occurred_at', $8::text
			)
		)
	`, out.ID, out.ChargeType, out.Quantity, out.UnitAmountUSD, out.TotalAmountUSD, out.Reason, out.CreatedBy, out.OccurredAt); err != nil {
		return OperationalChargeAdjustment{}, fmt.Errorf("audit operational charge: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return OperationalChargeAdjustment{}, fmt.Errorf("operational charge commit: %w", err)
	}
	s.cache.del(ctx, "fin:admin")
	s.cache.PublishEvent(ctx, "admin.operational_charge.created", map[string]any{
		"id":               out.ID,
		"charge_type":      out.ChargeType,
		"quantity":         out.Quantity,
		"total_amount_usd": out.TotalAmountUSD,
		"created_by":       out.CreatedBy,
	})
	return out, nil
}

func (s *Store) recordOperationalChargeAuditFallback(ctx context.Context, chargeType string, quantity int64, reason, adminEmail string, occurredAt time.Time) (OperationalChargeAdjustment, error) {
	unit, err := decimal.NewFromString(securityPendingChargeUSD)
	if err != nil {
		unit = decimal.NewFromInt(70)
	}
	out := OperationalChargeAdjustment{
		ID:             uuid.NewString(),
		ChargeType:     chargeType,
		Quantity:       quantity,
		UnitAmountUSD:  unit.StringFixed(2),
		TotalAmountUSD: unit.Mul(decimal.NewFromInt(quantity)).StringFixed(2),
		Reason:         reason,
		CreatedBy:      adminEmail,
		OccurredAt:     occurredAt.UTC().Format("2006-01-02T15:04:05Z"),
	}
	if _, err := s.db.Exec(ctx, `
		INSERT INTO audit.activity_log (entity_type, entity_id, action, after_data, occurred_at)
		VALUES (
			'payments.operational_charge_adjustment',
			$1,
			'created',
			jsonb_build_object(
				'source', 'audit_fallback',
				'charge_type', $2::text,
				'quantity', $3::bigint,
				'unit_amount_usd', $4::text,
				'total_amount_usd', $5::text,
				'reason', $6::text,
				'created_by', $7::text,
				'occurred_at', $8::text
			),
			$9
		)
	`, out.ID, out.ChargeType, out.Quantity, out.UnitAmountUSD, out.TotalAmountUSD, out.Reason, out.CreatedBy, out.OccurredAt, occurredAt); err != nil {
		return OperationalChargeAdjustment{}, fmt.Errorf("audit fallback operational charge: %w", err)
	}
	s.cache.del(ctx, "fin:admin")
	s.cache.PublishEvent(ctx, "admin.operational_charge.created", map[string]any{
		"id":               out.ID,
		"charge_type":      out.ChargeType,
		"quantity":         out.Quantity,
		"total_amount_usd": out.TotalAmountUSD,
		"created_by":       out.CreatedBy,
	})
	return out, nil
}

func (s *Store) recordOperationalChargeEventFallback(ctx context.Context, chargeType string, quantity int64, reason, adminEmail string, occurredAt time.Time) (OperationalChargeAdjustment, error) {
	unit, err := decimal.NewFromString(securityPendingChargeUSD)
	if err != nil {
		unit = decimal.NewFromInt(70)
	}
	out := OperationalChargeAdjustment{
		ID:             uuid.NewString(),
		ChargeType:     chargeType,
		Quantity:       quantity,
		UnitAmountUSD:  unit.StringFixed(2),
		TotalAmountUSD: unit.Mul(decimal.NewFromInt(quantity)).StringFixed(2),
		Reason:         reason,
		CreatedBy:      adminEmail,
		OccurredAt:     occurredAt.UTC().Format("2006-01-02T15:04:05Z"),
	}
	eventID := "manual_operational_charge:" + out.ID
	eventType := "manual_operational_charge:" + out.ChargeType + ":" + fmt.Sprint(out.Quantity) + ":" + out.TotalAmountUSD + ":" + out.UnitAmountUSD
	if _, err := s.db.Exec(ctx, `
		INSERT INTO payments.stripe_event (event_id, type, received_at)
		VALUES ($1, $2, $3)
		ON CONFLICT (event_id) DO NOTHING
	`, eventID, eventType, occurredAt); err != nil {
		return OperationalChargeAdjustment{}, fmt.Errorf("event fallback operational charge: %w", err)
	}
	s.cache.del(ctx, "fin:admin")
	s.cache.PublishEvent(ctx, "admin.operational_charge.created", map[string]any{
		"id":               out.ID,
		"charge_type":      out.ChargeType,
		"quantity":         out.Quantity,
		"total_amount_usd": out.TotalAmountUSD,
		"created_by":       out.CreatedBy,
	})
	return out, nil
}

func normalizeOperationalChargeType(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "failed", "rejected", "declined", "rechazado", "rechazada", "rechazo":
		return "failed"
	case "refund", "refunded", "reembolso", "reembolsado", "reembolsada":
		return "refunded"
	case "security", "security_blocked", "blocked", "bloqueo", "bloqueado":
		return "security_blocked"
	case "dispute", "disputed", "disputa":
		return "disputed"
	case "chargeback", "contracargo":
		return "chargeback"
	default:
		return strings.ToLower(strings.TrimSpace(v))
	}
}

func validOperationalChargeType(v string) bool {
	switch v {
	case "failed", "refunded", "security_blocked", "disputed", "chargeback":
		return true
	default:
		return false
	}
}

func moneyAdd(a, b string) string {
	da, err := decimal.NewFromString(strings.TrimSpace(a))
	if err != nil {
		da = decimal.Zero
	}
	db, err := decimal.NewFromString(strings.TrimSpace(b))
	if err != nil {
		db = decimal.Zero
	}
	return da.Add(db).StringFixed(2)
}

func isOperationalChargeTableUnavailable(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && (pgErr.Code == "42P01" || pgErr.Code == "42501")
}

// DBSalesTotal es el agregado interno (fuente de verdad) de intents ACTIVADOS
// desde una fecha. GrossCents = sum(total_cents) e incluye el 1% de activación,
// para ser comparable 1:1 con el bruto de Stripe.
type DBSalesTotal struct {
	Count      int64 `json:"count"`
	GrossCents int64 `json:"gross_cents"`
}

// SalesTotalsSince agrega los intents ACTIVADOS desde `from` (cuenta + bruto en
// centavos) para conciliar contra Stripe.
func (s *Store) SalesTotalsSince(ctx context.Context, from time.Time) (DBSalesTotal, error) {
	var t DBSalesTotal
	err := s.reader().QueryRow(ctx, `
		SELECT count(*), COALESCE(sum(total_cents), 0)
		  FROM payments.purchase_intent
		 WHERE status = 'activated' AND stripe_present IS DISTINCT FROM false AND created_at >= $1`, from).Scan(&t.Count, &t.GrossCents)
	if err != nil {
		return DBSalesTotal{}, fmt.Errorf("sales totals: %w", err)
	}
	return t, nil
}

// handleAdminSalesReconcile: GET /api/admin/sales/reconcile?days=30 — compara el
// bruto interno (DB, fuente de verdad) contra Stripe (Search API filtrado por
// packmindbliss=true). Un delta ≠ 0 delata ventas fuera de la app (Payment
// Links) o intents no activados. Todo en centavos; delta = stripe − db.
func (h *Handler) handleAdminSalesReconcile(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	days := atoiDefault(r.URL.Query().Get("days"), 30)
	if days < 1 || days > 365 {
		days = 30
	}
	from := time.Now().UTC().AddDate(0, 0, -days)

	db, err := h.store.SalesTotalsSince(r.Context(), from)
	if err != nil {
		h.log.Error().Err(err).Msg("reconcile: db totals")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	st, err := h.gw.SearchSalesSince(from)
	if err != nil {
		h.log.Error().Err(err).Msg("reconcile: stripe search")
		writeErr(w, http.StatusBadGateway, "stripe_error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"from":              from.Format("2006-01-02"),
		"days":              days,
		"db":                db,
		"stripe":            st,
		"delta_count":       st.Count - db.Count,
		"delta_gross_cents": st.GrossCents - db.GrossCents,
		"reconciled":        st.Count == db.Count && st.GrossCents == db.GrossCents,
		"since":             time.Now().UTC().Format(time.RFC3339),
	})
}

// handleAdminSalesReport: GET /api/admin/sales/report?days=30 — desglose de
// ventas por paquete para el panel admin.
func (h *Handler) handleAdminSalesReport(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	days := atoiDefault(r.URL.Query().Get("days"), 30)
	if days < 1 || days > 365 {
		days = 30
	}
	from := time.Now().UTC().AddDate(0, 0, -days)
	report, err := h.store.SalesReport(r.Context(), from)
	if err != nil {
		h.log.Error().Err(err).Msg("sales report")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	cash, err := h.store.SalesCashSummary(r.Context(), from)
	if err != nil {
		h.log.Error().Err(err).Msg("sales cash summary")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	securityCharges, err := h.store.SecurityPendingChargeSummary(r.Context(), from)
	if err != nil {
		h.log.Error().Err(err).Msg("security pending charges")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"from":             from.Format("2006-01-02"),
		"days":             days,
		"rows":             report,
		"cash_summary":     cash,
		"security_charges": securityCharges,
		"since":            time.Now().UTC().Format(time.RFC3339),
	})
}

func (h *Handler) handleAdminOperationalCharge(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	adminEmail, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	if !h.isSuperAdmin(adminEmail) {
		writeErr(w, http.StatusForbidden, "super_admin_required")
		return
	}
	var req struct {
		ChargeType string `json:"charge_type"`
		Quantity   int64  `json:"quantity"`
		Reason     string `json:"reason"`
		OccurredAt string `json:"occurred_at"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}
	occurredAt, err := parseOperationalChargeOccurredAt(req.OccurredAt)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_occurred_at")
		return
	}
	adj, err := h.store.RecordOperationalCharge(r.Context(), req.ChargeType, req.Quantity, req.Reason, adminEmail, occurredAt)
	switch {
	case errors.Is(err, ErrOperationalChargeType):
		writeErr(w, http.StatusBadRequest, "invalid_charge_type")
	case errors.Is(err, ErrOperationalChargeQuantity):
		writeErr(w, http.StatusBadRequest, "invalid_quantity")
	case errors.Is(err, ErrOperationalChargeReason):
		writeErr(w, http.StatusBadRequest, "reason_required")
	case err != nil:
		h.log.Error().Err(err).Str("admin", adminEmail).Msg("record operational charge")
		writeErr(w, http.StatusInternalServerError, "internal")
	default:
		h.log.Info().
			Str("id", adj.ID).
			Str("charge_type", adj.ChargeType).
			Int64("quantity", adj.Quantity).
			Str("total_amount_usd", adj.TotalAmountUSD).
			Str("admin", adminEmail).
			Msg("admin operational charge recorded")
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "charge": adj})
	}
}

func parseOperationalChargeOccurredAt(v string) (time.Time, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		return time.Now().UTC(), nil
	}
	if t, err := time.Parse(time.RFC3339, v); err == nil {
		return t.UTC(), nil
	}
	if t, err := time.Parse("2006-01-02", v); err == nil {
		return t.UTC(), nil
	}
	return time.Time{}, fmt.Errorf("invalid occurred_at")
}

// SalesTransaction es una venta individual de membresía MindBliss para el
// reporte de transacciones del panel. Fuente: payments.purchase_intent (solo
// checkouts del PACK MINDBLISS), unido a mlm.package (nombre del plan) y
// mlm.person (identidad del pagador). Otros productos de Stripe NO aparecen aquí
// porque nunca generan un purchase_intent.
type SalesTransaction struct {
	ID           string `json:"id"`
	CreatedAt    string `json:"created_at"`
	Email        string `json:"email"`
	Name         string `json:"name"`
	Plan         string `json:"plan"`
	AmountUSD    string `json:"amount_usd"`
	FeeUSD       string `json:"fee_usd"`
	TotalUSD     string `json:"total_usd"`
	Status       string `json:"status"`
	Reference    string `json:"reference"` // stripe_payment_intent_id
	PaidAt       string `json:"paid_at"`
	ActivatedAt  string `json:"activated_at"`
	AffiliateID  *int64 `json:"affiliate_id"`   // colocación en el árbol (null = sin colocar)
	StripeVerify *bool  `json:"stripe_present"` // verificación Stripe live (null = sin verificar)
	RefundUSD    string `json:"refund_usd"`
	RefundedAt   string `json:"refunded_at"`
}

// SalesTransactions lista las ventas individuales de membresías desde `from`,
// con filtro opcional por status y búsqueda por email (user_id). Paginado.
func (s *Store) SalesTransactions(ctx context.Context, from time.Time, status, q string, limit, offset int) ([]SalesTransaction, int64, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	if offset < 0 {
		offset = 0
	}
	var total int64
	if err := s.reader().QueryRow(ctx, `
		SELECT count(*)
		  FROM payments.purchase_intent pi
		  JOIN mlm.package pk ON pk.id = pi.package_id
		 WHERE pi.created_at >= $1
		   AND ($2 = '' OR pi.status = $2)
		   AND ($3 = '' OR lower(pi.user_id) ILIKE '%'||lower($3)||'%')
	`, from, status, q).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count sales transactions: %w", err)
	}
	rows, err := s.reader().Query(ctx, `
		SELECT pi.id::text,
		       to_char(pi.created_at,'YYYY-MM-DD"T"HH24:MI:SSZ'),
		       pi.user_id,
		       COALESCE((SELECT trim(p.first_name||' '||p.last_name) FROM mlm.person p WHERE p.id = pi.person_id), ''),
		       pk.name,
		       pi.amount_usd::text, pi.fee_usd::text, (pi.amount_usd + pi.fee_usd)::text,
		       pi.status, COALESCE(pi.stripe_payment_intent_id, ''),
		       COALESCE(to_char(pi.paid_at,'YYYY-MM-DD"T"HH24:MI:SSZ'), ''),
		       COALESCE(to_char(pi.activated_at,'YYYY-MM-DD"T"HH24:MI:SSZ'), ''),
		       pi.affiliate_id, pi.stripe_present,
		       CASE WHEN pi.status = 'refunded' THEN (pi.total_cents::numeric / 100)::text ELSE '0' END,
		       ''
		  FROM payments.purchase_intent pi
		  JOIN mlm.package pk ON pk.id = pi.package_id
		 WHERE pi.created_at >= $1
		   AND ($2 = '' OR pi.status = $2)
		   AND ($3 = '' OR lower(pi.user_id) ILIKE '%'||lower($3)||'%')
		 ORDER BY pi.created_at DESC
		 LIMIT $4 OFFSET $5
	`, from, status, q, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("list sales transactions: %w", err)
	}
	defer rows.Close()
	out := []SalesTransaction{}
	for rows.Next() {
		var t SalesTransaction
		if err := rows.Scan(&t.ID, &t.CreatedAt, &t.Email, &t.Name, &t.Plan,
			&t.AmountUSD, &t.FeeUSD, &t.TotalUSD, &t.Status, &t.Reference, &t.PaidAt,
			&t.ActivatedAt, &t.AffiliateID, &t.StripeVerify, &t.RefundUSD, &t.RefundedAt); err != nil {
			return nil, 0, err
		}
		out = append(out, t)
	}
	return out, total, rows.Err()
}

// handleAdminSalesTransactions: GET /api/admin/sales/transactions?days=30&status=&q=&limit=&offset=
// — detalle de ventas individuales de membresías para el panel (quién pagó, plan,
// monto, estado, referencia). Solo membresías MindBliss (ver SalesTransactions).
func (h *Handler) handleAdminSalesTransactions(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	qv := r.URL.Query()
	days := atoiDefault(qv.Get("days"), 30)
	if days < 1 || days > 365 {
		days = 30
	}
	status := strings.TrimSpace(qv.Get("status"))
	switch status {
	case "", "created", "paid", "activated", "needs_placement", "failed", "expired", "refunded", "security_blocked", "disputed", "chargeback":
	default:
		status = "" // status desconocido ⇒ sin filtro (no error)
	}
	q := strings.TrimSpace(qv.Get("q"))
	limit := atoiDefault(qv.Get("limit"), 25)
	offset := atoiDefault(qv.Get("offset"), 0)
	from := time.Now().UTC().AddDate(0, 0, -days)

	txns, total, err := h.store.SalesTransactions(r.Context(), from, status, q, limit, offset)
	if err != nil {
		h.log.Error().Err(err).Msg("sales transactions")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"from":   from.Format("2006-01-02"),
		"days":   days,
		"rows":   txns,
		"total":  total,
		"limit":  limit,
		"offset": offset,
		"since":  time.Now().UTC().Format(time.RFC3339),
	})
}

// VerifyTransactionStripe consulta un intent contra Stripe live y PERSISTE el
// resultado en stripe_present (true/false). Ids no consultables (sin pi_) dejan
// stripe_present sin tocar. Devuelve la presencia y el status actual del intent.
func (s *Store) VerifyTransactionStripe(ctx context.Context, gw *StripeGateway, intentID string) (PaymentIntentPresence, string, error) {
	var piID, status string
	err := s.reader().QueryRow(ctx,
		`SELECT COALESCE(stripe_payment_intent_id, ''), status FROM payments.purchase_intent WHERE id = $1::uuid`,
		intentID).Scan(&piID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return PIPresenceUnknown, "", ErrIntentNotFound
	}
	if err != nil {
		return PIPresenceUnknown, "", fmt.Errorf("verify: load intent: %w", err)
	}
	presence, err := gw.VerifyPaymentIntent(piID)
	if err != nil {
		return PIPresenceUnknown, status, err
	}
	if presence != PIPresenceUnknown {
		if _, uerr := s.db.Exec(ctx,
			`UPDATE payments.purchase_intent SET stripe_present = $2, updated_at = now() WHERE id = $1::uuid`,
			intentID, presence == PIPresent); uerr != nil {
			return presence, status, fmt.Errorf("verify: persist: %w", uerr)
		}
	}
	return presence, status, nil
}

// handleAdminSalesVerify: GET /api/admin/sales/verify?id=<intent> — verifica una
// venta contra Stripe live y persiste el resultado. Lo usa el detalle/timeline
// del panel para marcar "✓ verificada" / "✗ no encontrada (posible prueba)".
func (h *Handler) handleAdminSalesVerify(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if id == "" {
		writeErr(w, http.StatusBadRequest, "id_required")
		return
	}
	if h.gw == nil {
		writeErr(w, http.StatusServiceUnavailable, "stripe_unavailable")
		return
	}
	presence, status, err := h.store.VerifyTransactionStripe(r.Context(), h.gw, id)
	if errors.Is(err, ErrIntentNotFound) {
		writeErr(w, http.StatusNotFound, "not_found")
		return
	}
	if err != nil {
		h.log.Error().Err(err).Str("intent", id).Msg("sales verify")
		writeErr(w, http.StatusBadGateway, "stripe_error")
		return
	}
	presenceStr := "unknown"
	switch presence {
	case PIPresent:
		presenceStr = "present"
	case PIMissing:
		presenceStr = "missing"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":       id,
		"status":   status,
		"verified": presence != PIPresenceUnknown,
		"present":  presence == PIPresent,
		"presence": presenceStr,
	})
}

// handleRegistrationEvent: POST /api/events/registration — el BFF lo invoca
// (token de servicio) al confirmarse un registro Cognito; publica
// `member.registered` en el stream vp:events para el feed del panel admin.
// Best-effort por diseño: el registro del usuario NUNCA depende de esto.
func (h *Handler) handleRegistrationEvent(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	var req struct {
		Email string `json:"email"`
		Name  string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Email) == "" {
		writeErr(w, http.StatusBadRequest, "email_required")
		return
	}
	h.store.cache.PublishEvent(r.Context(), "member.registered", map[string]any{
		"email": strings.ToLower(strings.TrimSpace(req.Email)),
		"name":  strings.TrimSpace(req.Name),
	})
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
