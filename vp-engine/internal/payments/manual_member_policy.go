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

// Manual is an explicit, independent accounting projection. It is never a NOW
// receipt, a payment-provider assertion, an activation command or a withdraw API.
type ManualMemberPolicy struct {
	Provider           string                  `json:"provider"`
	ReadModelStatus    string                  `json:"read_model_status"`
	WithdrawalsEnabled bool                    `json:"withdrawals_enabled"`
	Commissions        *NOWMemberCommissions   `json:"commissions"`
	Membership         *ManualMemberMembership `json:"membership"`
}

// Reuse amounts/status semantics, not NOW provenance or its auth_subject column.
type ManualMemberMembership struct {
	PrincipalLockedUSD    string                       `json:"principal_locked_usd"`
	PrincipalAvailableUSD string                       `json:"principal_available_usd"`
	ROILockedUSD          string                       `json:"roi_locked_usd"`
	ROIAvailableUSD       string                       `json:"roi_available_usd"`
	Items                 []ManualMemberMembershipItem `json:"items"`
}

type ManualMemberMembershipItem struct {
	PrincipalUSD    string `json:"principal_usd"`
	GrossUSD        string `json:"gross_usd"`
	FeeUSD          string `json:"fee_usd"`
	NetUSD          string `json:"net_usd"`
	PV              string `json:"pv"`
	StartedAt       string `json:"started_at"`
	LockUntil       string `json:"lock_until"`
	Eligibility     string `json:"eligibility"`
	ROILockedUSD    string `json:"roi_locked_usd"`
	ROIAvailableUSD string `json:"roi_available_usd"`
}

func unavailableManualMemberPolicy() *ManualMemberPolicy {
	return &ManualMemberPolicy{Provider: "manual", ReadModelStatus: "unavailable"}
}

func emptyManualMemberPolicy() *ManualMemberPolicy {
	now := emptyNOWMemberPolicy()
	return &ManualMemberPolicy{Provider: "manual", ReadModelStatus: "operational", Commissions: now.Commissions,
		Membership: &ManualMemberMembership{PrincipalLockedUSD: "0.00", PrincipalAvailableUSD: "0.00",
			ROILockedUSD: "0.00", ROIAvailableUSD: "0.00", Items: []ManualMemberMembershipItem{}}}
}

func (h *Handler) attachManualMemberPolicy(r *http.Request, summary *MemberSummary, email string) {
	summary.ManualMemberships = unavailableManualMemberPolicy()
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
	policy, err := h.store.GetManualMemberPolicy(ctx, subject, verifiedEmail)
	if err == nil {
		summary.ManualMemberships = policy
	}
}

func (s *Store) GetManualMemberPolicy(ctx context.Context, subject, email string) (*ManualMemberPolicy, error) {
	if s == nil || s.db == nil || strings.TrimSpace(subject) == "" || len(subject) > 512 || len(email) > 320 {
		return nil, ErrCheckoutIdentityReview
	}
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return nil, ErrCheckoutIdentityReview
	}
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	out, err := readManualMemberPolicy(ctx, tx, subject, email)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

const manualMemberOwnerSQL = `SELECT p.id,a.id FROM identity.auth_binding b JOIN auth.user u ON u.id=b.subject
 JOIN mlm.person p ON p.id=b.person_id AND p.user_id=b.subject LEFT JOIN mlm.affiliate a ON a.person_id=p.id
 WHERE b.subject=$1 AND b.provider='better_auth' AND u.email_verified
 AND lower(btrim(u.email))=$2 AND lower(btrim(p.email::text))=$2
 AND p.status::text IN('pending','active') AND NOT COALESCE(p.blacklisted,false)
 AND(a.id IS NULL OR a.status::text='active')
 AND NOT EXISTS(SELECT 1 FROM mlm.person other WHERE other.id<>p.id AND lower(btrim(other.email::text))=$2)
 AND NOT EXISTS(SELECT 1 FROM auth.user other WHERE other.id<>u.id AND lower(btrim(other.email))=$2)
 AND NOT EXISTS(SELECT 1 FROM mlm.blacklist ban
   WHERE mlm.norm_email(p.email) IS NOT NULL AND ban.email_norm=mlm.norm_email(p.email))`

