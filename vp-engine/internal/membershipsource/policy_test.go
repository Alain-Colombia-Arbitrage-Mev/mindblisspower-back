package membershipsource

import (
	"errors"
	"fmt"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/shopspring/decimal"
)

var effective = time.Date(2026, 11, 5, 17, 0, 0, 0, time.UTC)

func sourceInput(id int, kind Kind) Input {
	fee, net := "1.00", "99.00"
	if kind == Manual {
		fee, net = "3.00", "97.00"
	}
	return Input{ID: fmt.Sprintf("00000000-0000-4000-8000-%012x", id), Kind: kind, Currency: "usd",
		GrossUSD: "100.00", FeeUSD: fee, NetUSD: net, PV: 100, EffectiveAt: effective}
}

func source(t *testing.T, id int, kind Kind) Source {
	t.Helper()
	s, err := NewSource(sourceInput(id, kind))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func lot(t *testing.T, id int, kind Kind) Lot {
	t.Helper()
	return Lot{Source: source(t, id, kind), Sequence: uint64(id)}
}

func lots(t *testing.T, first int, kind Kind, count int) []Lot {
	t.Helper()
	result := make([]Lot, count)
	for i := range result {
		result[i] = lot(t, first+i, kind)
	}
	return result
}

func assertAmount(t *testing.T, got decimal.Decimal, want string) {
	t.Helper()
	if !got.Equal(decimal.RequireFromString(want)) {
		t.Fatalf("amount=%s, want=%s", got, want)
	}
}

func TestSourceMethodSpecificCostKeepsGrossPrincipalAndCatalogPV(t *testing.T) {
	for _, tc := range []struct {
		kind             Kind
		fee, net, factor string
	}{{Manual, "3", "97", ".97"}, {NOWPayments, "1", "99", ".99"}} {
		t.Run(string(tc.kind), func(t *testing.T) {
			s := source(t, 1, tc.kind)
			assertAmount(t, s.GrossUSD(), "100")
			assertAmount(t, s.ROIPrincipalUSD(), "100")
			assertAmount(t, s.FeeUSD(), tc.fee)
			assertAmount(t, s.NetUSD(), tc.net)
			assertAmount(t, s.CommissionFactor(), tc.factor)
			assertAmount(t, s.ROIPrincipalUSD().Mul(decimal.RequireFromString(".25")), "25")
			assertAmount(t, s.NetUSD().Mul(decimal.RequireFromString(".05")), map[Kind]string{Manual: "4.85", NOWPayments: "4.95"}[tc.kind])
			if s.PV() != 100 || s.ID() == "" || s.Kind() != tc.kind || !s.EffectiveAt().Equal(effective) {
				t.Fatal("source facts changed")
			}
		})
	}
}

func TestNOWFractionalCentCostsRemainExactNotRoundedToCents(t *testing.T) {
	in := sourceInput(1, NOWPayments)
	in.GrossUSD, in.FeeUSD, in.NetUSD = "123.45", "1.2345", "122.2155"
	s, err := NewSource(in)
	if err != nil {
		t.Fatal(err)
	}
	assertAmount(t, s.GrossUSD(), "123.45")
	assertAmount(t, s.FeeUSD(), "1.2345")
	assertAmount(t, s.NetUSD(), "122.2155")
	assertAmount(t, s.CommissionFactor(), ".99")
	in.FeeUSD, in.NetUSD = "1.23", "122.22"
	if _, err := NewSource(in); !errors.Is(err, ErrSourceCost) {
		t.Fatal("rounded source cost was accepted")
	}
	in.FeeUSD, in.NetUSD = "1.23450", "122.21550"
	if _, err := NewSource(in); err == nil {
		t.Fatal("unbounded source precision accepted")
	}
}

func TestSourceRejectsInvalidIDsAmountsMethodDatesAndUnapprovedManualCatalog(t *testing.T) {
	changes := []func(*Input){
		func(in *Input) { in.ID = "not-an-id" },
		func(in *Input) { in.ID = "00000000-0000-0000-0000-000000000000" },
		func(in *Input) { in.ID = "00000000-0000-4000-8000-00000000000A" },
		func(in *Input) { in.Kind = "stripe" },
		func(in *Input) { in.Kind = "MANUAL" },
		func(in *Input) { in.Currency = "USD" },
		func(in *Input) { in.Currency = "eur" },
		func(in *Input) { in.GrossUSD = "0" },
		func(in *Input) { in.GrossUSD = "-100" },
		func(in *Input) { in.GrossUSD = "+100" },
		func(in *Input) { in.GrossUSD = "1e2" },
		func(in *Input) { in.GrossUSD = " 100" },
		func(in *Input) { in.GrossUSD = "100.000" },
		func(in *Input) { in.GrossUSD = "0100" },
		func(in *Input) { in.GrossUSD = "NaN" },
		func(in *Input) { in.GrossUSD = "Infinity" },
		func(in *Input) { in.GrossUSD = strings.Repeat("9", 31) },
		func(in *Input) { in.FeeUSD = "1.00" },
		func(in *Input) { in.FeeUSD = "3.001" },
		func(in *Input) { in.NetUSD = "99.00" },
		func(in *Input) { in.NetUSD = "97.001" },
		func(in *Input) { in.PV = 0 },
		func(in *Input) { in.PV = -1 },
		func(in *Input) { in.PV = 99 },
		func(in *Input) { in.GrossUSD, in.FeeUSD, in.NetUSD = "50", "1.5", "48.5" },
		func(in *Input) { in.EffectiveAt = time.Time{} },
		func(in *Input) { in.EffectiveAt = time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC) },
	}
	for i, change := range changes {
		in := sourceInput(1, Manual)
		change(&in)
		if _, err := NewSource(in); err == nil {
			t.Fatalf("invalid case %d accepted", i)
		}
	}
	wrongNOW := sourceInput(1, Manual)
	wrongNOW.Kind = NOWPayments
	if _, err := NewSource(wrongNOW); !errors.Is(err, ErrSourceCost) {
		t.Fatal("NOW must not accept manual source costs")
	}
}

