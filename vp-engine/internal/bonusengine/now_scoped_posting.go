package bonusengine

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

// PostNOWScopedAccrual reuses existing beneficiary/retirement routing only after
// checking an immutable NOW obligation. It is not a generic guard bypass and
// never invokes a global close, recovers Stripe funds or sends external money.
func PostNOWScopedAccrual(ctx context.Context, tx pgx.Tx, obligationID int64, amount decimal.Decimal, externalRef string,
	postedAt time.Time, root int64) (string, error) {
	if obligationID <= 0 || !amount.IsPositive() || !strings.HasPrefix(externalRef, "now:") || root <= 0 {
		return "", errors.New("invalid NOW accrual")
	}
	var affiliateID int64
	var kind string
	var availableAt time.Time
	var allowed decimal.Decimal
	err := tx.QueryRow(ctx, `SELECT e.affiliate_id,e.kind,e.available_at,e.entitlement_usd-e.paid_usd-e.cap_excluded_usd
 FROM payments.nowpayments_engine_obligation e JOIN payments.nowpayments_operational_order o ON o.attempt_id=e.source_attempt_id
 WHERE e.id=$1 AND o.state='activated' AND o.affiliate_id=e.affiliate_id AND o.affiliate_package_id=e.affiliate_package_id FOR UPDATE OF e`, obligationID).
		Scan(&affiliateID, &kind, &availableAt, &allowed)
	if err != nil || amount.GreaterThan(allowed) {
		return "", errors.New("NOW accrual source unavailable")
	}
	if kind == "roi" {
		route, err := effectivePayoutAffiliateID(ctx, tx, affiliateID, root, nil)
		if err != nil {
			return "", err
		}
		wallet, err := ensureUSDWallet(ctx, tx, route.affiliateID, map[int64]int64{})
		if err != nil {
			return "", err
		}
		var transactionID string
		if err := tx.QueryRow(ctx, `INSERT INTO mlm.transaction(external_ref,description,status,posted_at)
 VALUES($1,'NOW-only locked CD ROI accrual','posted',$2) ON CONFLICT(external_ref) DO NOTHING RETURNING id`, externalRef, postedAt).Scan(&transactionID); err != nil {
			return "", err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO mlm.wallet_movement(transaction_id,wallet_id,affiliate_id,concept_id,amount,posted_at,available_at)
 VALUES($1,$2,$3,1006,$4,$5,$6::date)`, transactionID, wallet, route.affiliateID, amount, postedAt, nowROIAvailableDate(availableAt)); err != nil {
			return "", err
		}
		return externalRef, nil
	}
	if kind != "binary_bonus" && kind != "direct_bonus" && kind != "royalty" {
		return "", errors.New("invalid NOW stream")
	}
	concept, err := conceptIDByKind(ctx, tx, kind)
	if err != nil {
		return "", err
	}
	route, err := effectivePayoutAffiliateID(ctx, tx, affiliateID, root, nil)
	if err != nil {
		return "", err
	}
	pct, err := pctToPlanFor(ctx, tx, route.affiliateID, kind)
	if err != nil {
		return "", err
	}
	retirement, withdrawable := routeSplit(amount, pct)
	if err := postRetirementContribution(ctx, tx, route.affiliateID, retirement, externalRef, postedAt, 65, map[int64]int64{}); err != nil {
		return "", err
	}
	if !withdrawable.IsPositive() {
		return externalRef, nil
	}
	wallet, err := ensureUSDWallet(ctx, tx, route.affiliateID, map[int64]int64{})
	if err != nil {
		return "", err
	}
	var transactionID string
	if err := tx.QueryRow(ctx, `INSERT INTO mlm.transaction(external_ref,description,status,posted_at)
 VALUES($1,'NOW-only locked compensation accrual','posted',$2) ON CONFLICT(external_ref) DO NOTHING RETURNING id`, externalRef, postedAt).Scan(&transactionID); err != nil {
		return "", err
	}
	_, err = tx.Exec(ctx, `INSERT INTO mlm.wallet_movement(transaction_id,wallet_id,affiliate_id,concept_id,amount,posted_at,available_at)
 VALUES($1,$2,$3,$4,$5,$6,$7::date)`, transactionID, wallet, route.affiliateID, concept, withdrawable, postedAt, availableAt.In(time.FixedZone("Bogota", -5*3600)).Format("2006-01-02"))
	return externalRef, err
}

func nowROIAvailableDate(available time.Time) string {
	business := available.In(time.FixedZone("Bogota", -5*3600))
	date := time.Date(business.Year(), business.Month(), business.Day(), 0, 0, 0, 0, business.Location())
	// The existing ledger stores DATE. Never unlock hours before maturity.
	if business.After(date) {
		date = date.AddDate(0, 0, 1)
	}
	return date.Format("2006-01-02")
}
