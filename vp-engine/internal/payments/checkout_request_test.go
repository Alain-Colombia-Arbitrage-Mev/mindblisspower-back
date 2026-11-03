package payments

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rs/zerolog"
)

type checkoutRequestVerifier struct{ calls int }

func (v *checkoutRequestVerifier) VerifyEmail(context.Context, string) (string, error) {
	v.calls++
	return "member@example.test", nil
}

func TestCheckoutRejectsAmbiguousJSONBeforeIdentity(t *testing.T) {
	const base = `{"provider":"nowpayments","email":"member@example.test","package_id":1}`
	for _, tc := range []struct{ name, body string }{
		{"null object", `null`},
		{"duplicate provider", strings.TrimSuffix(base, "}") + `,"provider":"nowpayments"}`},
		{"case alias provider", strings.TrimSuffix(base, "}") + `,"Provider":"stripe"}`},
		{"duplicate package", strings.TrimSuffix(base, "}") + `,"package_id":2}`},
		{"case alias package", strings.TrimSuffix(base, "}") + `,"Package_ID":2}`},
		{"duplicate email", strings.TrimSuffix(base, "}") + `,"email":"member@example.test"}`},
		{"escaped duplicate key", strings.TrimSuffix(base, "}") + `,"\u0065mail":"member@example.test"}`},
		{"unknown owner", strings.TrimSuffix(base, "}") + `,"authSubject":"other-subject"}`},
		{"unknown sponsor", strings.TrimSuffix(base, "}") + `,"sponsor_affiliate_id":123}`},
		{"unknown amount", strings.TrimSuffix(base, "}") + `,"amount_usd":1}`},
		{"duplicate request key", strings.TrimSuffix(base, "}") + `,"purchase_request_id":"` + syntheticNOWOrder + `","purchase_request_id":"` + syntheticNOWOrder + `"}`},
		{"case alias request key", strings.TrimSuffix(base, "}") + `,"Purchase_Request_ID":"` + syntheticNOWOrder + `"}`},
		{"null provider", strings.Replace(base, `"nowpayments"`, `null`, 1)},
		{"null ref", strings.TrimSuffix(base, "}") + `,"ref":null}`},
		{"null side", strings.TrimSuffix(base, "}") + `,"preferred_side":null}`},
		{"null name", strings.TrimSuffix(base, "}") + `,"name":null}`},
		{"null phone", strings.TrimSuffix(base, "}") + `,"phone":null}`},
		{"invalid UTF8", strings.TrimSuffix(base, "}") + `,"ref":"` + string([]byte{0xff}) + `"}`},
		{"invalid package type", strings.Replace(base, `"package_id":1`, `"package_id":"1"`, 1)},
		{"non-object", `[]`},
		{"trailing JSON", base + `{}`},
		{"oversized", strings.TrimSuffix(base, "}") + `,"name":"` + strings.Repeat("a", 1<<16) + `"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			verifier := &checkoutRequestVerifier{}
			h := NewHandler(nil, nil, "synthetic-service-token", nil, 0, zerolog.Nop())
			h.SetIdentityVerifier(verifier, true)
			r := httptest.NewRequest(http.MethodPost, "/api/payments/checkout", strings.NewReader(tc.body))
			r.Header.Set("X-VP-Service-Token", h.serviceToken)
			r.Header.Set(idTokenHeader, "synthetic-token")
			w := httptest.NewRecorder()
			h.handleCheckout(w, r)
			if w.Code != http.StatusBadRequest || verifier.calls != 0 {
				t.Fatalf("ambiguous JSON passed request boundary: status=%d identity_calls=%d", w.Code, verifier.calls)
			}
			if w.Body.String() != "{\"error\":\"invalid_json\"}\n" {
				t.Fatal("JSON error must be constant and contain no user input", w.Body.String())
			}
		})
	}
}

func TestCheckoutCanonicalClientEnvelopesRemainAccepted(t *testing.T) {
	for _, body := range []string{
		`{"provider":"nowpayments","email":"member@example.test","package_id":1,"ref":"MP123","preferred_side":"L","purchase_request_id":"` + syntheticNOWOrder + `","name":"José Synthetic","phone":"+12025550101"}`,
		`{"phone":"","name":"","purchase_request_id":"` + syntheticNOWOrder + `","preferred_side":"","ref":"","package_id":1,"email":"member@example.test","provider":"nowpayments"}`,
		` { "provider" : "nowpayments", "email" : "member@example.test", "package_id" : 1 } `,
		`{"email":"member@example.test","package_id":1,"ref":"","name":"Synthetic","phone":""}`,
	} {
		t.Run(body, func(t *testing.T) {
			verifier := &checkoutRequestVerifier{}
			h := NewHandler(nil, nil, "synthetic-service-token", nil, 0, zerolog.Nop())
			h.SetIdentityVerifier(verifier, true)
			r := httptest.NewRequest(http.MethodPost, "/api/payments/checkout", strings.NewReader(body))
			r.Header.Set("X-VP-Service-Token", h.serviceToken)
			r.Header.Set(idTokenHeader, "synthetic-token")
			w := httptest.NewRecorder()
			h.handleCheckout(w, r)
			if w.Code != http.StatusServiceUnavailable || strings.Contains(w.Body.String(), "invalid_json") {
				t.Fatal("canonical BFF JSON rejected", w.Code, w.Body.String())
			}
		})
	}
}

func TestCheckoutDecodingPreservesCanonicalFieldsAndOptionalValues(t *testing.T) {
	const body = `{"provider":"nowpayments","email":"member@example.test","package_id":100,"ref":"MP123","preferred_side":"R","purchase_request_id":"` + syntheticNOWOrder + `","name":"José Synthetic","phone":"+12025550101"}`
	r := httptest.NewRequest(http.MethodPost, "/api/payments/checkout", strings.NewReader(body))
	out, err := decodeCheckoutRequest(httptest.NewRecorder(), r)
	if err != nil || out.Provider != "nowpayments" || out.Email != "member@example.test" || out.PackageID != 100 || out.Ref != "MP123" || out.PreferredSide != "R" || out.PurchaseRequestID != syntheticNOWOrder || out.Name != "José Synthetic" || out.Phone != "+12025550101" || out.authSubject != "" {
		t.Fatal("canonical BFF fields changed", err)
	}
	for _, body := range []string{`{}`, `{"email":"member@example.test","package_id":1}`, `{"provider":"stripe","email":"member@example.test","package_id":1,"ref":"","preferred_side":"","name":"","phone":""}`} {
		r := httptest.NewRequest(http.MethodPost, "/api/payments/checkout", strings.NewReader(body))
		if out, err := decodeCheckoutRequest(httptest.NewRecorder(), r); err != nil || out.authSubject != "" || out.PurchaseRequestID != "" {
			t.Fatal("optional legacy fields must remain omissible", err)
		}
	}
}
