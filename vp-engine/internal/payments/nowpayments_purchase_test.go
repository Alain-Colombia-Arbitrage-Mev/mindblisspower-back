package payments

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNOWPurchaseProjectionFailsClosedOnEvidenceAndUnknownCreation(t *testing.T) {
	stamp := "2026-10-31T10:00:00Z"
	for _, tc := range []struct {
		name, payment, fulfillment string
		mutate                     func(*nowPurchaseSnapshot)
		actions                    bool
	}{
		{"unpaid", "awaiting_payment", "awaiting_payment", func(*nowPurchaseSnapshot) {}, true},
		{"creating", "invoice_unknown", "awaiting_payment", func(s *nowPurchaseSnapshot) { s.attemptState = "creating_invoice" }, false},
		{"unknown", "invoice_unknown", "awaiting_payment", func(s *nowPurchaseSnapshot) { s.attemptState = "invoice_unknown" }, false},
		{"waiting", "processing", "awaiting_payment", func(s *nowPurchaseSnapshot) { s.evidence, s.latestStatus = true, "waiting" }, false},
		{"payment_without_evidence", "under_review", "awaiting_payment", func(s *nowPurchaseSnapshot) { s.paymentID = "20" }, false},
		{"finished_not_activated", "completed", "awaiting_payment", func(s *nowPurchaseSnapshot) { s.finished, s.evidence = true, true }, false},
		{"activated", "completed", "activated", func(s *nowPurchaseSnapshot) { s.operationalState, s.finished, s.open = "activated", true, false }, false},
		{"activated_missing_proof", "under_review", "not_activated", func(s *nowPurchaseSnapshot) { s.operationalState = "activated" }, false},
		{"risk", "under_review", "not_activated", func(s *nowPurchaseSnapshot) { s.risk = true }, false},
		{"abandoned", "cancelled_local", "not_activated", func(s *nowPurchaseSnapshot) {
			s.CancelledAt, s.open, s.operationalState = &stamp, false, "security_blocked"
		}, false},
		{"late_payment", "under_review", "not_activated", func(s *nowPurchaseSnapshot) {
			s.CancelledAt, s.finished, s.evidence, s.operationalState = &stamp, true, true, "security_blocked"
		}, false},
		{"unknown_invoice", "under_review", "awaiting_payment", func(s *nowPurchaseSnapshot) { s.invoiceID = "https://evil.test" }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := nowPurchaseSnapshot{attemptState: "invoice_created", operationalState: "awaiting_payment", invoiceID: "9001", open: true}
			tc.mutate(&s)
			s.project()
			if s.PaymentStatus != tc.payment || s.FulfillmentStatus != tc.fulfillment || s.CanResume != tc.actions || s.CanCancel != tc.actions {
				t.Fatal("unsafe purchase projection", s.NOWPurchaseItem)
			}
		})
	}
}

func TestNOWPurchaseOperationalRequestKeyRequiredBeforeDatabase(t *testing.T) {
	store := &Store{nowOperational: true}
	for _, key := range []string{"", "client-text", "00000000-0000-0000-0000-000000000000", strings.ToUpper(syntheticNOWOrder)} {
		if _, err := store.CreateNOWPaymentsMembership(context.Background(), NOWPaymentsMembershipInput{PurchaseRequestID: key}); !errors.Is(err, ErrNOWPurchaseRequestInvalid) {
			t.Fatal("invalid request key reached database", err)
		}
	}
}

func TestNOWPurchaseResumeURLIsCanonicalNotCallerControlled(t *testing.T) {
	for _, tc := range []struct{ environment, id, want string }{
		{"production", "9001", "https://nowpayments.io/payment/?iid=9001"},
		{"sandbox", "1", "https://sandbox.nowpayments.io/payment/?iid=1"},
	} {
		if got, err := nowPurchaseInvoiceURL(tc.environment, tc.id); err != nil || got != tc.want {
			t.Fatal(got, err)
		}
	}
	for _, id := range []string{"", "0", "01", "9001&source=evil", "https://evil.test", strings.Repeat("1", 65)} {
		if _, err := nowPurchaseInvoiceURL("production", id); err == nil {
			t.Fatal("unsafe invoice ID accepted")
		}
	}
	if _, err := nowPurchaseInvoiceURL("client-host", "9001"); err == nil {
		t.Fatal("caller controlled environment accepted")
	}
}

