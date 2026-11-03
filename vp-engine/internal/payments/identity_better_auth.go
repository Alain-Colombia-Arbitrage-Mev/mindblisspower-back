package payments

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// BetterAuthVerifier verifies JWT-plugin service tokens, never session cookies.
// RS256 is explicitly configured on the issuer; no algorithm is inferred from
// an incoming token and no failure falls back to another identity provider.
type BetterAuthVerifier struct {
	keys     keyfunc.Keyfunc
	issuer   string
	audience string
}

type betterAuthIdentity struct{ subject, email string }

func NewBetterAuthVerifier(ctx context.Context, jwksURL, issuer, audience string) (*BetterAuthVerifier, error) {
	if !trustedIdentityURL(jwksURL) || !trustedIdentityURL(issuer) || strings.TrimSpace(audience) == "" {
		return nil, errors.New("Better Auth requires explicit HTTPS JWKS URL, issuer and audience (HTTP only on loopback)")
	}
	keys, err := keyfunc.NewDefaultCtx(ctx, []string{jwksURL})
	if err != nil {
		return nil, fmt.Errorf("initialize Better Auth JWKS: %w", err)
	}
	return &BetterAuthVerifier{keys: keys, issuer: issuer, audience: audience}, nil
}

func trustedIdentityURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" || u.RawQuery != "" {
		return false
	}
	if u.Scheme == "https" {
		return true
	}
	ip := net.ParseIP(u.Hostname())
	return u.Scheme == "http" && (u.Hostname() == "localhost" || (ip != nil && ip.IsLoopback()))
}

func (v *BetterAuthVerifier) verifyIdentity(_ context.Context, raw string) (betterAuthIdentity, error) {
	claims := jwt.MapClaims{}
	token, err := jwt.ParseWithClaims(raw, claims, v.keys.Keyfunc,
		jwt.WithValidMethods([]string{"RS256"}), jwt.WithIssuer(v.issuer), jwt.WithAudience(v.audience),
		jwt.WithExpirationRequired(), jwt.WithIssuedAt())
	if err != nil || !token.Valid {
		return betterAuthIdentity{}, errors.New("invalid Better Auth service token")
	}
	subject, _ := claims["sub"].(string)
	email, _ := claims["email"].(string)
	email = strings.ToLower(strings.TrimSpace(email))
	issued, ierr := claims.GetIssuedAt()
	expires, eerr := claims.GetExpirationTime()
	if strings.TrimSpace(subject) == "" || email == "" || claims["email_verified"] != true || claims["authVerified"] != true ||
		ierr != nil || eerr != nil || issued == nil || expires == nil || expires.Time.Sub(issued.Time) <= 0 || expires.Time.Sub(issued.Time) > 5*time.Minute {
		return betterAuthIdentity{}, errors.New("Better Auth requires verified email, authenticated subject and short-lived token")
	}
	return betterAuthIdentity{subject: subject, email: email}, nil
}

func (v *BetterAuthVerifier) VerifyEmail(ctx context.Context, raw string) (string, error) {
	identity, err := v.verifyIdentity(ctx, raw)
	return identity.email, err
}

// The binding, not an email coincidence or an optional JWT public ID, determines
// the MLM person. Missing bindings require reviewed enrollment; they never create
// a person, claim a legacy account or move a node in the network.
type boundBetterAuthVerifier struct {
	verifier *BetterAuthVerifier
	db       *pgxpool.Pool
}

func (v *boundBetterAuthVerifier) VerifyEmail(ctx context.Context, raw string) (string, error) {
	_, email, err := v.VerifySubject(ctx, raw)
	return email, err
}

// VerifySubject preserves the signed subject for owner-scoped payment reads.
// Unlike parsing a JWT after VerifyEmail, this never infers ownership by email.
func (v *boundBetterAuthVerifier) VerifySubject(ctx context.Context, raw string) (string, string, error) {
	identity, err := v.verifier.verifyIdentity(ctx, raw)
	if err != nil {
		return "", "", err
	}
	var email, publicID string
	if err := v.db.QueryRow(ctx, `SELECT p.email::text,p.public_id::text
		FROM identity.auth_binding b JOIN mlm.person p ON p.id=b.person_id
		JOIN auth.user u ON u.id=b.subject
		WHERE b.provider='better_auth' AND b.subject=$1 AND p.user_id=b.subject
		  AND u.email_verified=true AND lower(btrim(u.email))=lower(btrim(p.email::text))
		  AND p.status::text IN ('pending','active') AND NOT COALESCE(p.blacklisted,false)`, identity.subject).Scan(&email, &publicID); err != nil {
		return "", "", errors.New("Better Auth subject has no available verified MLM binding")
	}
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" || publicID == "" || email != identity.email {
		return "", "", errors.New("Better Auth binding requires identity review")
	}
	return identity.subject, email, nil
}

// ConfiguredBetterAuthVerifier is opt-in. The unchanged Cognito configuration
// remains the default; unknown providers and incomplete Better Auth setup fail
// closed instead of silently enabling legacy email-based fallback.
func ConfiguredBetterAuthVerifier(ctx context.Context, db *pgxpool.Pool) (IdentityVerifier, bool, error) {
	provider := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(os.Getenv("AUTH_PROVIDER"))), "_", "-")
	if provider == "" || provider == "cognito" {
		return nil, false, nil
	}
	if provider != "better-auth" {
		return nil, false, errors.New("AUTH_PROVIDER must be cognito or better-auth")
	}
	if db == nil {
		return nil, true, errors.New("Better Auth requires the MLM identity binding database")
	}
	verifier, err := NewBetterAuthVerifier(ctx, os.Getenv("BETTER_AUTH_JWKS_URL"), os.Getenv("BETTER_AUTH_JWT_ISSUER"), os.Getenv("BETTER_AUTH_JWT_AUDIENCE"))
	if err != nil {
		return nil, true, err
	}
	return &boundBetterAuthVerifier{verifier: verifier, db: db}, true, nil
}
