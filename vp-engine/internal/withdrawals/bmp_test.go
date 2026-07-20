package withdrawals

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Contrato real de BMP, verificado contra producción: los headers de
// credenciales llevan prefijo x- obligatorio y la ruta NO lleva el segmento
// "be-". La documentación (developer_apis.pdf) dice otra cosa y está
// equivocada; manda el servicio real. TestVerifyUser_RequestContract fija esto
// con aserciones explícitas — no cambies estas constantes para "arreglar" un
// test que falla: si fallan, es que bmp.go dejó de hablar el contrato real.
const (
	bmpHeaderClientID     = "x-client-id"
	bmpHeaderClientSecret = "x-client-secret"
	bmpWantPath           = "/api/v1/mindpower/user-verification"

	bmpTestClientID     = "cid"
	bmpTestClientSecret = "csec"
)

func bmpServer(t *testing.T, status int, body string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(bmpHeaderClientID) != bmpTestClientID ||
			r.Header.Get(bmpHeaderClientSecret) != bmpTestClientSecret {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.Query().Get("email") == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
}

const bmpFullyOK = `{
  "exists": true,
  "user": {"userId":"u-1","email":"a@b.com","username":"ab"},
  "virtualAccountActivated": true,
  "cardActivated": true,
  "isFullyActivated": true,
  "withdrawalStatus": "allowed",
  "bridgeCustomerId": "bc-1",
  "bridgeCustomerStatus": "active"
}`

// La tarjeta PayCrypto NO es requisito: sirve para gastar, no para recibir.
func TestVerifyUser_CardInactive_StillEligible(t *testing.T) {
	srv := bmpServer(t, 200, `{
	  "exists": true,
	  "user": {"userId":"u-1","email":"a@b.com","username":"ab"},
	  "virtualAccountActivated": true,
	  "cardActivated": false,
	  "isFullyActivated": false,
	  "withdrawalStatus": "allowed",
	  "bridgeCustomerStatus": "active"
	}`)
	defer srv.Close()

	v, err := NewBMPClient(srv.URL, "cid", "csec").VerifyUser(context.Background(), "a@b.com")
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !v.CanWithdraw {
		t.Fatalf("CanWithdraw = false (reason %q), want true", v.BlockReason)
	}
}

// El veto de BMP manda aunque la VA esté activa.
func TestVerifyUser_BMPBlocked_NotEligible(t *testing.T) {
	srv := bmpServer(t, 200, `{
	  "exists": true,
	  "user": {"userId":"u-1"},
	  "virtualAccountActivated": true,
	  "withdrawalStatus": "blocked",
	  "restrictionReason": "compliance_hold",
	  "bridgeCustomerStatus": "active"
	}`)
	defer srv.Close()

	v, _ := NewBMPClient(srv.URL, "cid", "csec").VerifyUser(context.Background(), "a@b.com")
	if v.CanWithdraw {
		t.Fatal("CanWithdraw = true, want false")
	}
	if v.BlockReason != BlockBMPBlocked {
		t.Fatalf("BlockReason = %q, want %q", v.BlockReason, BlockBMPBlocked)
	}
}

// 'allowed' NO alcanza si la cuenta virtual no está activada.
func TestVerifyUser_AllowedButNoVA_NotEligible(t *testing.T) {
	srv := bmpServer(t, 200, `{
	  "exists": true,
	  "user": {"userId":"u-1"},
	  "virtualAccountActivated": false,
	  "withdrawalStatus": "allowed",
	  "bridgeCustomerStatus": "active"
	}`)
	defer srv.Close()

	v, _ := NewBMPClient(srv.URL, "cid", "csec").VerifyUser(context.Background(), "a@b.com")
	if v.CanWithdraw {
		t.Fatal("CanWithdraw = true, want false")
	}
	if v.BlockReason != BlockVAIncomplete {
		t.Fatalf("BlockReason = %q, want %q", v.BlockReason, BlockVAIncomplete)
	}
}

// Precedencia: con Bridge inactivo Y VA inactiva se reporta kyc_pending.
func TestVerifyUser_Precedence_KYCBeforeVA(t *testing.T) {
	srv := bmpServer(t, 200, `{
	  "exists": true,
	  "user": {"userId":"u-1"},
	  "virtualAccountActivated": false,
	  "withdrawalStatus": "blocked",
	  "bridgeCustomerStatus": "pending"
	}`)
	defer srv.Close()

	v, _ := NewBMPClient(srv.URL, "cid", "csec").VerifyUser(context.Background(), "a@b.com")
	if v.BlockReason != BlockKYCPending {
		t.Fatalf("BlockReason = %q, want %q", v.BlockReason, BlockKYCPending)
	}
}

// El caso que importa para el dinero: KYC (Bridge) pendiente debe bloquear el
// pago aunque la cuenta virtual esté activa y BMP permita el retiro. No basta
// con afirmar el BlockReason: si alguien reordena el switch o mueve la
// condición de bridgeCustomerStatus fuera de la cadena, CanWithdraw podría
// quedar en true mientras el afiliado sigue sin KYC aprobado.
func TestVerifyUser_KYCPending_NotEligible(t *testing.T) {
	srv := bmpServer(t, 200, `{
	  "exists": true,
	  "user": {"userId":"u-1"},
	  "virtualAccountActivated": true,
	  "withdrawalStatus": "allowed",
	  "bridgeCustomerStatus": "pending"
	}`)
	defer srv.Close()

	v, err := NewBMPClient(srv.URL, "cid", "csec").VerifyUser(context.Background(), "a@b.com")
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if v.CanWithdraw {
		t.Fatal("CanWithdraw = true, want false (KYC/Bridge pendiente)")
	}
	if v.BlockReason != BlockKYCPending {
		t.Fatalf("BlockReason = %q, want %q", v.BlockReason, BlockKYCPending)
	}
}

// strings.EqualFold endurece la regla literal del spec (== "active") a
// case-insensitive. Fija esa decisión: un refactor a comparación exacta debe
// romper este test.
func TestVerifyUser_CaseInsensitiveStatuses_Eligible(t *testing.T) {
	srv := bmpServer(t, 200, `{
	  "exists": true,
	  "user": {"userId":"u-1"},
	  "virtualAccountActivated": true,
	  "withdrawalStatus": "ALLOWED",
	  "bridgeCustomerStatus": "Active"
	}`)
	defer srv.Close()

	v, err := NewBMPClient(srv.URL, "cid", "csec").VerifyUser(context.Background(), "a@b.com")
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !v.CanWithdraw {
		t.Fatalf("CanWithdraw = false (reason %q), want true", v.BlockReason)
	}
}

func TestVerifyUser_NotRegistered(t *testing.T) {
	srv := bmpServer(t, 200, `{"exists": false}`)
	defer srv.Close()

	v, _ := NewBMPClient(srv.URL, "cid", "csec").VerifyUser(context.Background(), "a@b.com")
	if v.Exists || v.CanWithdraw {
		t.Fatal("Exists/CanWithdraw = true, want false")
	}
	if v.BlockReason != BlockNotRegistered {
		t.Fatalf("BlockReason = %q, want %q", v.BlockReason, BlockNotRegistered)
	}
}

func TestVerifyUser_Eligible(t *testing.T) {
	srv := bmpServer(t, 200, bmpFullyOK)
	defer srv.Close()

	v, err := NewBMPClient(srv.URL, "cid", "csec").VerifyUser(context.Background(), "a@b.com")
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !v.CanWithdraw {
		t.Fatal("CanWithdraw = false, want true")
	}
	if v.UserID != "u-1" {
		t.Fatalf("UserID = %q, want u-1", v.UserID)
	}
	if v.CheckedAt.IsZero() {
		t.Fatal("CheckedAt vacío")
	}
}

// Errores upstream: devuelven error Y una verificación con BlockUnavailable, de
// modo que el caller puede persistir el estado sin ramificar.
func TestVerifyUser_UpstreamErrors(t *testing.T) {
	for _, tc := range []struct {
		name string
		code int
	}{
		{"unauthorized", 401},
		{"forbidden", 403},
		{"rate_limited", 429},
		{"server_error", 500},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.code)
			}))
			defer srv.Close()

			v, err := NewBMPClient(srv.URL, "cid", "csec").VerifyUser(context.Background(), "a@b.com")
			if err == nil {
				t.Fatal("err = nil, want error")
			}
			if v.BlockReason != BlockUnavailable {
				t.Fatalf("BlockReason = %q, want %q", v.BlockReason, BlockUnavailable)
			}
			if v.CanWithdraw {
				t.Fatal("CanWithdraw = true en error upstream")
			}
		})
	}
}

