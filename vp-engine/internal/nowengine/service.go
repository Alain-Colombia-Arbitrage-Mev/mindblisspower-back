package nowengine

import (
	"context"
	"errors"
	"fmt"
	"time"
	_ "time/tzdata"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/vicionpower/vp-engine/internal/bonusengine"
)

type Service struct {
	db   *pgxpool.Pool
	root int64
	loc  *time.Location
}

func New(db *pgxpool.Pool, root int64) *Service {
	loc, err := time.LoadLocation(businessTimezone)
	if err != nil {
		loc = nil
	}
	return &Service{db: db, root: root, loc: loc}
}

// ValidateReady is invoked in the same transaction as creating a new order.
// Missing schema, unsupported compensation modes, risks or credentials fail
// before an external invoice exists. There is no ambient environment bypass.
func (s *Service) ValidateReady(ctx context.Context, tx pgx.Tx) error {
	if err := s.validateReady(ctx, tx, true); err != nil {
		return err
	}
	// Validate already-activated sources before accepting another charge. A
	// corrupt/missing NOW manifest must not strand an otherwise payable invoice.
	_, err := s.load(ctx, tx)
	return err
}

func (s *Service) validateReady(ctx context.Context, tx pgx.Tx, invoice bool) error {
	if s == nil || s.db == nil || s.root <= 0 || s.loc == nil {
		return ErrNotReady
	}
	var version, count int
	if err := tx.QueryRow(ctx, `SELECT schema_version FROM payments.nowpayments_engine_control WHERE singleton`).Scan(&version); err != nil || version != 1 {
		return ErrNotReady
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM mlm.plan_config WHERE effective_from<=now() AND(effective_to IS NULL OR effective_to>now())`).Scan(&count); err != nil || count != 1 {
		return ErrNotReady
	}
	var raw string
	if err := tx.QueryRow(ctx, `SELECT to_jsonb(p)::text FROM mlm.plan_config p WHERE effective_from<=now() AND(effective_to IS NULL OR effective_to>now())`).Scan(&raw); err != nil {
		return ErrNotReady
	}
	if _, err := parsePlan(raw); err != nil {
		return err
	}
	var valid bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM mlm.cd_roi_tier WHERE active)
 AND NOT EXISTS(SELECT 1 FROM mlm.cd_roi_tier WHERE active AND(base_annual_rate<>.25 OR qualified_annual_rate<.30 OR qualified_annual_rate>.50))
 AND EXISTS(SELECT 1 FROM mlm.affiliate WHERE id=$1 AND parent_id IS NULL AND status::text='active')
 AND EXISTS(SELECT 1 FROM mlm.asset WHERE symbol='USD')
 AND EXISTS(SELECT 1 FROM mlm.concept WHERE id=1006 AND kind::text='roi' AND factor=1 AND active)
 AND (SELECT count(DISTINCT kind::text) FROM mlm.concept WHERE kind::text IN('roi','binary_bonus','direct_bonus','royalty') AND active AND factor=1)=4
 AND NOT EXISTS(SELECT 1 FROM mlm.concept WHERE kind::text IN('roi','binary_bonus','direct_bonus','royalty') AND active AND factor<>1)`, s.root).Scan(&valid); err != nil || !valid {
		return ErrNotReady
	}
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM payments.nowpayments_operational_order o
 WHERE o.activated_at IS NOT NULL AND(o.state<>'activated' OR EXISTS(SELECT 1 FROM payments.nowpayments_webhook_capture c
 WHERE c.matched_attempt_id=o.attempt_id AND(c.risk_detected OR c.disposition='quarantined'))))`).Scan(&valid); err != nil {
		return ErrNotReady
	}
	if valid {
		return ErrRiskFrozen
	}
	if invoice {
		// SQL79 capacity_slot UNIQUE provides the concurrent reservation. This
		// preflight gives a predictable rejection before an invoice is created.
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM payments.nowpayments_operational_order`).Scan(&count); err != nil || count >= 5000 {
			return ErrNotReady
		}
	}
	return nil
}

