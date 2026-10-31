package nowengine

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

// ROI is an earned, locked ledger claim, NOT an external payout or liquid cash.
// The approved rate is never silently reduced to cure a treasury shortage.
// Commissions remain held when the residual treasury budget is insufficient.
func (s *Service) accrueROI(ctx context.Context, tx pgx.Tx, u universe, now time.Time) (bool, error) {
	cutoff := dailyCutoff(now, s.loc)
	if !hasCommitBudget(ctx) {
		return false, nil
	}
	type accrualState struct {
		date               time.Time
		numerator, claimed decimal.Decimal
	}
	states := map[string]accrualState{}
	rows, err := tx.Query(ctx, `SELECT r.attempt_id::text,r.cutoff_date,r.rate_day_numerator,r.claimed_usd
 FROM payments.nowpayments_engine_roi_state r JOIN payments.nowpayments_operational_order o ON o.attempt_id=r.attempt_id
 WHERE o.state='activated' ORDER BY r.attempt_id FOR UPDATE OF r`)
	if err != nil {
		return false, err
	}
	for rows.Next() {
		var id string
		var state accrualState
		if err := rows.Scan(&id, &state.date, &state.numerator, &state.claimed); err != nil {
			rows.Close()
			return false, err
		}
		states[id] = state
	}
	rows.Close()
	if rows.Err() != nil {
		return false, rows.Err()
	}
	posted := 0
	for _, o := range u.orders {
		if o.status != "active" && o.status != "matured" {
			return false, ErrRiskFrozen
		}
		start := dailyCutoff(o.start.Add(30*time.Minute), s.loc)
		maturity := dailyCutoff(o.matures.Add(30*time.Minute), s.loc)
		last := start
		numerator, claimed := decimal.Zero, decimal.Zero
		if state, ok := states[o.id]; ok {
			last, numerator, claimed = state.date, state.numerator, state.claimed
		}
		// PostgreSQL date scans as UTC midnight; comparisons use business dates.
		last = time.Date(last.Year(), last.Month(), last.Day(), 0, 0, 0, 0, s.loc)
		limit := cutoff
		if maturity.Before(limit) {
			limit = maturity
		}
		for next := last.AddDate(0, 0, 1); !next.After(limit); next = next.AddDate(0, 0, 1) {
			if posted >= maxAccrualsPerRun || !hasCommitBudget(ctx) {
				return false, nil
			}
			rate := o.baseRate
			qualified := u.qualified(o.affiliate, next.Add(-time.Nanosecond), o.tier)
			if qualified {
				rate = o.qualifiedRate
			}
			// Exact finite rate-day numerator; cumulative cents preserve the
			// approved annual rate instead of destroying fractions each day.
			dayNumerator := o.gross.Mul(rate)
			numerator = numerator.Add(dayNumerator)
			target := numerator.Div(decimal.NewFromInt(365)).RoundDown(2)
			amount := target.Sub(claimed)
			if amount.IsNegative() {
				return false, ErrNotReady
			}
			remaining, err := s.remaining(ctx, tx, o.pkg)
			if err != nil {
				return false, err
			}
			excluded := decimal.Zero
			if amount.GreaterThan(remaining) {
				excluded = amount.Sub(remaining)
			}
			id := int64(0)
			if amount.IsPositive() {
				id, err = s.createObligation(ctx, tx, o, nil, "roi", fmt.Sprintf("now:roi:%d:%s", o.cd, next.Format("2006-01-02")), amount, excluded, decimal.Zero, decimal.NewFromInt(1), o.matures)
				if err != nil {
					return false, err
				}
				if id == 0 {
					return false, ErrNotReady
				}
			}
			credit := amount.Sub(excluded)
			if id > 0 && credit.IsPositive() {
				if err := s.post(ctx, tx, id, o.pkg, "roi", credit, decimal.NewFromInt(1), next.Add(30*time.Minute)); err != nil {
					return false, err
				}
			}
			if _, err := tx.Exec(ctx, `INSERT INTO payments.nowpayments_engine_roi_rate_day(attempt_id,cutoff_date,principal_usd,annual_rate,qualified,rate_day_numerator,entitlement_usd,credited_usd)
 VALUES($1::uuid,$2::date,$3,$4,$5,$6,$7,$8)`, o.id, next.Format("2006-01-02"), o.gross, rate, qualified, dayNumerator, amount, credit); err != nil {
				return false, err
			}
			if _, err := tx.Exec(ctx, `INSERT INTO payments.nowpayments_engine_roi_state(attempt_id,cutoff_date,accrued_usd,rate_day_numerator,claimed_usd)
 VALUES($1::uuid,$2::date,$3,$4,$5) ON CONFLICT(attempt_id) DO UPDATE SET cutoff_date=EXCLUDED.cutoff_date,
 accrued_usd=payments.nowpayments_engine_roi_state.accrued_usd+EXCLUDED.accrued_usd,
 rate_day_numerator=EXCLUDED.rate_day_numerator,claimed_usd=EXCLUDED.claimed_usd,updated_at=now()`, o.id, next.Format("2006-01-02"), credit, numerator, target); err != nil {
				return false, err
			}
			if _, err := tx.Exec(ctx, `UPDATE mlm.investment_cd SET roi_accrued_usd=roi_accrued_usd+$2,last_accrual_date=$3::date,
 qualified_since=COALESCE(qualified_since,CASE WHEN $4 THEN $5::timestamptz END)
 WHERE id=$1 AND affiliate_package_id=$6`, o.cd, credit, next.Format("2006-01-02"), qualified, next, o.pkg); err != nil {
				return false, err
			}
			posted++
			claimed = target
		}
		if !cutoff.Before(maturity) && o.status == "active" {
			if _, err := tx.Exec(ctx, `UPDATE mlm.investment_cd SET status='matured',closed_at=COALESCE(closed_at,now()) WHERE id=$1 AND status='active'`, o.cd); err != nil {
				return false, err
			}
		}
	}
	return true, nil
}

