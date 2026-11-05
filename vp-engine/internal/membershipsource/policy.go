// Package membershipsource describes source-aware membership arithmetic only.
// It neither proves a payment nor activates a membership, posts a ledger entry,
// selects a sponsor, moves a node, or authorizes a compensation policy.
package membershipsource

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata" // Calendar arithmetic must not depend on a host zoneinfo file.

	"github.com/shopspring/decimal"
)

type Kind string

const (
	NOWPayments Kind = "nowpayments"
	Manual      Kind = "manual"

	BinaryBlockPV = int64(500)
	// The owner explicitly approved the 97%/99% consumed-PV weighted rule.
	// Policy approval is not payment evidence, identity authorization or a
	// permission to activate/post without the operational transaction's guards.
	BinaryPolicyVersion         = "source_fifo_pv_weighted_v1"
	BinaryPreviewPolicy         = BinaryPolicyVersion
	BinaryApprovedForActivation = true
	maxPreviewLots              = 10000
	maxPreviewBlocks            = int64(10000)
)

var (
	ErrInvalidSource     = errors.New("invalid membership source")
	ErrSourceCost        = errors.New("membership source cost mismatch")
	ErrInvalidTime       = errors.New("invalid membership timestamp")
	ErrInvalidPreview    = errors.New("invalid binary preview")
	ErrClaimHistoryDrift = errors.New("binary claimed history changed")

	canonicalID    = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	canonicalMoney = regexp.MustCompile(`^(0|[1-9][0-9]*)(\.[0-9]{1,4})?$`)
	canonicalHash  = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// Input contains reviewed facts, not customer-supplied proof. Currency is USD
// only. A real adapter must independently verify provider evidence or the
// manual approval, catalog, person, affiliate and immutable activation sequence.
type Input struct {
	ID          string
	Kind        Kind
	Currency    string
	GrossUSD    string
	FeeUSD      string
	NetUSD      string
	PV          int64
	EffectiveAt time.Time
}

// Source is immutable to callers. Its zero value is invalid. In particular,
// setting Kind=Manual can never create NOWPayments evidence or a trusted actor.
type Source struct {
	id                string
	kind              Kind
	gross, fee, net   decimal.Decimal
	pv                int64
	effectiveAt       time.Time
	factorBasisPoints int64
	valid             bool
}

func NewSource(in Input) (Source, error) {
	if !canonicalID.MatchString(in.ID) || in.Currency != "usd" || in.PV <= 0 || !validTime(in.EffectiveAt) {
		return Source{}, ErrInvalidSource
	}
	var feeBPS int64
	switch in.Kind {
	case NOWPayments:
		feeBPS = 100
	case Manual:
		feeBPS = 300
	default:
		return Source{}, ErrInvalidSource
	}
	gross, err := money(in.GrossUSD, 2)
	if err != nil || !gross.IsPositive() {
		return Source{}, ErrInvalidSource
	}
	fee, err := money(in.FeeUSD, 4)
	if err != nil {
		return Source{}, ErrInvalidSource
	}
	net, err := money(in.NetUSD, 4)
	if err != nil || !net.IsPositive() {
		return Source{}, ErrInvalidSource
	}
	// Only this manual catalog amount/PV has been authorized. This constructor
	// must not quietly authorize other manually priced memberships.
	if in.Kind == Manual && (!gross.Equal(decimal.NewFromInt(100)) || in.PV != 100) {
		return Source{}, ErrInvalidSource
	}
	// No guessed rounding or provider-cost fallback: all three supplied values
	// must agree exactly with the reviewed source-specific policy.
	expectedFee := gross.Mul(decimal.New(feeBPS, -4))
	if !fee.Equal(expectedFee) || !net.Equal(gross.Sub(fee)) {
		return Source{}, ErrSourceCost
	}
	return Source{id: in.ID, kind: in.Kind, gross: gross, fee: fee, net: net, pv: in.PV,
		effectiveAt: in.EffectiveAt.Round(0).UTC(), factorBasisPoints: 10000 - feeBPS, valid: true}, nil
}

func money(value string, places int) (decimal.Decimal, error) {
	if len(value) > 30 || !canonicalMoney.MatchString(value) {
		return decimal.Zero, ErrInvalidSource
	}
	if dot := strings.IndexByte(value, '.'); dot >= 0 && len(value)-dot-1 > places {
		return decimal.Zero, ErrInvalidSource
	}
	return decimal.NewFromString(value)
}

func validTime(at time.Time) bool { return !at.IsZero() && at.Year() >= 1 && at.Year() <= 9998 }

func (s Source) ID() string                       { return s.id }
func (s Source) Kind() Kind                       { return s.kind }
func (s Source) GrossUSD() decimal.Decimal        { return s.gross }
func (s Source) FeeUSD() decimal.Decimal          { return s.fee }
func (s Source) NetUSD() decimal.Decimal          { return s.net }
func (s Source) PV() int64                        { return s.pv }
func (s Source) EffectiveAt() time.Time           { return s.effectiveAt }
func (s Source) ROIPrincipalUSD() decimal.Decimal { return s.gross }
func (s Source) CommissionFactor() decimal.Decimal {
	return decimal.New(s.factorBasisPoints, -4)
}

// Maturity365 is 365 elapsed days, not a calendar year and not a net principal.
func Maturity365(start time.Time) (time.Time, error) {
	if !validTime(start) {
		return time.Time{}, ErrInvalidTime
	}
	return start.Round(0).UTC().Add(365 * 24 * time.Hour), nil
}

// CommissionAvailableAt clamps month ends like PostgreSQL's calendar interval
// in America/Bogota. Go's AddDate alone normalizes January 31 into March.
// created is the obligation's creation time, not a backdated payment timestamp.
func CommissionAvailableAt(created time.Time) (time.Time, error) {
	if !validTime(created) {
		return time.Time{}, ErrInvalidTime
	}
	loc, err := time.LoadLocation("America/Bogota")
	if err != nil {
		return time.Time{}, ErrInvalidTime
	}
	local := created.In(loc)
	year, month, day := local.Date()
	next := time.Date(year, month+1, 1, 0, 0, 0, 0, loc)
	last := time.Date(next.Year(), next.Month()+1, 0, 0, 0, 0, 0, loc).Day()
	if day > last {
		day = last
	}
	return time.Date(next.Year(), next.Month(), day, local.Hour(), local.Minute(), local.Second(), local.Nanosecond(), loc).UTC(), nil
}

// Lot is one source's entire catalog PV for ONE ancestor's ONE physical leg.
// Sequence must be the immutable activation order, never an order reconstructed
// from a backdated paid_at. A source cannot appear twice or on both legs.
type Lot struct {
	Source   Source
	Sequence uint64
}

type PreviewRequest struct {
	Left, Right       []Lot
	AsOf              time.Time
	ClaimedBlocks     int64
	ClaimedPrefixHash string
	Founder           bool
}

// Segment is an auditable slice of a source, excluding already claimed PV and
// unpaired carry. Offsets are relative to that source's original catalog PV.
type Segment struct {
	BlockIndex        int64
	Side              string
	SourceID          string
	Kind              Kind
	Sequence          uint64
	OffsetPV, PV      int64
	FactorBasisPoints int64
}

// BlockAllocation retains exact unrounded arithmetic and each consumed lot.
// Index is one-based over lifetime matched blocks, including the claimed skip.
type BlockAllocation struct {
	Index               int64
	NominalUSD          decimal.Decimal
	MeanFactor          decimal.Decimal
	ExactEntitlementUSD decimal.Decimal
	Segments            []Segment
}

type BinaryPreview struct {
	Policy                string
	ApprovedForActivation bool
	MatchedBlocks         int64
	NewBlocks             int64
	CarryLeftPV           int64
	CarryRightPV          int64
	NominalUSD            decimal.Decimal
	ExactEntitlementUSD   decimal.Decimal
	EntitlementUSD        decimal.Decimal
	Segments              []Segment
	Blocks                []BlockAllocation
	NextClaimedPrefixHash string
}

// PreviewBinaryFIFO computes the approved source_fifo_pv_weighted_v1 rule. It
// authorizes no payment or activation by itself, and performs no side effects.
// Each new block consumes exactly 500 PV per side. Its nominal unit is USD10
// (or USD50 for founders), weighted by source factors across both consumed legs.
// It does not apply caps, theta, qualification, retirement routing or posting.
// Existing claimed PV is only skipped; its entitlement is never recomputed.
// Persisted claimed-prefix hashes detect changed costs, FIFO order or sources.
func PreviewBinaryFIFO(in PreviewRequest) (BinaryPreview, error) {
	out := BinaryPreview{Policy: BinaryPreviewPolicy, ApprovedForActivation: BinaryApprovedForActivation,
		Segments: []Segment{}, Blocks: []BlockAllocation{}}
	if !validTime(in.AsOf) || in.ClaimedBlocks < 0 || len(in.Left)+len(in.Right) > maxPreviewLots ||
		(in.ClaimedBlocks == 0 && in.ClaimedPrefixHash != "") ||
		(in.ClaimedBlocks > 0 && !canonicalHash.MatchString(in.ClaimedPrefixHash)) {
		return out, ErrInvalidPreview
	}
	left := append([]Lot(nil), in.Left...)
	right := append([]Lot(nil), in.Right...)
	seenIDs, seenSequences := map[string]bool{}, map[uint64]bool{}
	leftPV, err := validateLots(left, in.AsOf, seenIDs, seenSequences)
	if err != nil {
		return out, err
	}
	rightPV, err := validateLots(right, in.AsOf, seenIDs, seenSequences)
	if err != nil {
		return out, err
	}
	out.MatchedBlocks = min(leftPV, rightPV) / BinaryBlockPV
	if in.ClaimedBlocks > out.MatchedBlocks {
		return out, ErrClaimHistoryDrift
	}
	claimedPV := in.ClaimedBlocks * BinaryBlockPV
	if in.ClaimedBlocks > 0 && prefixHash(left, right, claimedPV) != in.ClaimedPrefixHash {
		return out, ErrClaimHistoryDrift
	}
	out.NewBlocks = out.MatchedBlocks - in.ClaimedBlocks
	// Bound output allocation independently of hostile/overflow-scale PV. This
	// is a calculation resource limit, not a financial cap or a partial claim.
	if out.NewBlocks > maxPreviewBlocks {
		return out, ErrInvalidPreview
	}
	matchedPV := out.MatchedBlocks * BinaryBlockPV
	out.CarryLeftPV, out.CarryRightPV = leftPV-matchedPV, rightPV-matchedPV
	if matchedPV > 0 {
		out.NextClaimedPrefixHash = prefixHash(left, right, matchedPV)
	}
	if out.NewBlocks == 0 {
		return out, nil
	}
	unit := decimal.NewFromInt(10)
	if in.Founder {
		unit = decimal.NewFromInt(50)
	}
	out.NominalUSD = unit.Mul(decimal.NewFromInt(out.NewBlocks))
	leftAllocations := blockSegments(left, "L", claimedPV, in.ClaimedBlocks, out.NewBlocks)
	rightAllocations := blockSegments(right, "R", claimedPV, in.ClaimedBlocks, out.NewBlocks)
	for i := int64(0); i < out.NewBlocks; i++ {
		allocation := BlockAllocation{Index: in.ClaimedBlocks + i + 1, NominalUSD: unit,
			Segments: append(leftAllocations[i], rightAllocations[i]...)}
		weighted := decimal.Zero
		for _, segment := range allocation.Segments {
			weighted = weighted.Add(decimal.NewFromInt(segment.PV).Mul(decimal.New(segment.FactorBasisPoints, -4)))
		}
		// Denominator: exactly two 500-PV legs. Finite decimal factors avoid
		// float error and dependency on global mutable division precision.
		allocation.MeanFactor = weighted.Mul(decimal.RequireFromString("0.001"))
		allocation.ExactEntitlementUSD = unit.Mul(allocation.MeanFactor)
		out.ExactEntitlementUSD = out.ExactEntitlementUSD.Add(allocation.ExactEntitlementUSD)
		out.Segments = append(out.Segments, allocation.Segments...)
		out.Blocks = append(out.Blocks, allocation)
	}
	// Round the sum of raw block amounts, never each block separately.
	out.EntitlementUSD = out.ExactEntitlementUSD.RoundDown(2)
	return out, nil
}

func blockSegments(lots []Lot, side string, skip, claimed, count int64) [][]Segment {
	result := make([][]Segment, int(count))
	index, offset := 0, int64(0)
	for skip > 0 {
		available := lots[index].Source.pv
		if skip < available {
			offset = skip
			break
		}
		skip -= available
		index++
	}
	for block := int64(0); block < count; block++ {
		remaining := BinaryBlockPV
		for remaining > 0 {
			lot := lots[index]
			s := lot.Source
			consumed := min(s.pv-offset, remaining)
			result[block] = append(result[block], Segment{BlockIndex: claimed + block + 1,
				Side: side, SourceID: s.id, Kind: s.kind, Sequence: lot.Sequence,
				OffsetPV: offset, PV: consumed, FactorBasisPoints: s.factorBasisPoints})
			offset += consumed
			remaining -= consumed
			if offset == s.pv {
				index++
				offset = 0
			}
		}
	}
	return result
}

func validateLots(lots []Lot, asOf time.Time, seenIDs map[string]bool, seenSequences map[uint64]bool) (int64, error) {
	var total int64
	for _, lot := range lots {
		s := lot.Source
		if !s.valid || s.effectiveAt.After(asOf) || lot.Sequence == 0 || seenIDs[s.id] || seenSequences[lot.Sequence] || s.pv > math.MaxInt64-total {
			return 0, ErrInvalidPreview
		}
		seenIDs[s.id], seenSequences[lot.Sequence] = true, true
		total += s.pv
	}
	sort.Slice(lots, func(i, j int) bool { return lots[i].Sequence < lots[j].Sequence })
	return total, nil
}

func segments(lots []Lot, side string, start, end int64) []Segment {
	var result []Segment
	var position int64
	for _, lot := range lots {
		next := position + lot.Source.pv
		from, to := max(start, position), min(end, next)
		if to > from {
			s := lot.Source
			result = append(result, Segment{Side: side, SourceID: s.id, Kind: s.kind, Sequence: lot.Sequence,
				OffsetPV: from - position, PV: to - from, FactorBasisPoints: s.factorBasisPoints})
		}
		position = next
		if position >= end {
			break
		}
	}
	return result
}

func prefixHash(left, right []Lot, pv int64) string {
	// Canonical source IDs, fixed kind values and decimal forms cannot inject
	// delimiters. Include partial source offsets so carry can safely grow.
	var data strings.Builder
	data.WriteString(BinaryPreviewPolicy + "\n" + strconv.FormatInt(pv, 10) + "\n")
	for _, side := range []struct {
		name string
		lots []Lot
	}{{"L", left}, {"R", right}} {
		sources := make(map[string]Source, len(side.lots))
		for _, lot := range side.lots {
			sources[lot.Source.id] = lot.Source
		}
		for _, segment := range segments(side.lots, side.name, 0, pv) {
			s := sources[segment.SourceID]
			fmt.Fprintf(&data, "%s|%s|%s|%d|%d|%d|%d|%s|%s|%s|%d|%s\n", segment.Side, segment.SourceID, segment.Kind,
				segment.Sequence, segment.OffsetPV, segment.PV, segment.FactorBasisPoints,
				s.gross.StringFixed(2), s.fee.StringFixed(4), s.net.StringFixed(4), s.pv, s.effectiveAt.Format(time.RFC3339Nano))
		}
	}
	sum := sha256.Sum256([]byte(data.String()))
	return hex.EncodeToString(sum[:])
}
