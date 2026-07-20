package withdrawals

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"github.com/rs/zerolog"
)

// ---------------------------------------------------------------------------
// Dobles de prueba
// ---------------------------------------------------------------------------

// fakeStore implementa StoreAPI con campos-función: permite ejercitar la capa
// HTTP (contratos de respuesta, mapeo de errores, autorización) sin Postgres.
type fakeStore struct {
	requestFn   func(ctx context.Context, email, amount, bankInfo string) (WithdrawalResult, error)
	listFn      func(ctx context.Context, status string, limit, offset int) ([]AdminWithdrawal, int64, error)
	setStatusFn func(ctx context.Context, id int64, status, adminEmail string) error
	isAdminFn   func(ctx context.Context, email string) (bool, error)
	suspendedFn func(ctx context.Context, email string) (bool, error)
	emailByIDFn func(ctx context.Context, id int64) (string, error)
	refreshFn   func(ctx context.Context, id int64, v BMPVerification) error

	// vínculo BMP alterno (Task 11)
	requestLinkFn func(ctx context.Context, memberEmail, bmpEmail, ip string, v BMPVerification) (int64, error)
	listLinksFn   func(ctx context.Context, limit, offset int) ([]BMPLink, int64, error)
	reviewLinkFn  func(ctx context.Context, id int64, approve bool, adminEmail, note string) error
	approvedFn    func(ctx context.Context, memberEmail string) (string, error)

	// gravado por los handlers, para asertar lo que se propagó al store
	gotLimit, gotOffset int
	gotStatus           string
	gotID               int64
	gotSetStatus        string
	gotAdminEmail       string
	gotAmount, gotBank  string
	gotRequestEmail     string
	isAdminCalledWith   string
	isAdminCallHappened bool

	// resultado de la verificación BMP que el handler propagó al store
	gotBMPEmail     string
	gotVerification BMPVerification

	// re-chequeo BMP al pagar (Task 10)
	refreshedID           int64
	refreshedVerification BMPVerification
	refreshCalled         bool
	emailByIDCalled       bool

	// gravado por los handlers de vínculo (Task 11)
	gotLinkMemberEmail string
	gotLinkBMPEmail    string
	gotLinkIP          string
	gotLinkVerif       BMPVerification
	gotReviewID        int64
	gotReviewApprove   bool
	gotReviewAdmin     string
	gotReviewNote      string
	reviewLinkCalled   bool
	approvedCalledWith string
}

func (f *fakeStore) RequestWithdrawalWithBMP(ctx context.Context, email, amount, bankInfo, bmpEmail string, v BMPVerification) (WithdrawalResult, error) {
	f.gotRequestEmail, f.gotAmount, f.gotBank = email, amount, bankInfo
	f.gotBMPEmail, f.gotVerification = bmpEmail, v
	if f.requestFn == nil {
		return WithdrawalResult{ID: 1, Status: "requested"}, nil
	}
	return f.requestFn(ctx, email, amount, bankInfo)
}

func (f *fakeStore) ListWithdrawals(ctx context.Context, status string, limit, offset int) ([]AdminWithdrawal, int64, error) {
	f.gotStatus, f.gotLimit, f.gotOffset = status, limit, offset
	if f.listFn == nil {
		return []AdminWithdrawal{}, 0, nil
	}
	return f.listFn(ctx, status, limit, offset)
}

func (f *fakeStore) SetWithdrawalStatus(ctx context.Context, id int64, status, adminEmail string) error {
	f.gotID, f.gotSetStatus, f.gotAdminEmail = id, status, adminEmail
	if f.setStatusFn == nil {
		return nil
	}
	return f.setStatusFn(ctx, id, status, adminEmail)
}

func (f *fakeStore) IsAdmin(ctx context.Context, email string) (bool, error) {
	f.isAdminCalledWith, f.isAdminCallHappened = email, true
	if f.isAdminFn == nil {
		return false, nil
	}
	return f.isAdminFn(ctx, email)
}

func (f *fakeStore) PersonSuspendedByEmail(ctx context.Context, email string) (bool, error) {
	if f.suspendedFn == nil {
		return false, nil
	}
	return f.suspendedFn(ctx, email)
}

func (f *fakeStore) EmailByWithdrawalID(ctx context.Context, id int64) (string, error) {
	f.emailByIDCalled = true
	if f.emailByIDFn == nil {
		return "member@test.local", nil
	}
	return f.emailByIDFn(ctx, id)
}

