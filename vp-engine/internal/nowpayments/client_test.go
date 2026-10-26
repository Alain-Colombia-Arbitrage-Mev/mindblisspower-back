package nowpayments

import (
	"context"
	"crypto/hmac"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

const paymentJSON = `{"payment_id":123456789,"invoice_id":"777","order_id":"mindbliss-order_123","payment_status":"finished","price_amount":1353,"price_currency":"usd","pay_amount":15,"actually_paid":15,"pay_currency":"trx"}`

func TestIPNCanonicalKeysMatchJavaScriptEnumeration(t *testing.T) {
	input := []byte(`{"z":{"10":"ten","2":"two","01":"leading"},"\ue000":1,"\ud83d\ude00":2,"0":"zero","10":"ten","2":"two"}`)
	got, err := canonicalJSON(input)
	want := "{\"0\":\"zero\",\"2\":\"two\",\"10\":\"ten\",\"z\":{\"2\":\"two\",\"10\":\"ten\",\"01\":\"leading\"},\"\U0001F600\":2,\"\uE000\":1}"
	if err != nil || string(got) != want {
		t.Fatal("IPN keys must follow JavaScript numeric-index and UTF-16 ordering")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func mockClient(t *testing.T, fn roundTripFunc) *Client {
	t.Helper()
	c, err := New(Config{APIKey: "test-server-only-api-key", IPNSecret: "test-ipn-secret", HTTPClient: &http.Client{Transport: fn}})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func response(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}

func TestInvoiceUsesExactCentsAndSafeHostedURL(t *testing.T) {
	var calls int
	c := mockClient(t, func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.String() != productionAPI+"/invoice" || r.Method != http.MethodPost || r.Header.Get("x-api-key") != "test-server-only-api-key" {
			t.Fatal("incorrect server API request")
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(body), `"price_amount":1353.01`) || !strings.Contains(string(body), `"price_currency":"usd"`) {
			t.Fatalf("cents not exact: %s", body)
		}
		if _, ok := r.Context().Deadline(); !ok {
			t.Fatal("missing bounded request deadline")
		}
		return response(201, `{"id":777,"invoice_url":"https://nowpayments.io/payment/?iid=777"}`), nil
	})
	in := InvoiceRequest{OrderID: "mindbliss-order_123", AmountUSDMinor: 135301, CallbackURL: "https://mindblisspower.com/api/payments/nowpayments/ipn", SuccessURL: "https://mindblisspower.com/dashboard/deposits", CancelURL: "https://mindblisspower.com/dashboard/deposits"}
	got, err := c.CreateInvoice(context.Background(), in)
	if err != nil || got.ID != "777" || calls != 1 {
		t.Fatalf("got %#v, error %v", got, err)
	}
}

func TestInvoiceRejectsMissingIPNAndUnsafeInputsBeforeProvider(t *testing.T) {
	c := mockClient(t, func(*http.Request) (*http.Response, error) { t.Fatal("provider must not be called"); return nil, nil })
	in := InvoiceRequest{OrderID: "order_1", AmountUSDMinor: 100, CallbackURL: "https://mindblisspower.com/ipn", SuccessURL: "https://mindblisspower.com/success", CancelURL: "https://mindblisspower.com/cancel"}
	c.ipnSecret = ""
	if _, err := c.CreateInvoice(context.Background(), in); !errors.Is(err, ErrConfiguration) {
		t.Fatal("missing IPN accepted")
	}
	c.ipnSecret = "test-ipn-secret"
	for _, mutate := range []func(*InvoiceRequest){
		func(i *InvoiceRequest) { i.OrderID = "../untrusted" },
		func(i *InvoiceRequest) { i.AmountUSDMinor = 0 },
		func(i *InvoiceRequest) { i.AmountUSDMinor = -1 },
		func(i *InvoiceRequest) { i.CallbackURL = "http://example.com/ipn" },
		func(i *InvoiceRequest) { i.SuccessURL = "https://evil@example.com/success" },
		func(i *InvoiceRequest) { i.CancelURL = "javascript:alert(1)" },
	} {
		bad := in
		mutate(&bad)
		if _, err := c.CreateInvoice(context.Background(), bad); !errors.Is(err, ErrInvalidInput) {
			t.Fatal("invalid input accepted")
		}
	}
}

func TestInvoiceRejectsUntrustedProviderRedirectURLs(t *testing.T) {
	for _, raw := range []string{"https://evil.example/payment/?iid=777", "https://nowpayments.io.evil.example/payment/?iid=777", "https://nowpayments.io:443/payment/?iid=777", "https://nowpayments.io/payment/?iid=778", "https://nowpayments.io/login?iid=777", "http://nowpayments.io/payment/?iid=777", "https://nowpayments.io/payment/?iid=777&iid=778", "https://nowpayments.io/payment/?iid=777&redirect=https://evil.example", "https://nowpayments.io/payment/?iid=777&success_url=https://evil.example"} {
		t.Run(raw, func(t *testing.T) {
			c := mockClient(t, func(*http.Request) (*http.Response, error) {
				return response(201, `{"id":777,"invoice_url":"`+raw+`"}`), nil
			})
			_, err := c.CreateInvoice(context.Background(), InvoiceRequest{OrderID: "order", AmountUSDMinor: 100, CallbackURL: "https://example.com/ipn", SuccessURL: "https://example.com/success", CancelURL: "https://example.com/cancel"})
			if !errors.Is(err, ErrResponse) {
				t.Fatal("untrusted invoice URL accepted")
			}
		})
	}
}

func TestProviderErrorsNeverExposeSecretsOrResponse(t *testing.T) {
	for _, providerResponse := range []string{"redirect", "body", "network", "oversize", "duplicate"} {
		t.Run(providerResponse, func(t *testing.T) {
			calls := 0
			c := mockClient(t, func(*http.Request) (*http.Response, error) {
				calls++
				switch providerResponse {
				case "redirect":
					r := response(302, "test-server-only-api-key")
					r.Header.Set("Location", "https://evil.example/steal")
					return r, nil
				case "network":
					return nil, errors.New("proxy failure test-server-only-api-key")
				case "body":
					return response(401, `{"message":"test-server-only-api-key"}`), nil
				case "duplicate":
					return response(200, `{"payment_id":123456789,"payment_id":1}`), nil
				default:
					return response(200, strings.Repeat("a", maxBody+1)), nil
				}
			})
			_, err := c.GetPayment(context.Background(), "123456789")
			if err == nil || strings.Contains(err.Error(), "test-server-only-api-key") || calls != 1 {
				t.Fatal("unsafe error or redirect")
			}
		})
	}
}

func TestGetPaymentBindsIDAndSeparatesSandbox(t *testing.T) {
	c := mockClient(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != productionAPI+"/payment/123456789" {
			t.Fatal("untrusted payment ID reached HTTP")
		}
		return response(200, paymentJSON), nil
	})
	p, err := c.GetPayment(context.Background(), "123456789")
	if err != nil || p.PriceAmount != "1353" {
		t.Fatal("valid payment rejected", err)
	}
	if _, err := c.GetPayment(context.Background(), "../invoice"); !errors.Is(err, ErrInvalidInput) {
		t.Fatal("unsafe ID accepted")
	}
	c.httpClient.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		return response(200, strings.Replace(paymentJSON, `"payment_id":123456789`, `"payment_id":1`, 1)), nil
	})
	if _, err := c.GetPayment(context.Background(), "123456789"); !errors.Is(err, ErrResponse) {
		t.Fatal("mismatched response payment accepted")
	}
	sandbox, err := New(Config{APIKey: "test-only", Environment: "sandbox"})
	if err != nil || sandbox.baseURL != sandboxAPI || sandbox.invoiceHost == c.invoiceHost {
		t.Fatal("sandbox not isolated")
	}
	if _, err := New(Config{APIKey: "test-only", Environment: "https://evil.example"}); err == nil {
		t.Fatal("custom endpoint accepted")
	}
}

