package payments

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

type budgetRule struct {
	key   string
	limit int64
}

type budgetEntry struct {
	hits    int64
	expires time.Time
}

var errBudgetCapacity = errors.New("request budget capacity")

// Local counters are bounded and remain available when Redis is absent/down.
type localBudgets struct {
	mu      sync.Mutex
	entries map[string]budgetEntry
	max     int
	swept   time.Time
}

func (b *localBudgets) take(rules []budgetRule, now time.Time) (time.Duration, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.entries == nil {
		b.entries = make(map[string]budgetEntry)
	}
	if now.Sub(b.swept) >= time.Minute {
		for key, entry := range b.entries {
			if !entry.expires.After(now) {
				delete(b.entries, key)
			}
		}
		b.swept = now
	}
	var retry time.Duration
	missing := 0
	for _, rule := range rules {
		entry, exists := b.entries[rule.key]
		if !exists {
			missing++
		}
		if entry.expires.After(now) && entry.hits >= rule.limit {
			retry = max(retry, entry.expires.Sub(now))
		}
	}
	if retry > 0 {
		return retry, nil
	}
	if len(b.entries)+missing > b.max {
		return 0, errBudgetCapacity
	}
	for _, rule := range rules {
		entry := b.entries[rule.key]
		if !entry.expires.After(now) {
			entry = budgetEntry{expires: now.Add(time.Minute)}
		}
		entry.hits++
		b.entries[rule.key] = entry
	}
	return 0, nil
}

// Check and increment every budget atomically, including its expiration.
var requestBudgetScript = redis.NewScript(`
local retry = 0
for i, key in ipairs(KEYS) do
  local hits = tonumber(redis.call('GET', key) or '0')
  local ttl = redis.call('PTTL', key)
  if hits >= tonumber(ARGV[i]) and ttl > 0 then retry = math.max(retry, ttl) end
end
if retry > 0 then return retry end
for i, key in ipairs(KEYS) do
  local ttl = redis.call('PTTL', key)
  if ttl <= 0 then redis.call('SET', key, '0', 'PX', 60000) end
  redis.call('INCR', key)
end
return 0
`)

func (c *Cache) takeRequestBudget(ctx context.Context, rules []budgetRule) (time.Duration, error) {
	ctx, cancel := context.WithTimeout(ctx, 350*time.Millisecond)
	defer cancel()
	keys := make([]string, len(rules))
	args := make([]any, len(rules))
	for i, rule := range rules {
		keys[i], args[i] = rule.key, rule.limit
	}
	ms, err := requestBudgetScript.Run(ctx, c.rdb, keys, args...).Int64()
	return time.Duration(ms) * time.Millisecond, err
}

type verifiedBudgetIdentity struct{ token, email string }
type budgetIdentityKey struct{}

type requestGuard struct {
	local                localBudgets
	redisTake            func(context.Context, []budgetRule) (time.Duration, error)
	redisDownUntil       atomic.Int64
	reads, heavy, writes chan struct{}
}

func positiveLimitEnv(name string, fallback, ceiling int) int {
	value := envInt(name, fallback)
	if value < 1 || value > ceiling {
		return fallback
	}
	return value
}

func newRequestGuard(cache *Cache) *requestGuard {
	g := &requestGuard{
		local:  localBudgets{max: 50_000},
		reads:  make(chan struct{}, positiveLimitEnv("PAYMENTS_MAX_CONCURRENT_READS", 128, 1024)),
		heavy:  make(chan struct{}, positiveLimitEnv("PAYMENTS_MAX_CONCURRENT_REPORTS", 4, 64)),
		writes: make(chan struct{}, positiveLimitEnv("PAYMENTS_MAX_CONCURRENT_WRITES", 32, 256)),
	}
	if cache != nil {
		g.redisTake = cache.takeRequestBudget
	}
	return g
}

func (g *requestGuard) take(ctx context.Context, rules []budgetRule, now time.Time) (time.Duration, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if g.redisTake != nil && now.UnixNano() >= g.redisDownUntil.Load() {
		retry, err := g.redisTake(ctx, rules)
		if err == nil {
			return retry, nil
		}
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		// Avoid a Redis connection/retry storm while it is unavailable.
		g.redisDownUntil.Store(now.Add(30 * time.Second).UnixNano())
	}
	return g.local.take(rules, now)
}

