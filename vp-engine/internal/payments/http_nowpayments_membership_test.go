package payments

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/rs/zerolog"
	"github.com/vicionpower/vp-engine/internal/nowpayments"
)

const syntheticNOWOrder = "3f3fba2c-d836-430d-b45e-63fd73050384"

type fakeNOWMembershipClient struct {
	creates, verifies, gets      int
	createErr, verifyErr, getErr error
	signed, authoritative        nowpayments.Payment
	request                      nowpayments.InvoiceRequest
}

func (c *fakeNOWMembershipClient) CreateInvoice(_ context.Context, in nowpayments.InvoiceRequest) (nowpayments.Invoice, error) {
	c.creates++
	c.request = in
	return nowpayments.Invoice{ID: "9001", URL: "https://nowpayments.io/payment/?iid=9001"}, c.createErr
}
func (c *fakeNOWMembershipClient) GetPayment(_ context.Context, _ string) (nowpayments.Payment, error) {
	c.gets++
	return c.authoritative, c.getErr
}
func (c *fakeNOWMembershipClient) VerifyIPN(_ []byte, _ string) (nowpayments.Payment, error) {
	c.verifies++
	return c.signed, c.verifyErr
}

type fakeNOWMembershipPersistence struct {
	creates, attaches, unknowns, lookups, records int
	attempt                                       NOWPaymentsMembershipAttempt
	createErr, attachErr, lookupErr, recordErr    error
	digest                                        string
}

func (s *fakeNOWMembershipPersistence) CreateNOWPaymentsMembership(_ context.Context, _ NOWPaymentsMembershipInput) (NOWPaymentsMembershipAttempt, error) {
	s.creates++
	return s.attempt, s.createErr
}
func (s *fakeNOWMembershipPersistence) AttachNOWPaymentsInvoice(_ context.Context, _, _, _ string) error {
	s.attaches++
	return s.attachErr
}
func (s *fakeNOWMembershipPersistence) MarkNOWPaymentsInvoiceUnknown(_ context.Context, _, _ string) error {
	s.unknowns++
	return nil
}
func (s *fakeNOWMembershipPersistence) LookupNOWPaymentsMembership(_ context.Context, _, _ string) (NOWPaymentsMembershipAttempt, error) {
	s.lookups++
	return s.attempt, s.lookupErr
}
func (s *fakeNOWMembershipPersistence) RecordNOWPaymentsReceipt(_ context.Context, _ string, _, _ nowpayments.Payment, digest string) (NOWPaymentsReceiptResult, error) {
	s.records++
	s.digest = digest
	return NOWPaymentsReceiptResult{State: "pending_review", Finished: true}, s.recordErr
}

func fakeNOWMembershipHandler() (*Handler, *fakeNOWMembershipClient, *fakeNOWMembershipPersistence) {
	payment := nowpayments.Payment{OrderID: syntheticNOWOrder, InvoiceID: "9001", PaymentID: "8001", Status: "finished"}
	client := &fakeNOWMembershipClient{signed: payment, authoritative: payment}
	store := &fakeNOWMembershipPersistence{attempt: NOWPaymentsMembershipAttempt{
		ID: syntheticNOWOrder, Environment: "production", State: "creating_invoice", InvoiceID: "9001", TotalCents: 10100, FeeUSD: "1.00"}}
	h := &Handler{log: zerolog.Nop(), nowMemberships: &nowPaymentsMemberships{
		client: client, store: store, environment: "production", callbackURL: "https://mindblisspower.com/api/webhooks/nowpayments",
		successURL: "https://mindblisspower.com/dashboard/packages?payment_provider=nowpayments&status=review",
		cancelURL:  "https://mindblisspower.com/dashboard/packages?payment_provider=nowpayments&status=cancelled"}}
	return h, client, store
}

func TestMembershipProviderWhitelist(t *testing.T) {
	for _, value := range []string{"", "stripe", "nowpayments"} {
		if _, err := membershipProvider(value); err != nil {
			t.Fatal(err)
		}
	}
	for _, value := range []string{"STRIPE", " nowpayments", "nowpayments ", "wallet", "deposit", "crypto", "sandbox"} {
		if _, err := membershipProvider(value); err == nil {
			t.Fatalf("accepted %q", value)
		}
	}
}

