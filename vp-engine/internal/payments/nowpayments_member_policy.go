package payments

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

// NOW is deliberately separate from recovered Stripe balances. These figures
// are accounting/temporal eligibility, not an enabled external withdrawal API.
type NOWMemberPolicy struct {
	ReadModelStatus    string                `json:"read_model_status"`
	WithdrawalsEnabled bool                  `json:"withdrawals_enabled"`
	Commissions        *NOWMemberCommissions `json:"commissions"`
	Membership         *NOWMemberMembership  `json:"membership"`
}

type NOWMemberCommissions struct {
	PendingUSD      string                    `json:"pending_usd"`
	AvailableUSD    string                    `json:"available_usd"`
	FundingHeldUSD  string                    `json:"funding_held_usd"`
	CreditedUSD     string                    `json:"credited_usd"`
	PaidExternalUSD string                    `json:"paid_external_usd"`
	Items           []NOWMemberCommissionItem `json:"items"`
}

type NOWMemberCommissionItem struct {
	GeneratedAt       string `json:"generated_at"`
	AvailableAt       string `json:"available_at"`
	Kind              string `json:"kind"`
	Status            string `json:"status"`
	AmountUSD         string `json:"amount_usd"`
	CreditedUSD       string `json:"credited_usd"`
	FundingHeldUSD    string `json:"funding_held_usd"`
	CapExcludedUSD    string `json:"cap_excluded_usd"`
	LiquidCreditedUSD string `json:"liquid_credited_usd"`
}

type NOWMemberMembership struct {
	PrincipalLockedUSD    string                    `json:"principal_locked_usd"`
	PrincipalAvailableUSD string                    `json:"principal_available_usd"`
	ROILockedUSD          string                    `json:"roi_locked_usd"`
	ROIAvailableUSD       string                    `json:"roi_available_usd"`
	Items                 []NOWMemberMembershipItem `json:"items"`
}

type NOWMemberMembershipItem struct {
	PrincipalUSD    string `json:"principal_usd"`
	StartedAt       string `json:"started_at"`
	LockUntil       string `json:"lock_until"`
	Eligibility     string `json:"eligibility"`
	ROILockedUSD    string `json:"roi_locked_usd"`
	ROIAvailableUSD string `json:"roi_available_usd"`
}

func emptyNOWMemberPolicy() *NOWMemberPolicy {
	return &NOWMemberPolicy{ReadModelStatus: "operational", Commissions: &NOWMemberCommissions{
		PendingUSD: "0.00", AvailableUSD: "0.00", FundingHeldUSD: "0.00", CreditedUSD: "0.00", PaidExternalUSD: "0.00", Items: []NOWMemberCommissionItem{},
	}, Membership: &NOWMemberMembership{PrincipalLockedUSD: "0.00", PrincipalAvailableUSD: "0.00", ROILockedUSD: "0.00", ROIAvailableUSD: "0.00", Items: []NOWMemberMembershipItem{}}}
}

