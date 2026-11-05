package payments

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/vicionpower/vp-engine/internal/nowpayments"
	"github.com/vicionpower/vp-engine/internal/shared/financialguard"
)

var ErrNOWOperationalPlan = errors.New("NOWPayments active compensation configuration unavailable")

func NewNOWPaymentsOperationalStore(pool *pgxpool.Pool) *Store {
	s := NewStore(pool)
	s.nowOperational = true
	return s
}

func (s *Store) SetNOWOperationalReadiness(check func(context.Context, pgx.Tx) error) {
	s.nowReadiness = check
}

func (s *Store) requireNOWMembershipMode(ctx context.Context) error {
	if !s.nowOperational {
		return financialguard.RequireOperational(ctx, s.db)
	}
	var ready bool
	if err := s.db.QueryRow(ctx, `SELECT to_regclass('payments.nowpayments_operational_order') IS NOT NULL`).Scan(&ready); err != nil || !ready {
		return ErrNOWOperationalPlan
	}
	return nil
}

func (s *Store) prepareNOWOperationalOrder(ctx context.Context, tx pgx.Tx, order NOWPaymentsMembershipAttempt) error {
	if s.nowReadiness == nil || s.nowReadiness(ctx, tx) != nil {
		return ErrNOWOperationalPlan
	}
	var planID int64
	var lockDays, tierID, plans, tiers int
	var capFactor decimal.Decimal
	var planSnapshot string
	var baseRate, qualifiedRate decimal.Decimal
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM mlm.plan_config WHERE effective_from<=now() AND(effective_to IS NULL OR effective_to>now())`).Scan(&plans); err != nil || plans != 1 {
		return ErrNOWOperationalPlan
	}
	if err := tx.QueryRow(ctx, `SELECT id,cd_lock_days,lifetime_cap_factor,to_jsonb(c)::text FROM mlm.plan_config c
 WHERE effective_from<=now() AND(effective_to IS NULL OR effective_to>now())`).Scan(&planID, &lockDays, &capFactor, &planSnapshot); err != nil || lockDays < 1 || lockDays > 36500 || !capFactor.IsPositive() {
		return ErrNOWOperationalPlan
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM mlm.cd_roi_tier WHERE active AND min_amount_usd<=$1::numeric AND(max_amount_usd IS NULL OR max_amount_usd>$1::numeric)`, order.AmountUSD).Scan(&tiers); err != nil || tiers != 1 {
		return ErrNOWOperationalPlan
	}
	if err := tx.QueryRow(ctx, `SELECT id,base_annual_rate,qualified_annual_rate FROM mlm.cd_roi_tier WHERE active AND min_amount_usd<=$1::numeric AND(max_amount_usd IS NULL OR max_amount_usd>$1::numeric)`, order.AmountUSD).Scan(&tierID, &baseRate, &qualifiedRate); err != nil {
		return ErrNOWOperationalPlan
	}
	var primitives bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM mlm.asset WHERE symbol='USD')`).Scan(&primitives); err != nil || !primitives {
		return ErrNOWOperationalPlan
	}
	var reserved string
	if err := tx.QueryRow(ctx, `INSERT INTO payments.nowpayments_operational_order(attempt_id,plan_config_id,roi_tier_id,cd_lock_days,lifetime_cap_factor,plan_snapshot,roi_base_annual_rate,roi_qualified_annual_rate,capacity_slot)
 SELECT $1::uuid,$2,$3,$4,$5,$6::jsonb,$7,$8,slot FROM generate_series(1,5000) slot
 WHERE NOT EXISTS(SELECT 1 FROM payments.nowpayments_operational_order WHERE capacity_slot=slot) ORDER BY slot LIMIT 1 RETURNING attempt_id::text`, order.ID, planID, tierID, lockDays, capFactor, planSnapshot, baseRate, qualifiedRate).Scan(&reserved); err != nil {
		return fmt.Errorf("%w: reserve NOW capacity: %w", ErrNOWOperationalPlan, err)
	}
	return nil
}

// processNOWOperationalPayment is called only after signed IPN + fixed-provider
// GET were matched and captured. Old/recovery invoices are never promoted.
func (s *Store) processNOWOperationalPayment(ctx context.Context, environment string, signed, api nowpayments.Payment, digest string) (string, error) {
	if !s.nowOperational {
		return "", ErrNOWOperationalPlan
	}
	if !validNOWPaymentsOrderID(signed.OrderID) {
		return "", nil
	}
	var operational bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM payments.nowpayments_operational_order o
 JOIN payments.nowpayments_membership_attempt a ON a.id=o.attempt_id WHERE a.id=$1::uuid AND a.environment=$2)`, signed.OrderID, environment).Scan(&operational); err != nil {
		return "", err
	}
	if !operational {
		return "", nil
	}
	result, err := s.RecordNOWPaymentsReceipt(ctx, environment, signed, api, digest)
	if err != nil {
		return "", err
	}
	// Abandonment never discards a later authenticated receipt. Even a waiting
	// notification on that timeless invoice is held for review, not reactivated.
	var abandoned bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM payments.nowpayments_purchase_cancellation WHERE attempt_id=$1::uuid)`, signed.OrderID).Scan(&abandoned); err != nil {
		return "", err
	}
	if abandoned {
		return "security_blocked", nil
	}
	if !result.Finished || result.MultiplePayments {
		if result.MultiplePayments || (api.Status != "waiting" && api.Status != "confirming" && api.Status != "confirmed" && api.Status != "sending") {
			_, err = s.db.Exec(ctx, `UPDATE payments.nowpayments_operational_order SET state='risk_review',updated_at=now() WHERE attempt_id=$1::uuid AND state IN('awaiting_payment','activated')`, signed.OrderID)
			return "risk_review", err
		}
		return "awaiting_payment", nil
	}
	return s.activateNOWOperationalOrder(ctx, environment, signed.OrderID)
}

func (s *Store) activateNOWOperationalOrder(ctx context.Context, environment, orderID string) (string, error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	order, err := scanNOWPaymentsAttempt(tx.QueryRow(ctx, `SELECT `+nowPaymentsAttemptColumns+` FROM payments.nowpayments_membership_attempt WHERE id=$1::uuid AND environment=$2 FOR UPDATE`, orderID, environment))
	if err != nil {
		return "", err
	}
	var state string
	var tierID, lockDays int
	var capFactor decimal.Decimal
	if err := tx.QueryRow(ctx, `SELECT state,roi_tier_id,cd_lock_days,lifetime_cap_factor FROM payments.nowpayments_operational_order WHERE attempt_id=$1::uuid FOR UPDATE`, orderID).Scan(&state, &tierID, &lockDays, &capFactor); err != nil {
		return "", err
	}
	if state != "awaiting_payment" {
		return state, tx.Commit(ctx)
	}
	if order.PricingPolicy != nowPaymentsIncludedPricingPolicy || order.PaymentID == "" || order.InvoiceID == "" {
		return "", ErrNOWPaymentsEvidence
	}
	// Any captured risk, multiple payment, or receipt risk remains sticky. Never
	// let a later finished notification silently release a held/refunded order.
	var safe bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM payments.nowpayments_membership_receipt WHERE attempt_id=$1::uuid AND payment_id=$2 AND finished_verified AND NOT multiple_payments)
 AND NOT EXISTS(SELECT 1 FROM payments.nowpayments_membership_receipt WHERE attempt_id=$1::uuid AND(multiple_payments OR api_evidence->>'payment_status' NOT IN('waiting','confirming','confirmed','sending','finished')))
 AND EXISTS(SELECT 1 FROM payments.nowpayments_webhook_capture WHERE environment=$3 AND matched_attempt_id=$1::uuid AND payment_id=$2 AND finished_verified AND NOT risk_detected)
 AND NOT EXISTS(SELECT 1 FROM payments.nowpayments_webhook_capture WHERE environment=$3 AND(payment_id=$2 OR order_id=$1::uuid::text) AND(risk_detected OR disposition='quarantined'))`, orderID, order.PaymentID, environment).Scan(&safe); err != nil {
		return "", err
	}
	if !safe {
		if _, err := tx.Exec(ctx, `UPDATE payments.nowpayments_operational_order SET state='risk_review',updated_at=now() WHERE attempt_id=$1::uuid`, orderID); err != nil {
			return "", err
		}
		return "risk_review", tx.Commit(ctx)
	}
	var email string
	var affID *int64
	if err := tx.QueryRow(ctx, `SELECT p.email::text,a.id FROM mlm.person p JOIN identity.auth_binding b ON b.person_id=p.id AND b.subject=p.user_id
 JOIN auth.user u ON u.id=b.subject LEFT JOIN mlm.affiliate a ON a.person_id=p.id
 WHERE p.id=$1 AND b.subject=$2 AND b.provider='better_auth' AND p.public_id=$3::uuid AND u.email_verified
 AND lower(btrim(u.email))=lower(btrim(p.email::text)) AND p.status::text IN('active','pending') AND NOT COALESCE(p.blacklisted,false)
 AND(a.id IS NULL OR a.status::text='active') FOR NO KEY UPDATE OF p`, order.PersonID, order.AuthSubject, order.PersonPublicID).Scan(&email, &affID); err != nil {
		return "", ErrCheckoutIdentityReview
	}
	decision, err := banDecisionFor(ctx, tx, BanCandidate{Email: email})
	if err != nil {
		return "", err
	}
	if decision.Blocked {
		if _, err := tx.Exec(ctx, `UPDATE payments.nowpayments_operational_order SET state='security_blocked',updated_at=now() WHERE attempt_id=$1::uuid`, orderID); err != nil {
			return "", err
		}
		return "security_blocked", tx.Commit(ctx)
	}
	if affID == nil {
		if order.SponsorAffiliateID == nil {
			return "", ErrCheckoutIdentityReview
		}
		eligible, err := sponsorCanReceivePlacement(ctx, tx, *order.SponsorAffiliateID)
		if err != nil || !eligible {
			return "", ErrCheckoutIdentityReview
		}
		id, err := autoPlaceNOWAffiliate(ctx, tx, order.PersonID, *order.SponsorAffiliateID, order.PreferredSide)
		if err != nil {
			return "", err
		}
		affID = &id
	}
	ref := "nowpayments:" + environment + ":" + order.PaymentID
	var packageID int64
	if err := tx.QueryRow(ctx, `INSERT INTO mlm.affiliate_package(affiliate_id,package_id,status,payment_method,transaction_hash,pv_remaining,activated_at,current_period_date)
 VALUES($1,$2,'active','nowpayments',$3,$4,now(),(now() AT TIME ZONE 'America/Bogota')::date) RETURNING id`, *affID, order.PackageID, ref, order.PV).Scan(&packageID); err != nil {
		return "", fmt.Errorf("activate NOW membership: %w", err)
	}
	var capTotal decimal.Decimal
	if err := tx.QueryRow(ctx, `SELECT cap_total FROM mlm.package_cap_state WHERE affiliate_package_id=$1`, packageID).Scan(&capTotal); err != nil {
		return "", ErrNOWOperationalPlan
	}
	amount, err := decimal.NewFromString(order.AmountUSD)
	if err != nil || !capTotal.Equal(amount.Mul(capFactor)) {
		return "", ErrNOWOperationalPlan
	}
	var investmentID int64
	if err := tx.QueryRow(ctx, `INSERT INTO mlm.investment_cd(affiliate_id,affiliate_package_id,principal_usd,roi_tier_id,matures_at)
 VALUES($1,$2,$3::numeric,$4,now()+($5::integer*interval '1 day')) RETURNING id`, *affID, packageID, order.AmountUSD, tierID, lockDays).Scan(&investmentID); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO mlm.wallet(affiliate_id,asset_id,address,balance)
 SELECT $1,id,$2,0 FROM mlm.asset s WHERE symbol='USD' AND NOT EXISTS(SELECT 1 FROM mlm.wallet w WHERE w.affiliate_id=$1 AND w.asset_id=s.id)`, *affID, fmt.Sprintf("ledger:%d", *affID)); err != nil {
		return "", err
	}
	// Net inflow is a treasury calculation base, never member earnings. Its
	// origin remains NOW-only and no Stripe purchase_intent/flags are written.
	var inflowID int64
	if err := tx.QueryRow(ctx, `INSERT INTO payments.nowpayments_operational_inflow(attempt_id,gross_usd,provider_cost_usd,net_usd,payment_ref)
 VALUES($1::uuid,$2::numeric,$3::numeric,$4::numeric,$5) RETURNING id`, orderID, order.AmountUSD, order.ProviderCostUSD, order.CommissionBaseUSD, ref).Scan(&inflowID); err != nil {
		return "", err
	}
	var pvSourceID int64
	if err := tx.QueryRow(ctx, `INSERT INTO payments.nowpayments_operational_pv_source(attempt_id,affiliate_id,pv) VALUES($1::uuid,$2,$3) RETURNING id`, orderID, *affID, order.PV).Scan(&pvSourceID); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `UPDATE payments.nowpayments_operational_order SET state='activated',affiliate_id=$2,affiliate_package_id=$3,investment_cd_id=$4,pv_source_id=$5,inflow_id=$6,activated_at=now(),updated_at=now() WHERE attempt_id=$1::uuid`, orderID, *affID, packageID, investmentID, pvSourceID, inflowID); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	s.invalidateMemberCaches(ctx, email)
	return "activated", nil
}

func (s *Store) ownedNOWOperationalState(ctx context.Context, environment, orderID, subject, email string) (string, error) {
	var state string
	err := s.db.QueryRow(ctx, `SELECT o.state FROM payments.nowpayments_operational_order o JOIN payments.nowpayments_membership_attempt a ON a.id=o.attempt_id
 JOIN identity.auth_binding b ON b.provider='better_auth' AND b.subject=a.auth_subject AND b.person_id=a.person_id
 JOIN auth.user u ON u.id=b.subject JOIN mlm.person p ON p.id=b.person_id AND p.user_id=b.subject AND p.public_id=a.person_public_id
 WHERE a.id=$1::uuid AND a.environment=$2 AND a.auth_subject=$3 AND u.email_verified AND lower(btrim(u.email))=$4 AND lower(btrim(p.email::text))=$4`, orderID, environment, subject, email).Scan(&state)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return state, err
}
