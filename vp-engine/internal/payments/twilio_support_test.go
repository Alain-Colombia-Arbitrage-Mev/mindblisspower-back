package payments

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"testing"

	"github.com/rs/zerolog"
)

func TestTwilioVoiceInitialReturnsGatherWithoutDB(t *testing.T) {
	h := &Handler{store: &Store{}, log: zerolog.Nop()}
	h.SetTwilioSupportChannels("", "", false, 3, "es-MX", "es-CO", 5)
	srv := httptest.NewServer(h.Routes())
	defer srv.Close()

	form := url.Values{
		"CallSid": {"CA123"},
		"From":    {"+573046572009"},
		"To":      {"+15551234567"},
	}
	resp, err := http.Post(srv.URL+"/api/support/voice/twilio", "application/x-www-form-urlencoded", strings.NewReader(form.Encode()))
	if err != nil {
		t.Fatalf("voice webhook: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, body = %s", resp.StatusCode, string(body))
	}
	if !strings.Contains(string(body), "<Gather") || !strings.Contains(string(body), "/api/support/voice/twilio/process") {
		t.Fatalf("body = %s, want Gather to process endpoint", string(body))
	}
}

func TestTwilioWhatsAppIgnoresNonSupportWithoutDB(t *testing.T) {
	h := &Handler{store: &Store{}, log: zerolog.Nop()}
	h.SetTwilioSupportChannels("", "", false, 3, "es-MX", "es-CO", 5)
	srv := httptest.NewServer(h.Routes())
	defer srv.Close()

	form := url.Values{
		"MessageSid":  {"SM123"},
		"From":        {"whatsapp:+573046572009"},
		"To":          {"whatsapp:+15551234567"},
		"ProfileName": {"Cliente"},
		"Body":        {"Hola, quiero proponer una alianza comercial y backlinks."},
	}
	resp, err := http.Post(srv.URL+"/api/support/whatsapp/twilio", "application/x-www-form-urlencoded", strings.NewReader(form.Encode()))
	if err != nil {
		t.Fatalf("whatsapp webhook: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, body = %s", resp.StatusCode, string(body))
	}
	if strings.TrimSpace(string(body)) != "<Response></Response>" {
		t.Fatalf("body = %q, want empty TwiML response", string(body))
	}
}

func TestTwilioWebhookRequiresValidSignatureWhenEnabled(t *testing.T) {
	h := &Handler{store: &Store{}, log: zerolog.Nop()}
	h.SetTwilioSupportChannels("auth-token", "", true, 3, "es-MX", "es-CO", 5)
	srv := httptest.NewServer(h.Routes())
	defer srv.Close()

	form := url.Values{"CallSid": {"CA123"}}
	resp, err := http.Post(srv.URL+"/api/support/voice/twilio", "application/x-www-form-urlencoded", strings.NewReader(form.Encode()))
	if err != nil {
		t.Fatalf("voice webhook: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", resp.StatusCode)
	}
}

func TestValidateTwilioSignature(t *testing.T) {
	params := url.Values{
		"CallSid": {"CA123"},
		"From":    {"+573046572009"},
	}
	publicURL := "https://app.mindblisspower.com/api/support/voice/twilio"
	sig := twilioTestSignature("secret", publicURL, params)
	if !validateTwilioSignature("secret", publicURL, sig, params) {
		t.Fatal("expected signature to validate")
	}
	if validateTwilioSignature("secret", publicURL, sig, url.Values{"CallSid": {"changed"}}) {
		t.Fatal("expected changed params to fail")
	}
}

func TestTicketSourcesIncludeTwilioChannels(t *testing.T) {
	for _, source := range []string{"voice", "whatsapp", "whatsapp_call"} {
		if got := normalizeTicketSource(source); got != source {
			t.Fatalf("normalizeTicketSource(%q) = %q", source, got)
		}
	}
}

func twilioTestSignature(authToken, publicURL string, params url.Values) string {
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(publicURL)
	for _, k := range keys {
		for _, v := range params[k] {
			b.WriteString(k)
			b.WriteString(v)
		}
	}
	mac := hmac.New(sha1.New, []byte(authToken))
	_, _ = mac.Write([]byte(b.String()))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}
