package payments

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rs/zerolog"
)

type fakeVerifiedReferral struct {
	calls                     int
	subject, email, ref, side string
	save                      bool
	out                       VerifiedReferralAttribution
	err                       error
}

func (f *fakeVerifiedReferral) VerifiedRegistrationReferral(_ context.Context, subject, email string, ref *string, side string) (VerifiedReferralAttribution, error) {
	f.calls++
	f.subject, f.email, f.side = subject, email, side
	f.save = ref != nil
	if ref != nil {
		f.ref = *ref
	}
	return f.out, f.err
}

func TestVerifiedReferralOwnerEnvelope(t *testing.T) {
	const body = `{"email":"member@example.test","ref":"MP123","preferred_side":"R"}`
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		t.Run(method, func(t *testing.T) {
			store := &fakeVerifiedReferral{out: VerifiedReferralAttribution{OK: true, Ref: "MP123", PreferredSide: "R"}}
			h := &Handler{serviceToken: "synthetic-service-token", verifier: fakeNOWSubject{}, requireVerified: true, referralPersistence: store, log: zerolog.Nop()}
			path := verifiedReferralPath
			if method == http.MethodGet {
				path += "?email=member%40example.test"
			}
			r := httptest.NewRequest(method, path, nil)
			if method == http.MethodPost {
				r = httptest.NewRequest(method, path, strings.NewReader(body))
				r.Header.Set("Content-Type", "application/json")
			}
			r.Header.Set("X-VP-Service-Token", h.serviceToken)
			r.Header.Set(idTokenHeader, "verified.jwt.token")
			w := httptest.NewRecorder()
			(&Config{ReadOnly: true}).ReadOnlyHandler(h.Routes()).ServeHTTP(w, r)
			if w.Code != 200 || store.calls != 1 || store.subject != "signed-subject" || store.email != "member@example.test" || store.save != (method == http.MethodPost) {
				t.Fatalf("owner proof lost: status=%d calls=%d state=%+v", w.Code, store.calls, store)
			}
			if method == http.MethodPost && (store.ref != "MP123" || store.side != "R") {
				t.Fatal("hint lost", store)
			}
			if w.Header().Get("Cache-Control") != "private, no-store" {
				t.Fatal("private response cached")
			}
		})
	}
}

func TestVerifiedReferralRejectsUntrustedEnvelopeBeforePersistence(t *testing.T) {
	const body = `{"email":"member@example.test","ref":"MP123","preferred_side":"R"}`
	tests := []struct {
		name, method, path, body          string
		headers                           map[string]string
		missingService, missingJWT, loose bool
		verifierErr                       error
	}{
		{name: "no service", method: "POST", path: verifiedReferralPath, body: body, missingService: true},
		{name: "no JWT", method: "POST", path: verifiedReferralPath, body: body, missingJWT: true},
		{name: "invalid JWT", method: "POST", path: verifiedReferralPath, body: body, verifierErr: errors.New("private-verifier-diagnostic")},
		{name: "legacy fallback", method: "POST", path: verifiedReferralPath, body: body, loose: true},
		{name: "ActAs", method: "POST", path: verifiedReferralPath, body: body, headers: map[string]string{actAsHeader: ""}},
		{name: "different owner", method: "POST", path: verifiedReferralPath, body: strings.ReplaceAll(body, "member@example.test", "other@example.test")},
		{name: "query owner", method: "GET", path: verifiedReferralPath + "?email=other%40example.test"},
		{name: "duplicate query", method: "GET", path: verifiedReferralPath + "?email=member%40example.test&email=member%40example.test"},
		{name: "encoded query key", method: "GET", path: verifiedReferralPath + "?%65mail=member%40example.test"},
		{name: "extra query", method: "GET", path: verifiedReferralPath + "?email=member%40example.test&subject=other"},
		{name: "POST query", method: "POST", path: verifiedReferralPath + "?email=member%40example.test", body: body},
		{name: "GET body", method: "GET", path: verifiedReferralPath + "?email=member%40example.test", body: body},
		{name: "wrong method", method: "DELETE", path: verifiedReferralPath},
		{name: "duplicate key", method: "POST", path: verifiedReferralPath, body: strings.Replace(body, `"ref":`, `"ref":"MP9","ref":`, 1)},
		{name: "escaped key", method: "POST", path: verifiedReferralPath, body: strings.Replace(body, `"ref"`, `"r\u0065f"`, 1)},
		{name: "unknown key", method: "POST", path: verifiedReferralPath, body: strings.TrimSuffix(body, "}") + `,"subject":"other"}`},
		{name: "missing side", method: "POST", path: verifiedReferralPath, body: `{"email":"member@example.test","ref":"MP123"}`},
		{name: "null side", method: "POST", path: verifiedReferralPath, body: strings.Replace(body, `"R"`, `null`, 1)},
		{name: "lowercase side", method: "POST", path: verifiedReferralPath, body: strings.Replace(body, `"R"`, `"r"`, 1)},
		{name: "empty code", method: "POST", path: verifiedReferralPath, body: strings.Replace(body, `"MP123"`, `""`, 1)},
		{name: "large body", method: "POST", path: verifiedReferralPath, body: strings.Repeat("x", 1025)},
		{name: "encoding", method: "POST", path: verifiedReferralPath, body: body, headers: map[string]string{"Content-Encoding": "gzip"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeVerifiedReferral{}
			h := &Handler{serviceToken: "synthetic-service-token", verifier: fakeNOWSubject{err: tc.verifierErr}, requireVerified: !tc.loose, referralPersistence: store, log: zerolog.Nop()}
			r := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			r.Header.Set("Content-Type", "application/json")
			if !tc.missingService {
				r.Header.Set("X-VP-Service-Token", h.serviceToken)
			}
			if !tc.missingJWT {
				r.Header.Set(idTokenHeader, "verified.jwt.token")
			}
			for k, v := range tc.headers {
				r.Header.Set(k, v)
			}
			w := httptest.NewRecorder()
			h.handleVerifiedReferral(w, r)
			if w.Code < 400 || store.calls != 0 || strings.Contains(w.Body.String(), "private-verifier-diagnostic") {
				t.Fatal("untrusted request reached persistence", w.Code, w.Body.String(), store.calls)
			}
		})
	}
}

