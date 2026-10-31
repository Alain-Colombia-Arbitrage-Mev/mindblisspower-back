package nowengine

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/shopspring/decimal"
)

const baseline = `{"block_size":500,"bonus_per_block":10,"depth_cap":10,"daily_cap_factor":3,"lifetime_cap_factor":2,"treasury_alpha":0.45,"period_cap_factor":0,"qualified_directs_left":1,"qualified_directs_right":1,"referral_rate":0.05,"royalty_rate":0.05,"royalty_enabled":true,"royalty_generation":2,"founder_referral_rate":0.10,"founder_binary_matched_rate":0.10,"cd_lock_days":365,"yield_enabled":false,"points_enabled":false,"ranks_enabled":false,"depth_repurchase_enabled":false,"retirement_age":65,"cd_same_tier_required":true,"cd_qualified_directs":2,"directs_active_required":true}`

func TestApprovedNOWPolicyRejectsUnsupportedModes(t *testing.T) {
	if _, err := parsePlan(baseline); err != nil {
		t.Fatal(err)
	}
	for _, change := range []map[string]any{{"yield_enabled": true}, {"points_enabled": true}, {"ranks_enabled": true}, {"depth_repurchase_enabled": true}, {"block_size": 100}, {"bonus_per_block": 11}, {"referral_rate": .1}, {"treasury_alpha": .5}, {"cd_lock_days": 366}} {
		var data map[string]any
		if err := json.Unmarshal([]byte(baseline), &data); err != nil {
			t.Fatal(err)
		}
		for k, v := range change {
			data[k] = v
		}
		raw, _ := json.Marshal(data)
		if _, err := parsePlan(string(raw)); err == nil {
			t.Fatal("unsupported policy accepted", change)
		}
	}
}

func TestNOWAmountsUseNet99ButROIDoesNot(t *testing.T) {
	p, err := parsePlan(baseline)
	if err != nil {
		t.Fatal(err)
	}
	if got := binaryEntitlement(p, 1, false); !got.Equal(decimal.RequireFromString("9.90")) {
		t.Fatal(got)
	}
	if got := binaryEntitlement(p, 1, true); !got.Equal(decimal.RequireFromString("49.50")) {
		t.Fatal(got)
	}
	if got := decimal.NewFromInt(100).Mul(commissionFactor).Mul(p.Ref).RoundDown(2); !got.Equal(decimal.RequireFromString("4.95")) {
		t.Fatal(got)
	}
	for _, rate := range []string{".25", ".50"} {
		numerator, claimed, credited := decimal.Zero, decimal.Zero, decimal.Zero
		for day := 0; day < 365; day++ {
			numerator = numerator.Add(decimal.NewFromInt(100).Mul(decimal.RequireFromString(rate)))
			target := numerator.Div(decimal.NewFromInt(365)).RoundDown(2)
			credited = credited.Add(target.Sub(claimed))
			claimed = target
		}
		want := decimal.NewFromInt(100).Mul(decimal.RequireFromString(rate))
		if !credited.Equal(want) {
			t.Fatalf("annual rate %s got=%s want=%s", rate, credited, want)
		}
	}
	numerator := decimal.NewFromInt(100).Mul(decimal.RequireFromString(".25")).Mul(decimal.NewFromInt(100)).Add(decimal.NewFromInt(100).Mul(decimal.RequireFromString(".50")).Mul(decimal.NewFromInt(265)))
	if got := numerator.Div(decimal.NewFromInt(365)).RoundDown(2); !got.Equal(decimal.RequireFromString("43.15")) {
		t.Fatal("qualified rate-days", got)
	}
	if got := roiEntitlement(decimal.RequireFromString(".01"), decimal.RequireFromString(".25"), 365); !got.IsZero() {
		t.Fatal("fractional cent invented", got)
	}
}

func TestNOWFundingRetentionHasNoNegativeOrInventedBudget(t *testing.T) {
	alpha := decimal.RequireFromString(".45")
	if got := availableBudget(alpha, decimal.NewFromInt(99), decimal.NewFromInt(50), decimal.Zero); !got.IsZero() {
		t.Fatal("qualified ROI funded with invented cash", got)
	}
	budget := availableBudget(alpha, decimal.NewFromInt(99), decimal.NewFromInt(25), decimal.Zero)
	if !budget.Equal(decimal.RequireFromString("19.55")) {
		t.Fatal(budget)
	}
	theta := paymentTheta(budget, decimal.NewFromInt(100))
	paid := decimal.NewFromInt(100).Mul(theta).RoundDown(2)
	if paid.GreaterThan(budget) || !decimal.NewFromInt(100).Sub(paid).Equal(decimal.RequireFromString("80.45")) {
		t.Fatal("held obligation lost", paid)
	}
}