func (f *fakeStore) RefreshBMPVerification(ctx context.Context, id int64, v BMPVerification) error {
	f.refreshCalled = true
	f.refreshedID, f.refreshedVerification = id, v
	if f.refreshFn == nil {
		return nil
	}
	return f.refreshFn(ctx, id, v)
}

func (f *fakeStore) RequestBMPLink(ctx context.Context, memberEmail, bmpEmail, ip string, v BMPVerification) (int64, error) {
	f.gotLinkMemberEmail, f.gotLinkBMPEmail, f.gotLinkIP, f.gotLinkVerif = memberEmail, bmpEmail, ip, v
	if f.requestLinkFn == nil {
		return 7, nil
	}
	return f.requestLinkFn(ctx, memberEmail, bmpEmail, ip, v)
}

func (f *fakeStore) ListPendingBMPLinks(ctx context.Context, limit, offset int) ([]BMPLink, int64, error) {
	f.gotLimit, f.gotOffset = limit, offset
	if f.listLinksFn == nil {
		return []BMPLink{}, 0, nil
	}
	return f.listLinksFn(ctx, limit, offset)
}

func (f *fakeStore) ReviewBMPLink(ctx context.Context, id int64, approve bool, adminEmail, note string) error {
	f.reviewLinkCalled = true
	f.gotReviewID, f.gotReviewApprove, f.gotReviewAdmin, f.gotReviewNote = id, approve, adminEmail, note
	if f.reviewLinkFn == nil {
		return nil
	}
	return f.reviewLinkFn(ctx, id, approve, adminEmail, note)
}

func (f *fakeStore) ApprovedBMPEmail(ctx context.Context, memberEmail string) (string, error) {
	f.approvedCalledWith = memberEmail
	if f.approvedFn == nil {
		return "", nil
	}
	return f.approvedFn(ctx, memberEmail)
}

// fakeVerifier implementa IdentityVerifier.
type fakeVerifier struct {
	email string
	err   error
}

func (v fakeVerifier) VerifyEmail(_ context.Context, _ string) (string, error) {
	return v.email, v.err
}

const testToken = "tok"

// adminPost arma un POST autenticado por token de servicio.
func adminPost(t *testing.T, url string, body any) *http.Request {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, url, bytes.NewReader(b))
	req.Header.Set("X-VP-Service-Token", testToken)
	return req
}

func decodeErr(t *testing.T, rr *httptest.ResponseRecorder) string {
	t.Helper()
	var out map[string]string
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode error body %q: %v", rr.Body.String(), err)
	}
	return out["error"]
}

// ---------------------------------------------------------------------------
// Smoke existente
// ---------------------------------------------------------------------------

