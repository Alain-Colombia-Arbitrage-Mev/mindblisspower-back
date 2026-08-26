package payments

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rs/zerolog"
)

func TestClassifySupportTicket(t *testing.T) {
	cases := []struct {
		name        string
		subject     string
		body        string
		support     bool
		category    string
		minPriority string
	}{
		{
			name:        "otp access issue",
			subject:     "No llega codigo OTP",
			body:        "No recibo el SMS ni el correo para entrar a mi cuenta.",
			support:     true,
			category:    "access",
			minPriority: "high",
		},
		{
			name:        "paid user not in tree",
			subject:     "Pague y no aparezco en el arbol",
			body:        "El pago fue exitoso pero no veo mi posicion dentro del arbol binario.",
			support:     true,
			category:    "tree",
			minPriority: "high",
		},
		{
			name:     "commercial proposal",
			subject:  "Propuesta comercial SEO",
			body:     "Ofrecemos guest post, backlinks y publicidad para su negocio.",
			support:  false,
			category: "non_support",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := classifySupportTicket(tc.subject, tc.body)
			if got.SupportRequest != tc.support {
				t.Fatalf("SupportRequest = %v, want %v (%+v)", got.SupportRequest, tc.support, got)
			}
			if got.Category != tc.category {
				t.Fatalf("Category = %q, want %q (%+v)", got.Category, tc.category, got)
			}
			if tc.minPriority != "" && got.Priority != tc.minPriority && got.Priority != "critical" {
				t.Fatalf("Priority = %q, want at least %q (%+v)", got.Priority, tc.minPriority, got)
			}
		})
	}
}

func TestSupportEmailIngestIgnoresNonSupportWithoutDB(t *testing.T) {
	h := &Handler{
		store:        &Store{},
		serviceToken: "test-token",
		log:          zerolog.Nop(),
	}
	srv := httptest.NewServer(h.Routes())
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/support/email/ingest", strings.NewReader(`{
		"from":"Sales <sales@example.com>",
		"subject":"Propuesta comercial SEO",
		"body":"Ofrecemos guest post, backlinks y publicidad para su negocio.",
		"message_id":"msg-non-support"
	}`))
	req.Header.Set("X-VP-Service-Token", "test-token")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("ingest non-support: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", resp.StatusCode)
	}
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if out["accepted"] != false || out["support_request"] != false {
		t.Fatalf("response = %+v, want accepted/support_request false", out)
	}
}

func TestSupportEmailIngestRequiresServiceToken(t *testing.T) {
	h := &Handler{
		store:        &Store{},
		serviceToken: "test-token",
		log:          zerolog.Nop(),
	}
	srv := httptest.NewServer(h.Routes())
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/api/support/email/ingest", "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatalf("ingest without token: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}
}