func TestCalendarMonthBogotaClampsAndKeepsCivilTime(t *testing.T) {
	for _, tc := range []struct{ at, want string }{
		{"2026-01-31T16:23:45.123456789-05:00", "2026-02-28T16:23:45.123456789-05:00"},
		{"2024-01-31T16:23:45-05:00", "2024-02-29T16:23:45-05:00"},
		{"2024-02-29T10:00:00-05:00", "2024-03-29T10:00:00-05:00"},
		{"2026-04-30T10:00:00-05:00", "2026-05-30T10:00:00-05:00"},
		{"2026-12-31T23:00:00-05:00", "2027-01-31T23:00:00-05:00"},
		{"2026-02-01T02:00:00Z", "2026-03-01T02:00:00Z"},
	} {
		at, err := time.Parse(time.RFC3339Nano, tc.at)
		if err != nil {
			t.Fatal(err)
		}
		want, err := time.Parse(time.RFC3339Nano, tc.want)
		if err != nil {
			t.Fatal(err)
		}
		got, err := CommissionAvailableAt(at)
		if err != nil || !got.Equal(want) {
			t.Fatalf("%s: got %s / %v, want %s", tc.at, got, err, want)
		}
	}
}

func TestPrincipalMaturityIs365ElapsedDaysNotCalendarYear(t *testing.T) {
	start := time.Date(2024, 1, 31, 21, 23, 45, 123456789, time.UTC)
	got, err := Maturity365(start)
	if err != nil || got.Sub(start) != 365*24*time.Hour || got.Day() != 30 || got.Year() != 2025 {
		t.Fatalf("maturity=%s, err=%v", got, err)
	}
	for _, invalid := range []time.Time{{}, time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)} {
		if _, err := Maturity365(invalid); err == nil {
			t.Fatal("invalid maturity accepted")
		}
		if _, err := CommissionAvailableAt(invalid); err == nil {
			t.Fatal("invalid calendar date accepted")
		}
	}
}

func TestSourceFIFOApprovedVersionPureAndMixedFactors(t *testing.T) {
	for _, tc := range []struct {
		left, right Kind
		founder     bool
		want        string
	}{{NOWPayments, NOWPayments, false, "9.90"}, {Manual, Manual, false, "9.70"},
		{NOWPayments, Manual, false, "9.80"}, {Manual, NOWPayments, false, "9.80"},
		{NOWPayments, Manual, true, "49.00"}, {Manual, Manual, true, "48.50"}} {
		in := PreviewRequest{Left: lots(t, 1, tc.left, 5), Right: lots(t, 11, tc.right, 5), AsOf: effective, Founder: tc.founder}
		got, err := PreviewBinaryFIFO(in)
		if err != nil {
			t.Fatal(err)
		}
		assertAmount(t, got.EntitlementUSD, tc.want)
		if !got.ApprovedForActivation || !BinaryApprovedForActivation || got.Policy != "source_fifo_pv_weighted_v1" || got.NewBlocks != 1 || len(got.Blocks) != 1 {
			t.Fatal("unapproved policy version or changed matching")
		}
		var left, right int64
		for _, segment := range got.Segments {
			if segment.BlockIndex != 1 {
				t.Fatal("missing block provenance")
			}
			if segment.Side == "L" {
				left += segment.PV
			} else if segment.Side == "R" {
				right += segment.PV
			} else {
				t.Fatal("unknown side")
			}
		}
		if left != 500 || right != 500 {
			t.Fatal("block did not consume 500 PV on both sides")
		}
	}
}