type order struct {
	id                                  string
	affiliate, pkg, cd                  int64
	pv                                  int64
	tier                                int
	gross, net, baseRate, qualifiedRate decimal.Decimal
	activated, start, matures           time.Time
	status                              string
	plan                                plan
	active                              bool
	packageStatus                       string
	capClosed, packageExpired, cdClosed *time.Time
}
type member struct {
	id, parent, sponsor int64
	position, status    string
	founder             bool
	rankBonus           decimal.Decimal
}
type universe struct {
	orders      []*order
	members     map[int64]member
	directLeg   map[int64]string
	byAffiliate map[int64][]*order
	bySponsor   map[int64][]*order
}

func (u *universe) index() {
	u.byAffiliate = map[int64][]*order{}
	u.bySponsor = map[int64][]*order{}
	for _, o := range u.orders {
		u.byAffiliate[o.affiliate] = append(u.byAffiliate[o.affiliate], o)
		if m, ok := u.members[o.affiliate]; ok {
			u.bySponsor[m.sponsor] = append(u.bySponsor[m.sponsor], o)
		}
	}
}

func (s *Service) load(ctx context.Context, tx pgx.Tx) (universe, error) {
	u := universe{members: map[int64]member{}, directLeg: map[int64]string{}}
	rows, err := tx.Query(ctx, `SELECT o.attempt_id::text,o.affiliate_id,o.affiliate_package_id,o.investment_cd_id,pv.pv,
 a.amount_usd,i.net_usd,o.roi_base_annual_rate,o.roi_qualified_annual_rate,o.activated_at,cd.start_at,cd.matures_at,
 cd.status::text,o.plan_snapshot::text,(ap.status='active' AND cs.closed_at IS NULL),ap.status::text,cs.closed_at,ap.expired_at,cd.closed_at,o.roi_tier_id
 FROM payments.nowpayments_operational_order o
 JOIN payments.nowpayments_membership_attempt a ON a.id=o.attempt_id AND a.environment='production'
 JOIN payments.nowpayments_operational_pv_source pv ON pv.id=o.pv_source_id AND pv.attempt_id=o.attempt_id AND pv.affiliate_id=o.affiliate_id
 JOIN payments.nowpayments_operational_inflow i ON i.id=o.inflow_id AND i.attempt_id=o.attempt_id
 JOIN mlm.affiliate_package ap ON ap.id=o.affiliate_package_id AND ap.affiliate_id=o.affiliate_id AND ap.payment_method='nowpayments'
 JOIN mlm.package_cap_state cs ON cs.affiliate_package_id=ap.id
 JOIN mlm.investment_cd cd ON cd.id=o.investment_cd_id AND cd.affiliate_package_id=ap.id AND cd.affiliate_id=o.affiliate_id
 WHERE o.state='activated' AND a.pricing_policy='catalog_includes_provider_1pct_v1'
 AND a.invoice_id IS NOT NULL AND a.payment_id IS NOT NULL AND a.commission_base_usd=i.net_usd
 AND i.gross_usd=a.amount_usd AND i.net_usd=a.amount_usd*.99 AND pv.pv=a.pv AND cd.principal_usd=a.amount_usd AND cd.roi_tier_id=o.roi_tier_id
 AND i.payment_ref='nowpayments:production:'||a.payment_id AND ap.transaction_hash=i.payment_ref
 AND cd.matures_at=cd.start_at+interval '365 days'
 AND EXISTS(SELECT 1 FROM payments.nowpayments_membership_receipt r WHERE r.attempt_id=o.attempt_id AND r.payment_id=a.payment_id AND r.finished_verified AND NOT r.multiple_payments)
 AND NOT EXISTS(SELECT 1 FROM payments.nowpayments_membership_receipt r WHERE r.attempt_id=o.attempt_id AND(r.multiple_payments OR r.api_evidence->>'payment_status' NOT IN('waiting','confirming','confirmed','sending','finished')))
 AND EXISTS(SELECT 1 FROM payments.nowpayments_webhook_capture c WHERE c.matched_attempt_id=o.attempt_id AND c.payment_id=a.payment_id AND c.environment='production' AND c.finished_verified AND NOT c.risk_detected AND c.disposition<>'quarantined')
 ORDER BY o.activated_at,o.attempt_id LIMIT 5001 FOR SHARE OF o`)
	if err != nil {
		return u, fmt.Errorf("load NOW sources: %w", err)
	}
	for rows.Next() {
		o := &order{}
		var raw string
		if err := rows.Scan(&o.id, &o.affiliate, &o.pkg, &o.cd, &o.pv, &o.gross, &o.net, &o.baseRate, &o.qualifiedRate, &o.activated, &o.start, &o.matures, &o.status, &raw, &o.active, &o.packageStatus, &o.capClosed, &o.packageExpired, &o.cdClosed, &o.tier); err != nil {
			rows.Close()
			return u, err
		}
		o.plan, err = parsePlan(raw)
		if err != nil {
			rows.Close()
			return u, err
		}
		if !o.baseRate.Equal(decimal.RequireFromString(".25")) || o.qualifiedRate.LessThan(decimal.RequireFromString(".30")) || o.qualifiedRate.GreaterThan(decimal.RequireFromString(".50")) {
			rows.Close()
			return u, ErrNotReady
		}
		if o.status != "active" && o.status != "matured" {
			rows.Close()
			return u, ErrRiskFrozen
		}
		u.orders = append(u.orders, o)
	}
	rows.Close()
	if rows.Err() != nil {
		return u, rows.Err()
	}
	if len(u.orders) > 5000 {
		return u, ErrNotReady
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM payments.nowpayments_operational_order WHERE state='activated'`).Scan(&count); err != nil || count != len(u.orders) {
		return u, ErrNotReady
	}
	rows, err = tx.Query(ctx, `SELECT a.id,COALESCE(a.parent_id,0),COALESCE(a.sponsor_id,0),COALESCE(a.position::text,''),a.status::text,a.is_founder,COALESCE(r.bonus_amount_usd,100)
 FROM mlm.affiliate a LEFT JOIN mlm.rank r ON r.id=a.current_rank_id
 WHERE EXISTS(SELECT 1 FROM payments.nowpayments_operational_order o JOIN mlm.affiliate_closure c ON c.descendant_id=o.affiliate_id
 WHERE o.activated_at IS NOT NULL AND c.ancestor_id=a.id AND c.distance<=10) ORDER BY a.id LIMIT 55001`)
	if err != nil {
		return u, err
	}
	for rows.Next() {
		var m member
		if err := rows.Scan(&m.id, &m.parent, &m.sponsor, &m.position, &m.status, &m.founder, &m.rankBonus); err != nil {
			rows.Close()
			return u, err
		}
		u.members[m.id] = m
	}
	rows.Close()
	if rows.Err() != nil {
		return u, rows.Err()
	}
	if len(u.members) > 55000 {
		return u, ErrNotReady
	}
	for _, o := range u.orders {
		if _, ok := u.members[o.affiliate]; !ok {
			return u, ErrNotReady
		}
	}
	rows, err = tx.Query(ctx, `SELECT DISTINCT d.id,leg.position::text
 FROM payments.nowpayments_operational_order o JOIN mlm.affiliate d ON d.id=o.affiliate_id
 JOIN mlm.affiliate leg ON leg.parent_id=d.sponsor_id AND leg.status::text='active'
 JOIN mlm.affiliate_closure c ON c.ancestor_id=leg.id AND c.descendant_id=d.id
 WHERE o.activated_at IS NOT NULL ORDER BY 1,2 LIMIT 5001`)
	if err != nil {
		return u, err
	}
	for rows.Next() {
		var id int64
		var leg string
		if err := rows.Scan(&id, &leg); err != nil {
			rows.Close()
			return u, err
		}
		if old, ok := u.directLeg[id]; ok && old != leg {
			rows.Close()
			return u, ErrNotReady
		}
		u.directLeg[id] = leg
	}
	rows.Close()
	if rows.Err() != nil {
		return u, rows.Err()
	}
	if len(u.directLeg) > 5000 {
		return u, ErrNotReady
	}
	u.index()
	return u, nil
}

func (o *order) activeAt(at time.Time) bool {
	return o.membershipActiveAt(at) && (o.capClosed == nil || at.Before(*o.capClosed))
}

func (o *order) membershipActiveAt(at time.Time) bool {
	if !o.activated.Before(at) {
		return false
	}
	if o.packageExpired != nil && !at.Before(*o.packageExpired) {
		return false
	}
	if o.packageStatus == "active" {
		return true
	}
	if o.packageStatus == "expired" && o.packageExpired != nil {
		return at.Before(*o.packageExpired)
	}
	// Pure test values predate SQL packageStatus support.
	return o.packageStatus == "" && o.active
}

func (u universe) own(affiliate int64, at time.Time) *order {
	return u.ownFor(affiliate, at, true)
}

func (u universe) ownFor(affiliate int64, at time.Time, capRequired bool) *order {
	var chosen *order
	orders := u.orders
	if u.byAffiliate != nil {
		orders = u.byAffiliate[affiliate]
	}
	for _, o := range orders {
		active := o.membershipActiveAt(at)
		if capRequired {
			active = o.activeAt(at)
		}
		if o.affiliate == affiliate && active && (chosen == nil || o.pkg > chosen.pkg) {
			chosen = o
		}
	}
	return chosen
}

func (u universe) leg(ancestor, descendant int64) (string, bool) {
	if u.directLeg != nil {
		m, ok := u.members[descendant]
		if !ok || m.sponsor != ancestor {
			return "", false
		}
		leg, ok := u.directLeg[descendant]
		return leg, ok
	}
	for steps := 0; steps < 2048; steps++ {
		m, ok := u.members[descendant]
		if !ok || m.parent == 0 {
			return "", false
		}
		if m.parent == ancestor {
			return m.position, true
		}
		descendant = m.parent
	}
	return "", false
}

func (u universe) qualified(affiliate int64, at time.Time, minTier int) bool {
	left, right := false, false
	seen := map[int64]bool{}
	orders := u.orders
	if u.bySponsor != nil {
		orders = u.bySponsor[affiliate]
	}
	for _, o := range orders {
		d, ok := u.members[o.affiliate]
		active := o.membershipActiveAt(at)
		if minTier > 0 {
			active = o.activeAt(at)
		}
		if !ok || seen[d.id] || d.sponsor != affiliate || d.status != "active" || !active || o.tier < minTier {
			continue
		}
		// The CD uplift requires a live same-or-higher investment. Ordinary
		// direct/binary gates require the membership, not an unmatured CD.
		if minTier > 0 && (!o.matures.After(at) || (o.cdClosed != nil && !at.Before(*o.cdClosed))) {
			continue
		}
		seen[d.id] = true
		if leg, ok := u.leg(affiliate, d.id); ok {
			left = left || leg == "L"
			right = right || leg == "R"
		}
	}
	return left && right
}

// Run uses database time, serializes against other runners and never performs
// provider calls. Bounded catch-up is retried by the private durable wake-up.
func (s *Service) Run(parent context.Context) error {
	if s == nil || s.db == nil {
		return ErrNotReady
	}
	ctx, cancel := context.WithTimeout(parent, 20*time.Second)
	defer cancel()
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var locked bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended('nowpayments-scoped-engine-v1',0))`).Scan(&locked); err != nil {
		return err
	}
	if !locked {
		return nil
	}
	if err := s.validateReady(ctx, tx, false); err != nil {
		return err
	}
	var now time.Time
	if err := tx.QueryRow(ctx, `SELECT now()`).Scan(&now); err != nil {
		return err
	}
	u, err := s.load(ctx, tx)
	if err != nil {
		return err
	}
	if len(u.orders) > 0 {
		caughtUp, err := s.accrueROI(ctx, tx, u, now)
		if err != nil {
			return err
		}
		start := periodStart(u.orders[0].activated, s.loc)
		var closed *time.Time
		if err := tx.QueryRow(ctx, `SELECT max(period_end) FROM payments.nowpayments_engine_period WHERE state='closed'`).Scan(&closed); err != nil {
			return err
		}
		if closed != nil {
			start = *closed
		}
		for n := 0; caughtUp && hasCommitBudget(ctx) && n < 8 && !start.AddDate(0, 0, 7).Add(2*time.Hour).After(now); n++ {
			end := start.AddDate(0, 0, 7)
			if err := s.closePeriod(ctx, tx, u, start, end); err != nil {
				return err
			}
			start = end
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE payments.nowpayments_engine_control SET last_run_at=$1 WHERE singleton`, now); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) remaining(ctx context.Context, tx pgx.Tx, pkg int64) (decimal.Decimal, error) {
	var cap, paid decimal.Decimal
	if err := tx.QueryRow(ctx, `SELECT cap_total,paid_total FROM mlm.package_cap_state WHERE affiliate_package_id=$1 FOR UPDATE`, pkg).Scan(&cap, &paid); err != nil {
		return decimal.Zero, err
	}
	result := cap.Sub(paid)
	if result.IsNegative() {
		return decimal.Zero, ErrNotReady
	}
	return result, nil
}

func (s *Service) createObligation(ctx context.Context, tx pgx.Tx, o *order, period *int64, kind, ref string, amount, excluded, unit, factor decimal.Decimal, available time.Time) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, `INSERT INTO payments.nowpayments_engine_obligation(external_ref,source_attempt_id,period_id,affiliate_id,affiliate_package_id,kind,entitlement_usd,cap_excluded_usd,unit_gross_usd,commission_factor,available_at)
 VALUES($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(external_ref) DO NOTHING RETURNING id`, ref, o.id, period, o.affiliate, o.pkg, kind, amount, excluded, unit, factor, available).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	return id, err
}

func (s *Service) post(ctx context.Context, tx pgx.Tx, id, pkg int64, kind string, amount, theta decimal.Decimal, posted time.Time) error {
	if !amount.IsPositive() {
		return nil
	}
	if consumesPackageCap(kind) {
		remaining, err := s.remaining(ctx, tx, pkg)
		if err != nil {
			return err
		}
		if amount.GreaterThan(remaining) {
			amount = remaining
		}
	}
	if !amount.IsPositive() {
		return nil
	}
	var installment int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(max(installment),0)+1 FROM payments.nowpayments_engine_payment WHERE obligation_id=$1`, id).Scan(&installment); err != nil {
		return err
	}
	ref := fmt.Sprintf("now:accrual:%d:%d", id, installment)
	if _, err := bonusengine.PostNOWScopedAccrual(ctx, tx, id, amount, ref, posted, s.root); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO payments.nowpayments_engine_payment(obligation_id,installment,amount_usd,theta,posted_at,transaction_ref) VALUES($1,$2,$3,$4,$5,$6)`, id, installment, amount, theta, posted, ref); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE payments.nowpayments_engine_obligation SET paid_usd=paid_usd+$2 WHERE id=$1`, id, amount); err != nil {
		return err
	}
	if consumesPackageCap(kind) {
		_, err := tx.Exec(ctx, `UPDATE mlm.package_cap_state SET paid_total=paid_total+$2 WHERE affiliate_package_id=$1`, pkg, amount)
		return err
	}
	return nil
}
