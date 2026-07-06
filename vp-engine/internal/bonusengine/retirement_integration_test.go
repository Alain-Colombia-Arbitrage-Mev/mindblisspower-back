package bonusengine

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
)

// seedRetirementFixture siembra los catálogos mínimos para el test de ruteo:
// country, asset USD, concept binario (id=11), package, person con birthday,
// afiliado, wallet USD y plan_config (con bypass approval, retirement_age=65).
// Devuelve el affiliateID.
func seedRetirementFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool) (affID int64) {
	t.Helper()

	// Catálogos base (igual que seedV2Tree — fresh container, sin ON CONFLICT).
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.country (id, iso2, name_es, name_en) VALUES (1, 'CO', 'Colombia', 'Colombia');
		INSERT INTO mlm.asset (id, symbol, name, is_fiat, decimals) VALUES (1, 'USD', 'US Dollar', true, 2);
		INSERT INTO mlm.concept (id, kind, name_es, name_en, factor, requires_pair, active) VALUES
		  (11, 'binary_bonus', 'Bono binario', 'Binary bonus', 1, false, true);
		INSERT INTO mlm.package (id, name, amount_usd, pv, type) VALUES
		  (1, 'Pack 1000', 1000, 1000, 'enrollment');
	`); err != nil {
		t.Fatalf("seedRetirementFixture: catalogs: %v", err)
	}

	// Persona raíz (id=1).
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.person (first_name, last_name, email, phone_number, status)
		VALUES ('root', 'ret', 'root_ret@t.local', '0', 'active')`); err != nil {
		t.Fatalf("seedRetirementFixture: root person: %v", err)
	}

	// Persona de test con birthday (id=2).
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.person (first_name, last_name, email, phone_number, status, birthday)
		VALUES ('ret', 'test', 'ret@t.local', '1', 'active', '1980-01-15')`); err != nil {
		t.Fatalf("seedRetirementFixture: person: %v", err)
	}

	// Afiliado raíz (person_id=1).
	var rootAffID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.affiliate (person_id, parent_id, position, status, path, depth)
		VALUES (1, NULL, NULL, 'active', '1', 0) RETURNING id`).Scan(&rootAffID); err != nil {
		t.Fatalf("seedRetirementFixture: root aff: %v", err)
	}

	// Afiliado de test (person_id=2).
	affPath := fmt.Sprintf("1.L_2")
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.affiliate (person_id, parent_id, position, status, path, depth)
		VALUES (2, $1, 'L', 'active', $2::ltree, 1) RETURNING id`, rootAffID, affPath).Scan(&affID); err != nil {
		t.Fatalf("seedRetirementFixture: affiliate: %v", err)
	}

	// Wallet USD.
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.wallet (affiliate_id, asset_id, address, balance)
		VALUES ($1, 1, 'w-ret', 0)`, affID); err != nil {
		t.Fatalf("seedRetirementFixture: wallet: %v", err)
	}

	// plan_config (sin parámetros en el multi-statement para evitar prepared stmt).
	if _, err := pool.Exec(ctx, `
		BEGIN;
		SET LOCAL app.bypass_approval = 'on';
		INSERT INTO mlm.plan_config (
		  version_label, effective_from, block_size, bonus_per_block, depth_cap,
		  daily_cap_factor, lifetime_cap_factor, treasury_alpha, carry_decay_days,
		  qualified_directs_left, qualified_directs_right, created_by_person_id,
		  retirement_age)
		VALUES ('ret-test', now(), 100, 2.00, 10, 3.0, 2.0, 0.45, 14, 0, 0, 1, 65);
		COMMIT;`); err != nil {
		t.Fatalf("seedRetirementFixture: plan_config: %v", err)
	}

	// Equivalente a migración 37: asset USD-RET + concepto 1007 factor=+1.
	// El harness de test aplica los schemas hasta v1.3 (concept 1007 factor=-1,
	// sin asset USD-RET). Hacemos el test auto-suficiente sin depender de que
	// la migración 37 esté en la cadena del harness.
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.asset (id, symbol, name, is_fiat, decimals)
		VALUES (2, 'USD-RET', 'Retirement USD', true, 2)
		ON CONFLICT (id) DO NOTHING;
		UPDATE mlm.concept SET factor = 1 WHERE id = 1007;
	`); err != nil {
		t.Fatalf("seedRetirementFixture: USD-RET asset + concept 1007 factor: %v", err)
	}

	return affID
}

// TestPostStreamPayment_RetirementRouting verifica el ruteo 401k en los tres
// modos del plan de jubilación: agresivo (todo a 1007), moderado (todo
// retirable) y parcial 50/50. Reutiliza el harness de testcontainers del
// paquete (pgContainer) para correr contra Postgres real.
func TestPostStreamPayment_RetirementRouting(t *testing.T) {
	if testing.Short() {
		t.Skip("requires docker / testcontainers")
	}
	ctx := context.Background()
	pool, cleanup := pgContainer(t)
	defer cleanup()

	affID := seedRetirementFixture(t, ctx, pool)
	postedAt := time.Now().UTC()
	const conceptBinaryID = 11 // sembrado en seedRetirementFixture

	d := func(s string) decimal.Decimal { v, _ := decimal.NewFromString(s); return v }

	// sumMov: suma movements por concept_id + affiliate_id (independiente del wallet).
	sumMov := func(tx pgx.Tx, conceptID int, aff int64) decimal.Decimal {
		var v decimal.Decimal
		if err := tx.QueryRow(ctx, `
			SELECT COALESCE(sum(amount), 0)
			  FROM mlm.wallet_movement
			 WHERE concept_id = $1 AND affiliate_id = $2`, conceptID, aff).Scan(&v); err != nil {
			t.Fatalf("sumMov concept=%d aff=%d: %v", conceptID, aff, err)
		}
		return v
	}

	countMov := func(tx pgx.Tx, conceptID int, aff int64) int {
		var n int
		if err := tx.QueryRow(ctx, `
			SELECT count(*)
			  FROM mlm.wallet_movement
			 WHERE concept_id = $1 AND affiliate_id = $2`, conceptID, aff).Scan(&n); err != nil {
			t.Fatalf("countMov concept=%d aff=%d: %v", conceptID, aff, err)
		}
		return n
	}

	// walletMovSum: suma movements de un afiliado en la wallet del asset dado.
	// Sirve para las aserciones C1: USD wallet NO debe verse debitada por 1007;
	// USD-RET wallet sí debe recibir el crédito positivo.
	walletMovSum := func(tx pgx.Tx, assetSymbol string, conceptID int, aff int64) decimal.Decimal {
		var v decimal.Decimal
		if err := tx.QueryRow(ctx, `
			SELECT COALESCE(sum(wm.amount), 0)
			  FROM mlm.wallet_movement wm
			  JOIN mlm.wallet w ON w.id = wm.wallet_id
			  JOIN mlm.asset a ON a.id = w.asset_id
			 WHERE a.symbol = $1 AND wm.concept_id = $2 AND wm.affiliate_id = $3`,
			assetSymbol, conceptID, aff).Scan(&v); err != nil {
			t.Fatalf("walletMovSum symbol=%s concept=%d aff=%d: %v", assetSymbol, conceptID, aff, err)
		}
		return v
	}

	// -------------------------------------------------------------------------
	// Caso 1: modo agresivo — todo al plan (1007), nada retirable.
	// -------------------------------------------------------------------------
	t.Run("agresivo", func(t *testing.T) {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatalf("begin: %v", err)
		}
		defer tx.Rollback(ctx) //nolint:errcheck

		if _, err := tx.Exec(ctx, `
			INSERT INTO mlm.retirement_plan (affiliate_id, mode, opened_at, unlocks_at, balance_usd, updated_at)
			VALUES ($1, 'agresivo', now(), '2045-01-15', 0, now())`, affID); err != nil {
			t.Fatalf("insert retirement_plan: %v", err)
		}

		cache := map[int64]int64{}
		retCache := map[int64]int64{}
		if _, err := postStreamPayment(ctx, tx, conceptBinaryID, "binary_bonus", affID,
			d("100.00"), "testret:agresivo:1", "test agresivo", postedAt, 65, cache, retCache); err != nil {
			t.Fatalf("postStreamPayment: %v", err)
		}

		// C1 fix: concept 1007 es ahora CRÉDITO POSITIVO (+100) en la wallet USD-RET,
		// no débito en la wallet USD. La wallet USD del afiliado no debe tener ningún
		// movimiento de concepto 1007.
		if got := sumMov(tx, retirementContribConceptID, affID); !got.Equal(d("100.00")) {
			t.Errorf("1007 agresivo: want +100 (crédito USD-RET), got %s", got)
		}
		// Aserciones C1: USD wallet limpia de 1007; USD-RET wallet con +100.
		if got := walletMovSum(tx, "USD", retirementContribConceptID, affID); !got.IsZero() {
			t.Errorf("C1 agresivo: USD wallet no debe tener movimiento 1007, got %s", got)
		}
		if got := walletMovSum(tx, "USD-RET", retirementContribConceptID, affID); !got.Equal(d("100.00")) {
			t.Errorf("C1 agresivo: USD-RET wallet debe tener +100, got %s", got)
		}
		// Sin movimiento del concepto retirable (binary, id=11) — toWd=0.
		if n := countMov(tx, conceptBinaryID, affID); n != 0 {
			t.Errorf("agresivo: esperaba 0 mov retiables, hubo %d", n)
		}
		// balance_usd = 100.
		var bal decimal.Decimal
		if err := tx.QueryRow(ctx, `SELECT balance_usd FROM mlm.retirement_plan WHERE affiliate_id=$1`, affID).Scan(&bal); err != nil {
			t.Fatalf("balance: %v", err)
		}
		if !bal.Equal(d("100.00")) {
			t.Errorf("balance agresivo: want 100, got %s", bal)
		}
		// available_at del movimiento 1007 = unlocks_at del plan.
		var avail *time.Time
		if err := tx.QueryRow(ctx, `
			SELECT available_at FROM mlm.wallet_movement
			 WHERE concept_id = $1 AND affiliate_id = $2`,
			retirementContribConceptID, affID).Scan(&avail); err != nil {
			t.Fatalf("available_at: %v", err)
		}
		wantDate := "2045-01-15"
		if avail == nil {
			t.Errorf("available_at agresivo: nil, want %s", wantDate)
		} else if avail.UTC().Format("2006-01-02") != wantDate {
			t.Errorf("available_at agresivo: got %s, want %s", avail.UTC().Format("2006-01-02"), wantDate)
		}
	})

	// -------------------------------------------------------------------------
	// Caso 2: modo moderado — todo retirable (sin routing row → pct=0).
	// -------------------------------------------------------------------------
	t.Run("moderado", func(t *testing.T) {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatalf("begin: %v", err)
		}
		defer tx.Rollback(ctx) //nolint:errcheck

		if _, err := tx.Exec(ctx, `
			INSERT INTO mlm.retirement_plan (affiliate_id, mode, opened_at, unlocks_at, balance_usd, updated_at)
			VALUES ($1, 'moderado', now(), NULL, 0, now())`, affID); err != nil {
			t.Fatalf("insert retirement_plan moderado: %v", err)
		}

		cache := map[int64]int64{}
		retCache := map[int64]int64{}
		if _, err := postStreamPayment(ctx, tx, conceptBinaryID, "binary_bonus", affID,
			d("100.00"), "testret:moderado:1", "test moderado", postedAt, 65, cache, retCache); err != nil {
			t.Fatalf("postStreamPayment: %v", err)
		}

		// Sin 1007.
		if n := countMov(tx, retirementContribConceptID, affID); n != 0 {
			t.Errorf("moderado: esperaba 0 mov 1007, hubo %d", n)
		}
		// $100 retirable (concept binary).
		if got := sumMov(tx, conceptBinaryID, affID); !got.Equal(d("100.00")) {
			t.Errorf("moderado: want $100 retirable, got %s", got)
		}
		// balance_usd = 0.
		var bal decimal.Decimal
		if err := tx.QueryRow(ctx, `SELECT balance_usd FROM mlm.retirement_plan WHERE affiliate_id=$1`, affID).Scan(&bal); err != nil {
			t.Fatalf("balance moderado: %v", err)
		}
		if !bal.IsZero() {
			t.Errorf("balance moderado: want 0, got %s", bal)
		}
	})

	// -------------------------------------------------------------------------
	// Caso 3: parcial 0.5 — 1007=$50, retirable=$50, suma=$100.
	// -------------------------------------------------------------------------
	t.Run("parcial_0.5", func(t *testing.T) {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatalf("begin: %v", err)
		}
		defer tx.Rollback(ctx) //nolint:errcheck

		if _, err := tx.Exec(ctx, `
			INSERT INTO mlm.retirement_plan (affiliate_id, mode, opened_at, unlocks_at, balance_usd, updated_at)
			VALUES ($1, 'agresivo', now(), '2045-01-15', 0, now())`, affID); err != nil {
			t.Fatalf("insert retirement_plan parcial: %v", err)
		}
		// Bajar el routing de agresivo/binary_bonus a 0.5 sólo en esta tx.
		if _, err := tx.Exec(ctx, `
			UPDATE mlm.retirement_mode_routing SET pct_to_plan = 0.5
			 WHERE mode = 'agresivo' AND concept_kind = 'binary_bonus'`); err != nil {
			t.Fatalf("update routing parcial: %v", err)
		}

		cache := map[int64]int64{}
		retCache := map[int64]int64{}
		if _, err := postStreamPayment(ctx, tx, conceptBinaryID, "binary_bonus", affID,
			d("100.00"), "testret:parcial:1", "test parcial", postedAt, 65, cache, retCache); err != nil {
			t.Fatalf("postStreamPayment: %v", err)
		}

		// C1 fix: 1007 = +$50 CRÉDITO en USD-RET (no débito en USD).
		if got := sumMov(tx, retirementContribConceptID, affID); !got.Equal(d("50.00")) {
			t.Errorf("parcial 1007: want +50 (crédito USD-RET), got %s", got)
		}
		// Aserciones C1: USD wallet no tiene 1007; USD-RET wallet tiene +50.
		if got := walletMovSum(tx, "USD", retirementContribConceptID, affID); !got.IsZero() {
			t.Errorf("C1 parcial: USD wallet no debe tener movimiento 1007, got %s", got)
		}
		if got := walletMovSum(tx, "USD-RET", retirementContribConceptID, affID); !got.Equal(d("50.00")) {
			t.Errorf("C1 parcial: USD-RET wallet debe tener +50, got %s", got)
		}
		// Retirable = $50 (crédito en USD).
		if got := sumMov(tx, conceptBinaryID, affID); !got.Equal(d("50.00")) {
			t.Errorf("parcial retirable: want 50, got %s", got)
		}
		// Invariante: ret + wd = 100 (no se crea dinero; ambos son positivos ahora).
		ret := sumMov(tx, retirementContribConceptID, affID)
		wd := sumMov(tx, conceptBinaryID, affID)
		if !ret.Add(wd).Equal(d("100.00")) {
			t.Errorf("parcial invariante: %s + %s != 100", ret, wd)
		}
	})

	// -------------------------------------------------------------------------
	// Caso 4: ensureRetirementPlan crea la fila (no hay pre-insert) y deriva
	// unlocks_at = birthday + retirement_age años.
	// El afiliado de seedRetirementFixture tiene birthday='1980-01-15' y age=65
	// → unlocks_at esperado = '2045-01-15'.
	// -------------------------------------------------------------------------
	t.Run("ensure_crea_con_birthday", func(t *testing.T) {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatalf("begin: %v", err)
		}
		defer tx.Rollback(ctx) //nolint:errcheck

		// NO pre-insertamos retirement_plan; ensureRetirementPlan lo crea.
		// retCache es el caché de wallets USD-RET (separado del USD caché).
		retCache := map[int64]int64{}
		if err := postRetirementContribution(ctx, tx, affID, d("100.00"),
			"testret:ensure:birthday:1", postedAt, 65, retCache); err != nil {
			t.Fatalf("postRetirementContribution: %v", err)
		}

		// unlocks_at debe ser birthday + 65 años = 2045-01-15.
		var unlocksAt *time.Time
		if err := tx.QueryRow(ctx,
			`SELECT unlocks_at FROM mlm.retirement_plan WHERE affiliate_id=$1`, affID,
		).Scan(&unlocksAt); err != nil {
			t.Fatalf("unlocks_at query: %v", err)
		}
		const wantUnlocks = "2045-01-15"
		if unlocksAt == nil {
			t.Errorf("unlocks_at con birthday: nil, want %s", wantUnlocks)
		} else if got := unlocksAt.UTC().Format("2006-01-02"); got != wantUnlocks {
			t.Errorf("unlocks_at con birthday: got %s, want %s", got, wantUnlocks)
		}

		// balance_usd debe acreditarse aunque esté bloqueado.
		var bal decimal.Decimal
		if err := tx.QueryRow(ctx,
			`SELECT balance_usd FROM mlm.retirement_plan WHERE affiliate_id=$1`, affID,
		).Scan(&bal); err != nil {
			t.Fatalf("balance query: %v", err)
		}
		if !bal.Equal(d("100.00")) {
			t.Errorf("balance con birthday: want 100, got %s", bal)
		}

		// C1-catching: el movimiento 1007 es POSITIVO (+100) en USD-RET, no en USD.
		if got := walletMovSum(tx, "USD", retirementContribConceptID, affID); !got.IsZero() {
			t.Errorf("C1 birthday: USD wallet no debe tener movimiento 1007, got %s", got)
		}
		if got := walletMovSum(tx, "USD-RET", retirementContribConceptID, affID); !got.Equal(d("100.00")) {
			t.Errorf("C1 birthday: USD-RET wallet debe tener +100, got %s", got)
		}
	})

	// -------------------------------------------------------------------------
	// Caso 5: ensureRetirementPlan crea la fila para un afiliado sin birthday →
	// unlocks_at IS NULL, pero balance_usd igual se acredita (bloqueado-no-perdido).
	// -------------------------------------------------------------------------
	t.Run("ensure_crea_sin_birthday", func(t *testing.T) {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatalf("begin: %v", err)
		}
		defer tx.Rollback(ctx) //nolint:errcheck

		// Persona nueva sin birthday; todo se inserta en la tx (se revierte al salir).
		var nullPersonID int64
		if err := tx.QueryRow(ctx, `
			INSERT INTO mlm.person (first_name, last_name, email, phone_number, status)
			VALUES ('nullbday', 'test', 'nullbday@t.local', '2', 'active')
			RETURNING id`).Scan(&nullPersonID); err != nil {
			t.Fatalf("insert person sin birthday: %v", err)
		}

		nullPath := fmt.Sprintf("%d.R_%d", affID, nullPersonID)
		var nullAffID int64
		if err := tx.QueryRow(ctx, `
			INSERT INTO mlm.affiliate (person_id, parent_id, position, status, path, depth)
			VALUES ($1, $2, 'R', 'active', $3::ltree, 1)
			RETURNING id`, nullPersonID, affID, nullPath).Scan(&nullAffID); err != nil {
			t.Fatalf("insert affiliate sin birthday: %v", err)
		}

		if _, err := tx.Exec(ctx, `
			INSERT INTO mlm.wallet (affiliate_id, asset_id, address, balance)
			VALUES ($1, 1, 'w-nullbday', 0)`, nullAffID); err != nil {
			t.Fatalf("insert wallet sin birthday: %v", err)
		}

		// ensureRetirementPlan debe crear la fila con unlocks_at=NULL (sin birthday).
		// retCache es el caché de wallets USD-RET (separado del USD caché).
		retCache := map[int64]int64{}
		if err := postRetirementContribution(ctx, tx, nullAffID, d("50.00"),
			"testret:ensure:nullbday:1", postedAt, 65, retCache); err != nil {
			t.Fatalf("postRetirementContribution sin birthday: %v", err)
		}

		// unlocks_at debe ser NULL.
		var unlocksAt *time.Time
		if err := tx.QueryRow(ctx,
			`SELECT unlocks_at FROM mlm.retirement_plan WHERE affiliate_id=$1`, nullAffID,
		).Scan(&unlocksAt); err != nil {
			t.Fatalf("unlocks_at query sin birthday: %v", err)
		}
		if unlocksAt != nil {
			t.Errorf("unlocks_at sin birthday: got %s, want NULL", unlocksAt.UTC().Format("2006-01-02"))
		}

		// balance_usd debe ser 50 (invariante: bloqueado pero no perdido).
		var bal decimal.Decimal
		if err := tx.QueryRow(ctx,
			`SELECT balance_usd FROM mlm.retirement_plan WHERE affiliate_id=$1`, nullAffID,
		).Scan(&bal); err != nil {
			t.Fatalf("balance sin birthday: %v", err)
		}
		if !bal.Equal(d("50.00")) {
			t.Errorf("balance sin birthday: want 50, got %s", bal)
		}

		// C1-catching: el movimiento 1007 es POSITIVO (+50) en USD-RET, no en USD.
		if got := walletMovSum(tx, "USD", retirementContribConceptID, nullAffID); !got.IsZero() {
			t.Errorf("C1 nullbday: USD wallet no debe tener movimiento 1007, got %s", got)
		}
		if got := walletMovSum(tx, "USD-RET", retirementContribConceptID, nullAffID); !got.Equal(d("50.00")) {
			t.Errorf("C1 nullbday: USD-RET wallet debe tener +50, got %s", got)
		}
	})
}
