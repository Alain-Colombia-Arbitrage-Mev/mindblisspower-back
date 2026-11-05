package bonusengine

import (
	"testing"
	"time"
)

func TestNOWROIAvailableDateNeverPrecedesExact365DayMaturity(t *testing.T) {
	loc, err := time.LoadLocation("America/Bogota")
	if err != nil {
		t.Fatal(err)
	}
	for _, hour := range []int{0, 12, 23} {
		purchase := time.Date(2027, 3, 1, hour, 0, 0, 0, loc)
		maturity := purchase.AddDate(0, 0, 365)
		result := nowAccrualAvailableDate(maturity)
		date, err := time.ParseInLocation("2006-01-02", result, time.UTC)
		if err != nil {
			t.Fatal(err)
		}
		if date.Before(maturity) {
			t.Fatal("ROI unlocked before exactly 365 days", hour, date, maturity)
		}
		if date.Sub(maturity) >= 24*time.Hour {
			t.Fatal("UTC DATE projection extended by a full extra day", date, maturity)
		}
	}
}

func TestNOWCommissionAvailableDateNeverPrecedesExactCalendarMaturity(t *testing.T) {
	for _, tc := range []struct{ name, exact, want string }{
		{"bogota_midnight", "2026-02-28T00:00:00-05:00", "2026-03-01"},
		{"fraction_after_midnight", "2026-02-28T00:00:00.000001-05:00", "2026-03-01"},
		{"midday", "2026-02-28T15:30:12.123456-05:00", "2026-03-01"},
		{"leap_day", "2028-02-29T23:59:59-05:00", "2028-03-02"},
		{"utc_previous_business_day", "2026-03-01T04:30:00Z", "2026-03-02"},
		{"utc_business_midnight", "2026-03-01T05:00:00Z", "2026-03-02"},
		{"utc_midnight", "2026-03-01T00:00:00Z", "2026-03-01"},
		{"after_utc_midnight", "2026-03-01T00:00:00.000001Z", "2026-03-02"},
		{"year_end", "2026-12-31T23:59:59-05:00", "2027-01-02"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			exact, err := time.Parse(time.RFC3339Nano, tc.exact)
			if err != nil {
				t.Fatal(err)
			}
			got := nowAccrualAvailableDate(exact)
			if got != tc.want {
				t.Fatalf("legacy DATE got=%s want=%s", got, tc.want)
			}
			projected, err := time.ParseInLocation("2006-01-02", got, time.UTC)
			if err != nil || projected.Before(exact) || projected.Sub(exact) >= 24*time.Hour {
				t.Fatal("projection unlocks early or extends by a full extra day", projected, exact, err)
			}
		})
	}
}
