package payments

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func betterAuthTestVerifier(t *testing.T) (*BetterAuthVerifier, *rsa.PrivateKey) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	public, err := json.Marshal(map[string]any{"keys": []any{map[string]string{
		"kty": "RSA", "kid": "synthetic", "alg": "RS256", "use": "sig",
		"n": base64.RawURLEncoding.EncodeToString(key.PublicKey.N.Bytes()),
		"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.PublicKey.E)).Bytes()),
	}}})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(public) }))
	t.Cleanup(server.Close)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	v, err := NewBetterAuthVerifier(ctx, server.URL, "https://auth.example.test", "vp-services-synthetic")
	if err != nil {
		t.Fatal(err)
	}
	return v, key
}

func betterAuthTestClaims() jwt.MapClaims {
	now := time.Now()
	return jwt.MapClaims{"iss": "https://auth.example.test", "aud": "vp-services-synthetic", "sub": "synthetic-user",
		"email": "Member@Example.test", "email_verified": true, "authVerified": true,
		"iat": now.Unix(), "exp": now.Add(5 * time.Minute).Unix()}
}

func signBetterAuthTestToken(t *testing.T, key *rsa.PrivateKey, claims jwt.MapClaims) string {
	t.Helper()
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	token.Header["kid"] = "synthetic"
	raw, err := token.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestBetterAuthJWTStrictVerification(t *testing.T) {
	v, key := betterAuthTestVerifier(t)
	ctx := context.Background()
	if email, err := v.VerifyEmail(ctx, signBetterAuthTestToken(t, key, betterAuthTestClaims())); err != nil || email != "member@example.test" {
		t.Fatal("valid JWT-plugin service token rejected", email, err)
	}
	for _, tc := range []struct {
		name string
		edit func(jwt.MapClaims)
	}{
		{"wrong issuer", func(c jwt.MapClaims) { c["iss"] = "https://other.example.test" }},
		{"wrong audience", func(c jwt.MapClaims) { c["aud"] = "other-service" }},
		{"missing issuer", func(c jwt.MapClaims) { delete(c, "iss") }},
		{"missing audience", func(c jwt.MapClaims) { delete(c, "aud") }},
		{"expired", func(c jwt.MapClaims) { c["exp"] = time.Now().Add(-time.Second).Unix() }},
		{"missing expiry", func(c jwt.MapClaims) { delete(c, "exp") }},
		{"missing issuance", func(c jwt.MapClaims) { delete(c, "iat") }},
		{"future issuance", func(c jwt.MapClaims) { c["iat"] = time.Now().Add(time.Minute).Unix() }},
		{"long-lived token", func(c jwt.MapClaims) { c["exp"] = time.Now().Add(time.Hour).Unix() }},
		{"missing subject", func(c jwt.MapClaims) { delete(c, "sub") }},
		{"missing email", func(c jwt.MapClaims) { delete(c, "email") }},
		{"email not verified", func(c jwt.MapClaims) { c["email_verified"] = false }},
		{"email verification string", func(c jwt.MapClaims) { c["email_verified"] = "true" }},
		{"missing authentication verification", func(c jwt.MapClaims) { delete(c, "authVerified") }},
		{"authentication verification string", func(c jwt.MapClaims) { c["authVerified"] = "true" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			claims := betterAuthTestClaims()
			tc.edit(claims)
			if email, err := v.VerifyEmail(ctx, signBetterAuthTestToken(t, key, claims)); err == nil || email != "" {
				t.Fatal("untrusted identity accepted", email, err)
			}
		})
	}
	for _, method := range []*jwt.SigningMethodHMAC{jwt.SigningMethodHS256} {
		token := jwt.NewWithClaims(method, betterAuthTestClaims())
		token.Header["kid"] = "synthetic"
		raw, err := token.SignedString([]byte("synthetic-not-a-real-secret"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := v.VerifyEmail(ctx, raw); err == nil {
			t.Fatal("symmetric algorithm confusion accepted")
		}
	}
}

func TestBetterAuthConfigurationFailsClosed(t *testing.T) {
	t.Setenv("AUTH_PROVIDER", "cognito")
	if v, enabled, err := ConfiguredBetterAuthVerifier(context.Background(), nil); err != nil || enabled || v != nil {
		t.Fatal("Cognito must remain unchanged and must not fetch Better Auth keys", err)
	}
	t.Setenv("AUTH_PROVIDER", "unknown")
	if _, _, err := ConfiguredBetterAuthVerifier(context.Background(), nil); err == nil {
		t.Fatal("unknown provider must not enable email fallback")
	}
	t.Setenv("AUTH_PROVIDER", "better-auth")
	t.Setenv("BETTER_AUTH_JWKS_URL", "")
	t.Setenv("BETTER_AUTH_JWT_ISSUER", "")
	t.Setenv("BETTER_AUTH_JWT_AUDIENCE", "")
	if _, enabled, err := ConfiguredBetterAuthVerifier(context.Background(), nil); err == nil || !enabled {
		t.Fatal("partial opt-in must fail closed before fetching anything")
	}
}

func TestBetterAuthBindingUsesSubjectNotEmailIntegration(t *testing.T) {
	if testing.Short() {
		t.Skip("isolated PostgreSQL testcontainer")
	}
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	migration, err := os.ReadFile(filepath.Join(findRepoRoot(t), "_meta/migration/70_stable_identity_bindings.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, string(migration)); err != nil {
		t.Fatal("prepared identity migration in isolated test database", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO auth.user(id,email,email_verified) VALUES('synthetic-user','member@example.test',true);
		INSERT INTO mlm.person(first_name,last_name,email,phone_number,status) VALUES('Synthetic','Member','member@example.test','0','active');`); err != nil {
		t.Fatal(err)
	}
	crypto, key := betterAuthTestVerifier(t)
	v := &boundBetterAuthVerifier{verifier: crypto, db: pool}
	raw := signBetterAuthTestToken(t, key, betterAuthTestClaims())
	if _, err := v.VerifyEmail(ctx, raw); err == nil {
		t.Fatal("matching verified email must never claim a legacy person without a subject binding")
	}
	if _, err := pool.Exec(ctx, `UPDATE mlm.person SET user_id='synthetic-user' WHERE email='member@example.test';
		INSERT INTO identity.auth_binding(subject,person_id,link_method)
		SELECT 'synthetic-user',id,'approved_claim' FROM mlm.person WHERE email='member@example.test'`); err != nil {
		t.Fatal(err)
	}
	if email, err := v.VerifyEmail(ctx, raw); err != nil || email != "member@example.test" {
		t.Fatal("explicit subject binding must authorize the canonical person", email, err)
	}
	for _, change := range []struct{ mutate, restore string }{
		{`UPDATE mlm.person SET blacklisted=true`, `UPDATE mlm.person SET blacklisted=false`},
		{`UPDATE mlm.person SET status='suspended'`, `UPDATE mlm.person SET status='active'`},
		{`UPDATE mlm.person SET user_id=NULL`, `UPDATE mlm.person SET user_id='synthetic-user'`},
		{`UPDATE auth.user SET email_verified=false`, `UPDATE auth.user SET email_verified=true`},
		{`UPDATE auth.user SET email='changed@example.test'`, `UPDATE auth.user SET email='member@example.test'`},
	} {
		if _, err := pool.Exec(ctx, change.mutate); err != nil {
			t.Fatal(err)
		}
		if _, err := v.VerifyEmail(ctx, raw); err == nil {
			t.Fatal("current identity restriction must reject even an unexpired signed token")
		}
		if _, err := pool.Exec(ctx, change.restore); err != nil {
			t.Fatal(err)
		}
	}
	claims := betterAuthTestClaims()
	claims["sub"] = "another-synthetic-user"
	if _, err := v.VerifyEmail(ctx, signBetterAuthTestToken(t, key, claims)); err == nil {
		t.Fatal("another subject must not inherit a binding through the same email")
	}
	claims = betterAuthTestClaims()
	claims["email"] = "different@example.test"
	if _, err := v.VerifyEmail(ctx, signBetterAuthTestToken(t, key, claims)); err == nil {
		t.Fatal("conflicting bound identity requires explicit review")
	}
}
