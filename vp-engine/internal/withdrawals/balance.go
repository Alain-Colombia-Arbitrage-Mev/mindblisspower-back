// Package withdrawals implementa el flujo de retiros: solicitud, verificación
// BMP, fee y pago admin. Vive en su propio servicio (cmd/vp-withdrawals) pero
// comparte la base RDS con vp-payments, de modo que el débito contable y el
// cambio de estado siguen ocurriendo en UNA sola transacción.
package withdrawals

// AvailableBalanceSQL calcula el saldo RETIRABLE de una wallet.
//
// Fuente única de verdad: antes esta consulta estaba duplicada literalmente en
// payments/withdrawals.go, payments/member.go y payments/finance.go.
//
// Reglas:
//   - solo movimientos madurados (available_at NULL o <= hoy) y no congelados
//   - se EXCLUYEN los conceptos de compra/fee (package_purchase, platform_fee,
//     inter_platform): son asientos del capital del comprador, no ganancias
//   - el scope por wallet_id excluye la wallet USD-RET de jubilación (401k)
//
// Parámetro $1 = wallet_id. Devuelve texto para parseo exacto con decimal.
const AvailableBalanceSQL = `
	SELECT COALESCE(SUM(wm.amount) FILTER (
	         WHERE NOT wm.is_frozen AND (wm.available_at IS NULL OR wm.available_at <= current_date)
	       ), 0)::text
	  FROM mlm.wallet_movement wm
	  JOIN mlm.concept c ON c.id = wm.concept_id
	 WHERE wm.wallet_id = $1
	   AND c.kind NOT IN ('package_purchase','platform_fee','inter_platform')`

// PendingWithdrawalsSQL suma los retiros ya solicitados o aprobados y aún no
// pagados, que reservan saldo. Parámetro $1 = affiliate_id.
const PendingWithdrawalsSQL = `
	SELECT COALESCE(SUM(amount_usd), 0)::text
	  FROM mlm.withdrawal_request
	 WHERE affiliate_id = $1 AND status IN ('requested','approved')`
