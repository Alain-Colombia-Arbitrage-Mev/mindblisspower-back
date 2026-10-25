package payments

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/vicionpower/vp-engine/internal/shared/financialguard"
)

const recoveredStripeSource = "verified_stripe_recovery"

// The product marker is required in addition to a successful live capture. Never
// union imported evidence with purchase_intent or the shared account's payouts.
const recoveredStripePredicate = `s.livemode AND s.payment_status='succeeded'
	AND s.currency='usd' AND s.metadata->>'packmindbliss'='true'
	AND jsonb_array_length(s.product_evidence)>0`

var ErrRecoveryFinancialReview = financialguard.ErrRecoveryReview

// StripeRecoveryReview separates source facts, owner allocation and unknown
// balances. The funds snapshot is all-time and is never prorated to a date filter.
type StripeRecoveryReview struct {
	Status              string              `json:"status"`
	Currency            string              `json:"currency"`
	From                string              `json:"from"`
	Sales               int64               `json:"sales"`
	FinanciallyEligible int64               `json:"financially_eligible_sales"`
	RefundedSales       int64               `json:"refunded_sales"`
	DisputedSales       int64               `json:"disputed_sales"`
	GrossUSD            string              `json:"gross_usd"`
	RefundedUSD         string              `json:"refunded_usd"`
	NetBeforeFeesUSD    string              `json:"net_before_fees_usd"`
	CommissionStatus    string              `json:"affiliate_commission_status"`
	ActivationStatus    string              `json:"activation_status"`
	Funds               StripeRecoveryFunds `json:"funds_review"`
}

type StripeRecoveryFunds struct {
	Scope                      string  `json:"scope"`
	PolicyKey                  string  `json:"policy_key"`
	SourceKind                 string  `json:"source_kind"`
	PaidScope                  string  `json:"paid_scope"`
	BaseKind                   string  `json:"base_kind"`
	SaleCount                  int64   `json:"sale_count"`
	GrossUSD                   string  `json:"gross_usd"`
	RefundedUSD                string  `json:"refunded_usd"`
	ProcessingEstimateBPS      int     `json:"processing_estimate_bps"`
	SecurityRetentionBPS       int     `json:"security_retention_bps"`
	ProcessingEstimateUSD      string  `json:"processing_estimate_usd"`
	SecurityRetainedUSD        string  `json:"security_retained_usd"`
	CompanyPayoutReportedUSD   string  `json:"company_payout_reported_usd"`
	HeldUnderReviewUSD         string  `json:"held_under_review_usd"`
	ActualProcessingFeeUSD     *string `json:"actual_processing_fee_usd"`
	ProcessingDifferenceUSD    *string `json:"processing_difference_under_review_usd"`
	CompanySettledVerifiedUSD  *string `json:"company_settled_verified_usd"`
	AffiliateLiabilityUSD      *string `json:"affiliate_commission_liability_usd"`
	ProviderReconciled         bool    `json:"provider_settlement_reconciled"`
	AutomaticPayoutEnabled     bool    `json:"automatic_payout_enabled"`
	AllocationBalanced         bool    `json:"allocation_balanced"`
	CompleteChargeFeeCoverage  bool    `json:"complete_charge_fee_coverage"`
	PolicyMatchesCurrentSource bool    `json:"policy_matches_current_source"`
	CompanyPayoutStatus        string  `json:"company_payout_status"`
}

func (s *Store) hasRecoveredStripe(ctx context.Context) (bool, error) {
	var exists bool
	if err := s.db.QueryRow(ctx, `SELECT to_regclass('payments.stripe_sale') IS NOT NULL`).Scan(&exists); err != nil {
		return false, fmt.Errorf("detect recovered Stripe read model: %w", err)
	}
	return exists, nil
}