func TestHealthEndpoint(t *testing.T) {
	h := NewHandler(nil, testToken, nil, zerolog.Nop())
	srv := httptest.NewServer(h.Routes())
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/health")
	if err != nil {
		t.Fatalf("get /health: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
}

func TestAdminRequiresServiceToken(t *testing.T) {
	h := NewHandler(nil, testToken, nil, zerolog.Nop())
	srv := httptest.NewServer(h.Routes())
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/admin/withdrawals")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}
}

// ---------------------------------------------------------------------------
// C1 — forma de la respuesta de handleAdminWithdrawals
// ---------------------------------------------------------------------------

// TestAdminWithdrawalsResponseShape congela el CONTRATO que consumen dos paneles
// en producción (vicion-admin/dashboard/usuarios y growth-hub/dashboard/admin,
// ambos leen `d.withdrawals`). Este test es el que habría atrapado C1: la clave
// se había renombrado a "items" y los paneles recibían 200 con lista vacía sin
// ningún error visible. Falla si alguien vuelve a renombrar o quitar una clave.
func TestAdminWithdrawalsResponseShape(t *testing.T) {
	store := &fakeStore{
		listFn: func(_ context.Context, _ string, _, _ int) ([]AdminWithdrawal, int64, error) {
			return []AdminWithdrawal{{
				ID: 7, Member: "Ada Lovelace", Email: "ada@test.local",
				AmountUSD: "150.00", Status: "requested", BankInfo: "Banco X 123",
				CreatedAt: "2026-07-19T10:00:00Z",
			}}, 42, nil
		},
	}
	h := NewHandler(store, testToken, []string{"admin@test.local"}, zerolog.Nop())

	req := httptest.NewRequest(http.MethodGet,
		"/api/admin/withdrawals?email=admin@test.local&status=requested&limit=10&offset=5", nil)
	req.Header.Set("X-VP-Service-Token", testToken)
	rr := httptest.NewRecorder()
	h.Routes().ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d (%s), want 200", rr.Code, rr.Body.String())
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(rr.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode: %v (%s)", err, rr.Body.String())
	}
	got := make([]string, 0, len(raw))
	for k := range raw {
		got = append(got, k)
	}
	sort.Strings(got)
	want := []string{"limit", "offset", "total", "withdrawals"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("claves de la respuesta = %v, want exactamente %v "+
			"(el frontend en producción lee d.withdrawals)", got, want)
	}

	var body struct {
		Withdrawals []AdminWithdrawal `json:"withdrawals"`
		Total       int64             `json:"total"`
		Limit       int               `json:"limit"`
		Offset      int               `json:"offset"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode tipado: %v", err)
	}
	if len(body.Withdrawals) != 1 || body.Withdrawals[0].ID != 7 {
		t.Fatalf("withdrawals = %+v, want 1 elemento con ID 7", body.Withdrawals)
	}
	if body.Total != 42 || body.Limit != 10 || body.Offset != 5 {
		t.Fatalf("total/limit/offset = %d/%d/%d, want 42/10/5", body.Total, body.Limit, body.Offset)
	}
	if store.gotStatus != "requested" || store.gotLimit != 10 || store.gotOffset != 5 {
		t.Fatalf("store recibió status=%q limit=%d offset=%d, want requested/10/5",
			store.gotStatus, store.gotLimit, store.gotOffset)
	}
}

// La lista vacía debe serializarse como [] (no null): el frontend hace .map().
func TestAdminWithdrawalsEmptyListIsArray(t *testing.T) {
	h := NewHandler(&fakeStore{}, testToken, []string{"admin@test.local"}, zerolog.Nop())
	req := httptest.NewRequest(http.MethodGet, "/api/admin/withdrawals?email=admin@test.local", nil)
	req.Header.Set("X-VP-Service-Token", testToken)
	rr := httptest.NewRecorder()
	h.Routes().ServeHTTP(rr, req)

	if !strings.Contains(rr.Body.String(), `"withdrawals":[]`) {
		t.Fatalf("body = %s, want withdrawals:[]", rr.Body.String())
	}
}

// Sin limit/offset explícitos se usan los defaults del original (25/0).
func TestAdminWithdrawalsDefaultPaging(t *testing.T) {
	store := &fakeStore{}
	h := NewHandler(store, testToken, []string{"admin@test.local"}, zerolog.Nop())
	req := httptest.NewRequest(http.MethodGet, "/api/admin/withdrawals?email=admin@test.local", nil)
	req.Header.Set("X-VP-Service-Token", testToken)
	h.Routes().ServeHTTP(httptest.NewRecorder(), req)

	if store.gotLimit != 25 || store.gotOffset != 0 {
		t.Fatalf("limit/offset = %d/%d, want 25/0", store.gotLimit, store.gotOffset)
	}
}

func TestAdminWithdrawalsStoreErrorIs500(t *testing.T) {
	store := &fakeStore{listFn: func(context.Context, string, int, int) ([]AdminWithdrawal, int64, error) {
		return nil, 0, errors.New("postgres caído")
	}}
	h := NewHandler(store, testToken, []string{"admin@test.local"}, zerolog.Nop())
	req := httptest.NewRequest(http.MethodGet, "/api/admin/withdrawals?email=admin@test.local", nil)
	req.Header.Set("X-VP-Service-Token", testToken)
	rr := httptest.NewRecorder()
	h.Routes().ServeHTTP(rr, req)

	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rr.Code)
	}
}

// ---------------------------------------------------------------------------
// C2 — origen del email en handleAdminWithdrawalAction
// ---------------------------------------------------------------------------

// TestAdminWithdrawalActionEmailFromBodyOnly es el test que habría atrapado C2:
// growth-hub (src/app/api/admin/withdrawals/action/route.js) manda {email,id,
// action} en el BODY y ningún query param. Leyendo el email sólo del query, el
// handler respondía 400 email_required y aprobar/pagar retiros no funcionaba.
func TestAdminWithdrawalActionEmailFromBodyOnly(t *testing.T) {
	store := &fakeStore{}
	h := NewHandler(store, testToken, []string{"admin@test.local"}, zerolog.Nop())

	// URL SIN query param: exactamente lo que manda growth-hub.
	req := adminPost(t, "/api/admin/withdrawals/action", map[string]any{
		"email": "admin@test.local", "id": 7, "action": "approve",
	})
	rr := httptest.NewRecorder()
	h.Routes().ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d (%s), want 200: el email del body debe autorizar",
			rr.Code, rr.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["status"] != "approved" {
		t.Fatalf("status = %q, want approved", body["status"])
	}
	if store.gotID != 7 || store.gotSetStatus != "approved" || store.gotAdminEmail != "admin@test.local" {
		t.Fatalf("store recibió id=%d status=%q by=%q", store.gotID, store.gotSetStatus, store.gotAdminEmail)
	}
}

// vicion-admin manda el email en query Y body: el query sigue funcionando como
// respaldo cuando el body no lo trae.
func TestAdminWithdrawalActionEmailFromQueryFallback(t *testing.T) {
	h := NewHandler(&fakeStore{}, testToken, []string{"admin@test.local"}, zerolog.Nop())
	req := adminPost(t, "/api/admin/withdrawals/action?email=admin@test.local", map[string]any{
		"id": 7, "action": "pay",
	})
	rr := httptest.NewRecorder()
	h.Routes().ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d (%s), want 200", rr.Code, rr.Body.String())
	}
}

// M2 — el chequeo de método va ANTES de requireAdmin: un GET de un NO-admin debe
// dar 405, no 403.
func TestAdminWithdrawalActionMethodCheckBeforeAuth(t *testing.T) {
	h := NewHandler(&fakeStore{}, testToken, nil, zerolog.Nop())
	req := httptest.NewRequest(http.MethodGet, "/api/admin/withdrawals/action?email=nadie@test.local", nil)
	req.Header.Set("X-VP-Service-Token", testToken)
	rr := httptest.NewRecorder()
	h.Routes().ServeHTTP(rr, req)

	if rr.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rr.Code)
	}
}

// M3 — el guard req.ID <= 0 rechaza antes de llegar al SQL.
func TestAdminWithdrawalActionRejectsNonPositiveID(t *testing.T) {
	store := &fakeStore{}
	h := NewHandler(store, testToken, []string{"admin@test.local"}, zerolog.Nop())

	for _, id := range []int{0, -1} {
		req := adminPost(t, "/api/admin/withdrawals/action", map[string]any{
			"email": "admin@test.local", "id": id, "action": "approve",
		})
		rr := httptest.NewRecorder()
		h.Routes().ServeHTTP(rr, req)

		if rr.Code != http.StatusBadRequest || decodeErr(t, rr) != "invalid_action" {
			t.Fatalf("id=%d: status=%d err=%q, want 400 invalid_action", id, rr.Code, decodeErr(t, rr))
		}
	}
	if store.gotID != 0 {
		t.Fatalf("el store fue invocado con id=%d; el guard debe cortar antes del SQL", store.gotID)
	}
}

func TestAdminWithdrawalActionRejectsUnknownAction(t *testing.T) {
	h := NewHandler(&fakeStore{}, testToken, []string{"admin@test.local"}, zerolog.Nop())
	req := adminPost(t, "/api/admin/withdrawals/action", map[string]any{
		"email": "admin@test.local", "id": 7, "action": "delete",
	})
	rr := httptest.NewRecorder()
	h.Routes().ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest || decodeErr(t, rr) != "invalid_action" {
		t.Fatalf("status=%d err=%q, want 400 invalid_action", rr.Code, decodeErr(t, rr))
	}
}

// ---------------------------------------------------------------------------
// I3 — 409 sólo para transición inválida; 500 para fallos de infraestructura
// ---------------------------------------------------------------------------

func TestAdminWithdrawalActionErrorMapping(t *testing.T) {
	cases := []struct {
		name     string
		storeErr error
		want     int
		wantMsg  string
	}{
		{"transición inválida", fmt.Errorf("%w: a \"paid\"", ErrInvalidTransition), http.StatusConflict, "transition_rejected"},
		{"postgres caído", errors.New("dial tcp: connection refused"), http.StatusInternalServerError, "internal"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{setStatusFn: func(context.Context, int64, string, string) error {
				return tc.storeErr
			}}
			h := NewHandler(store, testToken, []string{"admin@test.local"}, zerolog.Nop())
			req := adminPost(t, "/api/admin/withdrawals/action", map[string]any{
				"email": "admin@test.local", "id": 7, "action": "pay",
			})
			rr := httptest.NewRecorder()
			h.Routes().ServeHTTP(rr, req)

			if rr.Code != tc.want || decodeErr(t, rr) != tc.wantMsg {
				t.Fatalf("status=%d err=%q, want %d %q", rr.Code, decodeErr(t, rr), tc.want, tc.wantMsg)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// handleWithdraw — mapeo de errores y validación de body
// ---------------------------------------------------------------------------

func TestHandleWithdrawErrorMapping(t *testing.T) {
	cases := []struct {
		name     string
		storeErr error
		wantCode int
		wantMsg  string
	}{
		{"mínimo", ErrMinWithdrawal, http.StatusBadRequest, "min_withdrawal"},
		{"saldo insuficiente", ErrInsufficient, http.StatusBadRequest, "insufficient_balance"},
		{"sin wallet", ErrNoWallet, http.StatusBadRequest, "no_balance"},
		{"envuelto conserva el mapeo", fmt.Errorf("ctx: %w", ErrInsufficient), http.StatusBadRequest, "insufficient_balance"},
		{"inesperado", errors.New("dial tcp: connection refused"), http.StatusInternalServerError, "internal"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{requestFn: func(context.Context, string, string, string) (WithdrawalResult, error) {
				return WithdrawalResult{}, tc.storeErr
			}}
			h := NewHandler(store, testToken, nil, zerolog.Nop())
			req := adminPost(t, "/api/payments/withdraw", map[string]any{
				"email": "member@test.local", "amount": "150.00", "bank_info": "Banco X 12345",
			})
			rr := httptest.NewRecorder()
			h.Routes().ServeHTTP(rr, req)

			if rr.Code != tc.wantCode || decodeErr(t, rr) != tc.wantMsg {
				t.Fatalf("status=%d err=%q, want %d %q", rr.Code, decodeErr(t, rr), tc.wantCode, tc.wantMsg)
			}
		})
	}
}

func TestHandleWithdrawSuccess(t *testing.T) {
	store := &fakeStore{requestFn: func(context.Context, string, string, string) (WithdrawalResult, error) {
		return WithdrawalResult{ID: 99, Status: "requested"}, nil
	}}
	h := NewHandler(store, testToken, nil, zerolog.Nop())
	req := adminPost(t, "/api/payments/withdraw", map[string]any{
		"email": "Member@Test.Local", "amount": "150.00", "bank_info": "Banco X 12345",
	})
	rr := httptest.NewRecorder()
	h.Routes().ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d (%s), want 200", rr.Code, rr.Body.String())
	}
	var res WithdrawalResult
	if err := json.Unmarshal(rr.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if res.ID != 99 || res.Status != "requested" {
		t.Fatalf("res = %+v, want {99 requested}", res)
	}
	// resolveIdentity normaliza a minúsculas antes de llegar al store.
	if store.gotRequestEmail != "member@test.local" {
		t.Fatalf("email al store = %q, want member@test.local", store.gotRequestEmail)
	}
}

// I5 — validación de body del original: amount vacío o bank_info < 6 chars se
// rechazan ANTES de tocar la base. Sin esto un bank_info vacío persistía una
// solicitud impagable y un amount vacío se reportaba como "min_withdrawal".
func TestHandleWithdrawRejectsIncompleteBody(t *testing.T) {
	cases := []struct {
		name string
		body map[string]any
	}{
		{"amount vacío", map[string]any{"email": "m@test.local", "amount": "", "bank_info": "Banco X 12345"}},
		{"bank_info vacío", map[string]any{"email": "m@test.local", "amount": "150.00", "bank_info": ""}},
		{"bank_info corto", map[string]any{"email": "m@test.local", "amount": "150.00", "bank_info": "BX1"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{}
			h := NewHandler(store, testToken, nil, zerolog.Nop())
			rr := httptest.NewRecorder()
			h.Routes().ServeHTTP(rr, adminPost(t, "/api/payments/withdraw", tc.body))

			if rr.Code != http.StatusBadRequest {
				t.Fatalf("status = %d (%s), want 400", rr.Code, rr.Body.String())
			}
			if msg := decodeErr(t, rr); msg == "min_withdrawal" {
				t.Fatalf("error = %q: un body incompleto no debe reportarse como min_withdrawal", msg)
			}
			if store.gotRequestEmail != "" {
				t.Fatal("el store fue invocado con un body incompleto")
			}
		})
	}
}

func TestHandleWithdrawRejectsNonPost(t *testing.T) {
	h := NewHandler(&fakeStore{}, testToken, nil, zerolog.Nop())
	req := httptest.NewRequest(http.MethodGet, "/api/payments/withdraw", nil)
	req.Header.Set("X-VP-Service-Token", testToken)
	rr := httptest.NewRecorder()
	h.Routes().ServeHTTP(rr, req)

	if rr.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rr.Code)
	}
}

func TestHandleWithdrawRejectsBadJSON(t *testing.T) {
	h := NewHandler(&fakeStore{}, testToken, nil, zerolog.Nop())
	req := httptest.NewRequest(http.MethodPost, "/api/payments/withdraw", strings.NewReader("{no-json"))
	req.Header.Set("X-VP-Service-Token", testToken)
	rr := httptest.NewRecorder()
	h.Routes().ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest || decodeErr(t, rr) != "invalid_json" {
		t.Fatalf("status=%d err=%q, want 400 invalid_json", rr.Code, decodeErr(t, rr))
	}
}

// I2 — el body está acotado: un JSON gigantesco no se lee entero (io.LimitReader
// corta a 64 KiB y el decoder falla con 400 en vez de consumir memoria sin tope).
func TestHandleWithdrawBodyIsLimited(t *testing.T) {
	h := NewHandler(&fakeStore{}, testToken, nil, zerolog.Nop())
	huge := `{"email":"m@test.local","amount":"150.00","bank_info":"` +
		strings.Repeat("x", int(maxJSONBody)+1024) + `"}`
	req := httptest.NewRequest(http.MethodPost, "/api/payments/withdraw", strings.NewReader(huge))
	req.Header.Set("X-VP-Service-Token", testToken)
	rr := httptest.NewRecorder()
	h.Routes().ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d (%s), want 400 (body truncado por LimitReader)", rr.Code, rr.Body.String())
	}
}

// ---------------------------------------------------------------------------
// resolveIdentity
// ---------------------------------------------------------------------------

func TestResolveIdentity(t *testing.T) {
	t.Run("identity_mismatch cuando el declarado difiere del verificado", func(t *testing.T) {
		h := NewHandler(&fakeStore{}, testToken, nil, zerolog.Nop())
		h.SetIdentityVerifier(fakeVerifier{email: "real@test.local"}, false)

		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		req.Header.Set(idTokenHeader, "raw-token")
		rr := httptest.NewRecorder()

		if _, ok := h.resolveIdentity(rr, req, "otro@test.local"); ok {
			t.Fatal("resolveIdentity autorizó una identidad que no coincide")
		}
		if rr.Code != http.StatusForbidden || decodeErr(t, rr) != "identity_mismatch" {
			t.Fatalf("status=%d err=%q, want 403 identity_mismatch", rr.Code, decodeErr(t, rr))
		}
	})

	t.Run("invalid_id_token cuando el header está pero no verifica", func(t *testing.T) {
		h := NewHandler(&fakeStore{}, testToken, nil, zerolog.Nop())
		h.SetIdentityVerifier(fakeVerifier{err: errors.New("firma inválida")}, false)

		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		req.Header.Set(idTokenHeader, "raw-token")
		rr := httptest.NewRecorder()

		if _, ok := h.resolveIdentity(rr, req, "quien@test.local"); ok {
			t.Fatal("resolveIdentity autorizó con un id token inválido")
		}
		if rr.Code != http.StatusUnauthorized || decodeErr(t, rr) != "invalid_id_token" {
			t.Fatalf("status=%d err=%q, want 401 invalid_id_token", rr.Code, decodeErr(t, rr))
		}
	})

	t.Run("el email verificado gana y se normaliza", func(t *testing.T) {
		h := NewHandler(&fakeStore{}, testToken, nil, zerolog.Nop())
		h.SetIdentityVerifier(fakeVerifier{email: "Real@Test.Local"}, false)

		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		req.Header.Set(idTokenHeader, "raw-token")
		rr := httptest.NewRecorder()

		email, ok := h.resolveIdentity(rr, req, "real@test.local")
		if !ok || email != "real@test.local" {
			t.Fatalf("email=%q ok=%v, want real@test.local true", email, ok)
		}
	})

	t.Run("email_required sin header ni email declarado", func(t *testing.T) {
		h := NewHandler(&fakeStore{}, testToken, nil, zerolog.Nop())
		rr := httptest.NewRecorder()
		if _, ok := h.resolveIdentity(rr, httptest.NewRequest(http.MethodGet, "/x", nil), ""); ok {
			t.Fatal("resolveIdentity autorizó sin identidad alguna")
		}
		if rr.Code != http.StatusBadRequest || decodeErr(t, rr) != "email_required" {
			t.Fatalf("status=%d err=%q, want 400 email_required", rr.Code, decodeErr(t, rr))
		}
	})

	t.Run("id_token_required en modo estricto", func(t *testing.T) {
		h := NewHandler(&fakeStore{}, testToken, nil, zerolog.Nop())
		h.SetIdentityVerifier(fakeVerifier{email: "real@test.local"}, true)
		rr := httptest.NewRecorder()
		if _, ok := h.resolveIdentity(rr, httptest.NewRequest(http.MethodGet, "/x", nil), "x@test.local"); ok {
			t.Fatal("modo estricto autorizó sin header")
		}
		if rr.Code != http.StatusUnauthorized || decodeErr(t, rr) != "id_token_required" {
			t.Fatalf("status=%d err=%q, want 401 id_token_required", rr.Code, decodeErr(t, rr))
		}
	})
}

// ---------------------------------------------------------------------------
// C3 — isAdminEmail de tres vías
// ---------------------------------------------------------------------------

// TestIsAdminEmailThreeWays cubre C3: la versión rota sólo miraba ADMIN_EMAILS,
// dejando fuera de la cola de retiros a los super-admins que no estuvieran
// además en esa variable Y a TODOS los admins concedidos desde el panel
// (mlm.person.is_admin, migración 47).
func TestIsAdminEmailThreeWays(t *testing.T) {
	t.Run("super-admin sin consultar la base", func(t *testing.T) {
		store := &fakeStore{isAdminFn: func(context.Context, string) (bool, error) {
			return false, errors.New("no debió consultarse la base")
		}}
		h := NewHandler(store, testToken, nil, zerolog.Nop())
		h.SetSuperAdmins([]string{"devfidubit@gmail.com"})

		// Case-insensitive y tolerante a espacios, como el original.
		admin, err := h.isAdminEmail(context.Background(), " DevFidubit@Gmail.com ")
		if err != nil || !admin {
			t.Fatalf("admin=%v err=%v, want true nil", admin, err)
		}
		if store.isAdminCallHappened {
			t.Fatal("un super-admin no debe requerir consulta a la base")
		}
	})

	t.Run("allowlist ADMIN_EMAILS", func(t *testing.T) {
		store := &fakeStore{}
		h := NewHandler(store, testToken, []string{"ops@test.local"}, zerolog.Nop())

		admin, err := h.isAdminEmail(context.Background(), "OPS@test.local")
		if err != nil || !admin {
			t.Fatalf("admin=%v err=%v, want true nil", admin, err)
		}
		if store.isAdminCallHappened {
			t.Fatal("un email de la allowlist no debe requerir consulta a la base")
		}
	})

	t.Run("mlm.person.is_admin (concedido desde el panel)", func(t *testing.T) {
		store := &fakeStore{isAdminFn: func(_ context.Context, email string) (bool, error) {
			return email == "panel@test.local", nil
		}}
		h := NewHandler(store, testToken, []string{"ops@test.local"}, zerolog.Nop())

		admin, err := h.isAdminEmail(context.Background(), "panel@test.local")
		if err != nil || !admin {
			t.Fatalf("admin=%v err=%v, want true nil", admin, err)
		}
		if store.isAdminCalledWith != "panel@test.local" {
			t.Fatalf("store consultado con %q", store.isAdminCalledWith)
		}
	})

	t.Run("ninguna de las tres ⇒ no admin", func(t *testing.T) {
		h := NewHandler(&fakeStore{}, testToken, []string{"ops@test.local"}, zerolog.Nop())
		admin, err := h.isAdminEmail(context.Background(), "nadie@test.local")
		if err != nil || admin {
			t.Fatalf("admin=%v err=%v, want false nil", admin, err)
		}
	})
}

// El error de la consulta se propaga y el handler falla CERRADO con 500: nunca
// debe degradarse a "no eres admin" ni, peor, dejar pasar.
func TestAdminEndpointsFailClosedOnStoreError(t *testing.T) {
	newH := func() *Handler {
		store := &fakeStore{isAdminFn: func(context.Context, string) (bool, error) {
			return false, errors.New("postgres caído")
		}}
		return NewHandler(store, testToken, nil, zerolog.Nop())
	}

	t.Run("GET /api/admin/withdrawals", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/admin/withdrawals?email=x@test.local", nil)
		req.Header.Set("X-VP-Service-Token", testToken)
		rr := httptest.NewRecorder()
		newH().Routes().ServeHTTP(rr, req)
		if rr.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500", rr.Code)
		}
	})

	t.Run("POST /api/admin/withdrawals/action", func(t *testing.T) {
		req := adminPost(t, "/api/admin/withdrawals/action", map[string]any{
			"email": "x@test.local", "id": 7, "action": "approve",
		})
		rr := httptest.NewRecorder()
		newH().Routes().ServeHTTP(rr, req)
		if rr.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500", rr.Code)
		}
	})
}