func TestNOWPurchaseReusedInvoiceNeverCreatesAnotherProviderInvoice(t *testing.T) {
	h, client, store := fakeNOWMembershipHandler()
	h.nowMemberships.operational = true
	store.attempt.State, store.attempt.Reused, store.attempt.Reusable = "invoice_created", true, true
	for range 3 {
		invoice, err := h.nowMemberships.createInvoice(context.Background(), store.attempt)
		if err != nil || invoice.URL != "https://nowpayments.io/payment/?iid=9001" {
			t.Fatal(invoice, err)
		}
	}
	store.attempt.Reusable = false
	if _, err := h.nowMemberships.createInvoice(context.Background(), store.attempt); err == nil {
		t.Fatal("evidence-bearing or unknown reuse returned an invoice")
	}
	if client.creates != 0 || client.gets != 0 || store.attaches != 0 || store.unknowns != 0 {
		t.Fatal("reusing local snapshot contacted provider or mutated creation")
	}
}

type fakeNOWPurchases struct {
	fakeNOWMembershipPersistence
	calls                         int
	subject, email, order, action string
	err                           error
}

func (s *fakeNOWPurchases) ListNOWPurchases(_ context.Context, _, subject, email string) (NOWPurchaseHistory, error) {
	s.calls++
	s.subject, s.email, s.action = subject, email, "list"
	return NOWPurchaseHistory{Provider: "nowpayments", Purpose: "membership", Purchases: []NOWPurchaseItem{}}, s.err
}
func (s *fakeNOWPurchases) ResumeNOWPurchase(_ context.Context, _, subject, email, order string) (NOWPaymentsMembershipAttempt, error) {
	s.calls++
	s.subject, s.email, s.order, s.action = subject, email, order, "resume"
	return NOWPaymentsMembershipAttempt{ID: order, Environment: "production", InvoiceID: "9001", TotalCents: 10000, FeeUSD: "0.00", Reused: true, Reusable: true}, s.err
}
func (s *fakeNOWPurchases) CancelNOWPurchase(_ context.Context, _, subject, email, order string) (NOWPurchaseCancellationResult, error) {
	s.calls++
	s.subject, s.email, s.order, s.action = subject, email, order, "cancel"
	return NOWPurchaseCancellationResult{OrderID: order, State: "cancelled_local", LatePaymentPolicy: "review_required"}, s.err
}

func newFakeNOWPurchaseHandler() (*Handler, *fakeNOWPurchases, *fakeNOWMembershipClient) {
	h, client, _ := fakeNOWMembershipHandler()
	store := &fakeNOWPurchases{}
	h.nowMemberships.store, h.nowMemberships.operational = store, true
	h.serviceToken, h.requireVerified, h.verifier = "synthetic-service", true, fakeNOWSubject{}
	return h, store, client
}

func purchaseHTTPRequest(method, path, body string) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("X-VP-Service-Token", "synthetic-service")
	r.Header.Set(idTokenHeader, "synthetic-token")
	r.Header.Set("Content-Type", "application/json")
	return r
}

func TestNOWPurchaseRoutesUseVerifiedOwnerWithoutProviderCalls(t *testing.T) {
	for _, path := range []string{nowPurchasesPath, nowPurchasesPath + "/resume", nowPurchasesPath + "/cancel"} {
		h, store, client := newFakeNOWPurchaseHandler()
		method := http.MethodPost
		if path == nowPurchasesPath {
			method = http.MethodGet
		}
		r := purchaseHTTPRequest(method, path, `{"order_id":"`+syntheticNOWOrder+`"}`)
		w := httptest.NewRecorder()
		(&Config{ReadOnly: true, NOWPaymentsOperational: NOWPaymentsOperationalSettings{Enabled: true}}).ReadOnlyHandler(h.Routes()).ServeHTTP(w, r)
		if w.Code != http.StatusOK || store.calls != 1 || store.subject != "signed-subject" || store.email != "member@example.test" || client.creates != 0 || client.gets != 0 || w.Header().Get("Cache-Control") != "private, no-store" {
			t.Fatal(path, w.Code, w.Body.String(), store.calls)
		}
		if path == nowPurchasesPath+"/cancel" && !strings.Contains(w.Body.String(), `"provider_invoice_revoked":false`) {
			t.Fatal("local abandonment claimed provider cancellation")
		}
	}
}

