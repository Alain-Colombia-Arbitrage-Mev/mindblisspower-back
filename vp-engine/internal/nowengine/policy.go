// Package nowengine accrues only new, verified NOW operational entitlements.
// It never invokes the global/recovered bonus-engine jobs or provider APIs.
package nowengine

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"time"

	"github.com/shopspring/decimal"
	"github.com/vicionpower/vp-engine/internal/bonusengine"
)

var (
	ErrNotReady      = errors.New("NOW compensation configuration unavailable")
	ErrRiskFrozen    = errors.New("NOW compensation requires risk review")
	ErrFundingReview = errors.New("NOW compensation requires funding review")
	commissionFactor = decimal.RequireFromString("0.99")
)

const businessTimezone = "America/Bogota"
const maxAccrualsPerRun = 4

func hasCommitBudget(ctx context.Context) bool {
	if ctx.Err() != nil {
		return false
	}
	if deadline, ok := ctx.Deadline(); ok {
		return time.Until(deadline) > 5*time.Second
	}
	return true
}

// Baseline PayV2Streams treats referral/royalty as T1-only; never silently
// consume the ROI/binary package cap with these independent streams.
func consumesPackageCap(kind string) bool { return kind == "roi" || kind == "binary_bonus" }

type plan struct {
	ID             int64
	Block          int64           `json:"block_size"`
	Unit           decimal.Decimal `json:"bonus_per_block"`
	Depth          int             `json:"depth_cap"`
	DailyCap       decimal.Decimal `json:"daily_cap_factor"`
	LifetimeCap    decimal.Decimal `json:"lifetime_cap_factor"`
	Alpha          decimal.Decimal `json:"treasury_alpha"`
	PeriodCap      decimal.Decimal `json:"period_cap_factor"`
	DirectL        int             `json:"qualified_directs_left"`
	DirectR        int             `json:"qualified_directs_right"`
	Ref            decimal.Decimal `json:"referral_rate"`
	Royalty        decimal.Decimal `json:"royalty_rate"`
	RoyaltyEnabled bool            `json:"royalty_enabled"`
	Generation     int             `json:"royalty_generation"`
	FounderRef     decimal.Decimal `json:"founder_referral_rate"`
	FounderBinary  decimal.Decimal `json:"founder_binary_matched_rate"`
	LockDays       int             `json:"cd_lock_days"`
	Yield          bool            `json:"yield_enabled"`
	Points         bool            `json:"points_enabled"`
	Ranks          bool            `json:"ranks_enabled"`
	Repurchase     bool            `json:"depth_repurchase_enabled"`
	RetirementAge  int             `json:"retirement_age"`
	SameTier       bool            `json:"cd_same_tier_required"`
	CDDirects      int             `json:"cd_qualified_directs"`
	DirectsActive  bool            `json:"directs_active_required"`
}

func parsePlan(raw string) (plan, error) {
	var p plan
	if json.Unmarshal([]byte(raw), &p) != nil || p.Block != 500 || !p.Unit.Equal(decimal.NewFromInt(10)) || p.Depth != 10 ||
		!p.DailyCap.Equal(decimal.NewFromInt(3)) || !p.LifetimeCap.Equal(decimal.NewFromInt(2)) ||
		!p.Alpha.Equal(decimal.RequireFromString("0.45")) || !p.PeriodCap.IsZero() || p.DirectL != 1 || p.DirectR != 1 ||
		!p.Ref.Equal(decimal.RequireFromString("0.05")) || !p.Royalty.Equal(decimal.RequireFromString("0.05")) ||
		!p.RoyaltyEnabled || p.Generation != 2 || !p.FounderRef.Equal(decimal.RequireFromString("0.10")) ||
		!p.FounderBinary.Equal(decimal.RequireFromString("0.10")) || p.LockDays != 365 || p.Yield || p.Points || p.Ranks || p.Repurchase || p.RetirementAge != 65 || !p.SameTier || p.CDDirects != 2 || !p.DirectsActive {
		return p, ErrNotReady
	}
	return p, nil
}

func binaryEntitlement(p plan, blocks int64, founder bool) decimal.Decimal {
	unit := p.Unit
	if founder {
		unit = decimal.NewFromInt(p.Block).Mul(p.FounderBinary)
	}
	return unit.Mul(decimal.NewFromInt(blocks)).Mul(commissionFactor).RoundDown(2)
}

func roiEntitlement(principal, rate decimal.Decimal, days int) decimal.Decimal {
	return principal.Mul(rate).Mul(decimal.NewFromInt(int64(days))).Div(decimal.NewFromInt(365)).RoundDown(2)
}

func availableBudget(alpha, inflows, roi, alreadyPaid decimal.Decimal) decimal.Decimal {
	budget := alpha.Mul(inflows).RoundDown(2).Sub(roi).Sub(alreadyPaid)
	if budget.IsNegative() {
		return decimal.Zero
	}
	return budget
}

func paymentTheta(budget, projected decimal.Decimal) decimal.Decimal {
	return bonusengine.ComputeTheta(decimal.NewFromInt(1), budget, projected)
}

func periodStart(at time.Time, loc *time.Location) time.Time {
	local := at.In(loc)
	monday := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc).AddDate(0, 0, -(int(local.Weekday())+6)%7)
	return monday
}

func sortedKeys[T any](values map[int64]T) []int64 {
	keys := make([]int64, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	return keys
}

func bonusAvailable(at time.Time, loc *time.Location) time.Time {
	local := at.In(loc)
	last := time.Date(local.Year(), local.Month()+1, 0, 0, 0, 0, 0, loc)
	nextLast := time.Date(last.Year(), last.Month()+2, 0, 0, 0, 0, 0, loc)
	day := last.Day()
	if day > nextLast.Day() {
		day = nextLast.Day()
	}
	return time.Date(nextLast.Year(), nextLast.Month(), day, 0, 0, 0, 0, loc).AddDate(0, 0, 1)
}

func dailyCutoff(at time.Time, loc *time.Location) time.Time {
	local := at.In(loc)
	day := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)
	if local.Before(day.Add(30 * time.Minute)) {
		day = day.AddDate(0, 0, -1)
	}
	return day
}
