package payments

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rs/zerolog"
)

// Rutas de lista negra montadas y protegidas por el service token (401 sin él).
// DB-free: solo verifica el route table + svcAuth (primer guard de requireAdmin).
func TestBlacklistRoutes_Mounted(t *testing.T) {
	h := &Handler{
		store:        &Store{}, // cache nil → allow() true; db nil no se toca sin token
		serviceToken: "test-token",
		log:          zerolog.Nop(),
	}
	srv := httptest.NewServer(h.Routes())
	defer srv.Close()

	cases := []struct {
		method, path string
	}{
		{http.MethodGet, "/api/admin/blacklist?email=admin@example.com"},
		{http.MethodPost, "/api/admin/blacklist"},
		{http.MethodPost, "/api/admin/blacklist/remove"},
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

// cognitoUsername debe coincidir con el BFF de registro (mp_ + sha256(email)[:40]).
// Par verificado contra el pool real (mbpdiag8xq@mailinator.com → mp_ccd4684...).
func TestCognitoUsername_Parity(t *testing.T) {
	got := cognitoUsername("MBPDiag8xq@Mailinator.com ") // mayúsculas/espacios: se normaliza
	want := "mp_ccd4684a149d62260f26aafab09116ab860fc691"
	if got != want {
		t.Fatalf("cognitoUsername mismatch: got %s want %s", got, want)
	}
}