func (s *Store) recoveredStripeReview(ctx context.Context, from time.Time) (*StripeRecoveryReview, error) {
	r := &StripeRecoveryReview{Status: "pending_provider_reconciliation", Currency: "usd", From: from.UTC().Format(time.RFC3339),
		CommissionStatus: "pending_calculation_and_review", ActivationStatus: "not_inferred_from_stripe"}
	err := s.db.QueryRow(ctx, `SELECT count(*),
		count(*) FILTER(WHERE s.source_eligible), count(*) FILTER(WHERE s.refunded_minor>0),
		count(*) FILTER(WHERE s.dispute_count>0),
		(COALESCE(sum(s.captured_minor),0)::numeric/100)::numeric(24,2)::text,
		(COALESCE(sum(s.refunded_minor),0)::numeric/100)::numeric(24,2)::text,
		(COALESCE(sum(s.captured_minor-s.refunded_minor),0)::numeric/100)::numeric(24,2)::text
		FROM payments.stripe_sale s WHERE `+recoveredStripePredicate+` AND s.charged_at >= $1`, from).
		Scan(&r.Sales, &r.FinanciallyEligible, &r.RefundedSales, &r.DisputedSales, &r.GrossUSD, &r.RefundedUSD, &r.NetBeforeFeesUSD)
	if err != nil {
		return nil, fmt.Errorf("recovered Stripe source totals: %w", err)
	}
	f := &r.Funds
	f.Scope = "all_time_owner_snapshot_not_allocated_to_period_or_individual_sales"
	err = s.db.QueryRow(ctx, `SELECT p.policy_key,p.source_kind,p.paid_scope,p.base_kind,p.sale_count,
		(p.gross_collected_minor::numeric/100)::numeric(24,2)::text,
		(p.refunded_minor::numeric/100)::numeric(24,2)::text,
		p.processing_estimate_bps,p.security_retention_bps,
		(p.processing_estimate_minor::numeric/100)::numeric(24,2)::text,
		(p.security_retained_minor::numeric/100)::numeric(24,2)::text,
		(p.company_payout_reported_minor::numeric/100)::numeric(24,2)::text,
		(p.held_under_review_minor::numeric/100)::numeric(24,2)::text,
		CASE WHEN c.complete_charge_fee_coverage THEN (c.actual_processing_fee_minor::numeric/100)::numeric(24,2)::text END,
		CASE WHEN c.complete_charge_fee_coverage THEN (c.processing_difference_under_review_minor::numeric/100)::numeric(24,2)::text END,
		(p.company_settled_verified_minor::numeric/100)::numeric(24,2)::text,
		(p.affiliate_commission_liability_minor::numeric/100)::numeric(24,2)::text,
		p.provider_settlement_reconciled,p.automatic_payout_enabled,p.allocation_balanced,
		COALESCE(c.complete_charge_fee_coverage,false),
		(p.sale_count=live.sale_count AND p.gross_collected_minor=live.gross_minor AND p.refunded_minor=live.refunded_minor),
		COALESCE(c.company_payout_status,'paid_reported_by_owner_bank_allocation_not_verified')
		FROM recovery.v_stripe_funds_review p
		LEFT JOIN recovery.v_stripe_funds_provider_comparison c ON c.policy_key=p.policy_key
		CROSS JOIN (SELECT count(*) AS sale_count,COALESCE(sum(s.captured_minor),0) AS gross_minor,COALESCE(sum(s.refunded_minor),0) AS refunded_minor
			FROM payments.stripe_sale s WHERE `+recoveredStripePredicate+`) live
		WHERE p.currency='usd' ORDER BY p.recorded_at DESC,p.policy_key DESC LIMIT 1`).Scan(
		&f.PolicyKey, &f.SourceKind, &f.PaidScope, &f.BaseKind, &f.SaleCount, &f.GrossUSD, &f.RefundedUSD,
		&f.ProcessingEstimateBPS, &f.SecurityRetentionBPS, &f.ProcessingEstimateUSD, &f.SecurityRetainedUSD,
		&f.CompanyPayoutReportedUSD, &f.HeldUnderReviewUSD, &f.ActualProcessingFeeUSD, &f.ProcessingDifferenceUSD,
		&f.CompanySettledVerifiedUSD, &f.AffiliateLiabilityUSD, &f.ProviderReconciled, &f.AutomaticPayoutEnabled,
		&f.AllocationBalanced, &f.CompleteChargeFeeCoverage, &f.PolicyMatchesCurrentSource, &f.CompanyPayoutStatus)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("%w: reviewed funds snapshot absent", ErrRecoveryFinancialReview)
		}
		return nil, fmt.Errorf("%w: recovered funds read model: %v", ErrRecoveryFinancialReview, err)
	}
	if f.PaidScope != "company_payout" || f.BaseKind != "gross" || f.SourceKind != "owner_declaration" || !f.AllocationBalanced {
		return nil, fmt.Errorf("%w: unsupported owner allocation contract", ErrRecoveryFinancialReview)
	}
	if !f.PolicyMatchesCurrentSource {
		r.Status = "owner_policy_snapshot_requires_update"
	}
	return r, nil
}

