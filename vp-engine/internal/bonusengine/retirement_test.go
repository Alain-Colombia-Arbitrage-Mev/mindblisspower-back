package bonusengine

import (
	"testing"
)

func TestRouteSplit(t *testing.T) {
	cases := []struct{ net, pct, wantRet, wantWd string }{
		{"100.00", "0", "0", "100.00"},         // moderado
		{"100.00", "1", "100.00", "0"},         // agresivo 100%
		{"33.33", "1", "33.33", "0"},
		{"10.01", "0.5", "5.00", "5.01"},       // redondeo: el centavo va a retirable
	}
	for _, c := range cases {
		gotRet, gotWd := routeSplit(d(c.net), d(c.pct))
		if !gotRet.Equal(d(c.wantRet)) || !gotWd.Equal(d(c.wantWd)) {
			t.Fatalf("net=%s pct=%s => ret=%s wd=%s (want %s/%s)", c.net, c.pct, gotRet, gotWd, c.wantRet, c.wantWd)
		}
		if !gotRet.Add(gotWd).Equal(d(c.net)) {
			t.Fatalf("invariante rota: %s+%s != %s", gotRet, gotWd, c.net)
		}
	}
}