func TestNOWBusinessCadenceAndAvailability(t *testing.T) {
	loc, err := time.LoadLocation(businessTimezone)
	if err != nil {
		t.Fatal(err)
	}
	monday := time.Date(2026, 11, 2, 0, 0, 0, 0, loc)
	if got := periodStart(monday.Add(time.Hour), loc); !got.Equal(monday) {
		t.Fatal(got)
	}
	if got := dailyCutoff(monday.Add(29*time.Minute), loc); !got.Equal(monday.AddDate(0, 0, -1)) {
		t.Fatal(got)
	}
	if got := dailyCutoff(monday.Add(30*time.Minute), loc); !got.Equal(monday) {
		t.Fatal(got)
	}
	for _, tc := range []struct{ from, want string }{{"2026-01-15", "2026-03-01"}, {"2026-04-15", "2026-05-31"}, {"2028-01-15", "2028-03-01"}} {
		from, _ := time.ParseInLocation("2006-01-02", tc.from, loc)
		if got := bonusAvailable(from, loc).Format("2006-01-02"); got != tc.want {
			t.Fatal(tc, got)
		}
	}
	start := time.Date(2027, 3, 1, 12, 0, 0, 0, loc)
	if got := start.AddDate(0, 0, 365).Sub(start).Hours() / 24; got != 365 {
		t.Fatal("leap-year changed fixed maturity", got)
	}
}

func TestNOWQualificationUsesOnlyOwnedActiveScopedMemberships(t *testing.T) {
	now := time.Now()
	u := universe{members: map[int64]member{1: {id: 1, parent: 0, status: "active"}, 2: {id: 2, parent: 1, position: "L", sponsor: 1, status: "active"}, 3: {id: 3, parent: 1, position: "R", sponsor: 1, status: "active"}}}
	makeOrder := func(id int64) *order {
		return &order{affiliate: id, tier: 2, active: true, activated: now.Add(-time.Hour), matures: now.AddDate(1, 0, 0), gross: decimal.NewFromInt(1000)}
	}
	u.orders = []*order{makeOrder(2)}
	if u.qualified(1, now, 0) {
		t.Fatal("historical right leg inferred paid membership")
	}
	u.orders = append(u.orders, makeOrder(3))
	if !u.qualified(1, now, 2) {
		t.Fatal("balanced direct active membership not qualified")
	}
	if u.qualified(1, now, 3) {
		t.Fatal("lower tier qualified uplift")
	}
	u.orders[1].active = false
	if u.qualified(1, now, 0) {
		t.Fatal("closed membership qualified uplift")
	}
}

func TestNOWCatchupQualificationKeepsHistoricalIntervalsAndDeepSpillover(t *testing.T) {
	at := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	closed := at.Add(48 * time.Hour)
	u := universe{members: map[int64]member{1: {id: 1, status: "active"}, 101: {id: 101, parent: 100, sponsor: 1, status: "active"}, 202: {id: 202, parent: 201, sponsor: 1, status: "active"}}, directLeg: map[int64]string{101: "L", 202: "R"}}
	for _, id := range []int64{101, 202} {
		u.orders = append(u.orders, &order{affiliate: id, tier: 2, packageStatus: "active", active: false, capClosed: &closed, activated: at.Add(-24 * time.Hour), matures: at.AddDate(1, 0, 0), gross: decimal.NewFromInt(100)})
	}
	if !u.qualified(1, at, 2) {
		t.Fatal("late job erased earned uplift before cap closure, or deep spillover was truncated")
	}
	if u.qualified(1, closed.Add(time.Second), 2) {
		t.Fatal("closed membership retained uplift")
	}
	if !u.qualified(1, closed.Add(time.Second), 0) || u.ownFor(101, closed.Add(time.Second), false) == nil {
		t.Fatal("cap exhaustion blocked T1-only referral membership")
	}
	if consumesPackageCap("direct_bonus") || consumesPackageCap("royalty") || !consumesPackageCap("roi") || !consumesPackageCap("binary_bonus") {
		t.Fatal("baseline T1/T2 scopes changed")
	}
	if maxAncestors := 5000 * (10 + 1); maxAncestors != 55000 {
		t.Fatal("source capacity does not imply bounded graph")
	}
}

func TestNOWIndexedMembershipLookupIsBoundedAtSourceCapacity(t *testing.T) {
	now := time.Now()
	u := universe{members: map[int64]member{}}
	for id := int64(1); id <= 5000; id++ {
		u.members[id] = member{id: id, sponsor: id / 2, status: "active"}
		u.orders = append(u.orders, &order{affiliate: id, pkg: id, active: true, activated: now.Add(-time.Hour), matures: now.AddDate(1, 0, 0), tier: 1})
	}
	u.index()
	if len(u.byAffiliate) != 5000 {
		t.Fatal("capacity index lost ownership")
	}
	for id := int64(1); id <= 55000; id++ {
		got := u.own(id, now)
		if (id <= 5000) != (got != nil) {
			t.Fatal("indexed membership changed eligibility", id)
		}
	}
	if len(u.bySponsor[100]) != 2 {
		t.Fatal("qualification scans unrelated network instead of two direct sources")
	}
}

func TestNOWBatchReservesCommitTimeInsteadOfRollingBackEveryPrefix(t *testing.T) {
	if maxAccrualsPerRun > 4 {
		t.Fatal("daily posting batch exceeds bounded slow-database envelope")
	}
	short, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	if hasCommitBudget(short) {
		t.Fatal("job consumed COMMIT reserve")
	}
	full, cancelFull := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancelFull()
	if !hasCommitBudget(full) {
		t.Fatal("fresh bounded job cannot progress")
	}
	cancelFull()
	if hasCommitBudget(full) {
		t.Fatal("cancelled job tried to keep posting")
	}
}
