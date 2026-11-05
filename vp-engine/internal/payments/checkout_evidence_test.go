package payments

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/rs/zerolog"
	stripe "github.com/stripe/stripe-go/v85"
)

func validEvidenceCheckout() *stripe.CheckoutSession {
	return &stripe.CheckoutSession{ID: "cs_live_synthetic", Livemode: true, Mode: stripe.CheckoutSessionModePayment,
		PaymentStatus: stripe.CheckoutSessionPaymentStatusPaid, Currency: stripe.CurrencyUSD, AmountTotal: 101000,
		PaymentIntent: &stripe.PaymentIntent{ID: "pi_synthetic"},
		Metadata:      map[string]string{MetadataProductTag: MetadataProductVal, "purchase_intent_id": "synthetic-intent"}}
}

func TestCheckoutEvidenceValidation(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*stripe.CheckoutSession)
	}{
		{"test mode", func(c *stripe.CheckoutSession) { c.Livemode = false }},
		{"other product", func(c *stripe.CheckoutSession) { c.Metadata[MetadataProductTag] = "false" }},
		{"unpaid", func(c *stripe.CheckoutSession) { c.PaymentStatus = stripe.CheckoutSessionPaymentStatusUnpaid }},
		{"setup", func(c *stripe.CheckoutSession) { c.Mode = stripe.CheckoutSessionModeSetup }},
		{"EUR", func(c *stripe.CheckoutSession) { c.Currency = stripe.CurrencyEUR }},
		{"zero", func(c *stripe.CheckoutSession) { c.AmountTotal = 0 }},
		{"negative", func(c *stripe.CheckoutSession) { c.AmountTotal = -1 }},
		{"no session", func(c *stripe.CheckoutSession) { c.ID = "" }},
		{"no payment intent", func(c *stripe.CheckoutSession) { c.PaymentIntent = nil }},
		{"session fallback is not money evidence", func(c *stripe.CheckoutSession) { c.PaymentIntent.ID = "sess:cs_synthetic" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cs := validEvidenceCheckout()
			tc.change(cs)
			if _, err := evidenceFromCheckout(cs, true); !errors.Is(err, ErrCheckoutEvidence) {
				t.Fatalf("unsafe checkout accepted: %v", err)
			}
		})
	}
	if _, err := evidenceFromCheckout(validEvidenceCheckout(), true); err != nil {
		t.Fatal(err)
	}
	if _, err := evidenceFromCheckout(nil, true); !errors.Is(err, ErrCheckoutEvidence) {
		t.Fatal(err)
	}
}

func TestCheckoutEvidenceMatchesLockedIntent(t *testing.T) {
	e, err := evidenceFromCheckout(validEvidenceCheckout(), true)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, intent, session, payment, currency string
		total                                    int64
		valid                                    bool
	}{
		{"exact", "synthetic-intent", e.sessionID, e.paymentIntentID, "usd", 101000, true},
		{"late attach", "synthetic-intent", "", "", "usd", 101000, true},
		{"different intent", "another-intent", "", "", "usd", 101000, false},
		{"different session", "synthetic-intent", "cs_another", "", "usd", 101000, false},
		{"different PI", "synthetic-intent", "", "pi_another", "usd", 101000, false},
		{"different amount", "synthetic-intent", "", "", "usd", 101001, false},
		{"different currency", "synthetic-intent", "", "", "eur", 101000, false},
		{"zero snapshot", "synthetic-intent", "", "", "usd", 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := e.matchesIntent(tc.intent, tc.session, tc.payment, tc.currency, tc.total)
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v err=%v", tc.valid, err)
			}
		})
	}
}

func TestActivationStateRejectsTerminal(t *testing.T) {
	for _, status := range []string{"refunded", "disputed", "chargeback", "security_blocked", "failed", "expired", "cancelled", "unknown", ""} {
		if err := activationStateAllowed(status); !errors.Is(err, ErrActivationState) {
			t.Fatalf("accepted %q", status)
		}
	}
	for _, status := range []string{"created", "paid", "needs_placement", "activated"} {
		if err := activationStateAllowed(status); err != nil {
			t.Fatal(err)
		}
	}
}

func TestCheckoutGatewayRequiresLiveExceptExplicitTestEnvironment(t *testing.T) {
	for _, env := range []string{"", "production", "staging", "Development", "typo"} {
		if !NewStripeGateway("synthetic", "", "", "", "", "", nil, env).requireLive {
			t.Fatalf("non-live allowed in %q", env)
		}
	}
	if !NewStripeGateway("synthetic", "", "", "", "", "", nil).requireLive {
		t.Fatal("default must require live")
	}
	for _, env := range []string{"development", "test"} {
		g := NewStripeGateway("synthetic", "", "", "", "", "", nil, env)
		cs := validEvidenceCheckout()
		cs.Livemode = false
		if g.requireLive {
			t.Fatalf("explicit %s unexpectedly requires live", env)
		}
		if _, err := evidenceFromCheckout(cs, g.requireLive); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPaidWebhookRejectsInvalidEvidenceBeforeDatabase(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*stripe.CheckoutSession)
	}{
		{"test mode", func(c *stripe.CheckoutSession) { c.Livemode = false }},
		{"wrong currency", func(c *stripe.CheckoutSession) { c.Currency = stripe.CurrencyEUR }},
		{"missing PI", func(c *stripe.CheckoutSession) { c.PaymentIntent = nil }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cs := validEvidenceCheckout()
			tc.change(cs)
			raw, err := json.Marshal(cs)
			if err != nil {
				t.Fatal(err)
			}
			h := NewHandler(nil, NewStripeGateway("synthetic", "", "", "", "", "", nil, "production"), "synthetic", nil, 0, zerolog.Nop())
			err = h.handlePaid(context.Background(), stripe.Event{Livemode: cs.Livemode, Data: &stripe.EventData{Raw: raw}})
			if !errors.Is(err, ErrCheckoutEvidence) {
				t.Fatalf("invalid webhook reached activation: %v", err)
			}
		})
	}
}
