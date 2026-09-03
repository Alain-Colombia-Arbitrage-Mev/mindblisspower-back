package payments

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rs/zerolog"
)

// newInspectorTestHandler arma un Handler DB-free: los admins vienen del
// allowlist por env (isAdminEmail no toca la DB) y las validaciones de los
// handlers cortan ANTES de cualquier query, así que store.db nil nunca se usa.
func newInspectorTestHandler() *Handler {
	return &Handler{
		store:            &Store{}, // cache nil → allow()/del() no-op; db nil no se alcanza
		serviceToken:     "test-token",
		adminEmails:      []string{"admin@example.com"},
		superAdminEmails: []string{"root@example.com"},
		log:              zerolog.Nop(),
	}
}

func doInspectorReq(t *testing.T, srv *httptest.Server, method, path, body string) (*http.Response, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
	req.Header.Set("X-VP-Service-Token", "test-token")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp, out
}

// Rutas del inspector montadas y protegidas por el service token (401 sin él).
func TestAdminUserRoutes_Mounted(t *testing.T) {
	h := newInspectorTestHandler()
	srv := httptest.NewServer(h.Routes())
	defer srv.Close()

	cases := []struct{ method, path string }{
		{http.MethodGet, "/api/admin/user?person_id=1&email=admin@example.com"},
		{http.MethodPut, "/api/admin/user"},
		{http.MethodDelete, "/api/admin/user"},
		{http.MethodGet, "/api/admin/user/branch-tree?affiliate_id=1&email=admin@example.com"},
		{http.MethodPost, "/api/admin/user/tree-relocation"},
		{http.MethodGet, "/api/admin/tree/roots?email=admin@example.com"},
		{http.MethodGet, "/api/admin/tree/children?parent_id=1&email=admin@example.com"},
		{http.MethodGet, "/api/admin/tree/search?q=user@example.com&email=admin@example.com"},
	}
	for _, c := range cases {
		req, _ := http.NewRequest(c.method, srv.URL+c.path, strings.NewReader("{}"))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", c.method, c.path, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s %s: expected 401 without service token, got %d", c.method, c.path, resp.StatusCode)
		}
	}
}

// POST tree-relocation: exige super_admin, preview/confirmacion y parametros
// completos antes de tocar la DB.
func TestAdminUserTreeRelocation_Validation(t *testing.T) {
	h := newInspectorTestHandler()
	srv := httptest.NewServer(h.Routes())
	defer srv.Close()

	cases := []struct {
		name    string
		body    string
		status  int
		errCode string
	}{
		{"admin normal no puede", `{"email":"admin@example.com","person_id":5,"new_sponsor":"sponsor@example.com","reason":"corregir sponsor directo","dry_run":true}`, http.StatusForbidden, "not_super_admin"},
		{"person_id faltante", `{"email":"root@example.com","new_sponsor":"sponsor@example.com","reason":"corregir sponsor directo","dry_run":true}`, http.StatusBadRequest, "missing_person_id"},
		{"sponsor faltante", `{"email":"root@example.com","person_id":5,"reason":"corregir sponsor directo","dry_run":true}`, http.StatusBadRequest, "missing_sponsor"},
		{"reason corto", `{"email":"root@example.com","person_id":5,"new_sponsor":"sponsor@example.com","reason":"fix","dry_run":true}`, http.StatusBadRequest, "reason_required"},
		{"apply sin confirm", `{"email":"root@example.com","person_id":5,"new_sponsor":"sponsor@example.com","reason":"corregir sponsor directo","dry_run":false}`, http.StatusBadRequest, "confirm_required"},
		{"position sin parent", `{"email":"root@example.com","person_id":5,"new_sponsor":"sponsor@example.com","target_position":"L","reason":"corregir sponsor directo","dry_run":true}`, http.StatusBadRequest, "target_parent_required"},
		{"parent sin position", `{"email":"root@example.com","person_id":5,"new_sponsor":"sponsor@example.com","target_parent_affiliate_id":7,"reason":"corregir sponsor directo","dry_run":true}`, http.StatusBadRequest, "target_position_required"},
		{"position invalida", `{"email":"root@example.com","person_id":5,"new_sponsor":"sponsor@example.com","target_parent_affiliate_id":7,"target_position":"X","reason":"corregir sponsor directo","dry_run":true}`, http.StatusBadRequest, "invalid_position"},
		{"json inválido", `{`, http.StatusBadRequest, "invalid_json"},
	}
	for _, c := range cases {
		resp, out := doInspectorReq(t, srv, http.MethodPost, "/api/admin/user/tree-relocation", c.body)
		if resp.StatusCode != c.status {
			t.Fatalf("%s: expected %d, got %d (%v)", c.name, c.status, resp.StatusCode, out)
		}
		if got, _ := out["error"].(string); got != c.errCode {
			t.Fatalf("%s: expected error %q, got %q", c.name, c.errCode, got)
		}
	}
}

