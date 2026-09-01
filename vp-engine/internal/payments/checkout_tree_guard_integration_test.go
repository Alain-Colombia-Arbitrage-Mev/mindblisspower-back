package payments

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rs/zerolog"
)

func TestCheckoutBlocksExistingAffiliateWhenSponsorIsOutsideBinaryTree(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.package (id, name, amount_usd, pv, type)
		  VALUES (1001,'Pack 1.000',1000,500,'enrollment');
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE VALUES
		  (1,'Root','Node','root-tree-guard@t.local','0','active'),
		  (2,'Direct','Sponsor','sponsor-tree-guard@t.local','0','active'),
		  (3,'Other','Parent','other-parent-tree-guard@t.local','0','active'),
		  (4,'Legacy','Buyer','legacy-buyer-tree-guard@t.local','0','active');
	`); err != nil {
		t.Fatalf("seed catalogs: %v", err)
	}

	var rootAff, sponsorAff, otherParentAff int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.affiliate (person_id, parent_id, position, sponsor_id, status, path, depth)
		VALUES (1, NULL, NULL, NULL, 'active', ''::ltree, 0)
		RETURNING id`).Scan(&rootAff); err != nil {
		t.Fatalf("root affiliate: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.affiliate (person_id, parent_id, position, sponsor_id, status, path, depth)
		VALUES (2, $1, 'L', $1, 'active', ''::ltree, 0)
		RETURNING id`, rootAff).Scan(&sponsorAff); err != nil {
		t.Fatalf("sponsor affiliate: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.affiliate (person_id, parent_id, position, sponsor_id, status, path, depth)
		VALUES (3, $1, 'R', $1, 'active', ''::ltree, 0)
		RETURNING id`, rootAff).Scan(&otherParentAff); err != nil {
		t.Fatalf("other parent affiliate: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.affiliate (person_id, parent_id, position, sponsor_id, status, path, depth)
		VALUES (4, $1, 'L', $2, 'active', ''::ltree, 0)
	`, otherParentAff, sponsorAff); err != nil {
		t.Fatalf("legacy buyer affiliate: %v", err)
	}

	h := &Handler{
		store:        NewStore(pool),
		serviceToken: "test-token",
		log:          zerolog.Nop(),
	}
	req := httptest.NewRequest(http.MethodPost, "/api/payments/checkout", strings.NewReader(`{
		"email":"legacy-buyer-tree-guard@t.local",
		"package_id":1001
	}`))
	req.Header.Set("X-VP-Service-Token", "test-token")
	w := httptest.NewRecorder()

	h.handleCheckout(w, req)

	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d body=%s, want 409", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "tree_relocation_required") {
		t.Fatalf("body = %s, want tree_relocation_required", w.Body.String())
	}
	var intents int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM payments.purchase_intent
		 WHERE lower(user_id) = 'legacy-buyer-tree-guard@t.local'
	`).Scan(&intents); err != nil {
		t.Fatalf("count intents: %v", err)
	}
	if intents != 0 {
		t.Fatalf("purchase_intent count = %d, want 0", intents)
	}
}