func TestValidateFinishedRequiresExactFullEvidence(t *testing.T) {
	p, err := decodePayment([]byte(paymentJSON))
	if err != nil {
		t.Fatal(err)
	}
	want := ExpectedPayment{OrderID: "mindbliss-order_123", InvoiceID: "777", PaymentID: "123456789", AmountUSDMinor: 135300}
	if err := ValidateFinished(p, want); err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"waiting", "confirming", "confirmed", "sending", "partially_paid", "failed", "expired", "refunded", "FINISHED", "unknown"} {
		bad := p
		bad.Status = status
		if err := ValidateFinished(bad, want); !errors.Is(err, ErrNotFinished) {
			t.Fatalf("%s unexpectedly accepted: %v", status, err)
		}
	}
	for name, mutate := range map[string]func(*Payment){
		"currency":         func(p *Payment) { p.PriceCurrency = "eur" },
		"price":            func(p *Payment) { p.PriceAmount = "1353.01" },
		"fractional-cent":  func(p *Payment) { p.PriceAmount = "1353.00001" },
		"order":            func(p *Payment) { p.OrderID = "another-order" },
		"invoice":          func(p *Payment) { p.InvoiceID = "778" },
		"payment":          func(p *Payment) { p.PaymentID = "987" },
		"underpaid":        func(p *Payment) { p.ActuallyPaid = "14.999999999999999999" },
		"pay-zero":         func(p *Payment) { p.PayAmount = "0" },
		"missing-actual":   func(p *Payment) { p.ActuallyPaid = "" },
		"missing-currency": func(p *Payment) { p.PayCurrency = "" },
	} {
		t.Run(name, func(t *testing.T) {
			bad := p
			mutate(&bad)
			if err := ValidateFinished(bad, want); !errors.Is(err, ErrEvidence) {
				t.Fatal("mismatched evidence accepted", err)
			}
		})
	}
}

