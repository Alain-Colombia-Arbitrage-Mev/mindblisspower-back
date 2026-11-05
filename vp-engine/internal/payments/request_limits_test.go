package payments

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

func TestLocalBudgetsAtomicExpiryAndCapacity(t *testing.T) {
	b := localBudgets{max: 3}
	now := time.Unix(100, 0)
	rules := []budgetRule{{"member", 1}, {"shared", 10}}
	if retry, err := b.take(rules, now); retry != 0 || err != nil {
		t.Fatal(retry, err)
	}
	if retry, _ := b.take(rules, now.Add(time.Second)); retry != 59*time.Second {
		t.Fatal("wrong retry", retry)
	}
	if b.entries["shared"].hits != 1 {
		t.Fatal("a rejected request charged the shared budget")
	}
	if _, err := b.take([]budgetRule{{"other", 1}, {"overflow", 1}}, now); !errors.Is(err, errBudgetCapacity) {
		t.Fatal("unbounded counter allocation", err)
	}
	if len(b.entries) != 2 {
		t.Fatal("partial allocation")
	}
	if retry, err := b.take(rules, now.Add(time.Minute)); retry != 0 || err != nil {
		t.Fatal("expiration did not recover", retry, err)
	}
}

func TestLocalBudgetsConcurrentBurst(t *testing.T) {
	b := localBudgets{max: 10}
	var accepted atomic.Int64
	var wg sync.WaitGroup
	now := time.Now()
	for i := 0; i < 1100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if retry, err := b.take([]budgetRule{{"one-user", 30}}, now); retry == 0 && err == nil {
				accepted.Add(1)
			}
		}()
	}
	wg.Wait()
	if accepted.Load() != 30 || len(b.entries) != 1 {
		t.Fatal("burst escaped limit", accepted.Load(), len(b.entries))
	}
}

func TestRedisFailureFallsBackWithoutRetryStorm(t *testing.T) {
	g := newRequestGuard(nil)
	calls := 0
	g.redisTake = func(context.Context, []budgetRule) (time.Duration, error) {
		calls++
		return 0, errors.New("redis down")
	}
	now := time.Now()
	rules := []budgetRule{{"member", 1}}
	if retry, err := g.take(context.Background(), rules, now); retry != 0 || err != nil {
		t.Fatal(retry, err)
	}
	if retry, _ := g.take(context.Background(), rules, now.Add(time.Second)); retry <= 0 || calls != 1 {
		t.Fatal("Redis outage disabled limits or triggered retries", retry, calls)
	}
	g.take(context.Background(), rules, now.Add(31*time.Second))
	if calls != 2 {
		t.Fatal("Redis was not probed again")
	}
}

func TestClientCancellationDoesNotDisableSharedBudgets(t *testing.T) {
	g := newRequestGuard(nil)
	ctx, cancel := context.WithCancel(context.Background())
	g.redisTake = func(context.Context, []budgetRule) (time.Duration, error) {
		cancel()
		return 0, context.Canceled
	}
	if _, err := g.take(ctx, []budgetRule{{"member", 1}}, time.Now()); !errors.Is(err, context.Canceled) {
		t.Fatal("request cancellation ignored", err)
	}
	if g.redisDownUntil.Load() != 0 || len(g.local.entries) != 0 {
		t.Fatal("a client cancellation downgraded shared limits")
	}
	g.redisTake = func(context.Context, []budgetRule) (time.Duration, error) { return 0, nil }
	if retry, err := g.take(context.Background(), []budgetRule{{"member", 1}}, time.Now()); retry != 0 || err != nil {
		t.Fatal("healthy shared budget unavailable", retry, err)
	}
}

type budgetVerifierFunc func(context.Context, string) (string, error)

func (f budgetVerifierFunc) VerifyEmail(ctx context.Context, raw string) (string, error) {
	return f(ctx, raw)
}

func TestVerifiedUsersDoNotShareNATBudget(t *testing.T) {
	h := &Handler{serviceToken: "secret", log: zerolog.Nop(), verifier: budgetVerifierFunc(func(_ context.Context, token string) (string, error) { return token + "@example.test", nil })}
	wrapped := h.rateLimit(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	for i := 0; i < 1100; i++ {
		r := httptest.NewRequest("GET", "/api/payments/me?email=ignored@example.test", nil)
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("X-VP-Service-Token", "secret")
		r.Header.Set(idTokenHeader, fmt.Sprint(i))
		w := httptest.NewRecorder()
		wrapped.ServeHTTP(w, r)
		if w.Code != 204 {
			t.Fatalf("user %d blocked by another member: %d", i, w.Code)
		}
	}
}

func TestBudgetIdentityIsRequestScopedAndDoesNotAuthorizeMismatch(t *testing.T) {
	calls := 0
	h := &Handler{serviceToken: "secret", log: zerolog.Nop(), verifier: budgetVerifierFunc(func(_ context.Context, _ string) (string, error) { calls++; return "real@example.test", nil })}
	wrapped := h.rateLimit(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.resolveIdentity(w, r, r.URL.Query().Get("email"))
	}))
	for i := 0; i < 2; i++ {
		r := httptest.NewRequest("GET", "/api/payments/me?email=other@example.test", nil)
		r.Header.Set("X-VP-Service-Token", "secret")
		r.Header.Set(idTokenHeader, "valid")
		w := httptest.NewRecorder()
		wrapped.ServeHTTP(w, r)
		if w.Code != 403 || calls != i+1 {
			t.Fatal("identity reused across requests or mismatch authorized", w.Code, calls)
		}
	}
}

