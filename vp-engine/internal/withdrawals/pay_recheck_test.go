package withdrawals

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/rs/zerolog"
)

// payHandler arma un Handler admin listo para POSTear la acción "pay", con el
// store doble y (opcionalmente) un backend BMP falso.
func payHandler(t *testing.T, fs *fakeStore, bmpURL string) http.Handler {
	t.Helper()
	h := NewHandler(fs, testToken, []string{"admin@test.local"}, zerolog.Nop())
	if bmpURL != "" {
		h.SetBMPClient(NewBMPClient(bmpURL, "cid", "csec"))
	}
	return h.Routes()
}

func doAction(t *testing.T, routes http.Handler, action string, id int64) *httptest.ResponseRecorder {
	t.Helper()
	req := adminPost(t, "/api/admin/withdrawals/action", withdrawalActionReq{
		Email: "admin@test.local", ID: id, Action: action,
	})
	rr := httptest.NewRecorder()
	routes.ServeHTTP(rr, req)
	return rr
}

// Al PAGAR, el handler re-verifica contra BMP y persiste el resultado ANTES de
// llamar a SetWithdrawalStatus: el candado tiene que evaluar datos frescos, no
// la verificación del día de la solicitud.
func TestPayAction_ReVerifiesAndPersistsBeforeSettingStatus(t *testing.T) {
	bmp := bmpServer(t, 200, bmpFullyOK)
	defer bmp.Close()

	var refreshedBeforeStatus bool
	fs := &fakeStore{}
	fs.setStatusFn = func(_ context.Context, _ int64, _, _ string) error {
		refreshedBeforeStatus = fs.refreshCalled
		return nil
	}
	fs.emailByIDFn = func(_ context.Context, _ int64) (string, error) { return "a@b.com", nil }

	rr := doAction(t, payHandler(t, fs, bmp.URL), "pay", 7)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d (%s), want 200", rr.Code, rr.Body.String())
	}
	if !fs.refreshCalled {
		t.Fatal("no se persistió la re-verificación BMP al pagar")
	}
	if !refreshedBeforeStatus {
		t.Fatal("RefreshBMPVerification corrió DESPUÉS de SetWithdrawalStatus; debe ser antes")
	}
	if fs.refreshedID != 7 {
		t.Fatalf("refreshed id = %d, want 7", fs.refreshedID)
	}
	if !fs.refreshedVerification.CanWithdraw {
		t.Fatal("la verificación persistida no refleja la respuesta elegible de BMP")
	}
}

// Si BMP no responde, NO se refresca nada: la verificación vieja queda y el
// candado del store la rechaza. Fail-closed por omisión — el handler no
// inventa un 'allowed' ni aborta el flujo por su cuenta.
func TestPayAction_BMPDown_DoesNotRefresh_LetsGuardReject(t *testing.T) {
	bmp := bmpServer(t, 500, `{}`)
	defer bmp.Close()

	fs := &fakeStore{
		setStatusFn: func(_ context.Context, _ int64, _, _ string) error { return ErrBMPStale },
	}

	rr := doAction(t, payHandler(t, fs, bmp.URL), "pay", 9)
	if fs.refreshCalled {
		t.Fatal("se refrescó la verificación pese a que BMP falló; debe quedar la vieja (fail-closed)")
	}
	if rr.Code != http.StatusConflict {
		t.Fatalf("status = %d (%s), want 409", rr.Code, rr.Body.String())
	}
	if got := decodeErr(t, rr); got != "bmp_verification_stale" {
		t.Fatalf("error = %q, want bmp_verification_stale", got)
	}
}

// El rechazo del candado es política, no falla: 409 con motivo accionable, NO
// 500. Un 500 le diría al admin "se cayó algo, reintentá".
func TestPayAction_NotEligible_Returns409(t *testing.T) {
	fs := &fakeStore{
		setStatusFn: func(_ context.Context, _ int64, _, _ string) error { return ErrBMPNotEligible },
	}

	rr := doAction(t, payHandler(t, fs, ""), "pay", 3)
	if rr.Code != http.StatusConflict {
		t.Fatalf("status = %d (%s), want 409", rr.Code, rr.Body.String())
	}
	if got := decodeErr(t, rr); got != "bmp_not_eligible" {
		t.Fatalf("error = %q, want bmp_not_eligible", got)
	}
}

// El re-chequeo es SÓLO para pagar. Aprobar/rechazar/cancelar no mueven dinero:
// no deben gastar un round-trip contra un tercero ni depender de que responda.
func TestNonPayActions_DoNotReVerifyBMP(t *testing.T) {
	bmp := bmpServer(t, 200, bmpFullyOK)
	defer bmp.Close()

	for _, action := range []string{"approve", "reject", "cancel"} {
		fs := &fakeStore{}
		rr := doAction(t, payHandler(t, fs, bmp.URL), action, 5)
		if rr.Code != http.StatusOK {
			t.Fatalf("%s: status = %d (%s), want 200", action, rr.Code, rr.Body.String())
		}
		if fs.refreshCalled || fs.emailByIDCalled {
			t.Fatalf("%s disparó el re-chequeo BMP; sólo 'pay' debe hacerlo", action)
		}
	}
}

// Si no se puede resolver el email del retiro, no se paga: seguir adelante
// dejaría al candado evaluando una verificación que nadie pudo refrescar, y el
// admin recibiría un rechazo por "vencida" que no explica la causa real.
func TestPayAction_EmailResolutionFails_Returns500(t *testing.T) {
	bmp := bmpServer(t, 200, bmpFullyOK)
	defer bmp.Close()

	fs := &fakeStore{
		emailByIDFn: func(_ context.Context, _ int64) (string, error) {
			return "", errors.New("boom")
		},
		setStatusFn: func(_ context.Context, _ int64, _, _ string) error {
			t.Fatal("no debió llamarse a SetWithdrawalStatus")
			return nil
		},
	}

	rr := doAction(t, payHandler(t, fs, bmp.URL), "pay", 11)
	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d (%s), want 500", rr.Code, rr.Body.String())
	}
}

// Sin cliente BMP configurado el handler no re-verifica (no hay a quién
// preguntarle), pero SÍ llama al store: el candado decide con lo persistido.
func TestPayAction_NoBMPClient_StillCallsStore(t *testing.T) {
	fs := &fakeStore{}
	rr := doAction(t, payHandler(t, fs, ""), "pay", 4)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d (%s), want 200", rr.Code, rr.Body.String())
	}
	if fs.refreshCalled {
		t.Fatal("se refrescó BMP sin cliente configurado")
	}
	if fs.gotSetStatus != "paid" {
		t.Fatalf("gotSetStatus = %q, want paid", fs.gotSetStatus)
	}
	var out map[string]string
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out["status"] != "paid" {
		t.Fatalf("respuesta = %v, want status=paid", out)
	}
}
