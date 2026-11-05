package payments

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/shopspring/decimal"
	"github.com/stripe/stripe-go/v85/form"
)

func TestCheckoutStableIdentityPayload(t *testing.T) {
	gateway := &StripeGateway{successURL: "https://app.example.test/success", cancelURL: "https://app.example.test/cancel", paymentMethods: []string{"card"}}
	pack := Pack{ID: 7, AmountUSD: decimal.NewFromInt(25), PV: 10}
	identity := CheckoutIdentity{PersonPublicID: "c23a5519-82a1-4b6b-a01e-4df42d1c0f12", PersonID: 11, AffiliateID: ptrInt64(21), SponsorAffiliateID: ptrInt64(31), PackageID: 7}
	params, err := gateway.checkoutParams(pack, "7922a1f2-3c86-4a8d-9d68-a8d5855de112", identity)
	if err != nil {
		t.Fatal(err)
	}
	if *params.ClientReferenceID != identity.PersonPublicID || !reflect.DeepEqual(params.Metadata, params.PaymentIntentData.Metadata) {
		t.Fatal("stable buyer identity and both metadata copies must agree")
	}
	want := map[string]string{"packmindbliss": "true", "identity_version": "1", "person_public_id": identity.PersonPublicID,
		"person_id": "11", "buyer_id": "11", "affiliate_id": "21", "sponsor_affiliate_id": "31", "package_id": "7", "pv": "10", "purchase_intent_id": "7922a1f2-3c86-4a8d-9d68-a8d5855de112"}
	if !reflect.DeepEqual(params.Metadata, want) {
		t.Fatalf("metadata must contain only the stable identifier allowlist: %v", params.Metadata)
	}
	encoded := &form.Values{}
	form.AppendTo(encoded, params)
	fields := encoded.ToValues()
	for key, value := range want {
		if fields.Get("metadata["+key+"]") != value || fields.Get("payment_intent_data[metadata]["+key+"]") != value {
			t.Fatal("Stripe SDK must serialize both identifier copies", key)
		}
	}
	if fields.Get("client_reference_id") != identity.PersonPublicID || fields.Get("customer") != "" || fields.Get("customer_email") != "" {
		t.Fatal("wire payload must use a stable reference without choosing a customer by email")
	}
	for _, edit := range []func(*CheckoutIdentity){
		func(i *CheckoutIdentity) { i.PersonPublicID = "" },
		func(i *CheckoutIdentity) { i.PersonID = 0 },
		func(i *CheckoutIdentity) { i.PackageID = 8 },
		func(i *CheckoutIdentity) { i.AffiliateID = ptrInt64(-1) },
	} {
		invalid := identity
		edit(&invalid)
		if _, err := gateway.checkoutParams(pack, "7922a1f2-3c86-4a8d-9d68-a8d5855de112", invalid); !errors.Is(err, ErrCheckoutIdentityReview) {
			t.Fatal("incomplete identity must fail before making a Stripe call", err)
		}
	}
}

func TestCheckoutIdentityBoundToPersistedOwnerIntegration(t *testing.T) {
	if testing.Short() {
		t.Skip("isolated PostgreSQL testcontainer")
	}
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `ALTER TABLE mlm.person ADD COLUMN public_id uuid NOT NULL DEFAULT gen_random_uuid();
		INSERT INTO mlm.person(id,first_name,last_name,email,phone_number,status) OVERRIDING SYSTEM VALUE VALUES
		(1,'Synthetic','Buyer','buyer@example.test','0','active'),(2,'Synthetic','Sponsor','sponsor@example.test','0','active');
		INSERT INTO mlm.affiliate(person_id,status,path,depth) VALUES(1,'active',''::ltree,0),(2,'active',''::ltree,0);
		INSERT INTO mlm.package(id,name,amount_usd,pv,type) VALUES(7,'Synthetic package',25,10,'enrollment');
		INSERT INTO payments.purchase_intent(id,user_id,person_id,affiliate_id,sponsor_affiliate_id,package_id,pv,amount_usd,fee_usd,total_cents,currency,status)
		SELECT '7922a1f2-3c86-4a8d-9d68-a8d5855de112','untrusted-value@example.test',1,a.id,s.id,7,10,25,0.25,2525,'usd','created'
		FROM mlm.affiliate a,mlm.affiliate s WHERE a.person_id=1 AND s.person_id=2;`); err != nil {
		t.Fatal(err)
	}
	store := NewStore(pool)
	identity, err := store.checkoutIdentityForIntent(ctx, "7922a1f2-3c86-4a8d-9d68-a8d5855de112")
	if err != nil || identity.PersonID != 1 || identity.AffiliateID == nil || identity.SponsorAffiliateID == nil || identity.PersonPublicID == "" {
		t.Fatal("persisted owner, not user_id/email, must determine identity", identity, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE mlm.person SET status='suspended' WHERE id=2`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.checkoutIdentityForIntent(ctx, "7922a1f2-3c86-4a8d-9d68-a8d5855de112"); !errors.Is(err, ErrCheckoutIdentityReview) {
		t.Fatal("resume must not export a stale or invalid sponsor", err)
	}
}