func TestRequestRateLimitWorksWithoutRedisAndCannotRotateQuery(t *testing.T) {
	h := &Handler{log: zerolog.Nop()}
	wrapped := h.rateLimit(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	for i := 0; i < 3; i++ {
		r := httptest.NewRequest("GET", fmt.Sprintf("/api/admin/users/export?email=rotate%d@example.test", i), nil)
		w := httptest.NewRecorder()
		wrapped.ServeHTTP(w, r)
		if i < 2 && w.Code != 204 || i == 2 && w.Code != 429 {
			t.Fatal("unexpected rate decision", i, w.Code)
		}
		if i == 2 && (w.Header().Get("Retry-After") == "" || w.Header().Get("Cache-Control") != "private, no-store") {
			t.Fatal("missing overload metadata", w.Header())
		}
	}
}

func TestHeavyReadsDoNotConsumeAllReadSlotsOrBlockPayments(t *testing.T) {
	t.Setenv("PAYMENTS_MAX_CONCURRENT_READS", "2")
	t.Setenv("PAYMENTS_MAX_CONCURRENT_REPORTS", "1")
	h := &Handler{log: zerolog.Nop()}
	started := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})
	wrapped := h.rateLimit(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/admin/finance" {
			close(started)
			<-release
		}
		w.WriteHeader(204)
	}))
	go func() {
		defer close(done)
		wrapped.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/admin/finance", nil))
	}()
	<-started
	for _, tc := range []struct {
		method, path string
		want         int
	}{
		{"GET", "/api/admin/finance", 503},
		{"POST", "/api/admin/sales/sweep", 503},
		{"GET", "/api/payments/me", 204},
		{"POST", "/api/payments/checkout", 204},
		{"POST", "/api/webhooks/stripe", 204},
		{"GET", "/health", 204},
	} {
		w := httptest.NewRecorder()
		wrapped.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, nil))
		if w.Code != tc.want {
			t.Errorf("%s %s: got %d", tc.method, tc.path, w.Code)
		}
	}
	close(release)
	<-done
	// A completed request must release its permits.
	w := httptest.NewRecorder()
	wrapped.ServeHTTP(w, httptest.NewRequest("GET", "/api/admin/summary", nil))
	if w.Code != 204 {
		t.Fatal("leaked report permit", w.Code)
	}
}

func TestForwardedClientUsesLastTrustedHop(t *testing.T) {
	r := httptest.NewRequest("GET", "/api/payments/me?email=spoof@example.test", nil)
	r.RemoteAddr = "127.0.0.1:1234"
	r.Header.Set("X-Forwarded-For", "spoofed, 203.0.113.8")
	if clientKey(r) != "203.0.113.8" {
		t.Fatal(clientKey(r))
	}
	r.RemoteAddr = "198.51.100.9:1234"
	if clientKey(r) != "198.51.100.9" {
		t.Fatal("untrusted forwarding header accepted")
	}
}

func TestBudgetPolicies(t *testing.T) {
	for _, tc := range []struct {
		path, method string
		limit        int64
		expensive    bool
	}{
		{"/api/payments/me", "GET", 240, false},
		{"/api/admin/finance", "GET", 30, true},
		{"/api/admin/finance", "PUT", 30, true},
		{"/api/admin/tree/search", "GET", 60, false},
		{"/api/admin/users/export", "GET", 2, true},
		{"/api/admin/sales/sweep", "POST", 2, true},
		{"/api/payments/checkout", "POST", 240, false},
		{"/api/comms/unsubscribe", "POST", 12000, false},
	} {
		limit, expensive := requestBudgetPolicy(tc.path, tc.method)
		if limit != tc.limit || expensive != tc.expensive {
			t.Errorf("%s %s: got %d %v", tc.method, tc.path, limit, expensive)
		}
	}
}

func TestWriteCapacityKeepsStripeCallbacksAvailable(t *testing.T) {
	t.Setenv("PAYMENTS_MAX_CONCURRENT_WRITES", "1")
	h := &Handler{log: zerolog.Nop()}
	started, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	wrapped := h.rateLimit(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/payments/checkout" {
			close(started)
			<-release
		}
		w.WriteHeader(204)
	}))
	go func() {
		defer close(done)
		wrapped.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/api/payments/checkout", nil))
	}()
	<-started
	for _, tc := range []struct {
		method, path string
		want         int
	}{
		{"POST", "/api/payments/checkout", 503},
		{"POST", "/api/webhooks/stripe", 204},
		{"GET", "/api/payments/me", 204},
	} {
		w := httptest.NewRecorder()
		wrapped.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, nil))
		if w.Code != tc.want {
			t.Errorf("%s %s: %d", tc.method, tc.path, w.Code)
		}
	}
	close(release)
	<-done
}

func TestVerifiedBudgetCannotRotateTokenOrImpersonationTarget(t *testing.T) {
	h := &Handler{serviceToken: "secret", log: zerolog.Nop(), verifier: fakeVerifier{email: "admin@example.test"}}
	wrapped := h.rateLimit(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	for i := 0; i < 3; i++ {
		r := httptest.NewRequest("GET", fmt.Sprintf("/api/admin/users/export?email=target%d@example.test", i), nil)
		r.Header.Set("X-VP-Service-Token", "secret")
		r.Header.Set(idTokenHeader, fmt.Sprint(i))
		r.Header.Set(actAsHeader, fmt.Sprintf("target%d@example.test", i))
		w := httptest.NewRecorder()
		wrapped.ServeHTTP(w, r)
		if i == 2 && w.Code != 429 {
			t.Fatal("token/target rotation bypassed the real admin's quota", w.Code)
		}
	}
}