func TestPreviewSkipsClaimedPrefixAndUnmatchedCarryWithoutRepricing(t *testing.T) {
	initial := PreviewRequest{Left: lots(t, 1, NOWPayments, 5), Right: lots(t, 11, NOWPayments, 5), AsOf: effective}
	first, err := PreviewBinaryFIFO(initial)
	if err != nil {
		t.Fatal(err)
	}
	assertAmount(t, first.EntitlementUSD, "9.90")
	initial.Left = append(initial.Left, lots(t, 21, Manual, 7)...)
	initial.Right = append(initial.Right, lots(t, 41, Manual, 5)...)
	initial.ClaimedBlocks, initial.ClaimedPrefixHash = 1, first.NextClaimedPrefixHash
	second, err := PreviewBinaryFIFO(initial)
	if err != nil {
		t.Fatal(err)
	}
	assertAmount(t, second.EntitlementUSD, "9.70")
	if second.NewBlocks != 1 || second.CarryLeftPV != 200 || second.CarryRightPV != 0 {
		t.Fatal("carry changed")
	}
	for _, segment := range second.Segments {
		if segment.Kind != Manual {
			t.Fatal("already claimed NOW PV repriced")
		}
	}
	initial.ClaimedBlocks, initial.ClaimedPrefixHash = 2, second.NextClaimedPrefixHash
	replay, err := PreviewBinaryFIFO(initial)
	if err != nil || replay.NewBlocks != 0 || len(replay.Segments) != 0 || !replay.EntitlementUSD.IsZero() {
		t.Fatal("claimed prefix repeated")
	}
	initial.Right = append(initial.Right, lots(t, 61, NOWPayments, 5)...)
	partial, err := PreviewBinaryFIFO(initial)
	if err != nil || partial.NewBlocks != 0 || partial.CarryLeftPV != 200 || partial.CarryRightPV != 500 {
		t.Fatal("unpaired PV became a block")
	}
}

func TestPreviewUsesFIFOSequenceWithoutMutatingInputsOrUsingAllVolumeAverage(t *testing.T) {
	in := PreviewRequest{Left: append(lots(t, 1, NOWPayments, 5), lots(t, 31, Manual, 5)...), Right: lots(t, 11, NOWPayments, 5), AsOf: effective}
	// Shuffle input; sequence, not caller slice order, determines actual FIFO.
	in.Left[0], in.Left[9] = in.Left[9], in.Left[0]
	before := append([]Lot(nil), in.Left...)
	got, err := PreviewBinaryFIFO(in)
	if err != nil {
		t.Fatal(err)
	}
	assertAmount(t, got.EntitlementUSD, "9.90")
	if !reflect.DeepEqual(before, in.Left) || got.CarryLeftPV != 500 {
		t.Fatal("input changed or carry consumed")
	}
	for _, segment := range got.Segments {
		if segment.Kind != NOWPayments {
			t.Fatal("unmatched manual PV diluted the first block")
		}
	}
}

func TestPreviewRejectsDuplicatesFutureOverflowUnknownOrRewrittenClaims(t *testing.T) {
	base := PreviewRequest{Left: lots(t, 1, NOWPayments, 5), Right: lots(t, 11, NOWPayments, 5), AsOf: effective}
	first, err := PreviewBinaryFIFO(base)
	if err != nil {
		t.Fatal(err)
	}
	cases := []func(*PreviewRequest){
		func(in *PreviewRequest) { in.ClaimedBlocks = -1 },
		func(in *PreviewRequest) { in.AsOf = time.Time{} },
		func(in *PreviewRequest) { in.AsOf = effective.Add(-time.Second) },
		func(in *PreviewRequest) { in.Left = append(in.Left, in.Left[0]) },
		func(in *PreviewRequest) { in.Right[0] = in.Left[0] },
		func(in *PreviewRequest) { in.Left[0].Sequence = 0 },
		func(in *PreviewRequest) { in.Left[0].Sequence = in.Left[1].Sequence },
		func(in *PreviewRequest) { in.Left[0].Source = Source{} },
		func(in *PreviewRequest) { in.ClaimedBlocks = 1 },
		func(in *PreviewRequest) { in.ClaimedPrefixHash = first.NextClaimedPrefixHash },
		func(in *PreviewRequest) { in.ClaimedBlocks, in.ClaimedPrefixHash = 2, first.NextClaimedPrefixHash },
		func(in *PreviewRequest) {
			in.ClaimedBlocks, in.ClaimedPrefixHash = 1, first.NextClaimedPrefixHash
			in.Left[0].Source = source(t, 1, Manual)
		},
		func(in *PreviewRequest) {
			in.ClaimedBlocks, in.ClaimedPrefixHash = 1, first.NextClaimedPrefixHash
			in.Left[0], in.Left[1] = Lot{Source: in.Left[0].Source, Sequence: 2}, Lot{Source: in.Left[1].Source, Sequence: 1}
		},
	}
	for i, change := range cases {
		in := base
		in.Left, in.Right = append([]Lot(nil), base.Left...), append([]Lot(nil), base.Right...)
		change(&in)
		if _, err := PreviewBinaryFIFO(in); err == nil {
			t.Fatalf("invalid preview case %d accepted", i)
		}
	}
	large := sourceInput(100, NOWPayments)
	large.PV = math.MaxInt64
	largeSource, err := NewSource(large)
	if err != nil {
		t.Fatal(err)
	}
	base.Left = []Lot{{Source: largeSource, Sequence: 100}, lot(t, 101, NOWPayments)}
	if _, err := PreviewBinaryFIFO(base); !errors.Is(err, ErrInvalidPreview) {
		t.Fatal("PV overflow accepted")
	}
}

