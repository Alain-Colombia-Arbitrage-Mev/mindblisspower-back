package payments

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/shopspring/decimal"
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

	// 2e) Inflow posteado al ledger (package_purchase) PERO NO infla el balance
	//     retirable del comprador.
	var inflowAmt string
	if err := pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(wm.amount),0)::text FROM mlm.wallet_movement wm
		  JOIN mlm.concept c ON c.id=wm.concept_id
		 WHERE wm.affiliate_id=$1 AND c.kind='package_purchase'`, res.AffiliateID).Scan(&inflowAmt); err != nil {
		t.Fatalf("inflow: %v", err)
	}
	if inflowAmt == "0" {
		t.Fatal("esperaba un inflow package_purchase posteado")
	}
	// El balance del miembro debe seguir en 0 (la compra no es ganancia).
	sum, err := store.GetMemberSummary(ctx, "buyer@t.local")
	if err == nil {
		bal, _ := decimal.NewFromString(sum.WalletBalanceUSD)
		av, _ := decimal.NewFromString(sum.CommissionAvailable)
		if !bal.IsZero() || !av.IsZero() {
			t.Fatalf("la compra NO debe inflar el balance: balance=%s avail=%s", sum.WalletBalanceUSD, sum.CommissionAvailable)
		}
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

func TestMemberSummaryFiltersPaymentsByAuthoritativePerson(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.package (id, name, amount_usd, pv, type)
		VALUES (1001,'Pack 100',100,100,'enrollment');
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE VALUES
		  (1,'Target','User','target@t.local','0','active'),
		  (2,'Other','User','other@t.local','0','active');
	`); err != nil {
		t.Fatalf("seed people/package: %v", err)
	}

	var otherAff int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.affiliate (person_id, parent_id, position, status, path, depth)
		VALUES (2, NULL, NULL, 'active', ''::ltree, 0) RETURNING id`).Scan(&otherAff); err != nil {
		t.Fatalf("other affiliate: %v", err)
	}

	if _, err := pool.Exec(ctx, `
		INSERT INTO payments.purchase_intent
		  (id, user_id, person_id, affiliate_id, sponsor_affiliate_id, package_id, pv,
		   amount_usd, fee_usd, total_cents, currency, status, stripe_session_id, stripe_present)
		VALUES
		  ('00000000-0000-0000-0000-000000000001','target@t.local',1,NULL,NULL,1001,100,100,1,10100,'usd','created','cs_target_pending',NULL),
		  ('00000000-0000-0000-0000-000000000002','target@t.local',2,$1,NULL,1001,100,100,1,10100,'usd','created','cs_wrong_person',NULL),
		  ('00000000-0000-0000-0000-000000000004','target@t.local',1,NULL,NULL,1001,100,100,1,10100,'usd','activated','cs_test_false',false),
		  ('00000000-0000-0000-0000-000000000005','target@t.local',1,NULL,NULL,1001,100,10,1,1100,'usd','activated','cs_live_person',true),
		  ('00000000-0000-0000-0000-000000000007','target@t.local',2,$1,NULL,1001,100,30,3,3300,'usd','activated','cs_live_wrong_person',true)
	`, otherAff); err != nil {
		t.Fatalf("seed intents: %v", err)
	}

	store := NewStore(pool)
	sum, err := store.GetMemberSummary(ctx, "target@t.local")
	if err != nil {
		t.Fatalf("member summary: %v", err)
	}

	seen := map[string]bool{}
	for _, payment := range sum.Payments {
		seen[payment.PurchaseID] = true
	}
	for _, want := range []string{
		"00000000-0000-0000-0000-000000000001",
		"00000000-0000-0000-0000-000000000005",
	} {
		if !seen[want] {
			t.Fatalf("expected payment %s in member summary; got %#v", want, seen)
		}
	}
	for _, blocked := range []string{
		"00000000-0000-0000-0000-000000000002",
		"00000000-0000-0000-0000-000000000004",
		"00000000-0000-0000-0000-000000000007",
	} {
		if seen[blocked] {
			t.Fatalf("payment %s should not be visible in member summary", blocked)
		}
	}

	users, _, err := store.ListUsers(ctx, "target@t.local", 10, 0)
	if err != nil {
		t.Fatalf("list users: %v", err)
	}
	if len(users) != 1 {
		t.Fatalf("users = %d, want 1", len(users))
	}
	totalPaid, err := decimal.NewFromString(users[0].TotalPaidUSD)
	if err != nil {
		t.Fatalf("parse total paid %q: %v", users[0].TotalPaidUSD, err)
	}
	if !totalPaid.Equal(decimal.NewFromInt(11)) {
		t.Fatalf("total paid = %s, want 11", totalPaid)
	}
}

func TestCartResumeAndReminderUseAuthoritativePersonEmail(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.package (id, name, amount_usd, pv, type)
		VALUES (1001,'Pack 100',100,100,'enrollment');
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE VALUES
		  (1,'Real','Buyer','real-buyer@t.local','0','active');
		INSERT INTO payments.purchase_intent
		  (id, user_id, person_id, affiliate_id, sponsor_affiliate_id, package_id, pv,
		   amount_usd, fee_usd, total_cents, currency, status, stripe_session_id, created_at)
		VALUES
		  ('00000000-0000-0000-0000-000000000011','wrong-login@t.local',1,NULL,NULL,1001,100,100,1,10100,'usd','created','cs_resume_wrong_email',now() - interval '2 hours')
	`); err != nil {
		t.Fatalf("seed cart: %v", err)
	}

	store := NewStore(pool)
	ri, err := store.CartResumeInfo(ctx, "00000000-0000-0000-0000-000000000011")
	if err != nil {
		t.Fatalf("cart resume info: %v", err)
	}
	if ri.Email != "real-buyer@t.local" {
		t.Fatalf("resume email = %q, want authoritative person email", ri.Email)
	}

	cart, status, err := store.LoadCartForReminder(ctx, "00000000-0000-0000-0000-000000000011")
	if err != nil {
		t.Fatalf("load cart for reminder: %v", err)
	}
	if status != "created" || cart.Email != "real-buyer@t.local" {
		t.Fatalf("manual reminder = status %q email %q, want created/real-buyer@t.local", status, cart.Email)
	}

	carts, err := store.AbandonedCartsForReminder(ctx, time.Now().Add(-24*time.Hour), 3, 10)
	if err != nil {
		t.Fatalf("abandoned carts: %v", err)
	}
	if len(carts) != 1 || carts[0].Email != "real-buyer@t.local" {
		t.Fatalf("abandoned carts = %#v, want one with authoritative person email", carts)
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

func TestCreatePurchaseIntentStoresReferralCode_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.package (id, name, amount_usd, pv, type)
		VALUES (1001,'Pack 1.000',1000,500,'enrollment');
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE VALUES (11,'Ref','Buyer','ref-buyer@t.local','0','active');
	`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	id, err := NewStore(pool).CreatePurchaseIntent(ctx, PurchaseIntent{
		UserID:             "ref-buyer@t.local",
		PersonID:           11,
		SponsorAffiliateID: ptrInt64(79295),
		ReferralCode:       "martinezl14",
		PackageID:          1001,
		PV:                 500,
		AmountUSD:          decimal.NewFromInt(1000),
		FeeUSD:             decimal.NewFromInt(10),
		TotalCents:         101000,
		Currency:           "usd",
	})
	if err != nil {
		t.Fatalf("create purchase intent: %v", err)
	}

	var referralCode string
	if err := pool.QueryRow(ctx, `SELECT referral_code FROM payments.purchase_intent WHERE id=$1::uuid`, id).Scan(&referralCode); err != nil {
		t.Fatalf("read referral code: %v", err)
	}
	if referralCode != "martinezl14" {
		t.Fatalf("referral_code = %q, want martinezl14", referralCode)
	}
}

func TestRegistrationReferralAttribution_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE VALUES
		  (21,'Tiburcio','Hernandez','tibhern@t.local','0','active'),
		  (22,'Reynaldo','Sanchez','reynaldo@t.local','0','active');
		INSERT INTO mlm.affiliate (id, person_id, parent_id, position, sponsor_id, status, path, depth, invitation_link)
		  OVERRIDING SYSTEM VALUE VALUES
		  (210,21,NULL,NULL,NULL,'active',''::ltree,0,'tiburcio65');
	`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	store := NewStore(pool)
	recorded, err := store.RecordRegistrationReferral(ctx, "REYNALDO@t.local", "tiburcio65", "R")
	if err != nil {
		t.Fatalf("record registration referral: %v", err)
	}
	if recorded == nil || recorded.SponsorAffiliateID != 210 || recorded.PreferredSide != "R" {
		t.Fatalf("recorded sponsor = %#v, want affiliate 210", recorded)
	}

	found, err := store.LookupRegistrationReferral(ctx, "reynaldo@t.local")
	if err != nil {
		t.Fatalf("lookup registration referral: %v", err)
	}
	if found == nil || found.Code != "tiburcio65" || found.SponsorAffiliateID != 210 || found.PreferredSide != "R" {
		t.Fatalf("lookup = %#v, want tiburcio65/210", found)
	}
}

