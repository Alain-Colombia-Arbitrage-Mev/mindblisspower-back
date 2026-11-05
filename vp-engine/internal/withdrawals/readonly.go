package withdrawals

import (
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
)

func loadServiceReadOnly() (bool, error) {
	raw := strings.TrimSpace(os.Getenv("SERVICE_READ_ONLY"))
	if raw == "" {
		return false, nil
	}
	enabled, err := strconv.ParseBool(raw)
	if err != nil {
		return false, fmt.Errorf("SERVICE_READ_ONLY must be an explicit boolean")
	}
	return enabled, nil
}

func (c Config) ExternalProvidersEnabled() bool { return !c.ReadOnly }

func (c Config) ReadOnlyHandler(next http.Handler) http.Handler {
	if !c.ReadOnly {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "private, no-store")
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
			writeErr(w, http.StatusServiceUnavailable, "service_read_only")
			return
		}
		if r.URL.Path == "/health" {
			writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "mode": "read_only", "financial_operations_enabled": false})
			return
		}
		switch r.URL.Path {
		case "/api/admin/withdrawals", "/api/admin/bmp-links":
			next.ServeHTTP(w, r)
		default:
			// Even GET /bmp-status contacts the provider when configured.
			writeErr(w, http.StatusServiceUnavailable, "service_read_only")
		}
	})
}