// Apply after the historical summary/cache/recovery branch. A failure is null,
// not an invented zero balance, and cannot erase or unlock recovery balances.
func (h *Handler) attachNOWMemberPolicy(r *http.Request, summary *MemberSummary, email string) {
	summary.NOWPayments = &NOWMemberPolicy{ReadModelStatus: "unavailable"}
	verifier, ok := h.verifier.(nowSubjectVerifier)
	raw := strings.TrimSpace(r.Header.Get(idTokenHeader))
	if !ok || raw == "" || r.Header.Get(actAsHeader) != "" {
		return
	}
	subject, verifiedEmail, err := verifier.VerifySubject(r.Context(), raw)
	if err != nil || subject == "" || verifiedEmail != email {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	policy, err := h.store.GetNOWMemberPolicy(ctx, subject, verifiedEmail)
	if err == nil {
		summary.NOWPayments = policy
	}
}

// The caller must supply a server-verified JWT subject. Ownership is rechecked
// against the current binding and canonical verified email in the same primary
// READ ONLY snapshot; a supplied email alone can never choose another owner.
func (s *Store) GetNOWMemberPolicy(ctx context.Context, subject, email string) (*NOWMemberPolicy, error) {
	if s == nil || s.db == nil || subject == "" || len(subject) > 512 || email == "" || len(email) > 320 {
		return nil, ErrCheckoutIdentityReview
	}
	email = strings.ToLower(strings.TrimSpace(email))
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var person int64
	var affiliate *int64
	if err := tx.QueryRow(ctx, `SELECT p.id,a.id FROM identity.auth_binding b JOIN auth.user u ON u.id=b.subject
 JOIN mlm.person p ON p.id=b.person_id AND p.user_id=b.subject LEFT JOIN mlm.affiliate a ON a.person_id=p.id
 WHERE b.subject=$1 AND b.provider='better_auth' AND u.email_verified AND lower(btrim(u.email))=$2 AND lower(btrim(p.email::text))=$2
 AND p.status::text IN('pending','active') AND NOT COALESCE(p.blacklisted,false)
 AND NOT EXISTS(SELECT 1 FROM mlm.person other WHERE other.id<>p.id AND lower(btrim(other.email::text))=$2)`, subject, email).Scan(&person, &affiliate); err != nil {
		return nil, ErrCheckoutIdentityReview
	}
	out := emptyNOWMemberPolicy()
	if affiliate == nil {
		return out, tx.Commit(ctx)
	}
	args := []any{subject, person, *affiliate}
	var pending, available, held, credited decimal.Decimal
	if err := tx.QueryRow(ctx, nowMemberCommissionCTE+`
 SELECT COALESCE(sum(liquid) FILTER(WHERE NOT safe OR available_at>now()),0),
 COALESCE(sum(liquid) FILTER(WHERE safe AND available_at<=now()),0),
 COALESCE(sum(entitlement_usd-paid_usd-cap_excluded_usd),0),COALESCE(sum(paid_usd),0) FROM owned`, args...).
		Scan(&pending, &available, &held, &credited); err != nil {
		return nil, err
	}
	out.Commissions.PendingUSD, out.Commissions.AvailableUSD = pending.StringFixed(2), available.StringFixed(2)
	out.Commissions.FundingHeldUSD, out.Commissions.CreditedUSD = held.StringFixed(2), credited.StringFixed(2)
	rows, err := tx.Query(ctx, nowMemberCommissionCTE+`
	 SELECT created_at,available_at,kind,entitlement_usd,paid_usd,cap_excluded_usd,liquid,safe,now()
 FROM owned ORDER BY created_at DESC,id DESC LIMIT 100`, args...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var item NOWMemberCommissionItem
		var created, due, current time.Time
		var amount, paid, excluded, liquid decimal.Decimal
		var safe bool
		if err := rows.Scan(&created, &due, &item.Kind, &amount, &paid, &excluded, &liquid, &safe, &current); err != nil {
			rows.Close()
			return nil, err
		}
		item.GeneratedAt, item.AvailableAt = created.UTC().Format(time.RFC3339Nano), due.UTC().Format(time.RFC3339Nano)
		item.AmountUSD, item.CreditedUSD = amount.Sub(excluded).StringFixed(2), paid.StringFixed(2)
		item.FundingHeldUSD, item.CapExcludedUSD = amount.Sub(paid).Sub(excluded).StringFixed(2), excluded.StringFixed(2)
		item.LiquidCreditedUSD = liquid.StringFixed(2)
		item.Status = nowCommissionStatus(safe, due, current, amount, paid, excluded, liquid)
		out.Commissions.Items = append(out.Commissions.Items, item)
	}
	rows.Close()
	if rows.Err() != nil {
		return nil, rows.Err()
	}
	if err := s.loadNOWMemberMembership(ctx, tx, out, args); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// Own obligations are audit claims; paid_usd is a non-liquid internal counter.
// Availability is ONLY actual USD ledger credit to this verified beneficiary,
// excluding retirement wallets, redirected recipients and frozen movements.
// Never use DATE available_at as an alternative to the exact obligation time.
const nowMemberCommissionCTE = `WITH owned AS (
 SELECT e.id,e.created_at,e.available_at,e.kind,e.entitlement_usd,e.paid_usd,e.cap_excluded_usd,
 LEAST(COALESCE(l.liquid,0),e.paid_usd) AS liquid,` + nowMemberSafeSQL + ` AS safe
 FROM payments.nowpayments_engine_obligation e JOIN payments.nowpayments_operational_order o ON o.attempt_id=e.source_attempt_id
 JOIN payments.nowpayments_membership_attempt a ON a.id=o.attempt_id
 LEFT JOIN LATERAL(SELECT sum(wm.amount) AS liquid FROM payments.nowpayments_engine_payment ep
 JOIN mlm.transaction t ON t.external_ref=ep.transaction_ref JOIN mlm.wallet_movement wm ON wm.transaction_id=t.id
 JOIN mlm.wallet w ON w.id=wm.wallet_id JOIN mlm.asset asset ON asset.id=w.asset_id
 WHERE ep.obligation_id=e.id AND wm.affiliate_id=$3 AND asset.symbol='USD' AND NOT wm.is_frozen AND wm.amount>0)l ON true
 WHERE a.auth_subject=$1 AND a.person_id=$2 AND a.environment='production' AND e.affiliate_id=$3
 AND o.affiliate_id=e.affiliate_id AND o.affiliate_package_id=e.affiliate_package_id
 AND e.kind IN('binary_bonus','direct_bonus','royalty'))`

const nowMemberSafeSQL = `(o.state='activated' AND o.activated_at IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM payments.nowpayments_operational_order risky WHERE risky.activated_at IS NOT NULL
 AND(risky.state<>'activated'
 OR EXISTS(SELECT 1 FROM payments.nowpayments_webhook_capture rc WHERE rc.matched_attempt_id=risky.attempt_id AND(rc.risk_detected OR rc.disposition='quarantined'))
 OR EXISTS(SELECT 1 FROM payments.nowpayments_membership_receipt rr WHERE rr.attempt_id=risky.attempt_id AND(rr.multiple_payments OR COALESCE(rr.api_evidence->>'payment_status','') NOT IN('waiting','confirming','confirmed','sending','finished')))))
 AND NOT EXISTS(SELECT 1 FROM payments.nowpayments_webhook_capture c WHERE c.matched_attempt_id=o.attempt_id AND(c.risk_detected OR c.disposition='quarantined'))
 AND NOT EXISTS(SELECT 1 FROM payments.nowpayments_membership_receipt r WHERE r.attempt_id=o.attempt_id AND(r.multiple_payments OR COALESCE(r.api_evidence->>'payment_status','') NOT IN('waiting','confirming','confirmed','sending','finished')))
 AND NOT EXISTS(SELECT 1 FROM mlm.withdrawal_request wr WHERE wr.affiliate_id=$3 AND wr.status::text IN('requested','approved')))`

func nowCommissionStatus(safe bool, due, now time.Time, amount, credited, excluded, liquid decimal.Decimal) string {
	if !safe {
		return "risk_review"
	}
	if amount.Equal(excluded) {
		return "cap_excluded"
	}
	if !due.After(now) && liquid.IsPositive() {
		return "available"
	}
	if amount.Sub(credited).Sub(excluded).IsPositive() {
		return "funding_held"
	}
	return "pending_maturity"
}

func (s *Store) loadNOWMemberMembership(ctx context.Context, tx pgx.Tx, out *NOWMemberPolicy, args []any) error {
	rows, err := tx.Query(ctx, `SELECT cd.principal_usd,cd.start_at,cd.matures_at,cd.status::text,
 `+nowMemberSafeSQL+` AS safe,cd.matures_at=cd.start_at+interval '365 days' AS lock_valid,
 COALESCE(roi.credited,0),LEAST(COALESCE(roi.liquid,0),COALESCE(roi.credited,0)),now()
 FROM payments.nowpayments_operational_order o JOIN payments.nowpayments_membership_attempt a ON a.id=o.attempt_id
 JOIN mlm.investment_cd cd ON cd.id=o.investment_cd_id AND cd.affiliate_id=o.affiliate_id AND cd.affiliate_package_id=o.affiliate_package_id
 LEFT JOIN LATERAL(SELECT sum(e.paid_usd) AS credited,
 (SELECT COALESCE(sum(wm.amount),0) FROM payments.nowpayments_engine_obligation e2 JOIN payments.nowpayments_engine_payment ep ON ep.obligation_id=e2.id
 JOIN mlm.transaction t ON t.external_ref=ep.transaction_ref JOIN mlm.wallet_movement wm ON wm.transaction_id=t.id
 JOIN mlm.wallet w ON w.id=wm.wallet_id JOIN mlm.asset asset ON asset.id=w.asset_id
 WHERE e2.source_attempt_id=o.attempt_id AND e2.kind='roi' AND wm.affiliate_id=$3 AND asset.symbol='USD' AND NOT wm.is_frozen AND wm.amount>0) AS liquid
 FROM payments.nowpayments_engine_obligation e WHERE e.source_attempt_id=o.attempt_id AND e.kind='roi')roi ON true
 WHERE a.auth_subject=$1 AND a.person_id=$2 AND a.environment='production' AND o.affiliate_id=$3 AND o.activated_at IS NOT NULL
 ORDER BY cd.start_at DESC LIMIT 5001`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	principalLocked, principalAvailable, roiLocked, roiAvailable := decimal.Zero, decimal.Zero, decimal.Zero, decimal.Zero
	for rows.Next() {
		if len(out.Membership.Items) >= 5000 {
			return errors.New("NOW membership read capacity exceeded")
		}
		var principal, credited, liquid decimal.Decimal
		var start, maturity, now time.Time
		var status string
		var safe, lockValid bool
		if err := rows.Scan(&principal, &start, &maturity, &status, &safe, &lockValid, &credited, &liquid, &now); err != nil {
			return err
		}
		item := NOWMemberMembershipItem{PrincipalUSD: principal.StringFixed(2), StartedAt: start.UTC().Format(time.RFC3339Nano), LockUntil: maturity.UTC().Format(time.RFC3339Nano), ROILockedUSD: credited.StringFixed(2), ROIAvailableUSD: "0.00", Eligibility: "locked"}
		if !safe || !lockValid {
			item.Eligibility = "risk_review"
		} else if status == "closed" {
			item.Eligibility = "closed"
		} else if (status == "active" || status == "matured") && !maturity.After(now) {
			item.Eligibility = "eligible"
			item.ROIAvailableUSD = liquid.StringFixed(2)
			item.ROILockedUSD = decimal.Max(credited.Sub(liquid), decimal.Zero).StringFixed(2)
			principalAvailable = principalAvailable.Add(principal)
			roiAvailable = roiAvailable.Add(liquid)
		}
		if item.Eligibility != "eligible" && item.Eligibility != "closed" {
			principalLocked = principalLocked.Add(principal)
		}
		locked, _ := decimal.NewFromString(item.ROILockedUSD)
		roiLocked = roiLocked.Add(locked)
		out.Membership.Items = append(out.Membership.Items, item)
	}
	if rows.Err() != nil {
		return rows.Err()
	}
	out.Membership.PrincipalLockedUSD, out.Membership.PrincipalAvailableUSD = principalLocked.StringFixed(2), principalAvailable.StringFixed(2)
	out.Membership.ROILockedUSD, out.Membership.ROIAvailableUSD = roiLocked.StringFixed(2), roiAvailable.StringFixed(2)
	return nil
}
