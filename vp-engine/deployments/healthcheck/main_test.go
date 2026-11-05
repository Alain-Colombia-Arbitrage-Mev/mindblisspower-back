package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTarget(t *testing.T) {
	for service, port := range map[string]string{"vp-engine": "9090", "vp-payments": "9095", "vp-withdrawals": "9097", "vp-support": "9096"} {
		got, err := target(service, "")
		if err != nil || got != "http://127.0.0.1:"+port+"/health" {
			t.Fatalf("unexpected target for %s: %s, %v", service, got, err)
		}
	}
	for _, address := range []string{"https://127.0.0.1/health", "http://example.invalid/health", "http://169.254.169.254/health", "http://user:secret@127.0.0.1/health", "http://127.0.0.1/health?secret=value"} {
		if _, err := target("vp-engine", address); err == nil {
			t.Fatalf("accepted unsafe target %s", address)
		}
	}
}

func TestProbe(t *testing.T) {
	for _, status := range []int{200, 204, 302, 503} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(status)
			}))
			defer server.Close()
			err := probe(server.URL)
			if (err == nil) != (status >= 200 && status < 300) {
				t.Fatalf("unexpected result for %d: %v", status, err)
			}
		})
	}
}
