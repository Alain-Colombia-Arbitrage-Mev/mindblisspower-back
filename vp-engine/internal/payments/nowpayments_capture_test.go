package payments

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/vicionpower/vp-engine/internal/nowpayments"
)

type fakeNOWCaptureStore struct {
	captures, reads       int
	err                   error
	subject, email, order string
	status                NOWPaymentsCaptureStatus
}

func (s *fakeNOWCaptureStore) Capture(_ context.Context, _ string, _, _ nowpayments.Payment, _ string) error {
	s.captures++
	return s.err
}
func (s *fakeNOWCaptureStore) OwnedStatus(_ context.Context, _, order, subject, email string) (NOWPaymentsCaptureStatus, error) {
	s.reads++
	s.subject, s.email, s.order = subject, email, order
	return s.status, s.err
}

type fakeNOWSubject struct{ err error }

func (v fakeNOWSubject) VerifyEmail(context.Context, string) (string, error) {
	return "member@example.test", v.err
}
func (v fakeNOWSubject) VerifySubject(context.Context, string) (string, string, error) {
	return "signed-subject", "member@example.test", v.err
}

func fakeCaptureHandler() (*Handler, *fakeNOWMembershipClient, *fakeNOWCaptureStore) {
	h, client, _ := fakeNOWMembershipHandler()
	client.signed.PriceAmount, client.authoritative.PriceAmount = "101.00", "101.00"
	client.signed.PriceCurrency, client.authoritative.PriceCurrency = "usd", "usd"
	client.signed.PayCurrency, client.authoritative.PayCurrency = "trx", "trx"
	client.authoritative.PayAmount, client.authoritative.ActuallyPaid = "10", "10"
	s := &fakeNOWCaptureStore{status: pendingNOWCaptureStatus(syntheticNOWOrder)}
	h.nowCapture = &nowPaymentsCapture{client: client, store: s, environment: "production"}
	h.serviceToken = "synthetic-service"
	h.verifier = fakeNOWSubject{}
	h.requireVerified = true
	return h, client, s
}

