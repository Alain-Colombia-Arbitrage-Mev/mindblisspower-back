package payments

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
)

// IdentityVerifier verifica un id token Cognito (firma JWKS + iss + aud +
// token_use + exp) y devuelve el email verificado (lowercased). Es una interfaz
// para que los tests puedan inyectar un fake sin montar un JWKS real.
type IdentityVerifier interface {
	// VerifyEmail verifica el token y devuelve el email del claim. Cualquier
	// fallo (firma inválida, iss/aud incorrectos, expirado, sin email) => error.
	VerifyEmail(ctx context.Context, rawToken string) (string, error)
}

// cognitoVerifier implementa IdentityVerifier contra un user pool de Cognito.
// El keyfunc mantiene un cache del JWKS (refresco automático), así que es un
// singleton seguro para concurrencia.
type cognitoVerifier struct {
	keyfunc  keyfunc.Keyfunc
	issuer   string
	clientID string
}

// NewCognitoVerifier construye el verificador. jwksURL es
// <issuer>/.well-known/jwks.json. issuer y clientID son los valores esperados
// (clientID vacío ⇒ no se valida aud). Falla si el JWKS no se puede inicializar.
func NewCognitoVerifier(ctx context.Context, jwksURL, issuer, clientID string) (IdentityVerifier, error) {
	if jwksURL == "" {
		return nil, errors.New("jwks url required")
	}
	kf, err := keyfunc.NewDefaultCtx(ctx, []string{jwksURL})
	if err != nil {
		return nil, fmt.Errorf("init jwks %s: %w", jwksURL, err)
	}
	return &cognitoVerifier{keyfunc: kf, issuer: issuer, clientID: clientID}, nil
}

func (v *cognitoVerifier) VerifyEmail(_ context.Context, rawToken string) (string, error) {
	if rawToken == "" {
		return "", errors.New("empty token")
	}
	parserOpts := []jwt.ParserOption{
		jwt.WithValidMethods([]string{"RS256"}),
		jwt.WithExpirationRequired(),
	}
	if v.issuer != "" {
		parserOpts = append(parserOpts, jwt.WithIssuer(v.issuer))
	}
	// aud en id tokens Cognito == client id.
	if v.clientID != "" {
		parserOpts = append(parserOpts, jwt.WithAudience(v.clientID))
	}

	claims := jwt.MapClaims{}
	token, err := jwt.ParseWithClaims(rawToken, claims, v.keyfunc.Keyfunc, parserOpts...)
	if err != nil {
		return "", fmt.Errorf("parse/verify token: %w", err)
	}
	if !token.Valid {
		return "", errors.New("token invalid")
	}
	// token_use debe ser "id" (no un access token).
	if tu, _ := claims["token_use"].(string); tu != "id" {
		return "", fmt.Errorf("unexpected token_use %q", tu)
	}
	email, _ := claims["email"].(string)
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return "", errors.New("no email claim")
	}
	return email, nil
}
