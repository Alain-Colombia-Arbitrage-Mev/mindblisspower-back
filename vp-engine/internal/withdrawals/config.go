package withdrawals

import (
	"fmt"
	"os"
	"strings"
	"time"
)

type Config struct {
	Env            string
	LogLevel       string
	DatabaseURL    string
	HTTPListenAddr string
	ServiceToken   string
	AdminEmails    []string
	// SuperAdminEmails: rol super_admin (acceso total). Son admins también,
	// aunque NO estén en ADMIN_EMAILS ni en mlm.person.is_admin.
	SuperAdminEmails []string

	CognitoIssuer   string
	CognitoClientID string

	DBMaxConns     int32
	DBConnLifetime time.Duration

	// BMP (Task 6)
	BMPBaseURL      string
	BMPClientID     string
	BMPClientSecret string
}

// JWKSURL devuelve la URL del JWKS del user pool.
func (c *Config) JWKSURL() string {
	if c.CognitoIssuer == "" {
		return ""
	}
	return strings.TrimRight(c.CognitoIssuer, "/") + "/.well-known/jwks.json"
}

func LoadConfig() (Config, error) {
	cfg := Config{
		Env:            getenv("ENV", "dev"),
		LogLevel:       getenv("LOG_LEVEL", "info"),
		DatabaseURL:    os.Getenv("DATABASE_URL"),
		HTTPListenAddr: getenv("WITHDRAWALS_HTTP_ADDR", "0.0.0.0:9097"),
		ServiceToken:   os.Getenv("SERVICE_TOKEN"),
		AdminEmails:    splitCSV(os.Getenv("ADMIN_EMAILS")),
		// Mismo default que payments (PAYMENTS_SUPER_ADMIN_EMAILS) para no dejar
		// al super-admin fuera de la cola de retiros si la variable no está.
		SuperAdminEmails: splitCSV(getenv("SUPER_ADMIN_EMAILS", "devfidubit@gmail.com")),
		CognitoIssuer:    os.Getenv("COGNITO_ISSUER"),
		CognitoClientID:  os.Getenv("COGNITO_CLIENT_ID"),
		DBMaxConns:       10,
		DBConnLifetime:   30 * time.Minute,
		BMPBaseURL:       getenv("BMP_BASE_URL", "https://dev-backend.be-mindpower.net"),
		BMPClientID:      os.Getenv("BMP_CLIENT_ID"),
		BMPClientSecret:  os.Getenv("BMP_CLIENT_SECRET"),
	}
	if cfg.DatabaseURL == "" {
		return cfg, fmt.Errorf("DATABASE_URL requerido")
	}
	if cfg.ServiceToken == "" {
		return cfg, fmt.Errorf("SERVICE_TOKEN requerido")
	}
	return cfg, nil
}

func getenv(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func splitCSV(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(strings.ToLower(p)); p != "" {
			out = append(out, p)
		}
	}
	return out
}