func TestNOWCapturePersistsUnknownOrderWithoutInvoiceCreationOrActivation(t *testing.T) {
	h, c, s := fakeCaptureHandler()
	c.signed.OrderID, c.authoritative.OrderID = "external-unknown-order", "external-unknown-order"
	r := httptest.NewRequest(http.MethodPost, "/api/webhooks/nowpayments", strings.NewReader(`{"synthetic":true}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("x-nowpayments-sig", strings.Repeat("a", 128))
	w := httptest.NewRecorder()
	(&Config{ReadOnly: true, NOWPaymentsCapture: NOWPaymentsCaptureSettings{Enabled: true}}).ReadOnlyHandler(h.Routes()).ServeHTTP(w, r)
	if w.Code != 200 || s.captures != 1 || c.gets != 1 || c.creates != 0 || !strings.Contains(w.Body.String(), `"fulfillment_status":"not_activated"`) || !strings.Contains(w.Body.String(), `"state":"captured"`) {
		t.Fatal("capture must persist quarantined evidence only", w.Code, w.Body.String())
	}
}

func TestNOWCaptureFailuresNeverAcknowledgeUnpersistedEvidence(t *testing.T) {
	for _, tc := range []struct {
		name           string
		code           int
		mutate         func(*fakeNOWMembershipClient, *fakeNOWCaptureStore)
		captures, gets int
	}{
		{"signature", 401, func(c *fakeNOWMembershipClient, _ *fakeNOWCaptureStore) { c.verifyErr = errors.New("private") }, 0, 0},
		{"provider", 503, func(c *fakeNOWMembershipClient, _ *fakeNOWCaptureStore) { c.getErr = errors.New("private") }, 0, 1},
		{"mismatch", 409, func(c *fakeNOWMembershipClient, _ *fakeNOWCaptureStore) { c.authoritative.OrderID = "other" }, 0, 1},
		{"persistence", 503, func(_ *fakeNOWMembershipClient, s *fakeNOWCaptureStore) { s.err = errors.New("private") }, 1, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, c, s := fakeCaptureHandler()
			tc.mutate(c, s)
			r := httptest.NewRequest(http.MethodPost, "/api/webhooks/nowpayments", strings.NewReader(`{}`))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("x-nowpayments-sig", strings.Repeat("a", 128))
			w := httptest.NewRecorder()
			h.handleNOWPaymentsWebhook(w, r)
			if w.Code != tc.code || c.creates != 0 || s.captures != tc.captures || c.gets != tc.gets || strings.Contains(w.Body.String(), "private") || strings.Contains(w.Body.String(), `"received":true`) {
				t.Fatal("unsafe capture failure", w.Code, w.Body.String())
			}
		})
	}
}

func TestNOWCaptureReadOnlyExceptionDoesNotUnlockFinancialRoutes(t *testing.T) {
	cfg := &Config{ReadOnly: true, NOWPaymentsCapture: NOWPaymentsCaptureSettings{Enabled: true}}
	for _, path := range []string{"/api/payments/checkout", "/api/payments/resume", "/api/webhooks/stripe", "/api/admin/sales/reconcile", "/api/webhooks/nowpayments/", "/api/webhooks/nowpayments%2f"} {
		t.Run(path, func(t *testing.T) {
			called := false
			handler := cfg.ReadOnlyHandler(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, httptest.NewRequest(http.MethodPost, path, nil))
			if called || w.Code != 503 {
				t.Fatal("capture unlocked another write")
			}
		})
	}
	if cfg.ExternalProvidersEnabled() || cfg.BackgroundJobsEnabled() {
		t.Fatal("capture must not enable providers or jobs")
	}
}

func TestNOWCaptureStatusRequiresSignedSubjectAndExactQuery(t *testing.T) {
	for _, tc := range []struct {
		name, query, token, service, actAs string
		verifier                           IdentityVerifier
		code                               int
	}{
		{"valid", "order_id=" + syntheticNOWOrder, "synthetic", "synthetic-service", "", fakeNOWSubject{}, 200},
		{"no-token", "order_id=" + syntheticNOWOrder, "", "synthetic-service", "", fakeNOWSubject{}, 401},
		{"wrong-service", "order_id=" + syntheticNOWOrder, "synthetic", "wrong", "", fakeNOWSubject{}, 401},
		{"bad-token", "order_id=" + syntheticNOWOrder, "synthetic", "synthetic-service", "", fakeNOWSubject{err: errors.New("secret")}, 401},
		{"email-only-verifier", "order_id=" + syntheticNOWOrder, "synthetic", "synthetic-service", "", nil, 401},
		{"claimed-email", "order_id=" + syntheticNOWOrder + "&email=other@example.test", "synthetic", "synthetic-service", "", fakeNOWSubject{}, 400},
		{"duplicate", "order_id=" + syntheticNOWOrder + "&order_id=" + syntheticNOWOrder, "synthetic", "synthetic-service", "", fakeNOWSubject{}, 400},
		{"noncanonical", "order_id=3F3FBA2C-D836-430D-B45E-63FD73050384", "synthetic", "synthetic-service", "", fakeNOWSubject{}, 400},
		{"impersonation", "order_id=" + syntheticNOWOrder, "synthetic", "synthetic-service", "other@example.test", fakeNOWSubject{}, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, _, s := fakeCaptureHandler()
			h.verifier = tc.verifier
			r := httptest.NewRequest(http.MethodGet, "/api/payments/nowpayments/status?"+tc.query, nil)
			r.Header.Set(idTokenHeader, tc.token)
			r.Header.Set("X-VP-Service-Token", tc.service)
			r.Header.Set(actAsHeader, tc.actAs)
			w := httptest.NewRecorder()
			h.handleNOWPaymentsCaptureStatus(w, r)
			if w.Code != tc.code || (tc.code != 200 && s.reads != 0) {
				t.Fatal("status authorization failed", w.Code)
			}
			if tc.code == 200 && (s.subject != "signed-subject" || s.email != "member@example.test" || s.order != syntheticNOWOrder) {
				t.Fatal("owner not derived from signed subject")
			}
		})
	}
}

func TestNOWCaptureSettingsAreExplicitAndReadOnlyIndependent(t *testing.T) {
	for _, name := range []string{"NOWPAYMENTS_WEBHOOK_CAPTURE_ENABLED", "NOWPAYMENTS_WEBHOOK_DATABASE_URL", "NOWPAYMENTS_API_KEY", "NOWPAYMENTS:API_KEY", "NOWPAYMENTS_IPN_SECRET", "NOWPAYMENTS_ENV", "ENV"} {
		t.Setenv(name, "")
	}
	for _, flag := range []string{"", "false", "TRUE", "1", " true "} {
		t.Setenv("NOWPAYMENTS_WEBHOOK_CAPTURE_ENABLED", flag)
		s, err := loadNOWPaymentsCaptureSettings("reader")
		if err != nil || s.Enabled || s.Client.APIKey != "" {
			t.Fatal("capture requires literal true")
		}
	}
	t.Setenv("NOWPAYMENTS_WEBHOOK_CAPTURE_ENABLED", "true")
	if _, err := loadNOWPaymentsCaptureSettings("reader"); err == nil {
		t.Fatal("incomplete capture enabled")
	}
	t.Setenv("NOWPAYMENTS_WEBHOOK_DATABASE_URL", "separate-writer")
	t.Setenv("NOWPAYMENTS_API_KEY", "synthetic-key")
	t.Setenv("NOWPAYMENTS_IPN_SECRET", "synthetic-secret")
	t.Setenv("NOWPAYMENTS_ENV", "production")
	t.Setenv("ENV", "production")
	s, err := loadNOWPaymentsCaptureSettings("reader")
	if err != nil || !s.Enabled {
		t.Fatal("valid separate capture rejected")
	}
	encoded, _ := json.Marshal(s)
	if string(encoded) != "{}" || strings.Contains(s.String(), "synthetic") {
		t.Fatal("capture configuration leaked")
	}
	if _, err := loadNOWPaymentsCaptureSettings("separate-writer"); err == nil {
		t.Fatal("reader DSN reused as writer")
	}
	t.Setenv("ENV", "development")
	if _, err := loadNOWPaymentsCaptureSettings("reader"); err == nil {
		t.Fatal("mixed environments accepted")
	}
}