func TestResolveCheckoutSponsorUsesStoredRegistrationReferral_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE VALUES
		  (31,'Tiburcio','Hernandez','tibhern@t.local','0','active'),
		  (32,'Reynaldo','Sanchez','reynaldo@t.local','0','active');
		INSERT INTO mlm.affiliate (id, person_id, parent_id, position, sponsor_id, status, path, depth, invitation_link)
		  OVERRIDING SYSTEM VALUE VALUES
		  (310,31,NULL,NULL,NULL,'active',''::ltree,0,'tiburcio65');
	`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	store := NewStore(pool)
	if _, err := store.RecordRegistrationReferral(ctx, "reynaldo@t.local", "tiburcio65", "L"); err != nil {
		t.Fatalf("record registration referral: %v", err)
	}
	handler := &Handler{store: store, companyRoot: 999}
	sponsor, code, err := handler.resolveCheckoutSponsor(ctx, "reynaldo@t.local", Buyer{PersonID: 32}, "")
	if err != nil {
		t.Fatalf("resolve checkout sponsor: %v", err)
	}
	if sponsor == nil || *sponsor != 310 {
		t.Fatalf("sponsor = %v, want 310", sponsor)
	}
	if code != "tiburcio65" {
		t.Fatalf("referral code = %q, want tiburcio65", code)
	}
	sponsorWithSide, codeWithSide, side, err := handler.resolveCheckoutPlacement(ctx, "reynaldo@t.local", Buyer{PersonID: 32}, "", "")
	if err != nil || sponsorWithSide == nil || *sponsorWithSide != 310 || codeWithSide != "tiburcio65" || side != "L" {
		t.Fatalf("placement = sponsor %v code %q side %q err %v", sponsorWithSide, codeWithSide, side, err)
	}
}

func TestResolveCheckoutSponsorFallsBackToCompanyRootWithoutReferral_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	store := NewStore(pool)
	handler := &Handler{store: store, companyRoot: 999}
	sponsor, code, err := handler.resolveCheckoutSponsor(ctx, "organic@t.local", Buyer{PersonID: 42}, "")
	if err != nil {
		t.Fatalf("resolve checkout sponsor: %v", err)
	}
	if sponsor == nil || *sponsor != 999 {
		t.Fatalf("sponsor = %v, want company root 999", sponsor)
	}
	if code != "" {
		t.Fatalf("referral code = %q, want empty", code)
	}
}

func TestRecordRegistrationReferralRejectsInvalidCode_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	_, err := NewStore(pool).RecordRegistrationReferral(ctx, "buyer@t.local", "missing-code")
	if !errors.Is(err, ErrInvalidReferralCode) {
		t.Fatalf("err = %v, want ErrInvalidReferralCode", err)
	}
}

func TestReferralSponsorEligibility_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status, blacklisted)
		  OVERRIDING SYSTEM VALUE VALUES
		  (41,'Active','Sponsor','active-sponsor@t.local','0','active',false),
		  (42,'Banned','Sponsor','banned-sponsor@t.local','0','active',true),
		  (43,'Suspended','Sponsor','suspended-sponsor@t.local','0','suspended',false),
		  (44,'Affiliate','Banned','affiliate-banned@t.local','0','active',false),
		  (45,'Pending','Buyer','pending-buyer@t.local','0','active',false);
		INSERT INTO mlm.affiliate (id, person_id, parent_id, position, sponsor_id, status, path, depth, invitation_link)
		  OVERRIDING SYSTEM VALUE VALUES
		  (410,41,NULL,NULL,NULL,'active',''::ltree,0,'active-code'),
		  (420,42,NULL,NULL,NULL,'active',''::ltree,0,'banned-code'),
		  (430,43,NULL,NULL,NULL,'active',''::ltree,0,'suspended-code'),
		  (440,44,NULL,NULL,NULL,'banned',''::ltree,0,'affiliate-banned-code');
		INSERT INTO payments.registration_referral(email_norm, referral_code, sponsor_affiliate_id, source)
		  VALUES ('pending-buyer@t.local', 'banned-code', 420, 'register');
	`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	store := NewStore(pool)
	active, err := store.ResolveSponsorByCode(ctx, "active-code")
	if err != nil {
		t.Fatalf("resolve active sponsor: %v", err)
	}
	if active == nil || *active != 410 {
		t.Fatalf("active sponsor = %v, want 410", active)
	}
	for _, code := range []string{"banned-code", "suspended-code", "affiliate-banned-code", "MP420", "MP430", "MP440"} {
		got, err := store.ResolveSponsorByCode(ctx, code)
		if err != nil {
			t.Fatalf("resolve %s: %v", code, err)
		}
		if got != nil {
			t.Fatalf("resolve %s = %d, want nil", code, *got)
		}
	}

	registered, err := store.LookupRegistrationReferral(ctx, "pending-buyer@t.local")
	if err != nil {
		t.Fatalf("lookup registration referral: %v", err)
	}
	if registered != nil {
		t.Fatalf("registered referral = %#v, want nil for banned sponsor", registered)
	}

	handler := &Handler{store: store, companyRoot: 999}
	sponsor, code, err := handler.resolveCheckoutSponsor(ctx, "pending-buyer@t.local", Buyer{PersonID: 45}, "")
	if err != nil {
		t.Fatalf("resolve checkout sponsor: %v", err)
	}
	if sponsor == nil || *sponsor != 999 {
		t.Fatalf("sponsor = %v, want company root 999", sponsor)
	}
	if code != "" {
		t.Fatalf("referral code = %q, want empty", code)
	}
}

