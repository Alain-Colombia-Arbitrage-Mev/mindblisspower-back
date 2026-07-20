package withdrawals

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/rs/zerolog"
)

// ---------------------------------------------------------------------------
// GET /api/payments/bmp-status
// ---------------------------------------------------------------------------

func TestBMPStatusEndpoint_Eligible(t *testing.T) {
	bmp := bmpServer(t, 200, bmpFullyOK)
	defer bmp.Close()

	h := NewHandler(nil, "tok", nil, zerolog.Nop())
	h.SetBMPClient(NewBMPClient(bmp.URL, "cid", "csec"))
	srv := httptest.NewServer(h.Routes())
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/payments/bmp-status?email=a@b.com", nil)
	req.Header.Set("X-VP-Service-Token", "tok")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	var out struct {
		Available   bool   `json:"available"`
		CanWithdraw bool   `json:"can_withdraw"`
		BlockReason string `json:"block_reason"`
		BMPEmail    string `json:"bmp_email"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !out.Available || !out.CanWithdraw {
		t.Fatalf("available/can_withdraw = %v/%v, want true/true", out.Available, out.CanWithdraw)
	}
	// Sin vínculo BMP alterno aprobado (acá el Handler no tiene store), el email
	// verificado es el de sesión: el modal lo muestra para que el afiliado sepa
	// CON QUÉ correo se comprobó su cuenta BMP. El caso con vínculo aprobado lo
	// cubre TestBMPStatus_UsesApprovedLinkedEmail.
	if out.BMPEmail != "a@b.com" {
		t.Fatalf("bmp_email = %q, want a@b.com", out.BMPEmail)
	}
}

// BMP caído ⇒ available:false, pero 200 (fail-open: el modal deja continuar).
func TestBMPStatusEndpoint_Unavailable(t *testing.T) {
	bmp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer bmp.Close()

	h := NewHandler(nil, "tok", nil, zerolog.Nop())
	h.SetBMPClient(NewBMPClient(bmp.URL, "cid", "csec"))
	srv := httptest.NewServer(h.Routes())
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/payments/bmp-status?email=a@b.com", nil)
	req.Header.Set("X-VP-Service-Token", "tok")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (fail-open)", resp.StatusCode)
	}

	var out struct {
		Available   bool   `json:"available"`
		BlockReason string `json:"block_reason"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if out.Available {
		t.Fatal("available = true, want false")
	}
	if out.BlockReason != BlockUnavailable {
		t.Fatalf("block_reason = %q, want %q", out.BlockReason, BlockUnavailable)
	}
}

// Sin cliente BMP configurado (BMP_CLIENT_ID/SECRET ausentes) el endpoint no
// revienta: responde igual que "BMP caído".
func TestBMPStatusEndpoint_NoClientConfigured(t *testing.T) {
	h := NewHandler(nil, testToken, nil, zerolog.Nop())
	req := httptest.NewRequest(http.MethodGet, "/api/payments/bmp-status?email=a@b.com", nil)
	req.Header.Set("X-VP-Service-Token", testToken)
	rr := httptest.NewRecorder()
	h.Routes().ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d (%s), want 200", rr.Code, rr.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out["available"] != false || out["block_reason"] != BlockUnavailable {
		t.Fatalf("body = %s, want available:false block_reason:unavailable", rr.Body.String())
	}
}

func TestBMPStatusEndpoint_RequiresServiceToken(t *testing.T) {
	h := NewHandler(nil, testToken, nil, zerolog.Nop())
	rr := httptest.NewRecorder()
	h.Routes().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/payments/bmp-status?email=a@b.com", nil))

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rr.Code)
	}
}

// ---------------------------------------------------------------------------
// logBMPError — el fallo de NUESTRAS credenciales se distingue del resto
// ---------------------------------------------------------------------------

