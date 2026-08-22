package payments

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/rs/zerolog"
	stripe "github.com/stripe/stripe-go/v85"
)

func TestActivatePaidPurchaseForIntentIDFallback_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.country (id, iso2, name_es, name_en) VALUES (1,'CO','Colombia','Colombia');
		INSERT INTO mlm.asset (id, symbol, name, is_fiat, decimals) VALUES (1,'USD','US Dollar',true,2);
		INSERT INTO mlm.concept (id, kind, name_es, name_en, factor, requires_pair, active)
		  VALUES (1,'package_purchase','Compra','Purchase',-1,true,true);
		INSERT INTO mlm.package (id, name, amount_usd, pv, type) VALUES (1001,'Pack 1.000',1000,500,'enrollment');
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE VALUES (1,'Spon','Sor','sponsor-fallback@t.local','0','active');
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE VALUES (2,'Late','Buyer','buyer-fallback@t.local','0','active');
	`); err != nil {
		t.Fatalf("seed catalogs: %v", err)
	}

	var sponsorAff int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.affiliate (person_id, parent_id, position, status, path, depth)
		VALUES (1, NULL, NULL, 'active', ''::ltree, 0) RETURNING id`).Scan(&sponsorAff); err != nil {
		t.Fatalf("sponsor affiliate: %v", err)
	}

	var intentID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO payments.purchase_intent
		  (user_id, person_id, affiliate_id, sponsor_affiliate_id, package_id, pv,
		   amount_usd, fee_usd, total_cents, currency, status)
		VALUES ('buyer-fallback@t.local', 2, NULL, $1, 1001, 500, 1000, 10, 101000, 'usd', 'created')
		RETURNING id::text
	`, sponsorAff).Scan(&intentID); err != nil {
		t.Fatalf("seed intent: %v", err)
	}

	res, err := NewStore(pool).ActivatePaidPurchaseForIntent(ctx, "cs_live_late_attach", "pi_late_attach", intentID)
	if err != nil {
		t.Fatalf("activate by intent id fallback: %v", err)
	}
	if res.Status != "activated" || res.AffiliateID == 0 {
		t.Fatalf("activation result = %+v, want activated with affiliate", res)
	}

	var status, sessionID, paymentIntentID string
	if err := pool.QueryRow(ctx, `
		SELECT status, stripe_session_id, stripe_payment_intent_id
		  FROM payments.purchase_intent WHERE id=$1::uuid
	`, intentID).Scan(&status, &sessionID, &paymentIntentID); err != nil {
		t.Fatalf("intent after activation: %v", err)
	}
	if status != "activated" || sessionID != "cs_live_late_attach" || paymentIntentID != "pi_late_attach" {
		t.Fatalf("intent = %s/%s/%s", status, sessionID, paymentIntentID)
	}

	var parent int64
	var pos string
	if err := pool.QueryRow(ctx, `SELECT parent_id, position FROM mlm.affiliate WHERE person_id=2`).Scan(&parent, &pos); err != nil {
		t.Fatalf("buyer affiliate: %v", err)
	}
	if parent != sponsorAff || pos != "L" {
		t.Fatalf("placement = parent %d pos %s, want parent %d pos L", parent, pos, sponsorAff)
	}

	var packageCount, pvCount, inflowCount int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM mlm.affiliate_package WHERE transaction_hash='pi_late_attach' AND status='active'`).Scan(&packageCount)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM mlm.tree_event WHERE external_ref='package_purchase:pi_late_attach' AND kind='pv_credit'`).Scan(&pvCount)
	_ = pool.QueryRow(ctx, `
		SELECT count(*) FROM mlm.transaction t
		JOIN mlm.wallet_movement wm ON wm.transaction_id=t.id
		JOIN mlm.concept c ON c.id=wm.concept_id AND c.kind='package_purchase'
		WHERE t.external_ref='pkgbuy:pi_late_attach'
	`).Scan(&inflowCount)
	if packageCount != 1 || pvCount != 1 || inflowCount != 1 {
		t.Fatalf("activation artifacts: package=%d pv=%d inflow=%d", packageCount, pvCount, inflowCount)
	}
}

func TestPaymentIntentFailedWebhookByMetadataDoesNotPlace_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.package (id, name, amount_usd, pv, type) VALUES (1001,'Pack 1.000',1000,500,'enrollment');
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE VALUES (10,'Spon','Sor','sponsor-failed@t.local','0','active');
		INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
		  OVERRIDING SYSTEM VALUE VALUES (20,'Failed','Buyer','buyer-failed@t.local','0','active');
	`); err != nil {
		t.Fatalf("seed catalogs: %v", err)
	}

	var sponsorAff int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.affiliate (person_id, parent_id, position, status, path, depth)
		VALUES (10, NULL, NULL, 'active', ''::ltree, 0) RETURNING id`).Scan(&sponsorAff); err != nil {
		t.Fatalf("sponsor affiliate: %v", err)
	}

	var intentID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO payments.purchase_intent
		  (user_id, person_id, affiliate_id, sponsor_affiliate_id, package_id, pv,
		   amount_usd, fee_usd, total_cents, currency, status)
		VALUES ('buyer-failed@t.local', 20, NULL, $1, 1001, 500, 1000, 10, 101000, 'usd', 'created')
		RETURNING id::text
	`, sponsorAff).Scan(&intentID); err != nil {
		t.Fatalf("seed intent: %v", err)
	}

	raw, err := json.Marshal(map[string]any{
		"id": "pi_failed_by_metadata",
		"metadata": map[string]string{
			MetadataProductTag:   MetadataProductVal,
			"purchase_intent_id": intentID,
		},
	})
	if err != nil {
		t.Fatalf("marshal payment_intent: %v", err)
	}
	h := &Handler{store: NewStore(pool), log: zerolog.Nop()}
	h.markIntentFromEvent(ctx, stripe.Event{
		ID:   "evt_failed_by_metadata",
		Type: stripe.EventType("payment_intent.payment_failed"),
		Data: &stripe.EventData{Raw: raw},
	}, "failed")

	var status, paymentIntentID string
	if err := pool.QueryRow(ctx, `
		SELECT status, stripe_payment_intent_id
		  FROM payments.purchase_intent WHERE id=$1::uuid
	`, intentID).Scan(&status, &paymentIntentID); err != nil {
		t.Fatalf("intent after failed webhook: %v", err)
	}
	if status != "failed" || paymentIntentID != "pi_failed_by_metadata" {
		t.Fatalf("intent = %s/%s, want failed/pi_failed_by_metadata", status, paymentIntentID)
	}

	var affiliateCount, packageCount, pvCount int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM mlm.affiliate WHERE person_id=20`).Scan(&affiliateCount)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM mlm.affiliate_package WHERE transaction_hash='pi_failed_by_metadata'`).Scan(&packageCount)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM mlm.tree_event WHERE external_ref='package_purchase:pi_failed_by_metadata'`).Scan(&pvCount)
	if affiliateCount != 0 || packageCount != 0 || pvCount != 0 {
		t.Fatalf("failed payment created tree artifacts: affiliate=%d package=%d pv=%d", affiliateCount, packageCount, pvCount)
	}
}