func TestVerifiedReferralMinimalResponseAndSafeErrors(t *testing.T) {
	for _, tc := range []struct {
		name   string
		out    VerifiedReferralAttribution
		err    error
		status int
	}{
		{"empty", VerifiedReferralAttribution{OK: true}, nil, 200},
		{"positioned", VerifiedReferralAttribution{OK: true, Positioned: true}, nil, 200},
		{"invalid", VerifiedReferralAttribution{}, ErrInvalidReferralCode, 400},
		{"restricted", VerifiedReferralAttribution{}, errReferralBlocked, 403},
		{"review", VerifiedReferralAttribution{}, ErrCheckoutIdentityReview, 403},
		{"database", VerifiedReferralAttribution{}, errors.New("private-database-diagnostic"), 503},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := &Handler{serviceToken: "synthetic-service-token", verifier: fakeNOWSubject{}, requireVerified: true, referralPersistence: &fakeVerifiedReferral{out: tc.out, err: tc.err}, log: zerolog.Nop()}
			r := httptest.NewRequest("GET", verifiedReferralPath+"?email=member%40example.test", nil)
			r.Header.Set("X-VP-Service-Token", h.serviceToken)
			r.Header.Set(idTokenHeader, "verified.jwt.token")
			w := httptest.NewRecorder()
			h.handleVerifiedReferral(w, r)
			if w.Code != tc.status || strings.Contains(w.Body.String(), "private-database-diagnostic") {
				t.Fatal(w.Code, w.Body.String())
			}
			if tc.status == 200 {
				var out map[string]any
				if json.Unmarshal(w.Body.Bytes(), &out) != nil || len(out) != 4 || out["ref"] != "" || out["preferred_side"] != "" || out["positioned"] != tc.out.Positioned {
					t.Fatal("non-minimal response", w.Body.String())
				}
			}
		})
	}
}

func TestVerifiedReferralReadOnlyExceptionDoesNotEnableLegacyOrFinancialWrites(t *testing.T) {
	for _, path := range []string{"/api/registration/referral-attribution", "/api/registration/precheck", "/api/payments/checkout", "/api/admin/refund", verifiedReferralPath + "/", verifiedReferralPath + "?email=x"} {
		called := false
		next := http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true })
		w := httptest.NewRecorder()
		(&Config{ReadOnly: true}).ReadOnlyHandler(next).ServeHTTP(w, httptest.NewRequest("POST", path, strings.NewReader("{}")))
		if called || w.Code != 503 {
			t.Fatal("readonly exception widened", path, w.Code)
		}
	}
}
