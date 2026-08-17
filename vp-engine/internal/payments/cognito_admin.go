package payments

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/cognitoidentityprovider"
	ciptypes "github.com/aws/aws-sdk-go-v2/service/cognitoidentityprovider/types"
)

// CognitoAdmin habilita/deshabilita el login de un usuario en el user pool. Se
// usa al banear/desbanear desde el panel: un usuario deshabilitado no puede
// iniciar sesión (Cognito rechaza el auth). nil ⇒ el efecto Cognito se omite y
// solo se aplica el flag en la DB (mlm.person).
type CognitoAdmin struct {
	client *cognitoidentityprovider.Client
	poolID string
}

// CognitoUserAccessStatus resume lo que el BFF necesita para explicar problemas
// de OTP sin exponer atributos sensibles completos.
type CognitoUserAccessStatus struct {
	Exists        bool
	Enabled       bool
	Status        string
	PhoneNumber   string
	PhoneLinked   bool
	PhoneVerified bool
}

// NewCognitoAdmin crea el cliente cognito-idp con la cadena de credenciales
// estándar (env → shared config → rol de instancia IMDS), la misma que KYC/S3.
func NewCognitoAdmin(ctx context.Context, poolID, region string) (*CognitoAdmin, error) {
	if strings.TrimSpace(poolID) == "" {
		return nil, fmt.Errorf("cognito admin: user pool id vacío")
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region))
	if err != nil {
		return nil, fmt.Errorf("aws config: %w", err)
	}
	return &CognitoAdmin{client: cognitoidentityprovider.NewFromConfig(cfg), poolID: poolID}, nil
}

// cognitoUsername deriva el username determinístico que usa el registro:
// "mp_" + primeros 40 hex de sha256(lower(trim(email))). DEBE coincidir con el
// BFF de registro (frontend .../cognito/register/route.js) o el disable no
// apunta al usuario correcto.
func cognitoUsername(email string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(email))))
	return "mp_" + hex.EncodeToString(sum[:])[:40]
}

// UserExists indica si existe un usuario con ese email en el pool (AdminGetUser
// sobre el username determinístico). UserNotFoundException ⇒ (false, nil). Lo
// usa el BFF de login OTP para detectar usuarios nuevos y enrutarlos a registro:
// el flujo passwordless de Cognito NO envía código a un usuario inexistente y,
// con PreventUserExistenceErrors activo, tampoco lo revela — de ahí el "código
// que nunca llega". Aquí sí lo resolvemos (endpoint gated por service token).
func (c *CognitoAdmin) UserExists(ctx context.Context, email string) (bool, error) {
	username := cognitoUsername(email)
	_, err := c.client.AdminGetUser(ctx, &cognitoidentityprovider.AdminGetUserInput{
		UserPoolId: &c.poolID, Username: &username,
	})
	if err != nil {
		var notFound *ciptypes.UserNotFoundException
		if errors.As(err, &notFound) {
			return false, nil
		}
		return false, fmt.Errorf("cognito user exists (%s): %w", email, err)
	}
	return true, nil
}

// GetUserAccessStatus devuelve estado Cognito + teléfono vinculado/verificado.
// UserNotFoundException ⇒ Exists=false, nil.
func (c *CognitoAdmin) GetUserAccessStatus(ctx context.Context, email string) (CognitoUserAccessStatus, error) {
	username := cognitoUsername(email)
	out, err := c.client.AdminGetUser(ctx, &cognitoidentityprovider.AdminGetUserInput{
		UserPoolId: &c.poolID, Username: &username,
	})
	if err != nil {
		var notFound *ciptypes.UserNotFoundException
		if errors.As(err, &notFound) {
			return CognitoUserAccessStatus{}, nil
		}
		return CognitoUserAccessStatus{}, fmt.Errorf("cognito user status (%s): %w", email, err)
	}
	status := CognitoUserAccessStatus{
		Exists:  true,
		Enabled: out.Enabled,
		Status:  string(out.UserStatus),
	}
	for _, attr := range out.UserAttributes {
		name, value := "", ""
		if attr.Name != nil {
			name = *attr.Name
		}
		if attr.Value != nil {
			value = strings.TrimSpace(*attr.Value)
		}
		switch name {
		case "phone_number":
			status.PhoneNumber = value
			status.PhoneLinked = value != ""
		case "phone_number_verified":
			status.PhoneVerified = strings.EqualFold(value, "true")
		}
	}
	return status, nil
}

// GetUserStatus devuelve si el usuario existe en el pool y, si existe, si está
// habilitado y su estado Cognito (CONFIRMED, UNCONFIRMED, ...). Lo usa el
// inspector de usuario del panel admin. UserNotFoundException ⇒ (false,...,nil).
func (c *CognitoAdmin) GetUserStatus(ctx context.Context, email string) (exists, enabled bool, status string, err error) {
	access, err := c.GetUserAccessStatus(ctx, email)
	if err != nil {
		return false, false, "", err
	}
	return access.Exists, access.Enabled, access.Status, nil
}

func maskPhoneNumber(phone string) string {
	digits := make([]rune, 0, len(phone))
	for _, r := range strings.TrimSpace(phone) {
		if r >= '0' && r <= '9' {
			digits = append(digits, r)
		}
	}
	if len(digits) == 0 {
		return ""
	}
	if len(digits) <= 4 {
		return "***" + string(digits)
	}
	return "+***" + string(digits[len(digits)-4:])
}

// SetEnabled habilita (true) o deshabilita (false) el login del usuario por
// email. UserNotFoundException ⇒ no-op (migrados sin cuenta Cognito): devuelve
// (false, nil). Devuelve (true, nil) si el cambio se aplicó.
func (c *CognitoAdmin) SetEnabled(ctx context.Context, email string, enabled bool) (bool, error) {
	username := cognitoUsername(email)
	var err error
	if enabled {
		_, err = c.client.AdminEnableUser(ctx, &cognitoidentityprovider.AdminEnableUserInput{
			UserPoolId: &c.poolID, Username: &username,
		})
	} else {
		_, err = c.client.AdminDisableUser(ctx, &cognitoidentityprovider.AdminDisableUserInput{
			UserPoolId: &c.poolID, Username: &username,
		})
	}
	if err != nil {
		var notFound *ciptypes.UserNotFoundException
		if errors.As(err, &notFound) {
			return false, nil
		}
		return false, fmt.Errorf("cognito set enabled (%s): %w", email, err)
	}
	return true, nil
}
