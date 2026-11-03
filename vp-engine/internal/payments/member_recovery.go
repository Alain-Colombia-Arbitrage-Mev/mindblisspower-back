package payments

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/vicionpower/vp-engine/internal/withdrawals"
)

// MemberStripeSale is immutable payment evidence, not an activated membership,
// a commission award or a withdrawal. Only verified person mappings are exposed.
type MemberStripeSale struct {
	PaymentIntentID string `json:"payment_intent_id"`
	TotalUSD        string `json:"total_usd"`
	RefundedUSD     string `json:"refunded_usd"`
	Status          string `json:"status"`
	ChargedAt       string `json:"charged_at"`
	SourceEligible  bool   `json:"source_eligible"`
}

// recoveredMemberSummary intentionally bypasses the operational wallet cache.
// A missing ledger in the recovered database means unknown, not a zero balance.
// All queries use the primary so identity evidence cannot lag behind a correction.
func (s *Store) recoveredMemberSummary(ctx context.Context, email string) (MemberSummary, error) {
	out := MemberSummary{
		DataSource: recoveredStripeSource, FinancialStatus: "pending_calculation_and_review", PayoutLocked: true,
		MinWithdrawalUSD: withdrawals.MinWithdrawalUSD,
		Payments:         []MemberPayment{}, Withdrawals: []MemberWithdrawal{}, StripeSales: []MemberStripeSale{},
	}
	var personID int64
	err := s.db.QueryRow(ctx, `
		SELECT p.id,a.id,COALESCE(r.name_es,'—'),p.profile::text,
			to_char(COALESCE(a.created_at,p.created_at),'YYYY-MM-DD'),
			(SELECT count(*) FROM mlm.affiliate_package ap WHERE ap.affiliate_id=a.id AND ap.status='active')
		FROM mlm.person p LEFT JOIN mlm.affiliate a ON a.person_id=p.id
		LEFT JOIN mlm.rank r ON r.id=a.current_rank_id
		WHERE lower(p.email)=lower($1) LIMIT 1`, email).
		Scan(&personID, &out.AffiliateID, &out.Rank, &out.Plan, &out.JoinedAt, &out.ActivePackages)
	if errors.Is(err, pgx.ErrNoRows) {
		// The caller still has a verified identity but no corresponding MLM person.
		// Preserve unknown finances instead of handleMe's legacy unprovisioned zero.
		return out, nil
	}
	if err != nil {
		return MemberSummary{}, fmt.Errorf("recovered member identity: %w", err)
	}
	out.Positioned = out.AffiliateID != nil
	if reporting, err := s.hasAdminSales(ctx); err != nil {
		return MemberSummary{}, err
	} else if reporting {
		out.StripeSales, err = s.recoveredMemberCSVSales(ctx, personID)
		if err != nil {
			return MemberSummary{}, err
		}
		return out, nil
	}
	rows, err := s.db.Query(ctx, `SELECT s.payment_intent_id,
		(s.captured_minor::numeric/100)::numeric(24,2)::text,
		(s.refunded_minor::numeric/100)::numeric(24,2)::text,
		CASE WHEN s.refunded_minor>0 THEN 'refunded' WHEN s.dispute_count>0 THEN 'disputed'
			WHEN NOT s.source_eligible THEN 'under_review' ELSE 'paid' END,
		to_char(s.charged_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),s.source_eligible
		FROM payments.stripe_sale s
		JOIN recovery.stripe_sale_identity i USING(payment_intent_id)
		WHERE i.identity_verified AND i.person_id=$1 AND `+recoveredStripePredicate+`
		ORDER BY s.charged_at DESC,s.payment_intent_id LIMIT 100`, personID)
	if err != nil {
		return MemberSummary{}, fmt.Errorf("recovered member Stripe evidence: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var sale MemberStripeSale
		if err := rows.Scan(&sale.PaymentIntentID, &sale.TotalUSD, &sale.RefundedUSD, &sale.Status, &sale.ChargedAt, &sale.SourceEligible); err != nil {
			return MemberSummary{}, fmt.Errorf("scan recovered member Stripe evidence: %w", err)
		}
		out.StripeSales = append(out.StripeSales, sale)
	}
	if err := rows.Err(); err != nil {
		return MemberSummary{}, fmt.Errorf("iterate recovered member Stripe evidence: %w", err)
	}
	return out, nil
}

func (s *Store) recoveredMemberCSVSales(ctx context.Context, personID int64) ([]MemberStripeSale, error) {
	// Validate the source pointer and read its rows in one read-only snapshot.
	// A concurrent batch switch cannot mix the validation and visible sales.
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fmt.Errorf("begin member sales scope: %w", err)
	}
	defer tx.Rollback(ctx)
	var valid bool
	var batch string
	if err := tx.QueryRow(ctx, `SELECT count(*)=1 AND COALESCE(bool_and(b.status='reviewed'),false),
 COALESCE(min(source.active_batch_id::text),'')
 FROM payments.v_admin_sales_source source
 LEFT JOIN payments.v_admin_sales_import_batch b ON b.id=source.active_batch_id
 WHERE source.provider='stripe'`).Scan(&valid, &batch); err != nil {
		return nil, fmt.Errorf("verify member sales scope: %w", err)
	}
	if !valid || batch == "" {
		return nil, errors.New("reviewed member sales scope unavailable")
	}
	rows, err := tx.Query(ctx, `SELECT s.external_id,
 (s.gross_minor::numeric/100)::numeric(24,2)::text,
 (s.refunded_minor::numeric/100)::numeric(24,2)::text,
 CASE WHEN s.refunded_minor>0 THEN 'refunded' WHEN s.risk_status='disputed' THEN 'disputed'
      WHEN s.display_status='under_review' OR s.risk_status<>'none' THEN 'under_review' ELSE 'paid' END,
 to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),false
 FROM payments.v_admin_sales s
 JOIN recovery.stripe_sale_identity i ON i.payment_intent_id=s.external_id
 WHERE s.provider='stripe' AND s.source_batch_id=$2 AND s.person_id=$1
 AND i.identity_verified AND i.person_id=$1
 ORDER BY s.created_at DESC,s.external_id LIMIT 100`, personID, batch)
	if err != nil {
		return nil, fmt.Errorf("read member scoped Stripe evidence: %w", err)
	}
	defer rows.Close()
	out := []MemberStripeSale{}
	for rows.Next() {
		var sale MemberStripeSale
		if err := rows.Scan(&sale.PaymentIntentID, &sale.TotalUSD, &sale.RefundedUSD, &sale.Status, &sale.ChargedAt, &sale.SourceEligible); err != nil {
			return nil, fmt.Errorf("scan member scoped Stripe evidence: %w", err)
		}
		out = append(out, sale)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate member scoped Stripe evidence: %w", err)
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("complete member sales scope: %w", err)
	}
	return out, nil
}

func (s MemberSummary) MarshalJSON() ([]byte, error) {
	type wire MemberSummary
	if s.DataSource != recoveredStripeSource {
		return json.Marshal(wire(s))
	}
	// The normal operational Go contract remains string-valued. At the recovery
	// HTTP boundary null explicitly communicates that no liability was computed.
	b, err := recoveryNullFields(wire(s), "wallet_balance_usd", "commission_available_usd",
		"commission_maturing_usd", "available_for_withdrawal_usd")
	if err != nil || len(s.StripeSales) != 0 {
		return b, err
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, err
	}
	out["stripe_sales"] = json.RawMessage(`[]`)
	return json.Marshal(out)
}
