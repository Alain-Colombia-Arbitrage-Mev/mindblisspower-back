// Package payments implementa el servicio de cobros con Stripe (Checkout
// hosted, tarjeta + crypto). Verifica la firma del webhook y, en pago exitoso,
// publica el evento NATS `payments.deposit_confirmed` que vp-engine
// (walletbridge) consume para postear el ledger y activar el paquete en el
// árbol binario. Este servicio NUNCA escribe mlm.wallet_movement directamente.
package payments

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config para el binario cmd/vp-payments. Auth = Cognito (ya conectado aguas
// arriba); este servicio no usa better-auth. El endpoint de checkout confía en
// el BFF Next mediante un token de servicio compartido; el webhook se
// autentica por firma de Stripe, no por sesión.
type Config struct {
	Env            string
	LogLevel       string
	HTTPListenAddr string

	DatabaseURL    string
	DBMaxConns     int32
	DBConnLifetime time.Duration

	NATSURL      string
	NATSUser     string
	NATSPassword string

	StripeSecretKey     string
	StripeWebhookSecret string
	StripeProductID     string // Producto Stripe "PACK MINDBLISS" (prod_…)
	StripePMConfig      string // payment_method_configuration (pmc_…); si está, gana sobre PaymentMethods

	// ServiceToken: secreto compartido que el BFF Next debe enviar en
	// X-VP-Service-Token para crear sesiones de checkout.
	ServiceToken string

	SuccessURL     string
	CancelURL      string
	PaymentMethods []string // p.ej. ["card","crypto"]
	AdminEmails    []string // allowlist de super-admin por env (además de mlm.person.is_admin)
	// Afiliado raíz de la empresa: si un comprador no tiene sponsor (sin ?ref ni
	// afiliado previo), se coloca bajo este root (la activación derrama). 0 = desactivado.
	CompanyRootAffiliateID int64
}

// LoadConfig lee variables de entorno y falla rápido si falta algo crítico.
// Si PAYMENTS_ENV_FILE apunta a un archivo, lo carga primero (solo para correr
// local; las variables ya presentes en el entorno tienen prioridad). En
// producción usar systemd EnvironmentFile, no esto.
func LoadConfig() (*Config, error) {
	if p := os.Getenv("PAYMENTS_ENV_FILE"); p != "" {
		if err := loadEnvFile(p); err != nil {
			return nil, fmt.Errorf("load env file %s: %w", p, err)
		}
	}
	c := &Config{
		Env:                 env("ENV", "development"),
		LogLevel:            env("LOG_LEVEL", "info"),
		HTTPListenAddr:      env("PAYMENTS_HTTP_ADDR", "0.0.0.0:9095"),
		// DATABASE_URL preferido; fallback al nombre que ya usa el .env del repo.
		// OJO: requiere rol con escritura (payments.purchase_intent), no el rol
		// read-only de MEMBER_DATABASE_URL.
		DatabaseURL:    firstEnv("DATABASE_URL", "VP_ENGINE_DATABASE_URL"),
		DBMaxConns:     int32(envInt("PAYMENTS_DB_MAX_CONNS", 10)),
		DBConnLifetime: 30 * time.Minute,
		NATSURL:        env("NATS_URL", ""),
		NATSUser:       env("NATS_USER", ""),
		NATSPassword:   env("NATS_PASSWORD", ""),
		// Aliases aceptados (los que ya pusiste en backend/.env.local):
		//   STRIPE_SECRET_KEY      | CLAVE_API
		//   STRIPE_WEBHOOK_SECRET  | SECRET_FIRMA
		StripeSecretKey:     firstEnv("STRIPE_SECRET_KEY", "CLAVE_API"),
		StripeWebhookSecret: firstEnv("STRIPE_WEBHOOK_SECRET", "SECRET_FIRMA"),
		// Vacío ⇒ producto inline. PAYMENTS_STRIPE_PRODUCT_ID (explícito) gana;
		// fallback a ID_PRODUCTO_TEST para correr en test sin renombrar. En
		// producción setear PAYMENTS_STRIPE_PRODUCT_ID al prod_… LIVE.
		StripeProductID:     firstEnv("PAYMENTS_STRIPE_PRODUCT_ID", "ID_PRODUCTO_TEST"),
		StripePMConfig:      firstEnv("PAYMENTS_PM_CONFIG", "ID_METODO_PAGO"),
		ServiceToken:        os.Getenv("PAYMENTS_SERVICE_TOKEN"),
		SuccessURL:          env("PAYMENTS_SUCCESS_URL", "https://app.mindblisspower.com/dashboard/packages?paid=1&session_id={CHECKOUT_SESSION_ID}"),
		CancelURL:           env("PAYMENTS_CANCEL_URL", "https://app.mindblisspower.com/dashboard/packages?canceled=1"),
		PaymentMethods:      splitCSV(env("PAYMENTS_METHODS", "card,crypto")),
		AdminEmails:            splitCSV(env("PAYMENTS_ADMIN_EMAILS", "")),
		CompanyRootAffiliateID: int64(envInt("PAYMENTS_COMPANY_ROOT_AFFILIATE_ID", 0)),
	}

	if c.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}
	if c.StripeSecretKey == "" {
		return nil, fmt.Errorf("STRIPE_SECRET_KEY is required")
	}
	if c.StripeWebhookSecret == "" {
		return nil, fmt.Errorf("STRIPE_WEBHOOK_SECRET is required")
	}
	if c.ServiceToken == "" {
		return nil, fmt.Errorf("PAYMENTS_SERVICE_TOKEN is required")
	}
	if len(c.PaymentMethods) == 0 {
		c.PaymentMethods = []string{"card"}
	}
	return c, nil
}

// loadEnvFile carga un archivo KEY=VALUE en el entorno. Las variables que YA
// existen en el entorno NO se sobreescriben (env real > archivo). Soporta
// comentarios (#), líneas en blanco, `export KEY=` y comillas alrededor del valor.
func loadEnvFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		eq := strings.IndexByte(line, '=')
		if eq <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.Trim(strings.TrimSpace(line[eq+1:]), `"'`)
		if _, ok := os.LookupEnv(key); !ok {
			_ = os.Setenv(key, val)
		}
	}
	return sc.Err()
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// firstEnv devuelve el primer env var no vacío de la lista (orden de prioridad).
func firstEnv(keys ...string) string {
	for _, k := range keys {
		if v := os.Getenv(k); v != "" {
			return v
		}
	}
	return ""
}

func envInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			return i
		}
	}
	return fallback
}

func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}
