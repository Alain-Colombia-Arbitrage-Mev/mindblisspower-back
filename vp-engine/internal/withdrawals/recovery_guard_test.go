package withdrawals

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/rs/zerolog"
	"github.com/vicionpower/vp-engine/internal/shared/financialguard"
)

func TestRecoveryWithdrawalsStopBeforeSideEffects(t *testing.T) {
	for _, tc := range []struct {
		name, path string
		body       map[string]any
	}{
		{"request", "/api/payments/withdraw", map[string]any{"email": "member@example.test", "amount": "100", "bank_info": "synthetic account"}},
		{"approve", "/api/admin/withdrawals/action", map[string]any{"email": "admin@example.test", "id": 1, "action": "approve"}},
		{"pay", "/api/admin/withdrawals/action", map[string]any{"email": "admin@example.test", "id": 1, "action": "pay"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{
				financialWritesFn: func(context.Context) error { return financialguard.ErrRecoveryReview },
				requestFn: func(context.Context, string, string, string) (WithdrawalResult, error) {
					t.Fatal("request must not mutate")
					return WithdrawalResult{}, nil
				},
				setStatusFn: func(context.Context, int64, string, string) error { t.Fatal("status must not mutate"); return nil },
				refreshFn: func(context.Context, int64, BMPVerification) error {
					t.Fatal("BMP verification must not persist")
					return nil
				},
				emailByIDFn: func(context.Context, int64) (string, error) {
					t.Fatal("BMP verification must not start")
					return "", nil
				},
			}
			h := NewHandler(store, testToken, []string{"admin@example.test"}, zerolog.Nop())
			r := adminPost(t, tc.path, tc.body)
			w := httptest.NewRecorder()
			h.Routes().ServeHTTP(w, r)
			if w.Code != http.StatusServiceUnavailable || decodeErr(t, w) != "stripe_recovery_financial_review_required" {
				t.Fatalf("must be an explicit review lock: status=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
}

func TestUnconfiguredWithdrawalServiceFailsClosed(t *testing.T) {
	h := NewHandler(nil, "", nil, zerolog.Nop())
	r := httptest.NewRequest(http.MethodPost, "/api/payments/withdraw", nil)
	w := httptest.NewRecorder()
	h.Routes().ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("unconfigured service must reject before accessing the store: %d", w.Code)
	}
}