func TestNOWMembershipSetterRejectsMixedEnvironmentAndReturnTargets(t *testing.T) {
	for _, tc := range []struct {
		environment, callback, success string
		valid                          bool
	}{
		{"production", "https://mindblisspower.com/api/webhooks/nowpayments", "https://mindblisspower.com/dashboard/packages?payment_provider=nowpayments&status=review", true},
		{"sandbox", "https://mindblisspower.com/api/webhooks/nowpayments", "https://mindblisspower.com/dashboard/packages?payment_provider=nowpayments&status=review", false},
		{"production", "https://mindblisspower.com.evil.test/api/webhooks/nowpayments", "https://mindblisspower.com/dashboard/packages?payment_provider=nowpayments&status=review", false},
		{"production", "https://mindblisspower.com/api/webhooks/nowpayments", "https://mindblisspower.com/dashboard/packages?status=paid", false},
		{"production", "https://mindblisspower.com/api/webhooks/nowpayments?redirect=evil", "https://mindblisspower.com/dashboard/packages?payment_provider=nowpayments&status=review", false},
	} {
		client, err := nowpayments.New(nowpayments.Config{APIKey: "synthetic", IPNSecret: "synthetic"})
		if err != nil {
			t.Fatal(err)
		}
		h := &Handler{store: &Store{}}
		err = h.SetNOWPayments(client, tc.environment, tc.callback, tc.success, "https://mindblisspower.com/dashboard/packages?payment_provider=nowpayments&status=cancelled")
		if (err == nil) != tc.valid || (h.nowMemberships != nil) != tc.valid {
			t.Fatalf("invalid runtime accepted: %+v", tc)
		}
	}
}

func TestNOWMembershipInvoiceRejectsInvalidPersistedSnapshotBeforeProvider(t *testing.T) {
	for _, change := range []func(*NOWPaymentsMembershipAttempt){
		func(a *NOWPaymentsMembershipAttempt) { a.ID = "client-input" },
		func(a *NOWPaymentsMembershipAttempt) { a.Environment = "sandbox" },
		func(a *NOWPaymentsMembershipAttempt) { a.State = "invoice_created" },
		func(a *NOWPaymentsMembershipAttempt) { a.TotalCents = 0 },
	} {
		h, client, store := fakeNOWMembershipHandler()
		change(&store.attempt)
		if _, err := h.nowMemberships.createInvoice(context.Background(), store.attempt); err == nil {
			t.Fatal("invalid persisted snapshot accepted")
		}
		if client.creates != 0 || store.attaches != 0 || store.unknowns != 0 {
			t.Fatal("invalid order reached the provider")
		}
	}
}

func TestNOWMembershipCheckoutDisabledBeforeDatabaseOrProvider(t *testing.T) {
	for _, body := range []string{
		`{"email":"buyer@example.test","package_id":1,"provider":"nowpayments"}`,
		`{"email":"buyer@example.test","package_id":1,"provider":"wallet"}`,
		`{"email":"buyer@example.test","package_id":1,"provider":"nowpayments"} {}`,
	} {
		h := NewHandler(nil, nil, "test-service", nil, 0, zerolog.Nop())
		h.SetIdentityVerifier(fakeVerifier{email: "buyer@example.test"}, true)
		r := httptest.NewRequest(http.MethodPost, "/api/payments/checkout", strings.NewReader(body))
		r.Header.Set("X-VP-Service-Token", "test-service")
		r.Header.Set(idTokenHeader, "synthetic-token")
		w := httptest.NewRecorder()
		h.handleCheckout(w, r)
		if w.Code != http.StatusBadRequest && w.Code != http.StatusServiceUnavailable {
			t.Fatalf("unsafe status %d", w.Code)
		}
		if w.Header().Get("Cache-Control") != "private, no-store" {
			t.Fatal("checkout must not be cached")
		}
	}
}

func TestNOWMembershipInvoiceFailureNeverRetriesOrHandsOutURL(t *testing.T) {
	for _, providerFails := range []bool{true, false} {
		h, client, store := fakeNOWMembershipHandler()
		if providerFails {
			client.createErr = errors.New("sensitive provider failure")
		} else {
			store.attachErr = errors.New("attach failed")
		}
		w := httptest.NewRecorder()
		h.handleNOWMembershipCheckout(w, httptest.NewRequest(http.MethodPost, "/", nil), checkoutRequest{Email: "verified@example.test", PackageID: 1}, nil, "")
		if w.Code != http.StatusServiceUnavailable || client.creates != 1 || store.unknowns != 1 {
			t.Fatalf("unsafe failure: %d/%d/%d", w.Code, client.creates, store.unknowns)
		}
		if strings.Contains(w.Body.String(), "https://") || strings.Contains(w.Body.String(), "sensitive") {
			t.Fatal("invoice URL or provider error leaked")
		}
	}
}