func TestNOWPurchaseRoutesRejectUntrustedInputBeforeStore(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		mutate     func(*http.Request)
	}{
		{"invalid_uuid", `{"order_id":"1"}`, func(*http.Request) {}},
		{"extra_identity", `{"order_id":"` + syntheticNOWOrder + `","email":"victim@example.test"}`, func(*http.Request) {}},
		{"duplicate_order", `{"order_id":"` + syntheticNOWOrder + `","order_id":"` + syntheticNOWOrder + `"}`, func(*http.Request) {}},
		{"trailing_json", `{"order_id":"` + syntheticNOWOrder + `"}{}`, func(*http.Request) {}},
		{"missing_service", `{"order_id":"` + syntheticNOWOrder + `"}`, func(r *http.Request) { r.Header.Del("X-VP-Service-Token") }},
		{"missing_jwt", `{"order_id":"` + syntheticNOWOrder + `"}`, func(r *http.Request) { r.Header.Del(idTokenHeader) }},
		{"impersonation", `{"order_id":"` + syntheticNOWOrder + `"}`, func(r *http.Request) { r.Header.Set(actAsHeader, "victim@example.test") }},
		{"query", `{"order_id":"` + syntheticNOWOrder + `"}`, func(r *http.Request) { r.URL.RawQuery = "order_id=" + syntheticNOWOrder }},
		{"media", `{"order_id":"` + syntheticNOWOrder + `"}`, func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, store, client := newFakeNOWPurchaseHandler()
			r := purchaseHTTPRequest(http.MethodPost, nowPurchasesPath+"/cancel", tc.body)
			tc.mutate(r)
			w := httptest.NewRecorder()
			h.Routes().ServeHTTP(w, r)
			if w.Code < 400 || store.calls != 0 || client.creates != 0 || client.gets != 0 {
				t.Fatal("untrusted input reached persistence", w.Code, w.Body.String())
			}
		})
	}
}

func TestNOWPurchaseHistorySurvivesCheckoutPauseButPostDoesNot(t *testing.T) {
	h, store, _ := newFakeNOWPurchaseHandler()
	h.nowMemberships.operational = false
	for _, tc := range []struct {
		method, path string
		want         int
	}{{http.MethodGet, nowPurchasesPath, 200}, {http.MethodPost, nowPurchasesPath + "/cancel", 503}} {
		w := httptest.NewRecorder()
		r := purchaseHTTPRequest(tc.method, tc.path, `{"order_id":"`+syntheticNOWOrder+`"}`)
		(&Config{ReadOnly: true, NOWPaymentsCapture: NOWPaymentsCaptureSettings{Enabled: true}}).ReadOnlyHandler(h.Routes()).ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if store.calls != 1 {
		t.Fatal("paused write reached persistence")
	}
}

func TestNOWPurchaseFailureDoesNotLeakBackendDetails(t *testing.T) {
	h, store, _ := newFakeNOWPurchaseHandler()
	store.err = errors.New("postgres://sensitive sql relation")
	w := httptest.NewRecorder()
	h.Routes().ServeHTTP(w, purchaseHTTPRequest(http.MethodPost, nowPurchasesPath+"/resume", `{"order_id":"`+syntheticNOWOrder+`"}`))
	if w.Code != 503 || strings.Contains(w.Body.String(), "postgres") || strings.Contains(w.Body.String(), "sensitive") {
		t.Fatal(w.Code, w.Body.String())
	}
}
