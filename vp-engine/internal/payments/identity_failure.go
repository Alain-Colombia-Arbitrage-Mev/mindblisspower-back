package payments

import (
	"errors"

	"github.com/golang-jwt/jwt/v5"
)

// Fixed private service diagnostics only. Never retain the JWT, key ID, HTTP
// response, SQL error, customer identifier or an underlying error string.
type identityFailure struct {
	reason      string
	unavailable bool
}

func (e *identityFailure) Error() string {
	if e.unavailable {
		return ErrAuthenticationUnavailable.Error()
	}
	return "invalid Better Auth service identity"
}

func (e *identityFailure) Unwrap() error {
	if e.unavailable {
		return ErrAuthenticationUnavailable
	}
	return nil
}

func newIdentityFailure(reason string, unavailable bool) error {
	switch reason {
	case "jwt_format", "jwt_signature", "jwt_keys_unavailable", "jwt_expired", "jwt_not_yet_valid",
		"jwt_issued_in_future", "jwt_issuer", "jwt_audience", "jwt_claims", "binding_missing", "binding_mismatch",
		"identity_storage_unavailable", "identity_unavailable":
	default:
		reason = "identity_unknown"
	}
	return &identityFailure{reason: reason, unavailable: unavailable}
}

func identityFailureReason(err error) string {
	var classified *identityFailure
	if errors.As(err, &classified) {
		return classified.reason
	}
	if errors.Is(err, ErrAuthenticationUnavailable) {
		return "identity_unavailable"
	}
	return "identity_unknown"
}

func classifyBetterAuthJWTError(err error) error {
	switch {
	case errors.Is(err, jwt.ErrTokenMalformed):
		return newIdentityFailure("jwt_format", false)
	case errors.Is(err, jwt.ErrTokenUnverifiable):
		// A missing/unavailable trusted public key never authenticates a caller,
		// but it is not proof of a bad signature or a revoked native session.
		return newIdentityFailure("jwt_keys_unavailable", true)
	case errors.Is(err, jwt.ErrTokenSignatureInvalid):
		return newIdentityFailure("jwt_signature", false)
	case errors.Is(err, jwt.ErrTokenExpired):
		return newIdentityFailure("jwt_expired", false)
	case errors.Is(err, jwt.ErrTokenNotValidYet):
		return newIdentityFailure("jwt_not_yet_valid", false)
	case errors.Is(err, jwt.ErrTokenInvalidIssuer):
		return newIdentityFailure("jwt_issuer", false)
	case errors.Is(err, jwt.ErrTokenInvalidAudience):
		return newIdentityFailure("jwt_audience", false)
	default:
		return newIdentityFailure("jwt_claims", false)
	}
}