// Un 401/403 de BMP significa que nuestro Client-Id/Client-Secret venció o fue
// revocado: bloquea la verificación de TODOS los afiliados, no de uno. Debe
// distinguirse PROGRAMÁTICAMENTE (errors.Is, no substring del mensaje) y salir
// con nivel Error, para que la alerta operativa se dispare.
func TestLogBMPError_AuthErrorIsDistinguished(t *testing.T) {
	authErr := fmt.Errorf("bmp: status 401: %w", ErrBMPAuth)
	if !errors.Is(authErr, ErrBMPAuth) {
		t.Fatal("precondición rota: el error de auth no envuelve ErrBMPAuth")
	}

	cases := []struct {
		name      string
		err       error
		wantLevel string
	}{
		{"credenciales rechazadas", authErr, "error"},
		{"rate limit", errors.New("bmp: status 429"), "warn"},
		{"5xx", errors.New("bmp: status 500"), "warn"},
		{"red", errors.New("bmp: request: dial tcp: connection refused"), "warn"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var buf bytes.Buffer
			h := NewHandler(nil, testToken, nil, zerolog.New(&buf))
			h.logBMPError(tc.err)

			var entry map[string]any
			if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &entry); err != nil {
				t.Fatalf("log no parseable %q: %v", buf.String(), err)
			}
			if entry["level"] != tc.wantLevel {
				t.Fatalf("level = %v, want %q (log: %s)", entry["level"], tc.wantLevel, buf.String())
			}
		})
	}
}

// El 401 real que produce el cliente (no uno fabricado) también se distingue
// con errors.Is: fija el contrato de extremo a extremo entre bmp.go y http.go.
func TestLogBMPError_RealAuthErrorFromClient(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	_, err := NewBMPClient(srv.URL, "cid", "csec").VerifyUser(context.Background(), "a@b.com")
	if !errors.Is(err, ErrBMPAuth) {
		t.Fatalf("errors.Is(err, ErrBMPAuth) = false (err=%v)", err)
	}

	var buf bytes.Buffer
	h := NewHandler(nil, testToken, nil, zerolog.New(&buf))
	h.logBMPError(err)

	var entry map[string]any
	if uerr := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &entry); uerr != nil {
		t.Fatalf("log no parseable %q: %v", buf.String(), uerr)
	}
	if entry["level"] != "error" {
		t.Fatalf("level = %v, want error (log: %s)", entry["level"], buf.String())
	}
}

// ---------------------------------------------------------------------------
// handleWithdraw — la verificación BMP al SOLICITAR es FAIL-OPEN
// ---------------------------------------------------------------------------

// withdrawWith ejecuta un POST /api/payments/withdraw contra un handler con el
// cliente BMP apuntando a `bmpURL` (vacío ⇒ sin cliente).
func withdrawWith(t *testing.T, store *fakeStore, bmpURL string) *httptest.ResponseRecorder {
	t.Helper()
	h := NewHandler(store, testToken, nil, zerolog.Nop())
	if bmpURL != "" {
		h.SetBMPClient(NewBMPClient(bmpURL, "cid", "csec"))
	}
	req := adminPost(t, "/api/payments/withdraw", map[string]any{
		"email": "a@b.com", "amount": "150.00", "bank_info": "Banco X 12345",
	})
	rr := httptest.NewRecorder()
	h.Routes().ServeHTTP(rr, req)
	return rr
}

// EL TEST DEL FAIL-OPEN. Si BMP no responde, la solicitud SE REGISTRA igual,
// marcada 'unavailable'. Convertir esto en fail-closed (devolver un error HTTP
// cuando VerifyUser falla) debe hacer fallar este test.
func TestHandleWithdraw_BMPUnavailable_FailsOpen(t *testing.T) {
	bmp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer bmp.Close()

	store := &fakeStore{}
	rr := withdrawWith(t, store, bmp.URL)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d (%s), want 200: una caída de BMP no debe frenar la solicitud",
			rr.Code, rr.Body.String())
	}
	if store.gotRequestEmail != "a@b.com" {
		t.Fatal("el store no fue invocado: fail-open debió registrar la solicitud igual")
	}
	if store.gotVerification.BlockReason != BlockUnavailable {
		t.Fatalf("verification.BlockReason = %q, want %q",
			store.gotVerification.BlockReason, BlockUnavailable)
	}
	if store.gotVerification.CanWithdraw {
		t.Fatal("CanWithdraw = true con BMP caído")
	}
	if store.gotVerification.CheckedAt.IsZero() {
		t.Fatal("CheckedAt vacío: la fila necesita saber CUÁNDO se intentó verificar")
	}
}

