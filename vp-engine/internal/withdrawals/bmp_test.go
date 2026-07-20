package withdrawals

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func bmpServer(t *testing.T, status int, body string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Client-Id") != "cid" || r.Header.Get("Client-Secret") != "csec" {
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

func TestBMPClient_Enabled(t *testing.T) {
	if NewBMPClient("http://x", "", "").Enabled() {
		t.Fatal("Enabled = true sin credenciales")
	}
	if !NewBMPClient("http://x", "cid", "csec").Enabled() {
		t.Fatal("Enabled = false con credenciales")
	}
}