func requestBudgetPolicy(path, method string) (int64, bool) {
	if path == "/api/comms/unsubscribe" {
		return 12000, false
	}
	if method == http.MethodPost {
		switch path {
		case "/api/admin/plan/simulate", "/api/admin/sales/reconcile", "/api/admin/sales/sweep":
			return 2, true
		}
	}
	switch path {
	case "/api/admin/users/export":
		return 2, true
	case "/api/admin/tree/full", "/api/admin/user/branch-tree",
		"/api/admin/network/health", "/api/admin/network/sustainability",
		"/api/admin/command-center/summary", "/api/admin/finance", "/api/admin/solvency",
		"/api/admin/summary", "/api/admin/sales/report", "/api/admin/sales/reconcile":
		return 30, true
	case "/api/admin/tree/search":
		return 60, false
	default:
		return 240, false
	}
}

func writeBudgetError(w http.ResponseWriter, status int, code string, retry time.Duration) {
	seconds := max(1, int64((retry+time.Second-1)/time.Second))
	w.Header().Set("Retry-After", strconv.FormatInt(seconds, 10))
	w.Header().Set("Cache-Control", "private, no-store")
	writeJSON(w, status, map[string]any{"error": code, "retryAfterSec": seconds})
}

func (h *Handler) budgetClient(r *http.Request) (string, *http.Request) {
	trusted := h.serviceToken != "" && subtle.ConstantTimeCompare(
		[]byte(r.Header.Get("X-VP-Service-Token")), []byte(h.serviceToken)) == 1
	if trusted {
		raw := strings.TrimSpace(r.Header.Get(idTokenHeader))
		if email, ok := h.verifiedEmail(r); ok && email != "" {
			r = r.WithContext(context.WithValue(r.Context(), budgetIdentityKey{}, verifiedBudgetIdentity{raw, email}))
			return "user:" + email, r
		}
		if raw == "" && !h.requireVerified {
			if email := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("email"))); email != "" {
				return "legacy:" + email, r
			}
		}
	}
	return "ip:" + clientKey(r), r
}

func (h *Handler) rateLimit(next http.Handler) http.Handler {
	var cache *Cache
	if h.store != nil {
		cache = h.store.cache
	}
	g := newRequestGuard(cache)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		// Event callbacks must keep their existing signature verification/retry semantics.
		if path == "/health" || path == "/api/webhooks/stripe" || strings.HasPrefix(path, "/api/support/voice/") || path == "/api/support/whatsapp/twilio" {
			next.ServeHTTP(w, r)
			return
		}
		limit, expensive := requestBudgetPolicy(path, r.Method)
		if expensive {
			select {
			case g.heavy <- struct{}{}:
				defer func() { <-g.heavy }()
			default:
				writeBudgetError(w, 503, "server_busy", 2*time.Second)
				return
			}
		}
		if r.Method == http.MethodGet || r.Method == http.MethodHead {
			select {
			case g.reads <- struct{}{}:
				defer func() { <-g.reads }()
			default:
				writeBudgetError(w, 503, "server_busy", 2*time.Second)
				return
			}
		} else {
			select {
			case g.writes <- struct{}{}:
				defer func() { <-g.writes }()
			default:
				writeBudgetError(w, 503, "server_busy", 2*time.Second)
				return
			}
		}
		client, r := h.budgetClient(r)
		if strings.HasPrefix(client, "ip:") && limit == 240 {
			// Legacy/public BFF calls without identity must not share one member's quota.
			limit = 2400
		}
		// Mux patterns collapse dynamic IDs and unknown URLs into bounded scopes.
		if mux, ok := next.(*http.ServeMux); ok {
			_, path = mux.Handler(r)
			if path == "" {
				path = "unmatched"
			}
		}
		method := r.Method
		if method != "GET" && method != "HEAD" && method != "POST" && method != "PUT" && method != "PATCH" && method != "DELETE" && method != "OPTIONS" {
			method = "OTHER"
		}
		clientHash := fmt.Sprintf("%x", sha256.Sum256([]byte(client)))
		rules := []budgetRule{
			{"rl:v2:{payments}:c:" + clientHash + ":" + method + ":" + path, limit},
			{"rl:v2:{payments}:g:" + method + ":" + path, 12000},
		}
		retry, err := g.take(r.Context(), rules, time.Now())
		if err != nil {
			writeBudgetError(w, 503, "server_busy", time.Second)
			return
		}
		if retry > 0 {
			writeBudgetError(w, 429, "rate_limited", retry)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "private, no-store")
		}
		next.ServeHTTP(w, r)
	})
}
