package withdrawals

import (
	"context"
	"errors"
	"testing"

	"github.com/shopspring/decimal"
)

// TestWithdrawal_ExcludesRetirementWallet_Integration es el test de regresión para
// el bug crítico C1 (follow-up): las queries de saldo disponible contaban los
// movimientos de la wallet USD-RET (jubilación 401k) como fondos retirables.
//
// Setup: un miembro con wallet USD ($150 bono madurado, concept 11) Y wallet USD-RET
// ($150 contribución 401k, concept 1007, available_at=NULL → caso sin cumpleaños).
//
// Expectativa post-fix:
//   - RequestWithdrawal($200) → ErrInsufficient  (solo $150 disponibles en USD)
//   - GetMemberSummary.CommissionAvailable == 150  (no 300)
//   - GetMemberSummary.AvailableForWithdrawal == "150.00"
//   - RequestWithdrawal($150) → OK
//
// Sin el fix (queries asset-unawares) los checks de ErrInsufficient pasarían
// porque el total contado sería $300 — regresión detectada.
func TestWithdrawal_ExcludesRetirementWallet_Integration(t *testing.T) {
	if testing.Short() {
		t.Skip("requires docker / testcontainers")
	}
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	// ── Catálogos base ──────────────────────────────────────────────────────────
	// El harness (testhelpers_test.go) aplica schema_payouts_v1.3.sql que ya inserta
	// concept 1007 (kind='retirement', factor=-1). Simulamos migración 37:
	//   • Insertar asset USD-RET (id=2)
	//   • Voltear concept 1007 factor -1 → +1
	// USD asset (id=1) y concept 11 (binary_bonus) los insertamos aquí igual que
	// TestRequestWithdrawal_Integration (no están en los schemas aplicados).
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.country (id, iso2, name_es, name_en)
		  VALUES (1,'CO','Colombia','Colombia');
		INSERT INTO mlm.asset (id, symbol, name, is_fiat, decimals)
		  VALUES (1,'USD','US Dollar',true,2);
		INSERT INTO mlm.asset (id, symbol, name, is_fiat, decimals)
		  VALUES (2,'USD-RET','Retirement USD',true,2)
		  ON CONFLICT (id) DO NOTHING;
		INSERT INTO mlm.concept (id, kind, name_es, name_en, factor, requires_pair, active)
		  VALUES (11,'binary_bonus','Bono binario','Binary bonus',1,false,true);
		UPDATE mlm.concept SET factor = 1 WHERE id = 1007;
	`); err != nil {
		t.Fatalf("seed catalogs: %v", err)
	}

	// ── Persona + afiliado ──────────────────────────────────────────────────────
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE
		  VALUES (1,'Ret','Member','ret_scope@test.local','0','active');
	`); err != nil {
		t.Fatalf("seed person: %v", err)
	}
	var affID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.affiliate (person_id, parent_id, position, status, path, depth)
		VALUES (1, NULL, NULL, 'active', ''::ltree, 0) RETURNING id`,
	).Scan(&affID); err != nil {
		t.Fatalf("seed affiliate: %v", err)
	}

	// ── Wallets: USD (asset 1) y USD-RET (asset 2) ──────────────────────────────
	var usdWalletID, retWalletID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.wallet (affiliate_id, asset_id, address, balance)
		VALUES ($1, 1, 'usd-scope-test', 0) RETURNING id`, affID,
	).Scan(&usdWalletID); err != nil {
		t.Fatalf("seed USD wallet: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.wallet (affiliate_id, asset_id, address, balance)
		VALUES ($1, 2, 'usdret-scope-test', 0) RETURNING id`, affID,
	).Scan(&retWalletID); err != nil {
		t.Fatalf("seed USD-RET wallet: %v", err)
	}

	// ── Transacción de cabecera para los movimientos ────────────────────────────
	var txnID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.transaction (external_ref, description, status, initiated_by_person_id)
		VALUES ('seed:ret-scope','regression C1','posted',1) RETURNING id`,
	).Scan(&txnID); err != nil {
		t.Fatalf("seed transaction: %v", err)
	}

	// ── Movimientos ─────────────────────────────────────────────────────────────
	// +$150 en wallet USD (concept 11, bono madurado ayer).
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.wallet_movement
		  (transaction_id, wallet_id, affiliate_id, concept_id, amount, posted_at, available_at)
		VALUES ($1, $2, $3, 11, 150, now(), current_date - 1)`,
		txnID, usdWalletID, affID,
	); err != nil {
		t.Fatalf("seed USD movement: %v", err)
	}
	// +$150 en wallet USD-RET (concept 1007, available_at=NULL — sin cumpleaños).
	// Este es el dinero de jubilación que NO debe ser retirable.
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.wallet_movement
		  (transaction_id, wallet_id, affiliate_id, concept_id, amount, posted_at, available_at)
		VALUES ($1, $2, $3, 1007, 150, now(), NULL)`,
		txnID, retWalletID, affID,
	); err != nil {
		t.Fatalf("seed USD-RET movement: %v", err)
	}

	store := NewStore(pool)
	const email = "ret_scope@test.local"
	const bank = "Banco Regresión, cuenta 999"

	// ── Assert 1: RequestWithdrawal($200) debe ser ErrInsufficient ───────────────
	// Solo hay $150 en la wallet USD; el dinero 401k NO es retirable.
	// Sin el fix, el total contado sería $300 → $200 pasaría (falso positivo).
	if _, err := store.RequestWithdrawal(ctx, email, "200", bank); !errors.Is(err, ErrInsufficient) {
		t.Errorf("RequestWithdrawal($200): got %v, want ErrInsufficient — el saldo 401k está siendo contado como retirable", err)
	}

	// ── Assert 2: el saldo disponible excluye el wallet USD-RET ─────────────────
	// GetMemberSummary vive en internal/payments y NO se migra a
	// internal/withdrawals; verificamos el mismo invariante consultando
	// AvailableBalanceSQL (balance.go) directamente contra la wallet USD
	// (usdWalletID) — misma query que respaldaba CommissionAvailable, scoped por
	// wallet para excluir la wallet USD-RET de jubilación. AvailableForWithdrawal
	// se replica vía queryAvailableForWithdrawal (definido en
	// store_integration_test.go, mismo paquete): AvailableBalanceSQL menos
	// retiros pendientes (ninguno aún en este punto del test).
	// wallet_movement.amount es numeric(20,8) → ::text da "150.00000000".
	// Comparamos numéricamente con decimal para evitar fragilidad de formato.
	var availStr string
	if err := pool.QueryRow(ctx, AvailableBalanceSQL, usdWalletID).Scan(&availStr); err != nil {
		t.Fatalf("available: %v", err)
	}
	gotAvail, _ := decimal.NewFromString(availStr)
	if !gotAvail.Equal(decimal.NewFromInt(150)) {
		t.Errorf("CommissionAvailable = %s, want 150 — el saldo 401k (USD-RET) NO debe sumarse a comisiones retirables", availStr)
	}
	if got := queryAvailableForWithdrawal(t, ctx, pool, usdWalletID, affID); got != "150.00" {
		t.Errorf("AvailableForWithdrawal = %s, want 150.00", got)
	}

	// ── Assert 3: RequestWithdrawal($300) → ErrInsufficient ─────────────────────
	if _, err := store.RequestWithdrawal(ctx, email, "300", bank); !errors.Is(err, ErrInsufficient) {
		t.Errorf("RequestWithdrawal($300): got %v, want ErrInsufficient", err)
	}

	// ── Assert 4: RequestWithdrawal exactamente el saldo disponible $150 → OK ───
	res, err := store.RequestWithdrawal(ctx, email, "150", bank)
	if err != nil || res.Status != "requested" || res.ID == 0 {
		t.Errorf("RequestWithdrawal($150 exact): res=%+v err=%v — debería aceptarse exactamente el saldo USD disponible", res, err)
	}
}