func TestNOWMembershipInvoiceUsesOnlyPersistedSnapshot(t *testing.T) {
	h, client, store := fakeNOWMembershipHandler()
	w := httptest.NewRecorder()
	h.handleNOWMembershipCheckout(w, httptest.NewRequest(http.MethodPost, "/", nil), checkoutRequest{Email: "verified@example.test", PackageID: 1}, nil, "")
	if w.Code != http.StatusOK || client.request.AmountUSDMinor != 10100 || client.request.OrderID != syntheticNOWOrder || store.attaches != 1 {
		t.Fatal("invoice not bound to persisted order")
	}
	if !strings.Contains(w.Body.String(), `"provider":"nowpayments"`) || !strings.Contains(w.Body.String(), `"fulfillment_status":"review_required"`) {
		t.Fatal("membership provider/review state missing")
	}
	if strings.Contains(client.request.Description, "@") {
		t.Fatal("email must not be sent in the invoice")
	}
	returned, err := url.Parse(client.request.SuccessURL)
	if err != nil || returned.Scheme != "https" || returned.Host != "mindblisspower.com" || returned.Path != "/dashboard/packages" ||
		len(returned.Query()) != 3 || returned.Query().Get("order_id") != store.attempt.ID ||
		returned.Query().Get("payment_provider") != "nowpayments" || returned.Query().Get("status") != "review" {
		t.Fatal("return URL must carry only the persisted order, provider and review state")
	}
	if client.request.CancelURL != h.nowMemberships.cancelURL || strings.Contains(client.request.CancelURL, "order_id") ||
		client.request.CallbackURL != h.nowMemberships.callbackURL {
		t.Fatal("order return must not alter cancellation or webhook targets")
	}
}

func TestNOWMembershipReturnURLFailsClosedBeforeProvider(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*nowPaymentsMemberships, *NOWPaymentsMembershipAttempt)
	}{
		{"caller-controlled-id", func(_ *nowPaymentsMemberships, a *NOWPaymentsMembershipAttempt) { a.ID = "client-id&status=paid" }},
		{"foreign-origin", func(f *nowPaymentsMemberships, _ *NOWPaymentsMembershipAttempt) {
			f.successURL = "https://evil.example/dashboard/packages?payment_provider=nowpayments&status=review"
		}},
		{"spoofed-success", func(f *nowPaymentsMemberships, _ *NOWPaymentsMembershipAttempt) {
			f.successURL = "https://mindblisspower.com/dashboard/packages?payment_provider=nowpayments&status=paid"
		}},
		{"preloaded-id", func(f *nowPaymentsMemberships, _ *NOWPaymentsMembershipAttempt) {
			f.successURL += "&order_id=" + syntheticNOWOrder
		}},
		{"foreign-cancel", func(f *nowPaymentsMemberships, _ *NOWPaymentsMembershipAttempt) {
			f.cancelURL = "https://evil.example/cancel"
		}},
		{"callback-alias", func(f *nowPaymentsMemberships, _ *NOWPaymentsMembershipAttempt) {
			f.callbackURL = "https://mindblisspower.com/api/webhooks/nowpayments?redirect=evil"
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, c, s := fakeNOWMembershipHandler()
			tc.change(h.nowMemberships, &s.attempt)
			if _, err := h.nowMemberships.createInvoice(context.Background(), s.attempt); err == nil {
				t.Fatal("unsafe return accepted")
			}
			if c.creates != 0 || s.attaches != 0 || s.unknowns != 0 {
				t.Fatal("invalid return reached provider or persistence")
			}
		})
	}
}

func TestNOWMembershipReturnURLUsesTrustedSandboxAndEachServerOrder(t *testing.T) {
	h, c, s := fakeNOWMembershipHandler()
	f := h.nowMemberships
	f.environment = "sandbox"
	f.callbackURL = "https://payments-sandbox.example.com/api/webhooks/nowpayments"
	f.successURL = "https://payments-sandbox.example.com/dashboard/packages?payment_provider=nowpayments&status=review"
	f.cancelURL = "https://payments-sandbox.example.com/dashboard/packages?payment_provider=nowpayments&status=cancelled"
	s.attempt.Environment = "sandbox"
	for _, id := range []string{syntheticNOWOrder, "2e6e5304-a6df-451f-8799-d0a5bbbe902a"} {
		s.attempt.ID = id
		if _, err := f.createInvoice(context.Background(), s.attempt); err != nil {
			t.Fatal(err)
		}
		u, err := url.Parse(c.request.SuccessURL)
		if err != nil || u.Host != "payments-sandbox.example.com" || u.Query().Get("order_id") != id || len(u.Query()["order_id"]) != 1 {
			t.Fatal("server order was reused or sandbox origin changed")
		}
		if c.request.OrderID != id || c.request.CancelURL != f.cancelURL {
			t.Fatal("invoice identity or cancellation changed")
		}
	}
}