// 401/403 significan que fallaron NUESTRAS credenciales (bloquea a TODOS los
// afiliados, no a uno). El caller debe poder distinguirlo con errors.Is en
// vez de parsear el string del error, para emitir una alerta operativa
// diferenciada (consumido por Task 9).
func TestVerifyUser_AuthError_WrapsErrBMPAuth(t *testing.T) {
	for _, tc := range []struct {
		name    string
		code    int
		wantErr bool
	}{
		{"unauthorized", http.StatusUnauthorized, true},
		{"forbidden", http.StatusForbidden, true},
		{"rate_limited", http.StatusTooManyRequests, false},
		{"server_error", http.StatusInternalServerError, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.code)
			}))
			defer srv.Close()

			_, err := NewBMPClient(srv.URL, "cid", "csec").VerifyUser(context.Background(), "a@b.com")
			if err == nil {
				t.Fatal("err = nil, want error")
			}
			if got := errors.Is(err, ErrBMPAuth); got != tc.wantErr {
				t.Fatalf("errors.Is(err, ErrBMPAuth) = %v, want %v (err=%v)", got, tc.wantErr, err)
			}
		})
	}
}

// El contrato de transporte con BMP (nombres de header y ruta) es tan parte del
// contrato como el JSON de respuesta, y es igual de fácil de romper sin querer:
// el prefijo x- y el segmento "mindpower" (no "be-mindpower") salieron de
// verificar contra producción, contra lo que dice el PDF.
//
// El resto de los tests solo lo comprueba de forma INDIRECTA: el fake devuelve
// 401 y el fallo aparece como "bmp: status 401: credenciales rechazadas", que
// describe el síntoma y no la causa. Aquí se afirma de forma explícita, para
// que un cambio accidental diga exactamente qué se rompió.
func TestVerifyUser_RequestContract(t *testing.T) {
	var called bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true

		// t.Errorf (no Fatalf): el handler corre en otra goroutine, donde
		// Fatalf no detendría el test y además dejaría la respuesta sin
		// escribir.
		if got := r.URL.Path; got != bmpWantPath {
			t.Errorf("ruta del endpoint BMP = %q, want %q\n"+
				"  → verificationPath en bmp.go dejó de coincidir con la ruta real de BMP.", got, bmpWantPath)
		}
		if got := r.Header.Get(bmpHeaderClientID); got != bmpTestClientID {
			t.Errorf("header %q = %q, want %q\n"+
				"  → BMP exige el prefijo x-; sin él responde 401 \"Missing client credentials\".", bmpHeaderClientID, got, bmpTestClientID)
		}
		if got := r.Header.Get(bmpHeaderClientSecret); got != bmpTestClientSecret {
			t.Errorf("header %q = %q, want %q\n"+
				"  → BMP exige el prefijo x-; sin él responde 401 \"Missing client credentials\".", bmpHeaderClientSecret, got, bmpTestClientSecret)
		}

		// Los nombres SIN prefijo son los que documentaba el PDF. Si aparecen,
		// alguien revirtió el fix contra producción: dilo con todas las letras.
		for _, stale := range []string{"Client-Id", "Client-Secret"} {
			if v := r.Header.Get(stale); v != "" {
				t.Errorf("se envió el header obsoleto %q = %q\n"+
					"  → la API de BMP no lo reconoce; usa x-client-id / x-client-secret.", stale, v)
			}
		}

		// El email viaja como query param, en minúsculas.
		if got := r.URL.Query().Get("email"); got != "a@b.com" {
			t.Errorf("query email = %q, want %q", got, "a@b.com")
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(bmpFullyOK))
	}))
	defer srv.Close()

	v, err := NewBMPClient(srv.URL, bmpTestClientID, bmpTestClientSecret).
		VerifyUser(context.Background(), "A@B.com")
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !called {
		t.Fatal("BMP nunca fue llamado: el contrato no se verificó")
	}
	if !v.CanWithdraw {
		t.Fatalf("CanWithdraw = false (reason %q), want true", v.BlockReason)
	}
}

func TestBMPClient_Enabled(t *testing.T) {
	if NewBMPClient("http://x", "", "").Enabled() {
		t.Fatal("Enabled = true sin credenciales")
	}
	if !NewBMPClient("http://x", "cid", "csec").Enabled() {
		t.Fatal("Enabled = false con credenciales")
	}
}
