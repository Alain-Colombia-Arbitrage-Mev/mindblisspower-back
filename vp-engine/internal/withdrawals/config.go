package withdrawals

import (
	"fmt"
	"os"
	"strconv"
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

	// RequireBMP es el interruptor de despliegue del candado BMP al pagar
	// (WITHDRAWALS_REQUIRE_BMP). DEFAULT true.
	//
	// El sistema debe poder desplegarse ANTES de tener credenciales productivas
	// de BMP; con el candado activo eso congelaría todos los pagos. En false la
	// verificación se ejecuta y se PERSISTE igual (la cola admin sigue mostrando
	// el estado real de cada afiliado), pero no impide pagar.
	//
	// No afecta al candado de baneados (D10), que es fail-closed siempre, ni a
	// la verificación al solicitar.
	RequireBMP bool
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
		RequireBMP:       getenvBool("WITHDRAWALS_REQUIRE_BMP", true),
	}
	if cfg.DatabaseURL == "" {
		return cfg, fmt.Errorf("DATABASE_URL requerido")
	}
	if cfg.ServiceToken == "" {
		return cfg, fmt.Errorf("SERVICE_TOKEN requerido")
	}
	// En producción, BMP_BASE_URL debe ser explícito. El default apunta al
	// backend de DEV de BMP, que no conoce afiliados reales y responde
	// exists:false para todos: si la variable falta en un despliegue de
	// producción, el servicio decidiría pagos en silencio contra dev.
	if cfg.Env == "production" && strings.TrimSpace(os.Getenv("BMP_BASE_URL")) == "" {
		return cfg, fmt.Errorf("BMP_BASE_URL requerido en producción (ENV=production): el default apunta al backend de dev de BMP")
	}
	return cfg, nil
}

func getenv(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

// getenvBool lee una bandera booleana. Ausente, vacía o ILEGIBLE ⇒ se devuelve
// el default. Para WITHDRAWALS_REQUIRE_BMP el default es true, así que un
// "WITHDRAWALS_REQUIRE_BMP=flase" mal tipeado deja el candado PUESTO: el error
// de dedo falla del lado seguro en vez de abrir la salida de dinero en silencio.
func getenvBool(k string, def bool) bool {
	raw := strings.TrimSpace(os.Getenv(k))
	if raw == "" {
		return def
	}
	v, err := strconv.ParseBool(raw)
	if err != nil {
		return def
	}
	return v
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