// TestWithdrawal_ExcludesPackagePurchaseCapital_Integration es el test de
// regresión para el bug crítico F401: la query de saldo disponible en
// RequestWithdrawal sumaba movimientos de kind='package_purchase' (concepto 1004)
// como si fueran fondos retirables del miembro.
//
// Setup: un miembro cuya wallet USD tiene:
//   - +$500 concept 1004 (package_purchase, available_at=NULL, not frozen)
//     → capital del comprador; NO es ganancia retirable.
//   - +$50  concept 11  (binary_bonus, available_at=NULL, not frozen)
//     → bono ganado; SÍ es retirable.
//
// Expectativa post-fix (kind filter activo):
//   - avail interna = $50 (sólo el bono)
//   - RequestWithdrawal($100) → ErrInsufficient  ($100 > $50 disponibles)
//
// Sin el fix (sin kind filter), avail = $550 → RequestWithdrawal($100) devolvería
// nil (falso positivo: autoriza retirar capital propio).
//
// FALLA contra la query sin filtro; PASA con el filtro de kind.
func TestWithdrawal_ExcludesPackagePurchaseCapital_Integration(t *testing.T) {
	if testing.Short() {
		t.Skip("requires docker / testcontainers")
	}
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	// ── Catálogos base ──────────────────────────────────────────────────────────
	// schema_payouts_v1.2.sql ya inserta concept 1004 (kind='package_purchase').
	// Insertamos concept 11 (binary_bonus) para el crédito de bono.
	// Asset USD (id=1) y country (id=1) también son necesarios.
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.country (id, iso2, name_es, name_en)
		  VALUES (1,'CO','Colombia','Colombia')
		  ON CONFLICT (id) DO NOTHING;
		INSERT INTO mlm.asset (id, symbol, name, is_fiat, decimals)
		  VALUES (1,'USD','US Dollar',true,2)
		  ON CONFLICT (id) DO NOTHING;
		INSERT INTO mlm.concept (id, kind, name_es, name_en, factor, requires_pair, active)
		  VALUES (11,'binary_bonus','Bono binario','Binary bonus',1,false,true)
		  ON CONFLICT (id) DO NOTHING;
	`); err != nil {
		t.Fatalf("seed catalogs: %v", err)
	}

	// ── Persona + afiliado ──────────────────────────────────────────────────────
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE
		  VALUES (2,'Pkg','Buyer','pkg_capital_scope@test.local','0','active');
	`); err != nil {
		t.Fatalf("seed person: %v", err)
	}
	var affID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.affiliate (person_id, parent_id, position, status, path, depth)
		VALUES (2, NULL, NULL, 'active', ''::ltree, 0) RETURNING id`,
	).Scan(&affID); err != nil {
		t.Fatalf("seed affiliate: %v", err)
	}

	// ── Wallet USD ──────────────────────────────────────────────────────────────
	var usdWalletID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.wallet (affiliate_id, asset_id, address, balance)
		VALUES ($1, 1, 'pkg-capital-test', 0) RETURNING id`, affID,
	).Scan(&usdWalletID); err != nil {
		t.Fatalf("seed USD wallet: %v", err)
	}

	// ── Transacción de cabecera ─────────────────────────────────────────────────
	var txnID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.transaction (external_ref, description, status, initiated_by_person_id)
		VALUES ('seed:pkg-capital','regression F401','posted',2) RETURNING id`,
	).Scan(&txnID); err != nil {
		t.Fatalf("seed transaction: %v", err)
	}

	// ── Movimientos ─────────────────────────────────────────────────────────────
	// +$500 concept 1004 (package_purchase) — capital del comprador, NOT retirable.
	// available_at=NULL: sin el fix se trataría como "madurado" → contado en avail.
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.wallet_movement
		  (transaction_id, wallet_id, affiliate_id, concept_id, amount, posted_at, available_at)
		VALUES ($1, $2, $3, 1004, 500, now(), NULL)`,
		txnID, usdWalletID, affID,
	); err != nil {
		t.Fatalf("seed package_purchase movement: %v", err)
	}
	// +$50 concept 11 (binary_bonus) — bono ganado, SÍ retirable (pero bajo mínimo $100).
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.wallet_movement
		  (transaction_id, wallet_id, affiliate_id, concept_id, amount, posted_at, available_at)
		VALUES ($1, $2, $3, 11, 50, now(), NULL)`,
		txnID, usdWalletID, affID,
	); err != nil {
		t.Fatalf("seed bonus movement: %v", err)
	}

	store := NewStore(pool)
	const email = "pkg_capital_scope@test.local"
	const bank = "Banco Regresión F401, cuenta 001"

	// ── Assert principal: RequestWithdrawal($100) debe ser ErrInsufficient ───────
	// avail post-fix = $50 (sólo bono); $100 > $50 → ErrInsufficient.
	// avail pre-fix  = $550 ($500 capital + $50 bono); $100 <= $550 → nil (BUG).
	_, gotErr := store.RequestWithdrawal(ctx, email, "100", bank)
	if !errors.Is(gotErr, ErrInsufficient) {
		t.Errorf("RequestWithdrawal($100): got %v, want ErrInsufficient — "+
			"el capital package_purchase ($500) está siendo contado como retirable; "+
			"avail debería ser $50 (sólo bono), no $550", gotErr)
	}

	// ── Assert auxiliar: balance retirable reportado = $50, no $550 ──────────────
	// GetMemberSummary no se migra a internal/withdrawals; verificamos el mismo
	// invariante (CommissionAvailable) vía AvailableBalanceSQL directo contra
	// usdWalletID, igual que el Assert 2 de arriba.
	var availStr string
	if err := pool.QueryRow(ctx, AvailableBalanceSQL, usdWalletID).Scan(&availStr); err != nil {
		t.Fatalf("available: %v", err)
	}
	gotAvail, _ := decimal.NewFromString(availStr)
	if !gotAvail.Equal(decimal.NewFromInt(50)) {
		t.Errorf("CommissionAvailable = %s, want 50 — "+
			"package_purchase capital NO debe aparecer en saldo retirable", availStr)
	}
}
