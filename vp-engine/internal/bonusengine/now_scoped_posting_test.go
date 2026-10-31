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
		result := nowROIAvailableDate(maturity)
		date, err := time.ParseInLocation("2006-01-02", result, loc)
		if err != nil {
			t.Fatal(err)
		}
		if date.Before(maturity) {
			t.Fatal("ROI unlocked before exactly 365 days", hour, date, maturity)
		}
		if hour == 0 && !date.Equal(maturity) {
			t.Fatal("midnight maturity was shifted unnecessarily", date, maturity)
		}
	}
}
