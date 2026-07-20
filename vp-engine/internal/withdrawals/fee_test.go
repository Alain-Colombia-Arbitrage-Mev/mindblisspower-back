package withdrawals

import (
	"testing"

	"github.com/shopspring/decimal"
)

func TestCalcFee(t *testing.T) {
	for _, tc := range []struct {
		name            string
		gross, fee, net string
	}{
		{"redondo", "1000", "40", "960"},
		{"minimo", "100", "4", "96"},
		{"redondeo_medio", "100.13", "4.01", "96.12"}, // 4.0052 → 4.01
		{"redondeo_abajo", "100.12", "4", "96.12"},    // 4.0048 → 4.00
		{"tres_decimales", "333.33", "13.33", "320"},  // 13.3332 → 13.33
	} {
		t.Run(tc.name, func(t *testing.T) {
			gross := decimal.RequireFromString(tc.gross)
			fee, net := CalcFee(gross, DefaultFeePct)
			if fee.String() != decimal.RequireFromString(tc.fee).String() {
				t.Errorf("fee = %s, want %s", fee, tc.fee)
			}
			if net.String() != decimal.RequireFromString(tc.net).String() {
				t.Errorf("net = %s, want %s", net, tc.net)
			}
			// Invariante: bruto = fee + neto, exacto.
			if !fee.Add(net).Equal(gross) {
				t.Errorf("fee+net = %s, want %s", fee.Add(net), gross)
			}
		})
	}
}

// El fee se redondea a 2 decimales y el neto absorbe la diferencia, de modo que
// la suma nunca pierde ni gana centavos. Batería de montos con centavos
// incómodos: ninguno puede producir un fee de más de 2 decimales ni romper el
// invariante fee+net==gross.
func TestCalcFee_NoCentDrift(t *testing.T) {
	for _, g := range []string{
		"100.01", "100.07", "333.33", "999.99", "12345.67",
		"100.12", "100.13", "0.01", "1000000.01",
	} {
		gross := decimal.RequireFromString(g)
		fee, net := CalcFee(gross, DefaultFeePct)
		if !fee.Add(net).Equal(gross) {
			t.Errorf("gross=%s: fee+net = %s, want %s", g, fee.Add(net), gross)
		}
		if fee.Exponent() < -usdScale {
			t.Errorf("gross=%s: fee %s tiene más de 2 decimales", g, fee)
		}
		// El neto también se paga en USD: nunca puede necesitar sub-centavos.
		if net.Exponent() < -usdScale {
			t.Errorf("gross=%s: net %s tiene más de 2 decimales", g, net)
		}
		// El neto se deriva por resta: mata la mutación net = gross*(1-pct).
		if !net.Equal(gross.Sub(fee)) {
			t.Errorf("gross=%s: net %s != gross-fee %s", g, net, gross.Sub(fee))
		}
	}
}

// El fee del 4% sobre montos con centavos NO es simplemente gross*0.96: cuando
// el fee crudo cae por encima o por debajo del medio centavo, el neto se corre
// respecto de la multiplicación directa. Estos casos fijan el comportamiento.
func TestCalcFee_NetIsNotGrossTimes96(t *testing.T) {
	for _, tc := range []struct{ gross, net string }{
		{"100.13", "96.12"},      // 100.13*0.96 = 96.1248 → NO es el neto
		{"100.07", "96.07"},      // fee 4.0028 → 4.00; 100.07*0.96 = 96.0672
		{"12345.67", "11851.84"}, // fee 493.8268 → 493.83
	} {
		gross := decimal.RequireFromString(tc.gross)
		_, net := CalcFee(gross, DefaultFeePct)
		if net.String() != decimal.RequireFromString(tc.net).String() {
			t.Errorf("gross=%s: net = %s, want %s", tc.gross, net, tc.net)
		}
	}
}

func TestCalcFee_ZeroPct(t *testing.T) {
	fee, net := CalcFee(decimal.RequireFromString("500"), decimal.Zero)
	if !fee.IsZero() {
		t.Errorf("fee = %s, want 0", fee)
	}
	if net.String() != "500" {
		t.Errorf("net = %s, want 500", net)
	}
}

// QuantizeUSD TRUNCA hacia cero: el monto cuantizado nunca es mayor al pedido,
// así que jamás puede exceder un disponible ya validado.
func TestQuantizeUSD_Truncates(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"100", "100"},
		{"100.00", "100"},
		{"100.0049", "100"},   // sub-centavo hacia abajo
		{"100.009", "100"},    // redondear daría 100.01: NO
		{"100.999", "100.99"}, // redondear daría 101.00: NO
		{"99.999", "99.99"},   // no alcanza el mínimo: no se "sube" a 100
		{"12345.6789", "12345.67"},
	} {
		got := QuantizeUSD(decimal.RequireFromString(tc.in))
		if got.String() != decimal.RequireFromString(tc.want).String() {
			t.Errorf("QuantizeUSD(%s) = %s, want %s", tc.in, got, tc.want)
		}
		if got.GreaterThan(decimal.RequireFromString(tc.in)) {
			t.Errorf("QuantizeUSD(%s) = %s: no puede ser MAYOR al pedido", tc.in, got)
		}
		if got.Exponent() < -usdScale {
			t.Errorf("QuantizeUSD(%s) = %s tiene más de 2 decimales", tc.in, got)
		}
	}
}

// Refuerzo del "derivar por resta" en el caso frontera: cuando el fee crudo cae
// EXACTAMENTE en el medio centavo.
//
// Por qué hace falta un test aparte: con pct=0.04 y un bruto de 2 decimales, el
// fee crudo (bruto/2500) nunca cae exacto en .xx5, así que
// round(gross*(1-pct)) da el mismo resultado que gross-round(gross*pct) y una
// mutación "calcular el neto por multiplicación redondeada" pasaría inadvertida.
// Pero fee_pct se CONGELA por retiro y la política puede cambiar: con pct=0.025
// el empate sí ocurre, y ahí las dos fórmulas divergen — la multiplicación
// redondea el neto hacia arriba y la suma se pasa un centavo del bruto.
//
// Este test fija la propiedad para cualquier pct, no sólo para el 4% de hoy.
func TestCalcFee_HalfCentTieDerivesNetBySubtraction(t *testing.T) {
	pct := decimal.RequireFromString("0.025")
	for _, tc := range []struct{ gross, fee, net string }{
		{"0.20", "0.01", "0.19"},        // fee crudo 0.005 exacto
		{"1000.20", "25.01", "975.19"},  // fee crudo 25.005 exacto
		{"2000.20", "50.01", "1950.19"}, // fee crudo 50.005 exacto
	} {
		gross := decimal.RequireFromString(tc.gross)
		fee, net := CalcFee(gross, pct)
		if fee.String() != decimal.RequireFromString(tc.fee).String() {
			t.Errorf("gross=%s: fee = %s, want %s", tc.gross, fee, tc.fee)
		}
		if net.String() != decimal.RequireFromString(tc.net).String() {
			t.Errorf("gross=%s: net = %s, want %s (multiplicar daría un centavo de más)", tc.gross, net, tc.net)
		}
		if !fee.Add(net).Equal(gross) {
			t.Errorf("gross=%s: fee+net = %s, want %s", tc.gross, fee.Add(net), gross)
		}
	}
}
