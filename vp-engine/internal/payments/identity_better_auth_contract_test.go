package payments

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
)

func TestBetterAuthIssuedAtToleranceIsOnlyThirtySecondsAndNeverExpiryLeeway(t *testing.T) {
	v, key := betterAuthTestVerifier(t)
	for _, seconds := range []int64{0, 1, 2, 29, 30, 31, 60} {
		claims := betterAuthTestClaims()
		claims["iat"] = time.Now().Unix() + seconds
		claims["exp"] = claims["iat"].(int64) + 300
		_, err := v.VerifyEmail(context.Background(), signBetterAuthTestToken(t, key, claims))
		if seconds <= 30 && err != nil {
			t.Fatal("trusted service clock tolerance failed", seconds, identityFailureReason(err))
		}
		if seconds > 30 && (err == nil || identityFailureReason(err) != "jwt_issued_in_future" || errors.Is(err, ErrAuthenticationUnavailable)) {
			t.Fatal("future issuance beyond the fixed bound was accepted or misclassified")
		}
	}
	for _, tc := range []struct {
		name, reason string
		edit         func(jwt.MapClaims)
	}{
		{"already expired", "jwt_expired", func(c jwt.MapClaims) { c["iat"] = time.Now().Unix() - 61; c["exp"] = time.Now().Unix() - 1 }},
		{"future nbf", "jwt_not_yet_valid", func(c jwt.MapClaims) { c["nbf"] = time.Now().Unix() + 2 }},
		{"wrong issuer", "jwt_issuer", func(c jwt.MapClaims) { c["iss"] = "https://other.example.test" }},
		{"wrong audience", "jwt_audience", func(c jwt.MapClaims) { c["aud"] = "other-service" }},
		{"missing expiry", "jwt_claims", func(c jwt.MapClaims) { delete(c, "exp") }},
		{"missing issuance", "jwt_claims", func(c jwt.MapClaims) { delete(c, "iat") }},
		{"long lifetime", "jwt_claims", func(c jwt.MapClaims) { c["exp"] = c["iat"].(int64) + 301 }},
		{"unverified email", "jwt_claims", func(c jwt.MapClaims) { c["email_verified"] = false }},
		{"unverified session", "jwt_claims", func(c jwt.MapClaims) { c["authVerified"] = false }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			claims := betterAuthTestClaims()
			tc.edit(claims)
			if _, err := v.VerifyEmail(context.Background(), signBetterAuthTestToken(t, key, claims)); err == nil || identityFailureReason(err) != tc.reason {
				t.Fatal("strict non-iat verification was weakened", identityFailureReason(err))
			}
		})
	}
	foreign, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := v.VerifyEmail(context.Background(), signBetterAuthTestToken(t, foreign, betterAuthTestClaims())); err == nil || identityFailureReason(err) != "jwt_signature" {
		t.Fatal("a foreign signing key was accepted or misclassified")
	}
}

