package payments

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rs/zerolog"
)

// fakeVerifier es un IdentityVerifier inyectable para tests: devuelve un email
// fijo, o un error, sin montar un JWKS real.
type fakeVerifier struct {
	email string
	err   error
}

func (f fakeVerifier) VerifyEmail(_ context.Context, raw string) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	return f.email, nil
}

func newTestHandler(v IdentityVerifier, requireVerified bool) *Handler {
	h := &Handler{log: zerolog.Nop()}
	h.SetIdentityVerifier(v, requireVerified)
	return h
}

func reqWithToken(token, claimed string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/api/payments/me?email="+claimed, nil)
	if token != "" {
		r.Header.Set(idTokenHeader, token)
	}
	return r
}

func TestVerifiedEmail(t *testing.T) {
	t.Run("blank verified identity => false", func(t *testing.T) {
		for _, email := range []string{"", " \t\n"} {
			h := newTestHandler(fakeVerifier{email: email}, true)
			if _, ok := h.verifiedEmail(reqWithToken("tok", "")); ok {
				t.Fatal("empty verifier result must not authenticate")
			}
		}
	})
	t.Run("no header => false", func(t *testing.T) {
		h := newTestHandler(fakeVerifier{email: "a@x.com"}, false)
		if _, ok := h.verifiedEmail(reqWithToken("", "")); ok {
			t.Fatal("expected ok=false when header absent")
		}
	})
	t.Run("bad signature => false", func(t *testing.T) {
		h := newTestHandler(fakeVerifier{err: errors.New("bad signature")}, false)
		if _, ok := h.verifiedEmail(reqWithToken("tok", "")); ok {
			t.Fatal("expected ok=false when verification fails")
		}
	})
	t.Run("valid => lowercased email", func(t *testing.T) {
		h := newTestHandler(fakeVerifier{email: "USER@X.com"}, false)
		email, ok := h.verifiedEmail(reqWithToken("tok", ""))
		if !ok || email != "user@x.com" {
			t.Fatalf("expected user@x.com,true got %q,%v", email, ok)
		}
	})
	t.Run("nil verifier => false", func(t *testing.T) {
		h := &Handler{log: zerolog.Nop()} // no verifier set
		if _, ok := h.verifiedEmail(reqWithToken("tok", "")); ok {
			t.Fatal("expected ok=false with nil verifier")
		}
	})
}

func TestServiceAuthFailsClosed(t *testing.T) {
	for _, tc := range []struct {
		name, configured, supplied string
		wantOK                     bool
	}{
		{"missing configuration and credential", "", "", false},
		{"blank configuration", " \t", " \t", false},
		{"missing credential", "service-test-token", "", false},
		{"wrong credential", "service-test-token", "wrong", false},
		{"exact credential", "service-test-token", "service-test-token", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := &Handler{serviceToken: tc.configured, log: zerolog.Nop()}
			r := httptest.NewRequest(http.MethodGet, "/api/payments/me", nil)
			r.Header.Set("X-VP-Service-Token", tc.supplied)
			w := httptest.NewRecorder()
			if got := h.svcAuth(w, r); got != tc.wantOK {
				t.Fatalf("authenticated=%v, want %v", got, tc.wantOK)
			}
			if !tc.wantOK && w.Code != http.StatusUnauthorized {
				t.Fatalf("status=%d, want 401", w.Code)
			}
		})
	}
}

func TestVerifiedEmailCachedIdentityCannotOverrideToken(t *testing.T) {
	for _, tc := range []struct {
		name, token, cachedToken, cachedEmail, wantEmail string
		wantOK                                           bool
	}{
		{"another token must reverify", "current-token", "other-token", "other@example.test", "verified@example.test", true},
		{"missing token cannot use cache", "", "", "other@example.test", "", false},
		{"empty cached identity must reverify", "current-token", "current-token", "", "verified@example.test", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newTestHandler(fakeVerifier{email: "verified@example.test"}, true)
			r := reqWithToken(tc.token, "")
			r = r.WithContext(context.WithValue(r.Context(), budgetIdentityKey{}, verifiedBudgetIdentity{token: tc.cachedToken, email: tc.cachedEmail}))
			email, ok := h.verifiedEmail(r)
			if email != tc.wantEmail || ok != tc.wantOK {
				t.Fatalf("identity=%q,%v want %q,%v", email, ok, tc.wantEmail, tc.wantOK)
			}
		})
	}
}