func TestNOWMembershipWebhookValidationAndAcknowledgement(t *testing.T) {
	for _, tc := range []struct {
		name                  string
		change                func(*http.Request, *fakeNOWMembershipClient, *fakeNOWMembershipPersistence)
		status, gets, records int
	}{
		{"valid review only", func(*http.Request, *fakeNOWMembershipClient, *fakeNOWMembershipPersistence) {}, 200, 1, 1},
		{"signature missing", func(r *http.Request, _ *fakeNOWMembershipClient, _ *fakeNOWMembershipPersistence) {
			r.Header.Del("x-nowpayments-sig")
		}, 401, 0, 0},
		{"bad signature", func(_ *http.Request, c *fakeNOWMembershipClient, _ *fakeNOWMembershipPersistence) {
			c.verifyErr = nowpayments.ErrSignature
		}, 401, 0, 0},
		{"not JSON", func(r *http.Request, _ *fakeNOWMembershipClient, _ *fakeNOWMembershipPersistence) {
			r.Header.Set("Content-Type", "text/plain")
		}, 415, 0, 0},
		{"foreign invoice", func(_ *http.Request, c *fakeNOWMembershipClient, _ *fakeNOWMembershipPersistence) {
			c.signed.InvoiceID = "9999"
		}, 409, 0, 0},
		{"unknown order", func(_ *http.Request, _ *fakeNOWMembershipClient, s *fakeNOWMembershipPersistence) {
			s.lookupErr = ErrNOWPaymentsAttemptNotFound
		}, 404, 0, 0},
		{"malformed order", func(_ *http.Request, c *fakeNOWMembershipClient, _ *fakeNOWMembershipPersistence) {
			c.signed.OrderID = "not-an-order"
		}, 400, 0, 0},
		{"API unavailable", func(_ *http.Request, c *fakeNOWMembershipClient, _ *fakeNOWMembershipPersistence) {
			c.getErr = nowpayments.ErrProvider
		}, 503, 1, 0},
		{"mismatched API evidence", func(_ *http.Request, _ *fakeNOWMembershipClient, s *fakeNOWMembershipPersistence) {
			s.recordErr = ErrNOWPaymentsEvidence
		}, 409, 1, 1},
		{"DB failed cannot acknowledge", func(_ *http.Request, _ *fakeNOWMembershipClient, s *fakeNOWMembershipPersistence) {
			s.recordErr = errors.New("sensitive database error")
		}, 503, 1, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, client, store := fakeNOWMembershipHandler()
			r := httptest.NewRequest(http.MethodPost, "/api/webhooks/nowpayments", strings.NewReader(`{"synthetic":true}`))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("x-nowpayments-sig", strings.Repeat("a", 128))
			tc.change(r, client, store)
			w := httptest.NewRecorder()
			h.handleNOWPaymentsWebhook(w, r)
			if w.Code != tc.status || client.gets != tc.gets || store.records != tc.records {
				t.Fatalf("status/calls %d/%d/%d", w.Code, client.gets, store.records)
			}
			if strings.Contains(w.Body.String(), "sensitive") || strings.Contains(w.Body.String(), `"activated"`) {
				t.Fatal("unsafe acknowledgement")
			}
			if tc.status == 200 && (len(store.digest) != 64 || !strings.Contains(w.Body.String(), `"fulfillment_status":"review_required"`)) {
				t.Fatal("missing durable receipt digest or review state")
			}
		})
	}
}

func TestNOWMembershipWebhookReadOnlyAndSizeBoundaries(t *testing.T) {
	h, client, store := fakeNOWMembershipHandler()
	for _, tc := range []struct {
		readonly     bool
		method, body string
		status       int
	}{
		{true, http.MethodPost, `{}`, 503}, {false, http.MethodGet, `{}`, 405},
		{false, http.MethodPost, strings.Repeat("x", (128<<10)+1), 413},
	} {
		r := httptest.NewRequest(tc.method, "/api/webhooks/nowpayments", strings.NewReader(tc.body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("x-nowpayments-sig", strings.Repeat("a", 128))
		w := httptest.NewRecorder()
		(&Config{ReadOnly: tc.readonly}).ReadOnlyHandler(http.HandlerFunc(h.handleNOWPaymentsWebhook)).ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("status %d", w.Code)
		}
	}
	if client.verifies != 0 || client.gets != 0 || store.records != 0 {
		t.Fatal("unsafe requests reached provider/evidence store")
	}
}
