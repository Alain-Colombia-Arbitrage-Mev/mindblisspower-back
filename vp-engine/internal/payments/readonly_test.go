package payments

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func readOnlyConfigEnv(t *testing.T) {
	t.Helper()
	t.Setenv("PAYMENTS_ENV_FILE", "")
	t.Setenv("SERVICE_READ_ONLY", "true")
	t.Setenv("DATABASE_URL", "postgres://synthetic@localhost/synthetic")
	t.Setenv("PAYMENTS_SERVICE_TOKEN", "synthetic-service-token")
	for _, key := range []string{"STRIPE_SECRET_KEY", "CLAVE_API", "STRIPE_WEBHOOK_SECRET", "SECRET_FIRMA", "PAYMENTS_ADMIN_EMAILS", "PAYMENTS_SUPER_ADMIN_EMAILS"} {
		t.Setenv(key, "")
	}
}

func TestReadOnlyConfigDoesNotRequireOrRetainProviders(t *testing.T) {
	readOnlyConfigEnv(t)
	t.Setenv("COMMS_ENABLED", "true")
	t.Setenv("COMMS_UNSUBSCRIBE_SECRET", "")
	t.Setenv("PAYMENTS_CART_REMINDER_ENABLED", "true")
	t.Setenv("PAYMENTS_RECONCILE_INTERVAL_MIN", "1")
	c, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if !c.ReadOnly || !c.RequireVerifiedIdentity || c.ExternalProvidersEnabled() || c.BackgroundJobsEnabled() || c.CommsEnabled || c.CartReminderEnabled || c.ReconcileInterval != 0 || c.CartReminderInterval != 0 {
		t.Fatal("read-only must override every background/provider switch")
	}
	if len(c.AdminEmails) != 0 || len(c.SuperAdminEmails) != 0 {
		t.Fatal("read-only must not inherit hardcoded staff allowlists")
	}
	for _, key := range []string{"STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "REDIS_ADDR", "NATS_URL", "PAYMENTS_KYC_OCR_API_KEY", "KYC_S3_BUCKET", "PAYMENTS_SUPPORT_AI_SERVICE_TOKEN", "PAYMENTS_TWILIO_AUTH_TOKEN"} {
		t.Setenv(key, "synthetic-accidentally-configured")
	}
	t.Setenv("PAYMENTS_ADMIN_EMAILS", "explicit@example.test")
	t.Setenv("PAYMENTS_SUPER_ADMIN_EMAILS", "explicit-owner@example.test")
	c, err = LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if c.StripeSecretKey != "" || c.StripeWebhookSecret != "" || c.RedisAddr != "" || c.NATSURL != "" || c.KYCBucket != "" || c.KYCOCRAPIKey != "" || c.SupportAIServiceToken != "" || c.TwilioWebhookAuthToken != "" {
		t.Fatal("read-only retained provider material")
	}
	if len(c.AdminEmails) != 1 || c.AdminEmails[0] != "explicit@example.test" || len(c.SuperAdminEmails) != 1 || c.SuperAdminEmails[0] != "explicit-owner@example.test" {
		t.Fatal("explicit staff allowlists must remain explicit")
	}
}

func TestReadOnlyOptInIsStrictAndOperationalValidationRemains(t *testing.T) {
	readOnlyConfigEnv(t)
	t.Setenv("SERVICE_READ_ONLY", "flase")
	if _, err := LoadConfig(); err == nil || !strings.Contains(err.Error(), "SERVICE_READ_ONLY") {
		t.Fatal("invalid read-only setting must fail closed")
	}
	t.Setenv("SERVICE_READ_ONLY", "false")
	if _, err := LoadConfig(); err == nil || !strings.Contains(err.Error(), "STRIPE_SECRET_KEY") {
		t.Fatal("operational mode still requires Stripe credentials")
	}
	t.Setenv("STRIPE_SECRET_KEY", "sk_test_synthetic")
	if _, err := LoadConfig(); err == nil || !strings.Contains(err.Error(), "STRIPE_WEBHOOK_SECRET") {
		t.Fatal("operational mode still requires webhook secret")
	}
	t.Setenv("STRIPE_WEBHOOK_SECRET", "whsec_synthetic")
	c, err := LoadConfig()
	if err != nil || c.ReadOnly || !c.ExternalProvidersEnabled() || !c.BackgroundJobsEnabled() {
		t.Fatal("operational behavior must remain available when explicitly configured", err)
	}
}

func TestReadOnlyRouterRejectsWritesAndUnsafeGETsBeforeAnyHandler(t *testing.T) {
	c := &Config{ReadOnly: true}
	calls := 0
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(http.StatusAccepted) })
	h := c.ReadOnlyHandler(next)
	for _, method := range []string{"POST", "PUT", "PATCH", "DELETE", "CONNECT", "TRACE"} {
		for _, path := range []string{"/health", "/api/payments/checkout", "/api/webhooks/stripe", "/api/admin/user", "/api/admin/withdrawals/action"} {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest(method, path, strings.NewReader("not-read")))
			if w.Code != 503 || !strings.Contains(w.Body.String(), "service_read_only") || calls != 0 {
				t.Fatal("write reached a handler", method, path, w.Code)
			}
		}
	}
	for _, path := range []string{"/api/payments/resume", "/api/admin/sales/verify", "/api/admin/sales/reconcile", "/api/comms/unsubscribe", "/api/admin/otp-check", "/api/webhooks/stripe", "/unknown"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 503 || calls != 0 {
			t.Fatal("unsafe GET reached a provider-capable handler", path)
		}
	}
	for _, method := range []string{"GET", "HEAD", "OPTIONS"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(method, "/api/admin/check", nil))
		if w.Code != 202 {
			t.Fatal("safe reads must preserve their normal authentication/handler")
		}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/health", nil))
	var health map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &health); err != nil || health["mode"] != "read_only" || health["financial_operations_enabled"] != false || w.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatal("health must not claim financial readiness", w.Body.String())
	}
	if (&Config{}).ReadOnlyHandler(next) == nil {
		t.Fatal("normal router must remain available")
	}
}
