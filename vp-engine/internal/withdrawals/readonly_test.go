package withdrawals

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestReadOnlyConfigDiscardsBMPAndLegacyStaffDefaults(t *testing.T) {
	setBaseEnv(t)
	t.Setenv("SERVICE_READ_ONLY", "true")
	t.Setenv("ENV", "production")
	t.Setenv("BMP_BASE_URL", "")
	t.Setenv("ADMIN_EMAILS", "")
	t.Setenv("SUPER_ADMIN_EMAILS", "")
	c, err := LoadConfig()
	if err != nil || !c.ReadOnly || c.ExternalProvidersEnabled() || c.BMPBaseURL != "" || len(c.AdminEmails) != 0 || len(c.SuperAdminEmails) != 0 {
		t.Fatal("read-only must need neither BMP origin nor implicit staff", err)
	}
	t.Setenv("BMP_BASE_URL", "not-a-valid-or-trusted-origin")
	t.Setenv("BMP_CLIENT_ID", "synthetic")
	t.Setenv("BMP_CLIENT_SECRET", "synthetic")
	t.Setenv("ADMIN_EMAILS", "explicit@example.test")
	t.Setenv("SUPER_ADMIN_EMAILS", "owner@example.test")
	c, err = LoadConfig()
	if err != nil || c.BMPBaseURL != "" || c.BMPClientID != "" || c.BMPClientSecret != "" || !c.RequireBMP || len(c.AdminEmails) != 1 || len(c.SuperAdminEmails) != 1 {
		t.Fatal("read-only must discard configured BMP without removing payment safeguards", err)
	}
	t.Setenv("SERVICE_READ_ONLY", "flase")
	if _, err := LoadConfig(); err == nil || !strings.Contains(err.Error(), "SERVICE_READ_ONLY") {
		t.Fatal("a typo must not select writable mode")
	}
	t.Setenv("SERVICE_READ_ONLY", "false")
	t.Setenv("BMP_BASE_URL", "")
	if _, err := LoadConfig(); err == nil || !strings.Contains(err.Error(), "BMP_BASE_URL") {
		t.Fatal("operational production must still require an explicit BMP origin")
	}
}

func TestReadOnlyRouterBlocksBeforeStoreOrBMP(t *testing.T) {
	c := Config{ReadOnly: true}
	calls := 0
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(202) })
	h := c.ReadOnlyHandler(next)
	for _, method := range []string{"POST", "PUT", "PATCH", "DELETE", "CONNECT", "TRACE"} {
		for _, path := range []string{"/health", "/api/payments/withdraw", "/api/admin/withdrawals/action", "/api/payments/bmp-link"} {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest(method, path, nil))
			if w.Code != 503 || calls != 0 {
				t.Fatal("read-only write reached a handler", method, path)
			}
		}
	}
	for _, path := range []string{"/api/payments/bmp-status", "/api/payments/bmp-link", "/unknown"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 503 || calls != 0 {
			t.Fatal("provider-capable GET reached a handler", path)
		}
	}
	for _, method := range []string{"GET", "HEAD", "OPTIONS"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(method, "/api/admin/withdrawals", nil))
		if w.Code != 202 {
			t.Fatal("read-only must retain auth and read handlers")
		}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/health", nil))
	var health map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &health); err != nil || health["financial_operations_enabled"] != false || health["mode"] != "read_only" {
		t.Fatal("health must report read-only, not financial readiness")
	}
}