func TestAdminEndpointsRejectNonAdmin(t *testing.T) {
	h := NewHandler(&fakeStore{}, testToken, []string{"admin@test.local"}, zerolog.Nop())

	req := adminPost(t, "/api/admin/withdrawals/action", map[string]any{
		"email": "cualquiera@test.local", "id": 7, "action": "pay",
	})
	rr := httptest.NewRecorder()
	h.Routes().ServeHTTP(rr, req)

	if rr.Code != http.StatusForbidden || decodeErr(t, rr) != "not_admin" {
		t.Fatalf("status=%d err=%q, want 403 not_admin", rr.Code, decodeErr(t, rr))
	}
}

// ---------------------------------------------------------------------------
// D10 — chequeo de baneados al SOLICITAR. Modo FAIL-OPEN, deliberadamente al
// revés del candado al pagar (SetWithdrawalStatus, fail-closed).
// ---------------------------------------------------------------------------

// Un baneado que intenta solicitar recibe 403 y NO llega al store.
func TestHandleWithdraw_Suspended_Blocks(t *testing.T) {
	store := &fakeStore{suspendedFn: func(context.Context, string) (bool, error) {
		return true, nil
	}}
	h := NewHandler(store, testToken, nil, zerolog.Nop())
	req := adminPost(t, "/api/payments/withdraw", map[string]any{
		"email": "banned@test.local", "amount": "150.00", "bank_info": "Banco X 12345",
	})
	rr := httptest.NewRecorder()
	h.Routes().ServeHTTP(rr, req)

	if rr.Code != http.StatusForbidden || decodeErr(t, rr) != "account_suspended" {
		t.Fatalf("status=%d err=%q, want 403 account_suspended", rr.Code, decodeErr(t, rr))
	}
	if store.gotRequestEmail != "" {
		t.Fatalf("RequestWithdrawal fue llamado con %q; no debió llamarse", store.gotRequestEmail)
	}
}

