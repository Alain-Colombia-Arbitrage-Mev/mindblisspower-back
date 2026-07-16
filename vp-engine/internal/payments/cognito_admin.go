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