func (s *Service) closePeriod(ctx context.Context, tx pgx.Tx, u universe, start, end time.Time) error {
	var periodID int64
	if err := tx.QueryRow(ctx, `INSERT INTO payments.nowpayments_engine_period(period_start,period_end) VALUES($1,$2)
 ON CONFLICT(period_start,period_end) DO UPDATE SET period_start=EXCLUDED.period_start RETURNING id`, start, end).Scan(&periodID); err != nil {
		return err
	}
	var state string
	if err := tx.QueryRow(ctx, `SELECT state FROM payments.nowpayments_engine_period WHERE id=$1 FOR UPDATE`, periodID).Scan(&state); err != nil {
		return err
	}
	if state == "closed" {
		return nil
	}
	var inflow decimal.Decimal
	for _, o := range u.orders {
		if !o.activated.Before(start) && o.activated.Before(end) {
			inflow = inflow.Add(o.net)
		}
	}
	if err := s.referrals(ctx, tx, u, periodID, start, end); err != nil {
		return err
	}
	if err := s.binary(ctx, tx, u, periodID, end); err != nil {
		return err
	}
	// A held claim remains auditable and may use future NOW budget. No legacy
	// cash, source PV, rank bonus, wallet purchase credit or recovered balance is
	// part of this calculation.
	var allInflows, roi, previous, projected, roiWindow decimal.Decimal
	for _, o := range u.orders {
		if o.activated.Before(end) {
			allInflows = allInflows.Add(o.net)
		}
	}
	if err := tx.QueryRow(ctx, `SELECT COALESCE(sum(p.amount_usd) FILTER(WHERE e.kind='roi'),0),
 COALESCE(sum(p.amount_usd) FILTER(WHERE e.kind<>'roi'),0),
 COALESCE(sum(p.amount_usd) FILTER(WHERE e.kind='roi' AND p.posted_at >=$1 AND p.posted_at<$2),0)
 FROM payments.nowpayments_engine_payment p JOIN payments.nowpayments_engine_obligation e ON e.id=p.obligation_id
 WHERE p.posted_at<$2`, start, end).Scan(&roi, &previous, &roiWindow); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT e.id,e.affiliate_package_id,e.entitlement_usd-e.paid_usd-e.cap_excluded_usd,e.kind
 FROM payments.nowpayments_engine_obligation e JOIN payments.nowpayments_operational_order o ON o.attempt_id=e.source_attempt_id
 WHERE e.kind<>'roi' AND e.entitlement_usd>e.paid_usd+e.cap_excluded_usd AND o.state='activated'
 AND e.period_id<=$1 ORDER BY e.id FOR UPDATE OF e`, periodID)
	if err != nil {
		return err
	}
	type pending struct {
		id, pkg int64
		amount  decimal.Decimal
		kind    string
	}
	var entries []pending
	for rows.Next() {
		var p pending
		if err := rows.Scan(&p.id, &p.pkg, &p.amount, &p.kind); err != nil {
			rows.Close()
			return err
		}
		entries = append(entries, p)
		projected = projected.Add(p.amount)
	}
	rows.Close()
	if rows.Err() != nil {
		return rows.Err()
	}
	alpha := u.orders[0].plan.Alpha
	budget := availableBudget(alpha, allInflows, roi, previous)
	theta := paymentTheta(budget, projected)
	credited := decimal.Zero
	for _, p := range entries {
		remaining := p.amount
		if consumesPackageCap(p.kind) {
			var err error
			remaining, err = s.remaining(ctx, tx, p.pkg)
			if err != nil {
				return err
			}
		}
		amount := p.amount.Mul(theta).RoundDown(2)
		if amount.GreaterThan(remaining) {
			amount = remaining
		}
		if amount.IsPositive() {
			if err := s.post(ctx, tx, p.id, p.pkg, p.kind, amount, theta, end); err != nil {
				return err
			}
			credited = credited.Add(amount)
		}
		// Package exhaustion is distinct from funding retention: keep both numbers.
		if p.amount.GreaterThan(remaining) {
			if _, err := tx.Exec(ctx, `UPDATE payments.nowpayments_engine_obligation SET cap_excluded_usd=cap_excluded_usd+$2 WHERE id=$1`, p.id, p.amount.Sub(remaining)); err != nil {
				return err
			}
		}
	}
	if credited.GreaterThan(budget) {
		return ErrFundingReview
	}
	var held decimal.Decimal
	if err := tx.QueryRow(ctx, `SELECT COALESCE(sum(entitlement_usd-paid_usd-cap_excluded_usd),0) FROM payments.nowpayments_engine_obligation WHERE kind<>'roi' AND period_id<=$1`, periodID).Scan(&held); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE payments.nowpayments_engine_period SET state='closed',inflows_usd=$2,roi_usd=$3,projected_usd=$4,paid_usd=$5,held_usd=$6,theta=$7,closed_at=now() WHERE id=$1`, periodID, inflow, roiWindow, projected, credited, held, theta)
	return err
}

