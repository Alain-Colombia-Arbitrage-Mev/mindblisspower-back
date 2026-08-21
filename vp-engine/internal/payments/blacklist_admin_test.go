package payments

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rs/zerolog"
)

// Rutas de lista negra montadas y protegidas por el service token (401 sin él).
// DB-free: solo verifica el route table + svcAuth (primer guard de requireAdmin).
func TestBlacklistRoutes_Mounted(t *testing.T) {
	h := &Handler{
		store:        &Store{}, // cache nil → allow() true; db nil no se toca sin token
		serviceToken: "test-token",
		log:          zerolog.Nop(),
	}
	srv := httptest.NewServer(h.Routes())
	defer srv.Close()

	cases := []struct {
		method, path string
	}{
		{http.MethodGet, "/api/admin/blacklist?email=admin@example.com"},
		{http.MethodPost, "/api/admin/blacklist"},
		{http.MethodPost, "/api/admin/blacklist/remove"},
	}
	for _, c := range cases {
		req, _ := http.NewRequest(c.method, srv.URL+c.path, strings.NewReader("{}"))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", c.method, c.path, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s %s: expected 401 without service token, got %d", c.method, c.path, resp.StatusCode)
		}
	}
}

// cognitoUsername debe coincidir con el BFF de registro (mp_ + sha256(email)[:40]).
// Par verificado contra el pool real (mbpdiag8xq@mailinator.com → mp_ccd4684...).
func TestCognitoUsername_Parity(t *testing.T) {
	got := cognitoUsername("MBPDiag8xq@Mailinator.com ") // mayúsculas/espacios: se normaliza
	want := "mp_ccd4684a149d62260f26aafab09116ab860fc691"
	if got != want {
		t.Fatalf("cognitoUsername mismatch: got %s want %s", got, want)
	}
}

func TestBanDecision_NameOnlyUsesStoredIdentity(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE
		VALUES (10, 'Reyna de la Paz', 'Hernandez', 'reyna-name@test.local', '+573046572009', 'active');

		INSERT INTO mlm.blacklist (fullname, name_norm, motive, source)
		VALUES ('Reyna de la Paz Hernandez', mlm.norm_name('Reyna de la Paz Hernandez'), 'name-only test', 'test');
	`); err != nil {
		t.Fatalf("seed blacklist: %v", err)
	}

	store := NewStore(pool)
	byName, err := store.BanDecisionFor(ctx, BanCandidate{Name: "reyna de la paz hernandez"})
	if err != nil {
		t.Fatalf("ban decision by name: %v", err)
	}
	if !byName.Blocked || byName.Reason != "blacklist_name" {
		t.Fatalf("byName = %+v, want blacklist_name block", byName)
	}

	byEmail, err := store.BanDecisionFor(ctx, BanCandidate{Email: "reyna-name@test.local"})
	if err != nil {
		t.Fatalf("ban decision by email: %v", err)
	}
	if !byEmail.Blocked || byEmail.Reason != "blacklist_name" {
		t.Fatalf("byEmail = %+v, want stored-name blacklist block", byEmail)
	}

	other, err := store.BanDecisionFor(ctx, BanCandidate{Name: "Reyna Hernandez"})
	if err != nil {
		t.Fatalf("ban decision other: %v", err)
	}
	if other.Blocked {
		t.Fatalf("other = %+v, want allowed", other)
	}
}

func TestActivatePaidPurchase_BannedBuyerSecurityBlocked(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE
		VALUES (20, 'Gloria Elena', 'Sandoval', 'gloria-ban@test.local', '+573001112233', 'active');

		INSERT INTO mlm.blacklist (fullname, name_norm, motive, source)
		VALUES ('Gloria Elena Sandoval', mlm.norm_name('Gloria Elena Sandoval'), 'name-only activation test', 'test');

		INSERT INTO payments.purchase_intent
		  (user_id, person_id, affiliate_id, sponsor_affiliate_id, package_id, pv,
		   amount_usd, fee_usd, total_cents, currency, status, stripe_session_id)
		VALUES ('gloria-ban@test.local', 20, NULL, NULL, 1001, 100, 100, 1, 10100, 'usd', 'created', 'cs_banned_name');
	`); err != nil {
		t.Fatalf("seed banned payment: %v", err)
	}

	store := NewStore(pool)
	res, err := store.ActivatePaidPurchase(ctx, "cs_banned_name", "pi_banned_name")
	if err != nil {
		t.Fatalf("activate banned buyer: %v", err)
	}
	if res.Status != "security_blocked" {
		t.Fatalf("status = %q, want security_blocked", res.Status)
	}

	var status string
	var affiliateCount, packageCount int
	if err := pool.QueryRow(ctx, `
		SELECT status FROM payments.purchase_intent WHERE stripe_session_id='cs_banned_name'
	`).Scan(&status); err != nil {
		t.Fatalf("intent status: %v", err)
	}
	if status != "security_blocked" {
		t.Fatalf("intent status = %q, want security_blocked", status)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM mlm.affiliate WHERE person_id=20`).Scan(&affiliateCount); err != nil {
		t.Fatalf("affiliate count: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM mlm.affiliate_package ap JOIN mlm.affiliate a ON a.id=ap.affiliate_id WHERE a.person_id=20`).Scan(&packageCount); err != nil {
		t.Fatalf("package count: %v", err)
	}
	if affiliateCount != 0 || packageCount != 0 {
		t.Fatalf("blocked activation created affiliate/packages: affiliates=%d packages=%d", affiliateCount, packageCount)
	}
}
