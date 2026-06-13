package payments

import (
	"context"
	"testing"
)

// Valida el flujo pago→activación de punta a punta contra Postgres real:
// coloca al comprador en el árbol, liga el paquete y acredita PV — idempotente.
// Requiere Docker (testcontainers). Correr: go test ./internal/payments/ -run Integration
func TestActivatePaidPurchase_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	// --- Catálogos + sponsor (root) + comprador (sin afiliado aún) ---
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.country (id, iso2, name_es, name_en) VALUES (1,'CO','Colombia','Colombia');
		INSERT INTO mlm.asset (id, symbol, name, is_fiat, decimals) VALUES (1,'USD','US Dollar',true,2);
		INSERT INTO mlm.concept (id, kind, name_es, name_en, factor, requires_pair, active)
		  VALUES (1,'package_purchase','Compra','Purchase',-1,true,true);
		INSERT INTO mlm.package (id, name, amount_usd, pv, type) VALUES (1001,'Pack 1.000',1000,500,'enrollment');
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE VALUES (1,'Spon','Sor','sponsor@t.local','0','active');
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE VALUES (2,'Buy','Er','buyer@t.local','0','active');
	`); err != nil {
		t.Fatalf("seed catalogs: %v", err)
	}

	var sponsorAff int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.affiliate (person_id, parent_id, position, status, path, depth)
		VALUES (1, NULL, NULL, 'active', ''::ltree, 0) RETURNING id`).Scan(&sponsorAff); err != nil {
		t.Fatalf("sponsor affiliate: %v", err)
	}

	// purchase_intent pagado-pendiente (status created), sin afiliado, con sponsor.
	if _, err := pool.Exec(ctx, `
		INSERT INTO payments.purchase_intent
		  (user_id, person_id, affiliate_id, sponsor_affiliate_id, package_id, pv,
		   amount_usd, fee_usd, total_cents, currency, status, stripe_session_id)
		VALUES ('buyer@t.local', 2, NULL, $1, 1001, 500, 1000, 10, 101000, 'usd', 'created', 'cs_test_1')
	`, sponsorAff); err != nil {
		t.Fatalf("seed intent: %v", err)
	}

	store := NewStore(pool)

	// --- Activación ---
	res, err := store.ActivatePaidPurchase(ctx, "cs_test_1", "pi_test_1")
	if err != nil {
		t.Fatalf("activate: %v", err)
	}
	if res.Status != "activated" {
		t.Fatalf("status = %q, want activated", res.Status)
	}
	if res.AffiliateID == 0 {
		t.Fatal("affiliate not created")
	}

	// 1) Afiliado colocado bajo el sponsor (pierna L, árbol vacío → weak-leg='L').
	var parent int64
	var pos string
	if err := pool.QueryRow(ctx, `SELECT parent_id, position FROM mlm.affiliate WHERE person_id=2`).Scan(&parent, &pos); err != nil {
		t.Fatalf("buyer affiliate: %v", err)
	}
	if parent != sponsorAff || pos != "L" {
		t.Fatalf("placement = parent %d pos %s, want parent %d pos L", parent, pos, sponsorAff)
	}

	// 2) Paquete activado.
	var pkgStatus, method, hash string
	var pvRem int
	if err := pool.QueryRow(ctx, `
		SELECT status::text, payment_method, transaction_hash, pv_remaining
		  FROM mlm.affiliate_package WHERE affiliate_id=$1`, res.AffiliateID).
		Scan(&pkgStatus, &method, &hash, &pvRem); err != nil {
		t.Fatalf("affiliate_package: %v", err)
	}
	if pkgStatus != "active" || method != "stripe" || hash != "pi_test_1" || pvRem != 500 {
		t.Fatalf("package = %s/%s/%s/%d", pkgStatus, method, hash, pvRem)
	}

	// 2b) CD de inversión abierto (ROI por tier) + wallet USD asegurada.
	var cdTier int
	var cdStatus string
	if err := pool.QueryRow(ctx, `
		SELECT roi_tier_id, status::text FROM mlm.investment_cd WHERE affiliate_id=$1`, res.AffiliateID).
		Scan(&cdTier, &cdStatus); err != nil {
		t.Fatalf("investment_cd no creado en activación: %v", err)
	}
	if cdTier < 1 || cdStatus != "active" {
		t.Fatalf("investment_cd = tier %d / %s, want tier≥1 / active", cdTier, cdStatus)
	}
	var wallets int
	_ = pool.QueryRow(ctx, `
		SELECT count(*) FROM mlm.wallet w JOIN mlm.asset s ON s.id=w.asset_id
		 WHERE w.affiliate_id=$1 AND s.symbol='USD'`, res.AffiliateID).Scan(&wallets)
	if wallets != 1 {
		t.Fatalf("esperaba 1 wallet USD, got %d", wallets)
	}

	// 3) PV acreditado.
	var pvLeft int
	if err := pool.QueryRow(ctx, `
		SELECT pv_delta_left FROM mlm.tree_event
		 WHERE external_ref='package_purchase:pi_test_1' AND kind='pv_credit'`).Scan(&pvLeft); err != nil {
		t.Fatalf("pv_credit event: %v", err)
	}
	if pvLeft != 500 {
		t.Fatalf("pv_delta_left = %d, want 500", pvLeft)
	}

	// 4) Intent finalizado.
	var st string
	if err := pool.QueryRow(ctx, `SELECT status FROM payments.purchase_intent WHERE stripe_session_id='cs_test_1'`).Scan(&st); err != nil {
		t.Fatalf("intent status: %v", err)
	}
	if st != "activated" {
		t.Fatalf("intent status = %q, want activated", st)
	}

	// --- Idempotencia: reintento de Stripe no duplica ---
	res2, err := store.ActivatePaidPurchase(ctx, "cs_test_1", "pi_test_1")
	if err != nil {
		t.Fatalf("activate replay: %v", err)
	}
	if res2.Status != "replay" {
		t.Fatalf("replay status = %q, want replay", res2.Status)
	}
	var pkgCount, affCount int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM mlm.affiliate_package WHERE transaction_hash='pi_test_1'`).Scan(&pkgCount)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM mlm.affiliate WHERE person_id=2`).Scan(&affCount)
	if pkgCount != 1 || affCount != 1 {
		t.Fatalf("duplication on replay: packages=%d affiliates=%d", pkgCount, affCount)
	}
}

// Pago sin sponsor ni afiliado → queda 'needs_placement' (no crashea).
func TestActivate_NeedsPlacement_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.package (id, name, amount_usd, pv, type) VALUES (1001,'Pack 1.000',1000,500,'enrollment');
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE VALUES (9,'No','Sponsor','orphan@t.local','0','active');
		INSERT INTO payments.purchase_intent
		  (user_id, person_id, affiliate_id, sponsor_affiliate_id, package_id, pv,
		   amount_usd, fee_usd, total_cents, currency, status, stripe_session_id)
		VALUES ('orphan@t.local', 9, NULL, NULL, 1001, 500, 1000, 10, 101000, 'usd', 'created', 'cs_orphan');
	`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	res, err := NewStore(pool).ActivatePaidPurchase(ctx, "cs_orphan", "pi_orphan")
	if err != nil {
		t.Fatalf("activate: %v", err)
	}
	if res.Status != "needs_placement" {
		t.Fatalf("status = %q, want needs_placement", res.Status)
	}
}