// PUT: validaciones antes de tocar la DB.
func TestAdminUserUpdate_Validation(t *testing.T) {
	h := newInspectorTestHandler()
	srv := httptest.NewServer(h.Routes())
	defer srv.Close()

	cases := []struct {
		name    string
		body    string
		status  int
		errCode string
	}{
		{"person_id faltante", `{"email":"admin@example.com","new_email":"a@b.co"}`, http.StatusBadRequest, "missing_person_id"},
		{"sin campos", `{"email":"admin@example.com","person_id":5}`, http.StatusBadRequest, "no_fields"},
		{"email inválido", `{"email":"admin@example.com","person_id":5,"new_email":"no-es-un-email"}`, http.StatusBadRequest, "invalid_email"},
		{"email sin tld", `{"email":"admin@example.com","person_id":5,"new_email":"a@b"}`, http.StatusBadRequest, "invalid_email"},
		{"json inválido", `{`, http.StatusBadRequest, "invalid_json"},
	}
	for _, c := range cases {
		resp, out := doInspectorReq(t, srv, http.MethodPut, "/api/admin/user", c.body)
		if resp.StatusCode != c.status {
			t.Fatalf("%s: expected %d, got %d (%v)", c.name, c.status, resp.StatusCode, out)
		}
		if got, _ := out["error"].(string); got != c.errCode {
			t.Fatalf("%s: expected error %q, got %q", c.name, c.errCode, got)
		}
	}
}

// DELETE: exige super_admin y confirm exacto "DELETE" antes de tocar la DB.
func TestAdminUserDelete_Validation(t *testing.T) {
	h := newInspectorTestHandler()
	srv := httptest.NewServer(h.Routes())
	defer srv.Close()

	cases := []struct {
		name    string
		body    string
		status  int
		errCode string
	}{
		{"admin normal no puede", `{"email":"admin@example.com","person_id":5,"confirm":"DELETE"}`, http.StatusForbidden, "not_super_admin"},
		{"confirm faltante", `{"email":"root@example.com","person_id":5}`, http.StatusBadRequest, "confirm_required"},
		{"confirm incorrecto", `{"email":"root@example.com","person_id":5,"confirm":"delete"}`, http.StatusBadRequest, "confirm_required"},
		{"person_id faltante", `{"email":"root@example.com","confirm":"DELETE"}`, http.StatusBadRequest, "missing_person_id"},
	}
	for _, c := range cases {
		resp, out := doInspectorReq(t, srv, http.MethodDelete, "/api/admin/user", c.body)
		if resp.StatusCode != c.status {
			t.Fatalf("%s: expected %d, got %d (%v)", c.name, c.status, resp.StatusCode, out)
		}
		if got, _ := out["error"].(string); got != c.errCode {
			t.Fatalf("%s: expected error %q, got %q", c.name, c.errCode, got)
		}
	}
}

// GET ficha / branch-tree: parámetros obligatorios.
func TestAdminUserGet_Params(t *testing.T) {
	h := newInspectorTestHandler()
	srv := httptest.NewServer(h.Routes())
	defer srv.Close()

	resp, out := doInspectorReq(t, srv, http.MethodGet, "/api/admin/user?email=admin@example.com", "")
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("GET sin person_id/target_email: expected 400, got %d (%v)", resp.StatusCode, out)
	}
	resp, out = doInspectorReq(t, srv, http.MethodGet, "/api/admin/user/branch-tree?email=admin@example.com", "")
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("branch-tree sin affiliate_id: expected 400, got %d (%v)", resp.StatusCode, out)
	}
	resp, out = doInspectorReq(t, srv, http.MethodGet, "/api/admin/tree/children?email=admin@example.com", "")
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("admin tree children sin parent_id: expected 400, got %d (%v)", resp.StatusCode, out)
	}
	resp, out = doInspectorReq(t, srv, http.MethodGet, "/api/admin/tree/search?q=a&email=admin@example.com", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("admin tree search corta: expected 200, got %d (%v)", resp.StatusCode, out)
	}
	// Método no soportado en la ruta del inspector.
	resp, _ = doInspectorReq(t, srv, http.MethodPost, "/api/admin/user", `{}`)
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("POST /api/admin/user: expected 405, got %d", resp.StatusCode)
	}
}

// normPtr: presente-pero-vacío se trata como ausente; recorta espacios.
func TestNormPtr(t *testing.T) {
	if got := normPtr(nil); got != nil {
		t.Fatalf("normPtr(nil) = %v, want nil", got)
	}
	empty := "   "
	if got := normPtr(&empty); got != nil {
		t.Fatalf("normPtr(blank) = %v, want nil", got)
	}
	v := "  Ana  "
	got := normPtr(&v)
	if got == nil || *got != "Ana" {
		t.Fatalf("normPtr trim: got %v, want Ana", got)
	}
}

// Formato de email de la edición de identidad.
func TestEmailFmtRe(t *testing.T) {
	valid := []string{"a@b.co", "user.name+tag@sub.dominio.com"}
	invalid := []string{"", "sin-arroba", "a@b", "a b@c.co", "a@b .co"}
	for _, e := range valid {
		if !emailFmtRe.MatchString(e) {
			t.Fatalf("emailFmtRe: %q debería ser válido", e)
		}
	}
	for _, e := range invalid {
		if emailFmtRe.MatchString(e) {
			t.Fatalf("emailFmtRe: %q debería ser inválido", e)
		}
	}
}
