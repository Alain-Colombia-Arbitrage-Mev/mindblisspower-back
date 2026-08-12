package payments

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// reqActAs construye una request con token verificable, header act-as y método dado.
func reqActAs(method, token, actAs string) *http.Request {
	r := httptest.NewRequest(method, "/api/admin/users", nil)
	if token != "" {
		r.Header.Set(idTokenHeader, token)
	}
	if actAs != "" {
		r.Header.Set(actAsHeader, actAs)
	}
	return r
}

func superHandler(realEmail string) *Handler {
	h := newTestHandler(fakeVerifier{email: realEmail}, false)
	h.superAdminEmails = []string{"root@example.com"}
	return h
}

func TestEffectiveIdentity(t *testing.T) {
	t.Run("sin act-as => efectiva = real", func(t *testing.T) {
		h := superHandler("root@example.com")
		w := httptest.NewRecorder()
		real, eff, ok := h.effectiveIdentity(w, reqActAs(http.MethodGet, "tok", ""), "")
		if !ok || real != "root@example.com" || eff != "root@example.com" {
			t.Fatalf("got real=%q eff=%q ok=%v code=%d", real, eff, ok, w.Code)
		}
	})
	t.Run("super_admin + GET + act-as => efectiva = objetivo", func(t *testing.T) {
		h := superHandler("root@example.com")
		w := httptest.NewRecorder()
		real, eff, ok := h.effectiveIdentity(w, reqActAs(http.MethodGet, "tok", "Target@X.com"), "")
		if !ok || real != "root@example.com" || eff != "target@x.com" {
			t.Fatalf("got real=%q eff=%q ok=%v code=%d", real, eff, ok, w.Code)
		}
	})
	t.Run("admin normal + act-as => se ignora (efectiva = real)", func(t *testing.T) {
		h := newTestHandler(fakeVerifier{email: "admin@x.com"}, false) // no super
		w := httptest.NewRecorder()
		_, eff, ok := h.effectiveIdentity(w, reqActAs(http.MethodGet, "tok", "target@x.com"), "")
		if !ok || eff != "admin@x.com" {
			t.Fatalf("expected act-as ignored; got eff=%q ok=%v", eff, ok)
		}
	})
	t.Run("super_admin + POST + act-as => 403 read_only", func(t *testing.T) {
		h := superHandler("root@example.com")
		w := httptest.NewRecorder()
		_, _, ok := h.effectiveIdentity(w, reqActAs(http.MethodPost, "tok", "target@x.com"), "")
		if ok {
			t.Fatal("expected reject on non-GET while impersonating")
		}
		if w.Code != http.StatusForbidden {
			t.Fatalf("expected 403 got %d", w.Code)
		}
	})
	t.Run("identidad real inválida => propaga el rechazo", func(t *testing.T) {
		h := superHandler("root@example.com")
		h.SetIdentityVerifier(fakeVerifier{err: errors.New("bad token")}, false)
		w := httptest.NewRecorder()
		if _, _, ok := h.effectiveIdentity(w, reqActAs(http.MethodGet, "tok", "target@x.com"), ""); ok {
			t.Fatal("expected reject when real identity fails")
		}
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401 got %d", w.Code)
		}
	})
}
