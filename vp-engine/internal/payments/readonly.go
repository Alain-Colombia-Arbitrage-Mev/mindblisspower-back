package payments

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
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

func (c *Config) ExternalProvidersEnabled() bool { return !c.ReadOnly }
func (c *Config) BackgroundJobsEnabled() bool    { return !c.ReadOnly }

// ReadOnlyHandler wraps the complete router BEFORE rate limits/auth/handlers.
// GET alone is not proof of safety: resume, Stripe verification, OTP diagnostics
// and unsubscribe routes may contact providers or mutate state, so reads use a
// small explicit allowlist. Database login permissions remain a second boundary.
func (c *Config) ReadOnlyHandler(next http.Handler) http.Handler {
	if !c.ReadOnly {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "private, no-store")
		if c.NOWPaymentsOperational.Enabled && r.Method == http.MethodGet && r.URL.Path == nowReadyPath && r.URL.RawPath == "" && r.URL.RawQuery == "" && !r.URL.ForceQuery {
			next.ServeHTTP(w, r)
			return
		}
		if c.NOWPaymentsOperational.Enabled && r.Method == http.MethodPost && r.URL.Path == nowJobPath && r.URL.RawPath == "" && r.URL.RawQuery == "" && !r.URL.ForceQuery {
			next.ServeHTTP(w, r)
			return
		}
		if c.NOWPaymentsOperational.Enabled && r.Method == http.MethodPost && r.URL.Path == "/api/payments/checkout" && r.URL.RawPath == "" && r.URL.RawQuery == "" && !r.URL.ForceQuery {
			body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<16))
			if err != nil {
				writeErr(w, http.StatusBadRequest, "invalid_checkout_request")
				return
			}
			var request struct {
				Provider string `json:"provider"`
			}
			if json.Unmarshal(body, &request) != nil || request.Provider != "nowpayments" {
				writeErr(w, http.StatusServiceUnavailable, "service_read_only")
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
			next.ServeHTTP(w, r)
			return
		}
		// This explicit exception only captures signed evidence into a separate
		// restricted pool; it does not unlock checkout or operational finances.
		if c.NOWPaymentsCapture.Enabled && r.URL.RawPath == "" && ((r.Method == http.MethodPost && r.URL.Path == "/api/webhooks/nowpayments" && r.URL.RawQuery == "" && !r.URL.ForceQuery) ||
			(r.Method == http.MethodGet && r.URL.Path == "/api/payments/nowpayments/status")) {
			next.ServeHTTP(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
			writeErr(w, http.StatusServiceUnavailable, "service_read_only")
			return
		}
		if r.URL.Path == "/health" {
			writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "mode": "read_only", "financial_operations_enabled": false})
			return
		}
		switch r.URL.Path {
		case "/api/payments/me", "/api/member/referral", "/api/member/profile", "/api/member/onboarding", "/api/member/news",
			"/api/admin/check", "/api/admin/users", "/api/admin/users/export", "/api/admin/user", "/api/admin/user/branch-tree",
			"/api/admin/tree/roots", "/api/admin/tree/full", "/api/admin/tree/children", "/api/admin/tree/search",
			"/api/admin/summary", "/api/admin/payments", "/api/admin/finance", "/api/admin/activity", "/api/admin/admins",
			"/api/admin/sales/report", "/api/admin/sales/transactions", "/api/admin/plan", "/api/admin/plan/proposals",
			"/api/admin/blacklist", "/api/admin/network/health", "/api/admin/network/sustainability":
			next.ServeHTTP(w, r)
		default:
			writeErr(w, http.StatusServiceUnavailable, "service_read_only")
		}
	})
}