// Mismo fail-open cuando el fallo son NUESTRAS credenciales (401): se alerta,
// pero el afiliado no queda congelado.
func TestHandleWithdraw_BMPAuthError_FailsOpen(t *testing.T) {
	bmp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer bmp.Close()

	store := &fakeStore{}
	rr := withdrawWith(t, store, bmp.URL)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d (%s), want 200 (fail-open)", rr.Code, rr.Body.String())
	}
	if store.gotVerification.BlockReason != BlockUnavailable {
		t.Fatalf("BlockReason = %q, want %q", store.gotVerification.BlockReason, BlockUnavailable)
	}
}

// Sin cliente BMP configurado la solicitud también pasa, marcada 'unavailable'.
func TestHandleWithdraw_NoBMPClient_FailsOpen(t *testing.T) {
	store := &fakeStore{}
	rr := withdrawWith(t, store, "")

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d (%s), want 200", rr.Code, rr.Body.String())
	}
	if store.gotVerification.BlockReason != BlockUnavailable {
		t.Fatalf("BlockReason = %q, want %q", store.gotVerification.BlockReason, BlockUnavailable)
	}
}

// BMP responde y el afiliado es elegible: la verificación llega íntegra al
// store junto con el email con el que se verificó.
func TestHandleWithdraw_BMPEligible_PropagatesVerification(t *testing.T) {
	bmp := bmpServer(t, 200, bmpFullyOK)
	defer bmp.Close()

	store := &fakeStore{}
	rr := withdrawWith(t, store, bmp.URL)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d (%s), want 200", rr.Code, rr.Body.String())
	}
	if !store.gotVerification.CanWithdraw {
		t.Fatalf("CanWithdraw = false (reason %q), want true", store.gotVerification.BlockReason)
	}
	if store.gotBMPEmail != "a@b.com" {
		t.Fatalf("bmpEmail al store = %q, want a@b.com", store.gotBMPEmail)
	}
}

// BMP responde que el afiliado NO puede retirar: la solicitud igual se registra
// (la decide un admin), pero con el motivo del bloqueo, no con 'allowed'.
func TestHandleWithdraw_BMPBlocked_StillRecordsWithReason(t *testing.T) {
	bmp := bmpServer(t, 200, `{
	  "exists": true,
	  "user": {"userId":"u-1"},
	  "virtualAccountActivated": true,
	  "withdrawalStatus": "allowed",
	  "bridgeCustomerStatus": "pending"
	}`)
	defer bmp.Close()

	store := &fakeStore{}
	rr := withdrawWith(t, store, bmp.URL)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d (%s), want 200", rr.Code, rr.Body.String())
	}
	if store.gotVerification.CanWithdraw {
		t.Fatal("CanWithdraw = true con KYC pendiente")
	}
	if store.gotVerification.BlockReason != BlockKYCPending {
		t.Fatalf("BlockReason = %q, want %q", store.gotVerification.BlockReason, BlockKYCPending)
	}
}

// bmpEmailFor debe tolerar un Handler SIN store: los tests de handler lo
// construyen así, y en la Task 11 el cuerpo consultará la base.
func TestBMPEmailFor_NilStore(t *testing.T) {
	h := NewHandler(nil, testToken, nil, zerolog.Nop())
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	if got := h.bmpEmailFor(req, "a@b.com"); got != "a@b.com" {
		t.Fatalf("bmpEmailFor = %q, want a@b.com", got)
	}
}
