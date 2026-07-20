package withdrawals

import "github.com/shopspring/decimal"

// DefaultFeePct es la comisión de retiro vigente: 4% del BRUTO.
//
// El valor efectivo se PERSISTE por retiro en mlm.withdrawal_request.fee_pct al
// momento de solicitar, y el pago usa esa columna — no esta constante. Cambiar
// la política no reescribe retiros ya solicitados: cada uno conserva el
// porcentaje que se le prometió al afiliado cuando pidió el dinero.
var DefaultFeePct = decimal.RequireFromString("0.04")

// usdScale son los decimales de un monto en USD: mlm.withdrawal_request.amount_usd
// es numeric(14,2).
const usdScale = 2

// QuantizeUSD lleva un monto a los 2 decimales de un USD, TRUNCANDO hacia cero
// (no redondeando).
//
// Por qué truncar y no redondear
// ------------------------------
// mlm.wallet_movement.amount es numeric(20,8), así que el saldo disponible SÍ
// puede tener sub-centavos reales. amount_usd, en cambio, es numeric(14,2): lo
// que se inserte lo redondea Postgres. Si validáramos el monto crudo y
// dejáramos que la base lo redondeara, el valor validado y el valor almacenado
// podrían diferir:
//
//   - disponible 100.0049, se pide "100.0049" → pasa la validación → se guarda
//     100.00 (la conciliación ve $0.0049 menos de lo que se aprobó);
//   - disponible 100.00, se pide "100.009" → con redondeo se guardaría 100.01,
//     medio centavo MÁS de lo que el afiliado tenía.
//
// Truncar elimina las dos: el monto cuantizado es siempre ≤ el pedido, así que
// nunca puede exceder un disponible que ya se validó, y es exactamente el valor
// que Postgres almacenará. La diferencia (<$0.01) se queda en la wallet del
// afiliado y puede retirarse después; redondear hacia arriba, en cambio, le
// regalaría dinero que no tiene, y esa es la dirección que no se puede tolerar
// en un asiento contable.
//
// El monto cuantizado es el ÚNICO que se usa aguas abajo: mínimo, validación de
// saldo, fee, neto e inserción. Así SUM(amount_usd) cuadra contra
// SUM(wallet_movement.amount) del concepto 1013 en las conciliaciones.
func QuantizeUSD(amount decimal.Decimal) decimal.Decimal {
	return amount.Truncate(usdScale)
}

// CalcFee reparte un monto BRUTO entre comisión y neto a recibir.
//
//	fee = round(gross * pct, 2)
//	net = gross - fee
//
// El neto se deriva por RESTA (nunca se calcula aparte como gross*(1-pct)) para
// que fee+net == gross siempre, exacto, sin deriva de centavos por doble
// redondeo. El neto absorbe el redondeo del fee.
//
// gross debe venir ya cuantizado (ver QuantizeUSD); con eso fee y net caen
// naturalmente en 2 decimales.
func CalcFee(gross, pct decimal.Decimal) (fee, net decimal.Decimal) {
	fee = gross.Mul(pct).Round(usdScale)
	net = gross.Sub(fee)
	return fee, net
}