func (s *Store) recoveredAdminFinance(ctx context.Context) (AdminFinance, error) {
	r, err := s.recoveredStripeReview(ctx, time.Time{})
	if err != nil {
		return AdminFinance{}, err
	}
	f := AdminFinance{DataSource: recoveredStripeSource, StripeRecovery: r,
		InflowsUSD: r.GrossUSD, PacksPaid: r.Sales, RefundedUSD: r.RefundedUSD,
		RefundedPayments: r.RefundedSales, Moneyflow: []MoneyflowRow{}}
	// Historical rank milestones are preserved. Their amounts do not prove a
	// payment or a liability attributable to the recovered Stripe sales.
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM mlm.affiliate_rank_achieved`).Scan(&f.RanksAchieved); err != nil {
		return f, fmt.Errorf("preserved rank milestones: %w", err)
	}
	return f, nil
}

// A missing/unknown amount must be JSON null, never an invented zero. Keep the
// normal operational contract unchanged on databases without recovery evidence.
func recoveryNullFields(value any, fields ...string) ([]byte, error) {
	b, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, err
	}
	for _, field := range fields {
		out[field] = json.RawMessage(`null`)
	}
	return json.Marshal(out)
}

func (f AdminFinance) MarshalJSON() ([]byte, error) {
	type wire AdminFinance
	if f.StripeRecovery == nil {
		return json.Marshal(wire(f))
	}
	return recoveryNullFields(wire(f), "fees_usd", "stripe_fee_usd", "stripe_reserve_usd", "stripe_receivable_usd",
		"stripe_receivable_eta", "net_settled_usd", "security_pending_charges", "security_pending_charges_usd",
		"security_charge_unit_usd", "security_failed_sales", "security_blocked_sales", "disputed_sales", "chargeback_sales",
		"refunded_sales", "commissions_distributed_usd", "pending_payout_usd", "pending_payout_gross_usd",
		"pending_payout_net_usd", "security_pending_payout_offset_usd", "maturing_usd", "ranks_bonus_usd",
		"withdrawals_paid_usd", "withdrawals_pending_usd", "withdrawal_fee_income_usd", "treasury_usd", "moneyflow")
}

func (c SalesCashSummary) MarshalJSON() ([]byte, error) {
	type wire SalesCashSummary
	if c.StripeRecovery == nil {
		return json.Marshal(wire(c))
	}
	fields := []string{"total_started", "activated_sales", "stripe_fee_usd", "stripe_security_reserve_usd",
		"stripe_receivable_usd", "stripe_receivable_eta", "pending_stripe_payout_usd", "available_after_stripe_usd"}
	if c.PackageSalesUSD == "" {
		fields = append(fields, "package_sales_usd", "activation_fees_usd")
	}
	return recoveryNullFields(wire(c), fields...)
}

func (r SalesRow) MarshalJSON() ([]byte, error) {
	type wire SalesRow
	if r.DataSource != recoveredStripeSource {
		return json.Marshal(wire(r))
	}
	fields := []string{"created", "activated"}
	if r.AmountUSD == "" {
		fields = append(fields, "amount_usd", "revenue_usd")
	}
	return recoveryNullFields(wire(r), fields...)
}

// Metadata package IDs are source IDs, not IDs in the old SQL Server catalog.
// A separate verified snapshot supplies the base/activation fee breakdown.
const recoveredSaleCTE = `WITH recovered_sale AS (
	SELECT s.*,CASE WHEN i.identity_verified THEN i.affiliate_id END AS affiliate_id,COALESCE(p.email::text,'') AS buyer_email,
		COALESCE(trim(p.first_name||' '||p.last_name),'') AS buyer_name,
		c.source_package_id,c.base_minor,c.fee_minor,
		CASE WHEN s.refunded_minor>0 THEN 'refunded' WHEN s.dispute_count>0 THEN 'disputed'
			WHEN NOT s.source_eligible THEN 'under_review' ELSE 'paid' END AS display_status
	FROM payments.stripe_sale s
	LEFT JOIN recovery.stripe_sale_identity i USING(payment_intent_id)
	LEFT JOIN mlm.person p ON p.id=i.person_id AND i.identity_verified
	LEFT JOIN recovery.package_catalog_snapshot c ON i.catalog_verified
		AND c.source_package_id::text=s.metadata->>'package_id' AND c.currency=s.currency
		AND c.base_minor+c.fee_minor=s.captured_minor
	WHERE ` + recoveredStripePredicate + ` AND s.charged_at >= $1
) `

func (s *Store) recoveredSalesReport(ctx context.Context, from time.Time) ([]SalesRow, error) {
	rows, err := s.db.Query(ctx, recoveredSaleCTE+`SELECT COALESCE(source_package_id,0),
		CASE WHEN source_package_id IS NOT NULL THEN 'Mindbliss · paquete '||source_package_id ELSE 'Paquete pendiente de validación' END,
		COALESCE((base_minor::numeric/100)::numeric(24,2)::text,''),count(*),
		COALESCE((sum(base_minor)::numeric/100)::numeric(24,2)::text,''),
		(sum(captured_minor)::numeric/100)::numeric(24,2)::text,
		(sum(refunded_minor)::numeric/100)::numeric(24,2)::text
		FROM recovered_sale GROUP BY source_package_id,base_minor ORDER BY base_minor NULLS LAST`, from)
	if err != nil {
		return nil, fmt.Errorf("recovered sales report: %w", err)
	}
	defer rows.Close()
	out := []SalesRow{}
	for rows.Next() {
		r := SalesRow{DataSource: recoveredStripeSource}
		if err := rows.Scan(&r.PackageID, &r.Name, &r.AmountUSD, &r.Paid, &r.RevenueUSD, &r.GrossUSD, &r.RefundedUSD); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) recoveredSalesCashSummary(ctx context.Context, from time.Time) (SalesCashSummary, error) {
	r, err := s.recoveredStripeReview(ctx, from)
	if err != nil {
		return SalesCashSummary{}, err
	}
	c := SalesCashSummary{DataSource: recoveredStripeSource, StripeRecovery: r, SuccessfulCharges: r.Sales,
		GrossChargedUSD: r.GrossUSD, RefundedCharges: r.RefundedSales, RefundedUSD: r.RefundedUSD}
	err = s.db.QueryRow(ctx, recoveredSaleCTE+`SELECT
		CASE WHEN count(*) FILTER(WHERE base_minor IS NULL)=0 THEN (COALESCE(sum(base_minor),0)::numeric/100)::numeric(24,2)::text ELSE '' END,
		CASE WHEN count(*) FILTER(WHERE fee_minor IS NULL)=0 THEN (COALESCE(sum(fee_minor),0)::numeric/100)::numeric(24,2)::text ELSE '' END
		FROM recovered_sale`, from).Scan(&c.PackageSalesUSD, &c.ActivationFeesUSD)
	return c, err
}

func (s *Store) recoveredSalesTransactions(ctx context.Context, from time.Time, status, q string, limit, offset int) ([]SalesTransaction, int64, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	if offset < 0 {
		offset = 0
	}
	filter := `WHERE ($2='' OR display_status=$2) AND ($3='' OR buyer_email ILIKE '%'||$3||'%')`
	var total int64
	if err := s.db.QueryRow(ctx, recoveredSaleCTE+`SELECT count(*) FROM recovered_sale `+filter, from, status, q).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("recovered sales count: %w", err)
	}
	rows, err := s.db.Query(ctx, recoveredSaleCTE+`SELECT payment_intent_id,
		to_char(payment_created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),buyer_email,buyer_name,
		CASE WHEN source_package_id IS NOT NULL THEN 'Mindbliss · paquete '||source_package_id ELSE 'Paquete pendiente de validación' END,
		COALESCE((base_minor::numeric/100)::numeric(24,2)::text,''),COALESCE((fee_minor::numeric/100)::numeric(24,2)::text,''),
		(captured_minor::numeric/100)::numeric(24,2)::text,display_status,payment_intent_id,
		to_char(charged_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),affiliate_id,
		(refunded_minor::numeric/100)::numeric(24,2)::text
		FROM recovered_sale `+filter+` ORDER BY charged_at DESC,payment_intent_id LIMIT $4 OFFSET $5`, from, status, q, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("recovered sales transactions: %w", err)
	}
	defer rows.Close()
	out := []SalesTransaction{}
	for rows.Next() {
		verified := true
		r := SalesTransaction{DataSource: recoveredStripeSource, ReadOnly: true, CommissionStatus: "pending_calculation_and_review", StripeVerify: &verified}
		if err := rows.Scan(&r.ID, &r.CreatedAt, &r.Email, &r.Name, &r.Plan, &r.AmountUSD, &r.FeeUSD, &r.TotalUSD,
			&r.Status, &r.Reference, &r.PaidAt, &r.AffiliateID, &r.RefundUSD); err != nil {
			return nil, 0, err
		}
		out = append(out, r)
	}
	return out, total, rows.Err()
}

func (r SalesTransaction) MarshalJSON() ([]byte, error) {
	type wire SalesTransaction
	if r.DataSource != recoveredStripeSource {
		return json.Marshal(wire(r))
	}
	fields := []string{"activated_at", "refunded_at"}
	if r.AmountUSD == "" {
		fields = append(fields, "amount_usd", "fee_usd")
	}
	return recoveryNullFields(wire(r), fields...)
}

func (s AdminSummary) MarshalJSON() ([]byte, error) {
	type wire AdminSummary
	if s.StripeRecovery == nil {
		return json.Marshal(wire(s))
	}
	return recoveryNullFields(wire(s), "security_pending_charges", "security_pending_charges_usd")
}

func (p ProductSales) MarshalJSON() ([]byte, error) {
	type wire ProductSales
	if p.DataSource == recoveredStripeSource && p.AmountUSD == "" {
		return recoveryNullFields(wire(p), "amount_usd")
	}
	return json.Marshal(wire(p))
}