// FAIL-OPEN: si la consulta de baneo revienta por infraestructura, la solicitud
// SIGUE registrándose. No mueve dinero y se re-verifica (fail-closed) al pagar,
// así que negarla castigaría a un miembro limpio por una falla de la base.
func TestHandleWithdraw_SuspensionCheckError_FailsOpen(t *testing.T) {
	store := &fakeStore{
		suspendedFn: func(context.Context, string) (bool, error) {
			return false, errors.New("dial tcp: connection refused")
		},
		requestFn: func(context.Context, string, string, string) (WithdrawalResult, error) {
			return WithdrawalResult{ID: 7, Status: "requested"}, nil
		},
	}
	h := NewHandler(store, testToken, nil, zerolog.Nop())
	req := adminPost(t, "/api/payments/withdraw", map[string]any{
		"email": "member@test.local", "amount": "150.00", "bank_info": "Banco X 12345",
	})
	rr := httptest.NewRecorder()
	h.Routes().ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d (%s), want 200 (fail-open)", rr.Code, rr.Body.String())
	}
	if store.gotRequestEmail != "member@test.local" {
		t.Fatalf("RequestWithdrawal no fue llamado; fail-open debió dejar continuar")
	}
}

// Al PAGAR, ErrSuspended sale como 403 account_suspended y no como 500: es una
// decisión de política, no una caída. El admin debe poder distinguirlas.
func TestAdminAction_Suspended_Returns403(t *testing.T) {
	store := &fakeStore{
		isAdminFn: func(context.Context, string) (bool, error) { return true, nil },
		setStatusFn: func(context.Context, int64, string, string) error {
			return ErrSuspended
		},
	}
	h := NewHandler(store, testToken, nil, zerolog.Nop())
	req := adminPost(t, "/api/admin/withdrawals/action", map[string]any{
		"email": "admin@test.local", "id": 1, "action": "pay",
	})
	rr := httptest.NewRecorder()
	h.Routes().ServeHTTP(rr, req)

	if rr.Code != http.StatusForbidden || decodeErr(t, rr) != "account_suspended" {
		t.Fatalf("status=%d err=%q, want 403 account_suspended", rr.Code, decodeErr(t, rr))
	}
}