func (s *Service) referrals(ctx context.Context, tx pgx.Tx, u universe, periodID int64, start, end time.Time) error {
	for _, sale := range u.orders {
		if sale.activated.Before(start) || !sale.activated.Before(end) {
			continue
		}
		buyer, ok := u.members[sale.affiliate]
		if !ok {
			return ErrNotReady
		}
		sponsor, ok := u.members[buyer.sponsor]
		if !ok || sponsor.parent == 0 || sponsor.status != "active" {
			continue
		}
		if own := u.ownFor(sponsor.id, end, false); own != nil && u.qualified(sponsor.id, end, 0) {
			rate := sale.plan.Ref
			if sponsor.founder {
				rate = sale.plan.FounderRef
			}
			amount := sale.net.Mul(rate).RoundDown(2)
			if amount.IsPositive() {
				if _, err := s.createObligation(ctx, tx, own, &periodID, "direct_bonus", fmt.Sprintf("now:ref:%d:%s", periodID, sale.id), amount, decimal.Zero, rate, commissionFactor, bonusAvailable(end, s.loc)); err != nil {
					return err
				}
			}
		}
		g2, ok := u.members[sponsor.sponsor]
		if !ok || g2.parent == 0 || g2.status != "active" {
			continue
		}
		if own := u.ownFor(g2.id, end, false); own != nil {
			amount := sale.net.Mul(sale.plan.Royalty).RoundDown(2)
			if amount.IsPositive() {
				if _, err := s.createObligation(ctx, tx, own, &periodID, "royalty", fmt.Sprintf("now:roy:%d:%s", periodID, sale.id), amount, decimal.Zero, sale.plan.Royalty, commissionFactor, bonusAvailable(end, s.loc)); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func (s *Service) binary(ctx context.Context, tx pgx.Tx, u universe, periodID int64, end time.Time) error {
	type volume struct{ left, right int64 }
	volumes := map[int64]*volume{}
	for _, sale := range u.orders {
		if !sale.activated.Before(end) {
			continue
		}
		child := sale.affiliate
		for depth := 0; depth < sale.plan.Depth; depth++ {
			node, ok := u.members[child]
			if !ok || node.parent == 0 {
				break
			}
			v := volumes[node.parent]
			if v == nil {
				v = &volume{}
				volumes[node.parent] = v
			}
			if node.position == "L" {
				v.left += sale.pv
			} else if node.position == "R" {
				v.right += sale.pv
			} else {
				return ErrNotReady
			}
			child = node.parent
		}
	}
	// Deterministic lock/post order, independent of Go map iteration.
	ids := sortedKeys(volumes)
	for _, affiliate := range ids {
		m, ok := u.members[affiliate]
		if !ok || m.status != "active" {
			continue
		}
		own := u.own(affiliate, end)
		if own == nil {
			continue
		}
		if !u.qualified(affiliate, end, 0) {
			continue
		}
		v := volumes[affiliate]
		matched := min(v.left, v.right)
		blocks := matched / own.plan.Block
		var claimed int64
		if err := tx.QueryRow(ctx, `INSERT INTO payments.nowpayments_engine_binary_state(affiliate_id) VALUES($1) ON CONFLICT(affiliate_id) DO UPDATE SET affiliate_id=EXCLUDED.affiliate_id RETURNING claimed_blocks`, affiliate).Scan(&claimed); err != nil {
			return err
		}
		newBlocks := blocks - claimed
		if newBlocks <= 0 {
			continue
		}
		amount := binaryEntitlement(own.plan, newBlocks, m.founder)
		cap := own.plan.DailyCap.Mul(m.rankBonus)
		remaining, err := s.remaining(ctx, tx, own.pkg)
		if err != nil {
			return err
		}
		allowed := amount
		if allowed.GreaterThan(cap) {
			allowed = cap
		}
		if allowed.GreaterThan(remaining) {
			allowed = remaining
		}
		excluded := amount.Sub(allowed)
		if amount.IsPositive() {
			if _, err := s.createObligation(ctx, tx, own, &periodID, "binary_bonus", fmt.Sprintf("now:binary:%d:%d", periodID, affiliate), amount, excluded, own.plan.Unit, commissionFactor, bonusAvailable(end, s.loc)); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE payments.nowpayments_engine_binary_state SET claimed_blocks=$2,updated_at=now() WHERE affiliate_id=$1`, affiliate, blocks); err != nil {
			return err
		}
	}
	return nil
}
