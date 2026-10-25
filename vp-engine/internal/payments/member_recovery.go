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