func TestActivatePaidPurchaseDefersPlacementWhenSponsorBecomesIneligible_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.package (id, name, amount_usd, pv, type) VALUES (1201,'Pack 100',100,50,'enrollment');
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status, blacklisted)
		  OVERRIDING SYSTEM VALUE VALUES
		  (51,'Late','Sponsor','late-sponsor@t.local','0','active',false),
		  (52,'Late','Buyer','late-buyer@t.local','0','active',false);
		INSERT INTO mlm.affiliate (id, person_id, parent_id, position, sponsor_id, status, path, depth)
		  OVERRIDING SYSTEM VALUE VALUES
		  (510,51,NULL,NULL,NULL,'active',''::ltree,0);
		INSERT INTO payments.purchase_intent
		  (id, user_id, person_id, affiliate_id, sponsor_affiliate_id, package_id, pv,
		   amount_usd, fee_usd, total_cents, currency, status, stripe_session_id)
		VALUES ('00000000-0000-0000-0000-000000001201','late-buyer@t.local',52,NULL,510,1201,50,
		        100,1,10100,'usd','created','cs_late_sponsor');
		UPDATE mlm.person SET blacklisted = true WHERE id = 51;
	`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	res, err := NewStore(pool).ActivatePaidPurchase(ctx, "cs_late_sponsor", "pi_late_sponsor")
	if err != nil {
		t.Fatalf("activate: %v", err)
	}
	if res.Status != "needs_placement" {
		t.Fatalf("status = %q, want needs_placement", res.Status)
	}

	var affiliates, packages int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM mlm.affiliate WHERE person_id = 52`).Scan(&affiliates); err != nil {
		t.Fatalf("buyer affiliate count: %v", err)
	}
	if affiliates != 0 {
		t.Fatalf("buyer affiliate count = %d, want 0", affiliates)
	}
	if err := pool.QueryRow(ctx, `
		SELECT count(*)
		  FROM mlm.affiliate_package ap
		  JOIN mlm.affiliate a ON a.id = ap.affiliate_id
		 WHERE a.person_id = 52
	`).Scan(&packages); err != nil {
		t.Fatalf("buyer package count: %v", err)
	}
	if packages != 0 {
		t.Fatalf("buyer package count = %d, want 0", packages)
	}

	var status string
	var paid bool
	if err := pool.QueryRow(ctx, `
		SELECT status::text, paid_at IS NOT NULL
		  FROM payments.purchase_intent
		 WHERE stripe_session_id = 'cs_late_sponsor'
	`).Scan(&status, &paid); err != nil {
		t.Fatalf("intent status: %v", err)
	}
	if status != "needs_placement" || !paid {
		t.Fatalf("intent = %s paid=%v, want needs_placement paid=true", status, paid)
	}
}

func ptrInt64(v int64) *int64 {
	return &v
}