func TestCheckoutCannotClaimAnotherVerifiedIdentity(t *testing.T) {
	h := NewHandler(nil, nil, "synthetic-service-token", nil, 0, zerolog.Nop())
	h.SetIdentityVerifier(fakeVerifier{email: "verified@example.test"}, true)
	r := httptest.NewRequest(http.MethodPost, "/api/payments/checkout", strings.NewReader(`{"email":"other@example.test","package_id":1}`))
	r.Header.Set("X-VP-Service-Token", "synthetic-service-token")
	r.Header.Set(idTokenHeader, "synthetic-id-token")
	w := httptest.NewRecorder()
	h.handleCheckout(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("checkout identity mismatch must stop before the database, got %d", w.Code)
	}
}

func TestUnconfiguredServiceRoutesRejectBeforeDatabase(t *testing.T) {
	h := NewHandler(nil, nil, "", nil, 0, zerolog.Nop())
	routes := h.Routes()
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/payments/me?email=member@example.test"},
		{http.MethodPost, "/api/payments/checkout"},
		{http.MethodGet, "/api/member/referral?email=member@example.test"},
		{http.MethodGet, "/api/admin/check?email=admin@example.test"},
	} {
		t.Run(tc.path, func(t *testing.T) {
			w := httptest.NewRecorder()
			routes.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, nil))
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("status=%d, want 401", w.Code)
			}
		})
	}
}

func TestResolveIdentity(t *testing.T) {
	t.Run("verified used as authoritative (no claimed)", func(t *testing.T) {
		h := newTestHandler(fakeVerifier{email: "user@x.com"}, false)
		w := httptest.NewRecorder()
		email, ok := h.resolveIdentity(w, reqWithToken("tok", ""), "")
		if !ok || email != "user@x.com" {
			t.Fatalf("got %q,%v (code %d)", email, ok, w.Code)
		}
	})
	t.Run("claimed matches verified => ok", func(t *testing.T) {
		h := newTestHandler(fakeVerifier{email: "user@x.com"}, false)
		w := httptest.NewRecorder()
		email, ok := h.resolveIdentity(w, reqWithToken("tok", "User@X.com"), "User@X.com")
		if !ok || email != "user@x.com" {
			t.Fatalf("got %q,%v (code %d)", email, ok, w.Code)
		}
	})
	t.Run("claimed mismatches verified => 403 reject", func(t *testing.T) {
		h := newTestHandler(fakeVerifier{email: "user@x.com"}, false)
		w := httptest.NewRecorder()
		_, ok := h.resolveIdentity(w, reqWithToken("tok", "attacker@x.com"), "attacker@x.com")
		if ok {
			t.Fatal("expected reject on mismatch")
		}
		if w.Code != http.StatusForbidden {
			t.Fatalf("expected 403 got %d", w.Code)
		}
	})
	t.Run("header present but invalid => 401 fail-closed (no fallback)", func(t *testing.T) {
		h := newTestHandler(fakeVerifier{err: errors.New("expired")}, false)
		w := httptest.NewRecorder()
		_, ok := h.resolveIdentity(w, reqWithToken("tok", "user@x.com"), "user@x.com")
		if ok {
			t.Fatal("expected reject when header present but invalid")
		}
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401 got %d", w.Code)
		}
	})
	t.Run("no header + not strict => fallback to claimed", func(t *testing.T) {
		h := newTestHandler(fakeVerifier{email: "unused@x.com"}, false)
		w := httptest.NewRecorder()
		email, ok := h.resolveIdentity(w, reqWithToken("", "claimed@x.com"), "claimed@x.com")
		if !ok || email != "claimed@x.com" {
			t.Fatalf("got %q,%v (code %d)", email, ok, w.Code)
		}
	})
	t.Run("no header + not strict + no claimed => 400 missing email", func(t *testing.T) {
		h := newTestHandler(fakeVerifier{}, false)
		w := httptest.NewRecorder()
		_, ok := h.resolveIdentity(w, reqWithToken("", ""), "")
		if ok {
			t.Fatal("expected reject when nothing to identify")
		}
		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 got %d", w.Code)
		}
	})
	t.Run("no header + strict => 401 required", func(t *testing.T) {
		h := newTestHandler(fakeVerifier{email: "unused@x.com"}, true)
		w := httptest.NewRecorder()
		_, ok := h.resolveIdentity(w, reqWithToken("", "claimed@x.com"), "claimed@x.com")
		if ok {
			t.Fatal("expected reject in strict mode without header")
		}
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401 got %d", w.Code)
		}
	})
}
