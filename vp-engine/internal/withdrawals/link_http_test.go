package withdrawals

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/rs/zerolog"
)

// linkSrv monta un Handler con fakeStore + un BMP que responde `body`.
func linkSrv(t *testing.T, fs *fakeStore, bmpBody string) (*httptest.Server, func()) {
	t.Helper()
	bmp := bmpServer(t, 200, bmpBody)
	h := NewHandler(fs, "tok", []string{"admin@test.local"}, zerolog.Nop())
	h.SetBMPClient(NewBMPClient(bmp.URL, "cid", "csec"))
	srv := httptest.NewServer(h.Routes())
	return srv, func() { srv.Close(); bmp.Close() }
}

func postJSON(t *testing.T, url string, body any) *http.Response {
	t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(b))
	req.Header.Set("X-VP-Service-Token", "tok")
	req.Header.Set("X-Forwarded-For", "203.0.113.9, 10.0.0.1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("post %s: %v", url, err)
	}
	return resp
}

// ---------------------------------------------------------------------------
// Step 8: la verificación BMP usa el email VINCULADO, no el de sesión.
// Sin esta prueba, bmpEmailFor podría quedar desconectado y nadie lo notaría.
// ---------------------------------------------------------------------------

func TestBMPStatus_UsesApprovedLinkedEmail(t *testing.T) {
	fs := &fakeStore{approvedFn: func(_ context.Context, _ string) (string, error) {
		return "vinculado@bmp.com", nil
	}}
	srv, done := linkSrv(t, fs, bmpFullyOK)
	defer done()

	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/payments/bmp-status?email=sesion@test.local", nil)
	req.Header.Set("X-VP-Service-Token", "tok")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()

	var out struct {
		BMPEmail string `json:"bmp_email"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.BMPEmail != "vinculado@bmp.com" {
		t.Fatalf("bmp_email = %q, want vinculado@bmp.com (el vínculo aprobado, no el de sesión)", out.BMPEmail)
	}
	if fs.approvedCalledWith != "sesion@test.local" {
		t.Fatalf("ApprovedBMPEmail consultado con %q, want sesion@test.local", fs.approvedCalledWith)
	}
}

// Y el retiro se solicita verificando (y persistiendo) ese mismo email vinculado.
func TestWithdraw_VerifiesAgainstApprovedLinkedEmail(t *testing.T) {
	fs := &fakeStore{approvedFn: func(_ context.Context, _ string) (string, error) {
		return "vinculado@bmp.com", nil
	}}
	srv, done := linkSrv(t, fs, bmpFullyOK)
	defer done()

	resp := postJSON(t, srv.URL+"/api/payments/withdraw", map[string]string{
		"email": "sesion@test.local", "amount": "150.00", "bank_info": "banco cuenta titular",
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if fs.gotBMPEmail != "vinculado@bmp.com" {
		t.Fatalf("bmp_email persistido = %q, want vinculado@bmp.com", fs.gotBMPEmail)
	}
	// Sigue siendo el afiliado de sesión el que retira: el vínculo cambia DÓNDE
	// se deposita, no QUIÉN cobra.
	if fs.gotRequestEmail != "sesion@test.local" {
		t.Fatalf("email del retiro = %q, want sesion@test.local", fs.gotRequestEmail)
	}
}

// Sin vínculo aprobado se sigue usando el email de sesión.
func TestBMPStatus_NoLink_UsesSessionEmail(t *testing.T) {
	fs := &fakeStore{}
	srv, done := linkSrv(t, fs, bmpFullyOK)
	defer done()

	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/payments/bmp-status?email=sesion@test.local", nil)
	req.Header.Set("X-VP-Service-Token", "tok")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()

	var out struct {
		BMPEmail string `json:"bmp_email"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.BMPEmail != "sesion@test.local" {
		t.Fatalf("bmp_email = %q, want sesion@test.local", out.BMPEmail)
	}
}

// ---------------------------------------------------------------------------
// POST /api/payments/bmp-link
// ---------------------------------------------------------------------------

func TestBMPLinkRequest_VerifiesAndRecordsIP(t *testing.T) {
	fs := &fakeStore{}
	srv, done := linkSrv(t, fs, bmpFullyOK)
	defer done()

	resp := postJSON(t, srv.URL+"/api/payments/bmp-link", map[string]string{
		"email": "sesion@test.local", "bmp_email": "otro@bmp.com",
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var out struct {
		ID     int64  `json:"id"`
		Status string `json:"status"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// El vínculo NACE pendiente: nunca aprobado de entrada.
	if out.Status != "pending_admin" || out.ID == 0 {
		t.Fatalf("respuesta = %+v, want status pending_admin con id", out)
	}
	if fs.gotLinkBMPEmail != "otro@bmp.com" || fs.gotLinkMemberEmail != "sesion@test.local" {
		t.Fatalf("store recibió %q/%q", fs.gotLinkMemberEmail, fs.gotLinkBMPEmail)
	}
	// Se registra la IP del solicitante (primer hop del XFF).
	if fs.gotLinkIP != "203.0.113.9" {
		t.Fatalf("ip = %q, want 203.0.113.9", fs.gotLinkIP)
	}
	// Y el resultado de la verificación BMP viaja al store.
	if !fs.gotLinkVerif.Exists || fs.gotLinkVerif.UserID != "u-1" {
		t.Fatalf("verificación propagada = %+v", fs.gotLinkVerif)
	}
}

// Una segunda solicitud pendiente ⇒ 409, no 500.
func TestBMPLinkRequest_PendingConflict(t *testing.T) {
	fs := &fakeStore{requestLinkFn: func(context.Context, string, string, string, BMPVerification) (int64, error) {
		return 0, ErrLinkPending
	}}
	srv, done := linkSrv(t, fs, bmpFullyOK)
	defer done()

	resp := postJSON(t, srv.URL+"/api/payments/bmp-link", map[string]string{
		"email": "s@test.local", "bmp_email": "otro@bmp.com",
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d, want 409", resp.StatusCode)
	}
}

// BMP no reconoce el email ⇒ 400 y NUNCA llega al store como éxito.
func TestBMPLinkRequest_UnknownEmail(t *testing.T) {
	fs := &fakeStore{requestLinkFn: func(context.Context, string, string, string, BMPVerification) (int64, error) {
		return 0, ErrBMPEmailUnknown
	}}
	srv, done := linkSrv(t, fs, `{"exists": false}`)
	defer done()

	resp := postJSON(t, srv.URL+"/api/payments/bmp-link", map[string]string{
		"email": "s@test.local", "bmp_email": "fantasma@bmp.com",
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	if fs.gotLinkVerif.Exists {
		t.Fatal("se propagó Exists=true para un email que BMP no reconoce")
	}
}

// ---------------------------------------------------------------------------
// /api/admin/bmp-links (+ /action)
// ---------------------------------------------------------------------------

func TestAdminBMPLinks_RequiresAdmin(t *testing.T) {
	fs := &fakeStore{}
	srv, done := linkSrv(t, fs, bmpFullyOK)
	defer done()

	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/admin/bmp-links?email=nadie@test.local", nil)
	req.Header.Set("X-VP-Service-Token", "tok")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", resp.StatusCode)
	}
}

func TestAdminBMPLinkAction_ApproveAndConflict(t *testing.T) {
	fs := &fakeStore{}
	srv, done := linkSrv(t, fs, bmpFullyOK)
	defer done()

	resp := postJSON(t, srv.URL+"/api/admin/bmp-links/action", map[string]any{
		"email": "admin@test.local", "id": 42, "action": "approve", "note": "ok",
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if !fs.reviewLinkCalled || fs.gotReviewID != 42 || !fs.gotReviewApprove ||
		fs.gotReviewAdmin != "admin@test.local" || fs.gotReviewNote != "ok" {
		t.Fatalf("review recibió id=%d approve=%v admin=%q note=%q",
			fs.gotReviewID, fs.gotReviewApprove, fs.gotReviewAdmin, fs.gotReviewNote)
	}

	// Un vínculo ya resuelto ⇒ 409 (política), no 500 (falla).
	fs2 := &fakeStore{reviewLinkFn: func(context.Context, int64, bool, string, string) error {
		return ErrLinkNotPending
	}}
	srv2, done2 := linkSrv(t, fs2, bmpFullyOK)
	defer done2()
	resp2 := postJSON(t, srv2.URL+"/api/admin/bmp-links/action", map[string]any{
		"email": "admin@test.local", "id": 42, "action": "approve",
	})
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d, want 409", resp2.StatusCode)
	}
}

func TestAdminBMPLinkAction_InvalidAction(t *testing.T) {
	fs := &fakeStore{}
	srv, done := linkSrv(t, fs, bmpFullyOK)
	defer done()

	resp := postJSON(t, srv.URL+"/api/admin/bmp-links/action", map[string]any{
		"email": "admin@test.local", "id": 42, "action": "delete",
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	if fs.reviewLinkCalled {
		t.Fatal("una acción inválida llegó al store")
	}
}
