package payments

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestNOWReadinessBudgetIsTwelveSecondsAndRespectsParent(t *testing.T) {
	if nowReadinessTimeout != 12*time.Second {
		t.Fatal("private readiness budget changed")
	}
	h, _, _ := fakeNOWMembershipHandler()
	h.serviceToken = "synthetic-service-token"
	invoke := func(ctx context.Context) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, nowReadyPath, nil).WithContext(ctx)
		r.Header.Set("X-VP-Service-Token", h.serviceToken)
		w := httptest.NewRecorder()
		h.handleNOWOperationalReadiness(w, r)
		return w
	}
	h.SetNOWOperationalReadinessRunner(func(ctx context.Context) error {
		deadline, ok := ctx.Deadline()
		remaining := time.Until(deadline)
		if !ok || remaining <= 11*time.Second || remaining > nowReadinessTimeout {
			t.Fatal("readiness did not receive bounded 12s context", remaining)
		}
		return nil
	})
	if got := invoke(context.Background()); got.Code != http.StatusOK {
		t.Fatal("bounded readiness failed", got.Code)
	}

	parent, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	parentDeadline, _ := parent.Deadline()
	h.SetNOWOperationalReadinessRunner(func(ctx context.Context) error {
		deadline, ok := ctx.Deadline()
		if !ok || !deadline.Equal(parentDeadline) {
			t.Fatal("readiness extended caller deadline")
		}
		<-ctx.Done()
		return ctx.Err()
	})
	if got := invoke(parent); got.Code != http.StatusServiceUnavailable || got.Body.String() != "{\"error\":\"nowpayments_not_ready\"}\n" {
		t.Fatal("deadline did not fail closed", got.Code, got.Body.String())
	}

	canceled, stop := context.WithCancel(context.Background())
	stop()
	h.SetNOWOperationalReadinessRunner(func(ctx context.Context) error {
		if !errors.Is(ctx.Err(), context.Canceled) {
			t.Fatal("readiness lost caller cancellation")
		}
		return ctx.Err()
	})
	if got := invoke(canceled); got.Code != http.StatusServiceUnavailable {
		t.Fatal("canceled readiness accepted", got.Code)
	}
}