func TestPreviewEmptyOrIncompleteVolumeDoesNotInventEntitlements(t *testing.T) {
	for _, in := range []PreviewRequest{
		{AsOf: effective},
		{Left: lots(t, 1, Manual, 5), AsOf: effective},
		{Left: lots(t, 1, Manual, 4), Right: lots(t, 11, NOWPayments, 5), AsOf: effective},
	} {
		got, err := PreviewBinaryFIFO(in)
		if err != nil || got.NewBlocks != 0 || len(got.Segments) != 0 || !got.EntitlementUSD.IsZero() || got.NextClaimedPrefixHash != "" {
			t.Fatal("zero volume invented compensation")
		}
	}
}

func nowWithPV(t *testing.T, id int, pv int64) Lot {
	t.Helper()
	in := sourceInput(id, NOWPayments)
	in.PV = pv
	s, err := NewSource(in)
	if err != nil {
		t.Fatal(err)
	}
	return Lot{Source: s, Sequence: uint64(id)}
}

func TestNewBlockConsumesOnlyPartialSourceAfterClaimedOffset(t *testing.T) {
	in := PreviewRequest{Left: []Lot{nowWithPV(t, 1, 750)}, Right: []Lot{nowWithPV(t, 2, 500)}, AsOf: effective}
	first, err := PreviewBinaryFIFO(in)
	if err != nil {
		t.Fatal(err)
	}
	in.Left = append(in.Left, lots(t, 10, Manual, 3)...)
	in.Right = append(in.Right, lots(t, 20, Manual, 5)...)
	in.ClaimedBlocks, in.ClaimedPrefixHash = 1, first.NextClaimedPrefixHash
	second, err := PreviewBinaryFIFO(in)
	if err != nil {
		t.Fatal(err)
	}
	assertAmount(t, second.EntitlementUSD, "9.75")
	if len(second.Blocks) != 1 || second.Blocks[0].Index != 2 || second.CarryLeftPV != 50 {
		t.Fatal("partial carry or block offset incorrect")
	}
	firstSegment := second.Blocks[0].Segments[0]
	if firstSegment.SourceID != in.Left[0].Source.ID() || firstSegment.OffsetPV != 500 || firstSegment.PV != 250 {
		t.Fatal("previously claimed source slice consumed twice")
	}
}

func TestRoundSumOfRawBlocksNotEachBlock(t *testing.T) {
	in := PreviewRequest{
		Left:  []Lot{nowWithPV(t, 1, 499), lot(t, 2, Manual), nowWithPV(t, 3, 401)},
		Right: []Lot{nowWithPV(t, 10, 1000)}, AsOf: effective,
	}
	got, err := PreviewBinaryFIFO(in)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Blocks) != 2 {
		t.Fatal("expected two auditable blocks")
	}
	assertAmount(t, got.Blocks[0].ExactEntitlementUSD, "9.8998")
	assertAmount(t, got.Blocks[1].ExactEntitlementUSD, "9.8802")
	assertAmount(t, got.ExactEntitlementUSD, "19.78")
	assertAmount(t, got.EntitlementUSD, "19.78")
	perBlockRounded := got.Blocks[0].ExactEntitlementUSD.RoundDown(2).Add(got.Blocks[1].ExactEntitlementUSD.RoundDown(2))
	assertAmount(t, perBlockRounded, "19.77")
}