func TestVerifyIPNKnownSortedPayloadAndTamper(t *testing.T) {
	c := mockClient(t, nil)
	// Deliberately independent of the canonicalizer under test.
	canonical := `{"actually_paid":15,"invoice_id":"777","order_id":"mindbliss-order_123","pay_amount":15,"pay_currency":"trx","payment_id":123456789,"payment_status":"finished","price_amount":1353,"price_currency":"usd"}`
	mac := hmac.New(sha512.New, []byte("test-ipn-secret"))
	_, _ = mac.Write([]byte(canonical))
	signature := hex.EncodeToString(mac.Sum(nil))
	if p, err := c.VerifyIPN([]byte(paymentJSON), signature); err != nil || p.PaymentID != "123456789" {
		t.Fatal("valid signature rejected", err)
	}
	for _, bad := range []string{strings.Replace(paymentJSON, "1353", "1354", 1), paymentJSON + `{}`, `{"payment_id":123456789,"payment_id":1}`} {
		if _, err := c.VerifyIPN([]byte(bad), signature); !errors.Is(err, ErrSignature) {
			t.Fatal("tampered body accepted")
		}
	}
	for _, bad := range []string{"", "invalid", strings.Repeat("0", 128), strings.Repeat("z", 128)} {
		if _, err := c.VerifyIPN([]byte(paymentJSON), bad); !errors.Is(err, ErrSignature) {
			t.Fatal("invalid signature accepted")
		}
	}
	c.ipnSecret = ""
	if _, err := c.VerifyIPN([]byte(paymentJSON), signature); !errors.Is(err, ErrConfiguration) {
		t.Fatal("missing secret accepted")
	}
}

func TestCanonicalJSONNestedPrecisionAndStringEscaping(t *testing.T) {
	raw := `{"z":{"b":1.0,"a":1e2},"arr":[{"z":0,"a":"<>&/\u2028"}],"id":"900719925474099312345","d":0.000001}`
	got, err := canonicalJSON([]byte(raw))
	want := "{\"arr\":[{\"a\":\"<>&/\u2028\",\"z\":0}],\"d\":0.000001,\"id\":\"900719925474099312345\",\"z\":{\"a\":100,\"b\":1}}"
	if err != nil || string(got) != want {
		t.Fatalf("canonical got %s, want %s: %v", got, want, err)
	}
	for _, bad := range []string{`{"n":9007199254740993}`, `{"n":0.123456789012345678901}`, `{"n":1e99999}`, `{"a":1,"a":2}`, `{"nested":{"a":1,"a":2}}`, `[]`, `{}`, `{} null`, strings.Repeat(`{"a":`, 34) + `0` + strings.Repeat("}", 34)} {
		if bad == "{}" { // Empty objects may be canonical JSON, but not payment evidence.
			if _, err := decodePayment([]byte(bad)); err == nil {
				t.Fatal("empty evidence accepted")
			}
			continue
		}
		if _, err := canonicalJSON([]byte(bad)); err == nil {
			t.Fatalf("ambiguous or malformed JSON accepted: %.80s", bad)
		}
	}
}

func TestConfigurationDiagnosticsOnlyReturnPresence(t *testing.T) {
	got := ConfigurationStatus(Config{APIKey: " test-only ", IPNSecret: " "})
	if !got.APIKeyConfigured || got.IPNSecretConfigured {
		t.Fatal("incorrect configuration diagnostic")
	}
	for _, cfg := range []Config{{}, {APIKey: "bad\r\nheader"}, {APIKey: "test", Environment: "development"}} {
		if _, err := New(cfg); !errors.Is(err, ErrConfiguration) {
			t.Fatal("unsafe configuration accepted")
		}
	}
}

func TestConfigAndClientAccidentalLogsAreRedacted(t *testing.T) {
	cfg := Config{APIKey: "do-not-expose-api", IPNSecret: "do-not-expose-ipn", Environment: "production"}
	c, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []any{cfg, &cfg, c} {
		body, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		for _, output := range []string{string(body), fmt.Sprintf("%v", value), fmt.Sprintf("%+v", value), fmt.Sprintf("%#v", value)} {
			if strings.Contains(output, "do-not-expose-") {
				t.Fatal("configuration or client exposes credential")
			}
		}
	}
}

func TestOutcomeEvidenceIsPreservedNotTreatedAsUSDCredit(t *testing.T) {
	fixture := strings.TrimSuffix(paymentJSON, "}") + `,"outcome_amount":"14.810612345678901234","outcome_currency":"trx"}`
	p, err := decodePayment([]byte(fixture))
	if err != nil || p.OutcomeAmount != "14.810612345678901234" || p.OutcomeCurrency != "trx" || p.PriceAmount != "1353" {
		t.Fatal("settlement and gross evidence must stay separate", err)
	}
	pending := strings.Replace(strings.Replace(fixture, `"finished"`, `"waiting"`, 1), `"14.810612345678901234"`, `null`, 1)
	if p, err := decodePayment([]byte(pending)); err != nil || p.OutcomeAmount != "" {
		t.Fatal("pending settlement is unknown, not zero", err)
	}
}
