package payments

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rs/zerolog"
)

func TestStripeCheckoutConfigRequiresLiteralTrue(t *testing.T) {
	readOnlyConfigEnv(t)
	t.Setenv("SERVICE_READ_ONLY", "false")
	t.Setenv("STRIPE_SECRET_KEY", "sk_test_synthetic")
	t.Setenv("STRIPE_WEBHOOK_SECRET", "whsec_synthetic")
	t.Setenv("NOWPAYMENTS_MEMBERSHIPS_ENABLED", "false")
	for _, value := range []string{"", "false", "1", "TRUE", "True", " true", "true ", "yes", "on", "invalid", "true"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("STRIPE_CHECKOUT_ENABLED", value)
			config, err := LoadConfig()
			if err != nil {
				t.Fatal(err)
			}
			if config.StripeCheckoutEnabled != (value == "true") {
				t.Fatalf("checkout admission must require the literal true, got %q", value)
			}
			if config.StripeSecretKey != "sk_test_synthetic" || config.StripeWebhookSecret != "whsec_synthetic" {
				t.Fatal("checkout admission must not discard webhook or historical-read credentials")
			}
		})
	}
	t.Setenv("SERVICE_READ_ONLY", "true")
	t.Setenv("STRIPE_CHECKOUT_ENABLED", "true")
	config, err := LoadConfig()
	if err != nil || config.StripeCheckoutEnabled {
		t.Fatal("read-only must override checkout opt-in", err)
	}
}

func TestStripeCheckoutDisabledBeforeDatabaseOrGateway(t *testing.T) {
	for _, routed := range []bool{false, true} {
		for _, body := range []string{
			`{"email":"buyer@example.test","package_id":1}`,
			`{"email":"buyer@example.test","package_id":1,"provider":""}`,
			`{"email":"buyer@example.test","package_id":1,"provider":"stripe"}`,
		} {
			// Nil store and gateway deliberately panic if financial work is reached.
			h := NewHandler(nil, nil, "synthetic-service", nil, 0, zerolog.Nop())
			h.SetIdentityVerifier(fakeVerifier{email: "buyer@example.test"}, true)
			r := httptest.NewRequest(http.MethodPost, "/api/payments/checkout", strings.NewReader(body))
			r.Header.Set("X-VP-Service-Token", "synthetic-service")
			r.Header.Set(idTokenHeader, "synthetic-id-token")
			w := httptest.NewRecorder()
			if routed {
				h.Routes().ServeHTTP(w, r)
			} else {
				h.handleCheckout(w, r)
			}
			if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "stripe_checkout_disabled") {
				t.Fatal("disabled checkout did not stop before its absent dependencies", w.Code, w.Body.String())
			}
			if w.Header().Get("Cache-Control") != "private, no-store" || strings.Contains(w.Body.String(), `"url"`) {
				t.Fatal("disabled checkout must be non-cacheable and return no payment URL")
			}
		}
	}
}

func TestStripeResumeDisabledBeforeDatabaseOrGateway(t *testing.T) {
	for _, token := range []string{"", "malformed", "signed"} {
		h := NewHandler(nil, nil, "synthetic-service", nil, 0, zerolog.Nop())
		if token == "signed" {
			token = h.signResumeToken("synthetic-intent")
		}
		r := httptest.NewRequest(http.MethodGet, "/api/payments/resume?t="+token, nil)
		r.Header.Set("X-VP-Service-Token", "synthetic-service")
		w := httptest.NewRecorder()
		h.Routes().ServeHTTP(w, r)
		if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "stripe_checkout_disabled") || w.Header().Get("Cache-Control") != "private, no-store" {
			t.Fatal("disabled resume reached token/database/provider work", w.Code, w.Body.String())
		}
	}
}

func TestStripeGatewayCheckoutFailsClosedForDirectCallers(t *testing.T) {
	for _, gateway := range []*StripeGateway{nil, {}} {
		url, sessionID, err := gateway.CreateCheckout(Pack{}, "", CheckoutIdentity{})
		if !errors.Is(err, ErrStripeCheckoutDisabled) || url != "" || sessionID != "" {
			t.Fatal("gateway must reject before preparing or sending a checkout", err)
		}
	}
	gateway := &StripeGateway{webhookSecret: "synthetic-webhook-secret"}
	h := NewHandler(nil, gateway, "synthetic-service", nil, 0, zerolog.Nop())
	h.SetStripeCheckoutEnabled(true)
	if !h.stripeCheckoutEnabled || !gateway.checkoutEnabled {
		t.Fatal("startup opt-in must propagate to both checkout guards")
	}
	// An explicitly enabled gateway still applies the existing stable-owner guard.
	if _, _, err := gateway.CreateCheckout(Pack{}, "", CheckoutIdentity{}); !errors.Is(err, ErrCheckoutIdentityReview) {
		t.Fatal("checkout opt-in must preserve identity validation", err)
	}
	h.SetStripeCheckoutEnabled(false)
	if gateway.checkoutEnabled || gateway.webhookSecret != "synthetic-webhook-secret" {
		t.Fatal("disabling checkout must preserve webhook credentials")
	}
	if _, err := gateway.ConstructEvent([]byte(`{}`), "invalid"); err == nil || errors.Is(err, ErrStripeCheckoutDisabled) {
		t.Fatal("disabled checkout must preserve independent webhook signature validation", err)
	}
}

func TestStripeCheckoutGatePreservesServiceAuthentication(t *testing.T) {
	h := NewHandler(nil, nil, "synthetic-service", nil, 0, zerolog.Nop())
	for _, path := range []string{"/api/payments/checkout", "/api/payments/resume"} {
		w := httptest.NewRecorder()
		h.Routes().ServeHTTP(w, httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"package_id":1}`)))
		if w.Code != http.StatusUnauthorized {
			t.Fatal("checkout gate must not bypass service authentication", path, w.Code)
		}
	}
}

func TestStripeCheckoutDisabledLeavesNOWPaymentsUnchanged(t *testing.T) {
	h := NewHandler(nil, nil, "synthetic-service", nil, 0, zerolog.Nop())
	h.SetIdentityVerifier(fakeVerifier{email: "buyer@example.test"}, true)
	r := httptest.NewRequest(http.MethodPost, "/api/payments/checkout", strings.NewReader(`{"email":"buyer@example.test","package_id":1,"provider":"nowpayments"}`))
	r.Header.Set("X-VP-Service-Token", "synthetic-service")
	r.Header.Set(idTokenHeader, "synthetic-id-token")
	w := httptest.NewRecorder()
	h.Routes().ServeHTTP(w, r)
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "nowpayments-unavailable") || strings.Contains(w.Body.String(), "stripe_checkout_disabled") {
		t.Fatal("NOWPayments must retain its own admission checks", w.Code, w.Body.String())
	}
	// A configured NOWPayments fake still creates exactly one review-only invoice
	// without a Stripe gateway or an enabled Stripe flag. No external calls.
	h, client, store := fakeNOWMembershipHandler()
	h.SetStripeCheckoutEnabled(false)
	w = httptest.NewRecorder()
	h.handleNOWMembershipCheckout(w, httptest.NewRequest(http.MethodPost, "/", nil), checkoutRequest{Email: "buyer@example.test", PackageID: 1}, nil, "")
	if w.Code != http.StatusOK || client.creates != 1 || store.creates != 1 || store.attaches != 1 || !strings.Contains(w.Body.String(), `"fulfillment_status":"review_required"`) {
		t.Fatal("Stripe switch changed NOWPayments invoice behavior", w.Code, w.Body.String())
	}
}
