package payments

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/rs/zerolog"
)

// TestNetworkSustainabilityRoute_Mounted verifies that
// GET /api/admin/network/sustainability is registered in Routes() and requires
// the service token (returns 401 without it).
// This test is DB-free: it only checks the route table + svcAuth guard.
func TestNetworkSustainabilityRoute_Mounted(t *testing.T) {
	// Build a handler with a known service token.
	// svcAuth only checks the X-VP-Service-Token header; it doesn't touch the store.
	// We need a non-nil store so rateLimit can dereference store.cache (which
	// handles nil receiver safely via its allow() method).
	h := &Handler{
		store:        &Store{}, // cache == nil → allow() returns true; db == nil is fine here
		serviceToken: "test-token",
		log:          zerolog.Nop(),
		httpClient:   &http.Client{Timeout: 10 * 1e9}, // 10s
	}

	srv := httptest.NewServer(h.Routes())
	defer srv.Close()

	// Without the service token → 401.
	resp, err := http.Get(srv.URL + "/api/admin/network/sustainability?email=admin@example.com")
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 without service token, got %d", resp.StatusCode)
	}
}