const manualMemberSafeSQL = `COALESCE((s.state='activated' AND s.activated_at IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM payments.manual_membership_order risky
   WHERE risky.effective_at IS NOT NULL AND risky.state<>'activated')
 AND ` + memberNOWGlobalSafeSQL + `
 AND NOT EXISTS(SELECT 1 FROM mlm.withdrawal_request wr WHERE wr.affiliate_id=$2 AND wr.status::text IN('requested','approved'))),false)`

// source_attempt_id preserves the beneficiary membership/cap contract. The
// separate immutable earning-source view identifies the purchaser or mixed
// binary lots, never the beneficiary's payment method as a substitute origin.
const manualMemberCommissionCTE = `WITH owned AS (
 SELECT e.id,e.created_at,e.available_at,e.kind,COALESCE(origin.source_provider,'unattributed') AS source_provider,e.entitlement_usd,e.paid_usd,e.cap_excluded_usd,
 LEAST(COALESCE(l.liquid,0),e.paid_usd) AS liquid,
 (` + manualMemberSafeSQL + ` AND e.available_at=(((e.created_at AT TIME ZONE 'America/Bogota')+interval '1 month') AT TIME ZONE 'America/Bogota')) AS safe
 FROM payments.nowpayments_engine_obligation e
 JOIN payments.compensation_source source ON source.id=e.source_attempt_id AND source.source_kind='manual'
 JOIN payments.manual_membership_order manifest ON manifest.id=source.manual_order_id
 AND manifest.person_id=$1 AND manifest.affiliate_id=e.affiliate_id AND manifest.affiliate_package_id=e.affiliate_package_id
 LEFT JOIN payments.v_compensation_source s ON s.source_id=source.id AND s.source_kind='manual'
 LEFT JOIN obligation_origins origin ON origin.obligation_id=e.id
 JOIN mlm.affiliate_package beneficiary ON beneficiary.id=e.affiliate_package_id AND beneficiary.affiliate_id=e.affiliate_id
 LEFT JOIN LATERAL(SELECT sum(wm.amount) AS liquid FROM payments.nowpayments_engine_payment ep
 JOIN mlm.transaction t ON t.external_ref=ep.transaction_ref JOIN mlm.wallet_movement wm ON wm.transaction_id=t.id
 JOIN mlm.wallet w ON w.id=wm.wallet_id AND w.affiliate_id=wm.affiliate_id JOIN mlm.asset asset ON asset.id=w.asset_id
 WHERE ep.obligation_id=e.id AND wm.affiliate_id=$2 AND asset.symbol='USD' AND NOT wm.is_frozen AND wm.amount>0)l ON true
 WHERE e.affiliate_id=$2 AND e.kind IN('binary_bonus','direct_bonus','royalty'))`

