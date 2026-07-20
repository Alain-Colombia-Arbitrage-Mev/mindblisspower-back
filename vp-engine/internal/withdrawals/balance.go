// Package withdrawals implementa el flujo de retiros: solicitud, verificación
// BMP, fee y pago admin. Vive en su propio servicio (cmd/vp-withdrawals) pero
// comparte la base RDS con vp-payments, de modo que el débito contable y el
// cambio de estado siguen ocurriendo en UNA sola transacción.
package withdrawals

// resolveUSDWalletBaseSQL es el SELECT + JOIN + WHERE de resolución de wallet
// USD por email (persona → afiliado → wallet JOIN asset symbol='USD'),
// COMPARTIDO entre ResolveUSDWalletSQL (producción, con LIMIT 1) y el test de
// regresión del scope 401k (retirement_wallet_scope_test.go), que reutiliza
// esta misma constante SIN LIMIT para verificar, de forma determinista, que
// ninguna otra wallet del afiliado matchea el filtro. Al construir ambas
// variantes desde el mismo string en vez de re-teclear la query en el test,
// un cambio al JOIN/WHERE no puede quedar sin reflejarse en la verificación.
const resolveUSDWalletBaseSQL = `
	SELECT a.id, w.id
	  FROM mlm.person p
	  JOIN mlm.affiliate a ON a.person_id = p.id
	  JOIN mlm.wallet w    ON w.affiliate_id = a.id
	  JOIN mlm.asset s     ON s.id = w.asset_id AND s.symbol = 'USD'
	 WHERE lower(p.email) = lower($1)`

// ResolveUSDWalletSQL resuelve (affiliate_id, wallet_id) de la wallet USD de
// un afiliado a partir de su email. Único punto de resolución de wallet
// usado por RequestWithdrawal (store.go) — se expone como constante en vez de
// quedar inline para que los tests puedan ejercer la MISMA query que usa
// producción, en lugar de una copia que puede divergir silenciosamente si
// alguien cambia el JOIN aquí y no allá (o viceversa).
//
// El JOIN con mlm.asset filtrando symbol='USD' es lo que EXCLUYE otras
// wallets del afiliado — en particular la wallet USD-RET del plan de
// jubilación (401k, ver retirement_wallet_scope_test.go). Sin ese filtro, la
// wallet resuelta (y por tanto qué saldo se considera retirable vía
// AvailableBalanceSQL) queda a merced del plan que elija Postgres — en la
// práctica, sin ORDER BY, Postgres tiende a devolver la primera fila
// insertada, lo que puede enmascarar el bug bajo un LIMIT 1 (por eso el test
// de regresión verifica también contra resolveUSDWalletBaseSQL sin LIMIT).
//
// Parámetro $1 = email (case-insensitive).
const ResolveUSDWalletSQL = resolveUSDWalletBaseSQL + `
	 LIMIT 1`

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

// ExcludedKindsPredicate es el filtro de conceptos NO retirables, compartido
// por AvailableBalanceSQL y por los agregados financieros de payments/finance.go
// y payments/member.go, que necesitan el MISMO filtro dentro de agregaciones
// distintas (no la consulta completa) — por eso se expone el predicado solo,
// para concatenar, en vez de forzar esos callers a reusar AvailableBalanceSQL
// donde no encaja.
const ExcludedKindsPredicate = `c.kind NOT IN ('package_purchase','platform_fee','inter_platform')`

// PendingWithdrawalsSQL suma los retiros ya solicitados o aprobados y aún no
// pagados, que reservan saldo. Parámetro $1 = affiliate_id.
const PendingWithdrawalsSQL = `
	SELECT COALESCE(SUM(amount_usd), 0)::text
	  FROM mlm.withdrawal_request
	 WHERE affiliate_id = $1 AND status IN ('requested','approved')`
