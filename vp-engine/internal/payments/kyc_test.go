package payments

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rs/zerolog"
)

func TestSanitizeKYCFileName(t *testing.T) {
	cases := map[string]string{
		"cedula frontal.jpg":              "cedula_frontal.jpg",
		"../../etc/passwd":                "passwd",
		`C:\docs\ine (2).png`:             "ine_2_.png",
		"":                                "document",
		"   ":                             "document",
		"ñandú-ID.pdf":                    "and_-ID.pdf",
		strings.Repeat("a", 200) + ".pdf": strings.Repeat("a", 76) + ".pdf",
	}
	for in, want := range cases {
		if got := sanitizeKYCFileName(in); got != want {
			t.Errorf("sanitizeKYCFileName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestValidateKYCUpload(t *testing.T) {
	cases := []struct {
		name                    string
		docType, fileName, mime string
		size                    int64
		want                    string
	}{
		{"ok pdf", "identity_card", "ine.pdf", "application/pdf", 1024, ""},
		{"ok jpg selfie", "selfie", "selfie.jpg", "image/jpeg", 5 << 20, ""},
		{"bad doc type", "dni", "ine.pdf", "application/pdf", 1024, "invalid-doc-type"},
		{"bad mime", "passport", "doc.gif", "image/gif", 1024, "invalid-mime"},
		{"zero size", "passport", "doc.pdf", "application/pdf", 0, "invalid-size"},
		{"too big", "passport", "doc.pdf", "application/pdf", 16 << 20, "invalid-size"},
		{"empty name", "passport", "  ", "application/pdf", 1024, "invalid-file-name"},
	}
	for _, tc := range cases {
		if got := validateKYCUpload(tc.docType, tc.fileName, tc.mime, tc.size); got != tc.want {
			t.Errorf("%s: validateKYCUpload = %q, want %q", tc.name, got, tc.want)
		}
	}
}

// TestKYCRoutes_Mounted: rutas KYC registradas y protegidas por svcAuth (401 sin
// token de servicio). DB-free.
func TestKYCRoutes_Mounted(t *testing.T) {
	h := &Handler{
		store:        &Store{},
		serviceToken: "test-token",
		log:          zerolog.Nop(),
	}
	srv := httptest.NewServer(h.Routes())
	defer srv.Close()

	for _, tc := range []struct {
		method, path string
	}{
		{http.MethodPost, "/api/member/kyc/upload-url"},
		{http.MethodPost, "/api/member/kyc/confirm"},
		{http.MethodGet, "/api/member/kyc/documents?email=a@b.c"},
	} {
		req, _ := http.NewRequest(tc.method, srv.URL+tc.path, strings.NewReader("{}"))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", tc.method, tc.path, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s %s: expected 401 without service token, got %d", tc.method, tc.path, resp.StatusCode)
		}
	}
}

// TestKYCUploadURL_Unconfigured: con token de servicio pero sin bucket S3
// configurado (h.kyc == nil) responde 503 kyc-unconfigured antes de tocar la DB.
func TestKYCUploadURL_Unconfigured(t *testing.T) {
	h := &Handler{
		store:        &Store{},
		serviceToken: "test-token",
		log:          zerolog.Nop(),
	}
	srv := httptest.NewServer(h.Routes())
	defer srv.Close()

	body := `{"email":"a@b.c","doc_type":"identity_card","file_name":"ine.pdf","mime":"application/pdf","size":1024}`
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/member/kyc/upload-url", strings.NewReader(body))
	req.Header.Set("X-VP-Service-Token", "test-token")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("expected 503 kyc-unconfigured, got %d", resp.StatusCode)
	}
}
