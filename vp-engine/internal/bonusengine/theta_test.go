package bonusengine

import (
	"testing"

	"github.com/shopspring/decimal"
)

func d(s string) decimal.Decimal {
	v, err := decimal.NewFromString(s)
	if err != nil {
		panic(err)
	}
	return v
}

func TestComputeTheta_NoProjected_ReturnsOne(t *testing.T) {
	got := ComputeTheta(d("0.45"), d("1000"), decimal.Zero)
	if !got.Equal(decimal.NewFromInt(1)) {
		t.Fatalf("expected 1, got %s", got)
	}
}

func TestComputeTheta_UnderBudget_CapsAtOne(t *testing.T) {
	// alpha*inflows = 0.45*1000 = 450 ; projected = 100 → ratio 4.5 → clamp 1
	got := ComputeTheta(d("0.45"), d("1000"), d("100"))
	if !got.Equal(decimal.NewFromInt(1)) {
		t.Fatalf("expected 1 (clamped), got %s", got)
	}
}

func TestComputeTheta_OverBudget_Throttles(t *testing.T) {
	// alpha*inflows = 0.45*1000 = 450 ; projected = 900 → 0.5
	got := ComputeTheta(d("0.45"), d("1000"), d("900"))
	want := d("0.500000")
	if !got.Equal(want) {
		t.Fatalf("expected %s, got %s", want, got)
	}
}

func TestComputeTheta_RoundsDownTo6Decimals(t *testing.T) {
	// 1/3 = 0.333333333... → debe truncar (no redondear hacia arriba) a evitar
	// pagar más de lo habilitado por T1.
	got := ComputeTheta(d("1"), d("1"), d("3"))
	want := d("0.333333")
	if !got.Equal(want) {
		t.Fatalf("expected %s, got %s", want, got)
	}
}

func TestComputeTheta_NegativeInflows_FloorsAtZero(t *testing.T) {
	// inflows negativos no deberían existir en la práctica pero protegemos.
	got := ComputeTheta(d("0.45"), d("-100"), d("100"))
	if !got.Equal(decimal.Zero) {
		t.Fatalf("expected 0, got %s", got)
	}
}