func readManualMemberPolicy(ctx context.Context, tx pgx.Tx, subject, email string) (*ManualMemberPolicy, error) {
	var person int64
	var affiliate *int64
	if err := tx.QueryRow(ctx, manualMemberOwnerSQL, subject, email).Scan(&person, &affiliate); err != nil {
		return nil, ErrCheckoutIdentityReview
	}
	var ready bool
	if err := tx.QueryRow(ctx, `SELECT to_regclass('payments.compensation_source') IS NOT NULL
 AND to_regclass('payments.v_compensation_source') IS NOT NULL
 AND to_regclass('payments.manual_membership_order') IS NOT NULL
 AND to_regclass('payments.v_compensation_obligation_origin') IS NOT NULL`).Scan(&ready); err != nil {
		return nil, err
	}
	if !ready {
		return nil, errors.New("manual membership source unavailable")
	}
	out := emptyManualMemberPolicy()
	if affiliate == nil {
		return out, nil
	}
	args := []any{person, *affiliate}
	// The view must not silently omit a broken package/CD/canonical source join.
	if err := tx.QueryRow(ctx, `SELECT
 (SELECT count(*) FROM payments.manual_membership_order WHERE person_id=$1 AND affiliate_id=$2 AND effective_at IS NOT NULL)
 =(SELECT count(*) FROM payments.v_compensation_source WHERE source_kind='manual' AND person_id=$1 AND affiliate_id=$2)`, args...).Scan(&ready); err != nil {
		return nil, err
	}
	if !ready {
		return nil, errors.New("manual membership source coverage unavailable")
	}
	var pending, available, held, credited decimal.Decimal
	commissionSQL := memberCommissionOriginSQL(manualMemberCommissionCTE, true)
	if err := tx.QueryRow(ctx, commissionSQL+`
 SELECT COALESCE(sum(liquid) FILTER(WHERE NOT safe OR available_at>now()),0),
 COALESCE(sum(liquid) FILTER(WHERE safe AND available_at<=now()),0),
 COALESCE(sum(entitlement_usd-paid_usd-cap_excluded_usd),0),COALESCE(sum(paid_usd),0) FROM owned`, args...).
		Scan(&pending, &available, &held, &credited); err != nil {
		return nil, err
	}
	if pending.IsNegative() || available.IsNegative() || held.IsNegative() || credited.IsNegative() {
		return nil, errors.New("manual commission amounts unavailable")
	}
	out.Commissions.PendingUSD, out.Commissions.AvailableUSD = pending.StringFixed(2), available.StringFixed(2)
	out.Commissions.FundingHeldUSD, out.Commissions.CreditedUSD = held.StringFixed(2), credited.StringFixed(2)
	rows, err := tx.Query(ctx, commissionSQL+`
 SELECT created_at,available_at,kind,source_provider,entitlement_usd,paid_usd,cap_excluded_usd,liquid,safe,now()
 FROM owned ORDER BY created_at DESC,id DESC LIMIT 100`, args...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var item NOWMemberCommissionItem
		var created, due, current time.Time
		var amount, paid, excluded, liquid decimal.Decimal
		var safe bool
		if err := rows.Scan(&created, &due, &item.Kind, &item.SourceProvider, &amount, &paid, &excluded, &liquid, &safe, &current); err != nil {
			rows.Close()
			return nil, err
		}
		if !amount.IsPositive() || paid.IsNegative() || excluded.IsNegative() || liquid.IsNegative() || paid.Add(excluded).GreaterThan(amount) || liquid.GreaterThan(paid) {
			rows.Close()
			return nil, errors.New("manual commission detail unavailable")
		}
		item.GeneratedAt, item.AvailableAt = created.UTC().Format(time.RFC3339Nano), due.UTC().Format(time.RFC3339Nano)
		item.SourceProvider = memberCommissionProvider(item.SourceProvider)
		item.AmountUSD, item.CreditedUSD = amount.Sub(excluded).StringFixed(2), paid.StringFixed(2)
		item.FundingHeldUSD, item.CapExcludedUSD = amount.Sub(paid).Sub(excluded).StringFixed(2), excluded.StringFixed(2)
		item.LiquidCreditedUSD = liquid.StringFixed(2)
		item.Status = nowCommissionStatus(safe, due, current, amount, paid, excluded, liquid)
		out.Commissions.Items = append(out.Commissions.Items, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := loadManualMemberMembership(ctx, tx, out, args); err != nil {
		return nil, err
	}
	return out, nil
}

const manualMemberMembershipSQL = `SELECT cd.principal_usd,s.gross_usd,s.net_usd,s.pv,cd.start_at,cd.matures_at,cd.status::text,
 ` + manualMemberSafeSQL + ` AS safe,
 (cd.matures_at=cd.start_at+interval '365 days' AND s.start_at=cd.start_at AND s.matures_at=cd.matures_at) AS lock_valid,
 COALESCE(roi.credited,0),LEAST(COALESCE(roi.liquid,0),COALESCE(roi.credited,0)),now()
 FROM payments.v_compensation_source s
 JOIN mlm.investment_cd cd ON cd.id=s.investment_cd_id AND cd.affiliate_id=s.affiliate_id AND cd.affiliate_package_id=s.affiliate_package_id
 LEFT JOIN LATERAL(SELECT sum(e.paid_usd) AS credited,
 (SELECT COALESCE(sum(wm.amount),0) FROM payments.nowpayments_engine_obligation e2 JOIN payments.nowpayments_engine_payment ep ON ep.obligation_id=e2.id
 JOIN mlm.transaction t ON t.external_ref=ep.transaction_ref JOIN mlm.wallet_movement wm ON wm.transaction_id=t.id
 JOIN mlm.wallet w ON w.id=wm.wallet_id AND w.affiliate_id=wm.affiliate_id JOIN mlm.asset asset ON asset.id=w.asset_id
 WHERE e2.source_attempt_id=s.source_id AND e2.kind='roi' AND e2.affiliate_id=$2 AND wm.affiliate_id=$2
 AND asset.symbol='USD' AND NOT wm.is_frozen AND wm.amount>0) AS liquid
 FROM payments.nowpayments_engine_obligation e WHERE e.source_attempt_id=s.source_id AND e.kind='roi' AND e.affiliate_id=$2)roi ON true
 WHERE s.source_kind='manual' AND s.person_id=$1 AND s.affiliate_id=$2 AND s.activated_at IS NOT NULL
 ORDER BY cd.start_at DESC,s.source_id LIMIT 5001`

func loadManualMemberMembership(ctx context.Context, tx pgx.Tx, out *ManualMemberPolicy, args []any) error {
	rows, err := tx.Query(ctx, manualMemberMembershipSQL, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	principalLocked, principalAvailable, roiLocked, roiAvailable := decimal.Zero, decimal.Zero, decimal.Zero, decimal.Zero
	for rows.Next() {
		if len(out.Membership.Items) >= 5000 {
			return errors.New("manual membership read capacity exceeded")
		}
		var principal, gross, net, pv, credited, liquid decimal.Decimal
		var start, maturity, current time.Time
		var status string
		var safe, lockValid bool
		if err := rows.Scan(&principal, &gross, &net, &pv, &start, &maturity, &status, &safe, &lockValid, &credited, &liquid, &current); err != nil {
			return err
		}
		if !principal.Equal(decimal.NewFromInt(100)) || !gross.Equal(principal) || !net.Equal(gross.Mul(decimal.RequireFromString("0.97"))) || !pv.Equal(decimal.NewFromInt(100)) ||
			credited.IsNegative() || liquid.IsNegative() || liquid.GreaterThan(credited) || start.IsZero() || !maturity.After(start) {
			return errors.New("manual membership amounts unavailable")
		}
		item := ManualMemberMembershipItem{PrincipalUSD: principal.StringFixed(2), GrossUSD: gross.StringFixed(2),
			FeeUSD: gross.Sub(net).StringFixed(2), NetUSD: net.StringFixed(2), PV: pv.String(),
			StartedAt: start.UTC().Format(time.RFC3339Nano), LockUntil: maturity.UTC().Format(time.RFC3339Nano),
			ROILockedUSD: credited.StringFixed(2), ROIAvailableUSD: "0.00", Eligibility: "locked"}
		if !safe || !lockValid {
			item.Eligibility = "risk_review"
		} else if status == "closed" {
			item.Eligibility = "closed"
		} else if (status == "active" || status == "matured") && !maturity.After(current) {
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
	if err := rows.Err(); err != nil {
		return err
	}
	out.Membership.PrincipalLockedUSD, out.Membership.PrincipalAvailableUSD = principalLocked.StringFixed(2), principalAvailable.StringFixed(2)
	out.Membership.ROILockedUSD, out.Membership.ROIAvailableUSD = roiLocked.StringFixed(2), roiAvailable.StringFixed(2)
	return nil
}
