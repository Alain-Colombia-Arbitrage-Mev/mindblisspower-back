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

func TestTwilioVoiceInitialReturnsPipecatStreamWhenEnabled(t *testing.T) {
	h := &Handler{store: &Store{}, log: zerolog.Nop()}
	h.SetTwilioSupportChannels("", "", false, 3, "es-MX", "es-CO", 5)
	h.SetPipecatVoiceAgent("pipecat", "wss://app.mindblisspower.com/api/support/voice/pipecat/ws", "stream-secret")
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
	text := string(body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, body = %s", resp.StatusCode, text)
	}
	if !strings.Contains(text, "<Connect><Stream") ||
		!strings.Contains(text, `url="wss://app.mindblisspower.com/api/support/voice/pipecat/ws"`) ||
		!strings.Contains(text, `name="mb_call_sid" value="CA123"`) ||
		!strings.Contains(text, `name="mb_sig" value="`) {
		t.Fatalf("body = %s, want signed Pipecat stream", text)
	}
	if strings.Contains(text, "<Gather") {
		t.Fatalf("body = %s, did not want Gather when Pipecat is enabled", text)
	}
}

func TestTwilioVoicePipecatFallsBackWithoutSecureURLAndSecret(t *testing.T) {
	h := &Handler{store: &Store{}, log: zerolog.Nop()}
	h.SetTwilioSupportChannels("", "", false, 3, "es-MX", "es-CO", 5)
	h.SetPipecatVoiceAgent("pipecat", "http://app.mindblisspower.com/ws", "")
	srv := httptest.NewServer(h.Routes())
	defer srv.Close()

	form := url.Values{"CallSid": {"CA123"}}
	resp, err := http.Post(srv.URL+"/api/support/voice/twilio", "application/x-www-form-urlencoded", strings.NewReader(form.Encode()))
	if err != nil {
		t.Fatalf("voice webhook: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "<Gather") {
		t.Fatalf("body = %s, want Gather fallback", string(body))
	}
}

func TestSignPipecatStreamContract(t *testing.T) {
	got := signPipecatStream("s", "CA123", "123", "voice")
	want := "fff01464eb3b4c396900ab4994b2c40cd8738050479e396b0856d01a57eed881"
	if got != want {
		t.Fatalf("signature = %s, want %s", got, want)
	}
}

func TestInternalVoiceTurnRequiresServiceToken(t *testing.T) {
	h := &Handler{store: &Store{}, serviceToken: "svc", log: zerolog.Nop()}
	srv := httptest.NewServer(h.Routes())
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/internal/support/voice/turn", "application/json", strings.NewReader(`{"call_sid":"CA123","user_message":"no veo mi arbol"}`))
	if err != nil {
		t.Fatalf("voice turn: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
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