func contractPublicJWK(t *testing.T, key *rsa.PrivateKey, kid string) []byte {
	t.Helper()
	value, err := json.Marshal(map[string]any{"keys": []any{map[string]string{"kty": "RSA", "kid": kid, "alg": "RS256", "use": "sig",
		"n": base64.RawURLEncoding.EncodeToString(key.PublicKey.N.Bytes()), "e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.PublicKey.E)).Bytes())}}})
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func TestBetterAuthKeyRotationRefreshesOnceAndUnknownKeyFloodIsBoundedByCallerContext(t *testing.T) {
	oldKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	newKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	var document atomic.Value
	document.Store(contractPublicJWK(t, oldKey, "synthetic"))
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		_, _ = w.Write(document.Load().([]byte))
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	v, err := NewBetterAuthVerifier(ctx, server.URL, "https://auth.example.test", "vp-services-synthetic")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := v.VerifyEmail(context.Background(), signBetterAuthTestToken(t, oldKey, betterAuthTestClaims())); err != nil {
		t.Fatal("initial trusted key unavailable")
	}
	document.Store(contractPublicJWK(t, newKey, "rotated-synthetic"))
	rotated := jwt.NewWithClaims(jwt.SigningMethodRS256, betterAuthTestClaims())
	rotated.Header["kid"] = "rotated-synthetic"
	raw, err := rotated.SignedString(newKey)
	if err != nil {
		t.Fatal(err)
	}
	for range 5 {
		if _, err := v.VerifyEmail(context.Background(), raw); err != nil {
			t.Fatal("trusted rotation was not recovered and cached", identityFailureReason(err))
		}
	}
	if requests.Load() != 2 {
		t.Fatal("key rotation caused repeated network work", requests.Load())
	}
	for _, kid := range []string{"untrusted-one", "untrusted-two"} {
		unknown := jwt.NewWithClaims(jwt.SigningMethodRS256, betterAuthTestClaims())
		unknown.Header["kid"] = kid
		raw, err := unknown.SignedString(newKey)
		if err != nil {
			t.Fatal(err)
		}
		short, stop := context.WithTimeout(context.Background(), 20*time.Millisecond)
		start := time.Now()
		_, failure := v.VerifyEmail(short, raw)
		stop()
		if !errors.Is(failure, ErrAuthenticationUnavailable) || identityFailureReason(failure) != "jwt_keys_unavailable" || time.Since(start) > time.Second {
			t.Fatal("unknown key bypassed validation or caller cancellation", identityFailureReason(failure))
		}
	}
	if requests.Load() != 2 {
		t.Fatal("untrusted key IDs bypassed the unchanged refresh limiter")
	}
}

func TestBetterAuthStalledKeyFetchAndPrecancelledRequestsNeverOutliveCaller(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	var requests atomic.Int32
	document := contractPublicJWK(t, key, "synthetic")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) == 1 {
			_, _ = w.Write(document)
			return
		}
		<-r.Context().Done()
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	v, err := NewBetterAuthVerifier(ctx, server.URL, "https://auth.example.test", "vp-services-synthetic")
	if err != nil {
		t.Fatal(err)
	}
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, betterAuthTestClaims())
	token.Header["kid"] = "unknown-synthetic"
	raw, err := token.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	short, stop := context.WithTimeout(context.Background(), 20*time.Millisecond)
	_, failure := v.VerifyEmail(short, raw)
	stop()
	if !errors.Is(failure, ErrAuthenticationUnavailable) || identityFailureReason(failure) != "jwt_keys_unavailable" {
		t.Fatal("stalled public-key request lost its bounded failure classification", identityFailureReason(failure))
	}
	preCancelled, stop := context.WithCancel(context.Background())
	stop()
	if _, failure := v.VerifyEmail(preCancelled, signBetterAuthTestToken(t, key, betterAuthTestClaims())); !errors.Is(failure, ErrAuthenticationUnavailable) || identityFailureReason(failure) != "identity_unavailable" {
		t.Fatal("cancelled request proceeded to trusted identity")
	}
}

type contractIdentityQuery struct {
	err                error
	email, publicID    string
	calls              int
	deadlineWasBounded bool
}

func (q *contractIdentityQuery) QueryRow(ctx context.Context, _ string, _ ...any) pgx.Row {
	q.calls++
	deadline, ok := ctx.Deadline()
	q.deadlineWasBounded = ok && time.Until(deadline) <= betterAuthVerificationTimeout
	return contractIdentityRow{q}
}

type contractIdentityRow struct{ query *contractIdentityQuery }

func (r contractIdentityRow) Scan(dest ...any) error {
	if r.query.err != nil {
		return r.query.err
	}
	*dest[0].(*string), *dest[1].(*string) = r.query.email, r.query.publicID
	return nil
}

func TestBoundBetterAuthIdentitySeparatesUnavailableStorageFromInvalidCanonicalOwnership(t *testing.T) {
	crypto, key := betterAuthTestVerifier(t)
	raw := signBetterAuthTestToken(t, key, betterAuthTestClaims())
	for _, tc := range []struct {
		query       contractIdentityQuery
		reason      string
		unavailable bool
	}{
		{contractIdentityQuery{err: context.DeadlineExceeded}, "identity_storage_unavailable", true},
		{contractIdentityQuery{err: errors.New("private SQL password/customer detail")}, "identity_storage_unavailable", true},
		{contractIdentityQuery{err: pgx.ErrNoRows}, "binding_missing", false},
		{contractIdentityQuery{email: "different@example.test", publicID: "synthetic"}, "binding_mismatch", false},
	} {
		v := &boundBetterAuthVerifier{verifier: crypto, db: &tc.query}
		subject, email, failure := v.VerifySubject(context.Background(), raw)
		if subject != "" || email != "" || identityFailureReason(failure) != tc.reason || errors.Is(failure, ErrAuthenticationUnavailable) != tc.unavailable || tc.query.calls != 1 || !tc.query.deadlineWasBounded {
			t.Fatal("canonical denial or infrastructure error lost its safe classification", identityFailureReason(failure))
		}
		if tc.unavailable && failure.Error() != ErrAuthenticationUnavailable.Error() {
			t.Fatal("private dependency details retained")
		}
	}
}
