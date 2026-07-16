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

	DatabaseURL string
	// ReadDatabaseURL: réplica de lectura RDS (opcional). Vacío ⇒ los reads van al
	// primary. Los métodos read-only de payments la usan; las escrituras siempre
	// al primary.
	ReadDatabaseURL string
	DBMaxConns      int32
	DBConnLifetime  time.Duration

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

	SuccessURL       string
	CancelURL        string
	PaymentMethods   []string // p.ej. ["card","crypto"]
	AdminEmails      []string // allowlist de admin por env (además de mlm.person.is_admin)
	SuperAdminEmails []string // subconjunto con rol super_admin (acceso total)
	// Afiliado raíz de la empresa: si un comprador no tiene sponsor (sin ?ref ni
	// afiliado previo), se coloca bajo este root (la activación derrama). 0 = desactivado.
	CompanyRootAffiliateID int64

	// EngineURL: base del motor vp-engine para el simulador canónico de θ
	// (POST /simulate). Vacío ⇒ el lock de solvencia usa solo la proyección forward.
	EngineURL string

	// Sweep de reconciliación: activa intents pagados en Stripe que quedaron sin
	// activar en DB (webhook perdido). Corre en background cada ReconcileInterval.
	// 0 ⇒ desactivado. Solo toca intents con más de ReconcileMinAge de antigüedad
	// (evita competir con el webhook normal) y menos de 30 días.
	ReconcileInterval time.Duration
	ReconcileMinAge   time.Duration

	// ── Verificación de identidad (defensa en profundidad, H-2) ────────────────
	// El backend re-verifica el id token Cognito que reenvía el BFF (header
	// X-VP-Id-Token) contra el JWKS del user pool. Deriva la identidad del token
	// verificado en lugar de confiar en el `email` que envía el cliente.
	//
	// CognitoIssuer: emisor esperado, p.ej.
	//   https://cognito-idp.<region>.amazonaws.com/<userPoolId>
	// Si está vacío se deriva de CognitoUserPoolID + AWSRegion.
	CognitoIssuer string
	// CognitoUserPoolID + AWSRegion se usan para derivar issuer/JWKS si falta el
	// issuer explícito.
	CognitoUserPoolID string
	AWSRegion         string
	// CognitoClientID: audiencia (`aud`) esperada del id token. Vacío ⇒ no se
	// valida aud (pero sí firma + iss + token_use + exp).
	CognitoClientID string
	// RequireVerifiedIdentity: cuando true, el header X-VP-Id-Token es obligatorio
	// en los handlers que portan identidad (rechaza si falta). Default false para
	// permitir un rollout backward-compatible: primero se despliegan los BFFs que
	// reenvían el token, luego se activa el modo estricto.
	RequireVerifiedIdentity bool

	// Redis (cache-aside + rate-limit). RedisAddr vacío ⇒ caché deshabilitada.
	RedisAddr     string
	RedisPassword string

	// ── KYC (subida de documentos) ──────────────────────────────────────────────
	// KYCBucket: bucket S3 privado para documentos KYC. Vacío ⇒ endpoints KYC
	// responden 503 kyc-unconfigured (rollout seguro sin bucket).
	KYCBucket string
	// KYCRegion: región del bucket (default: AWSRegion o us-east-1).
	KYCRegion string
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
		Env:            env("ENV", "development"),
		LogLevel:       env("LOG_LEVEL", "info"),
		HTTPListenAddr: env("PAYMENTS_HTTP_ADDR", "0.0.0.0:9095"),
		// DATABASE_URL preferido; fallback al nombre que ya usa el .env del repo.
		// OJO: requiere rol con escritura (payments.purchase_intent), no el rol
		// read-only de MEMBER_DATABASE_URL.
		DatabaseURL:     firstEnv("DATABASE_URL", "VP_ENGINE_DATABASE_URL"),
		ReadDatabaseURL: env("READ_DATABASE_URL", ""),
		DBMaxConns:      int32(envInt("PAYMENTS_DB_MAX_CONNS", 10)),
		DBConnLifetime:  30 * time.Minute,
		NATSURL:         env("NATS_URL", ""),
		NATSUser:        env("NATS_USER", ""),
		NATSPassword:    env("NATS_PASSWORD", ""),
		// Aliases aceptados (los que ya pusiste en backend/.env.local):
		//   STRIPE_SECRET_KEY      | CLAVE_API
		//   STRIPE_WEBHOOK_SECRET  | SECRET_FIRMA
		StripeSecretKey:     firstEnv("STRIPE_SECRET_KEY", "CLAVE_API"),
		StripeWebhookSecret: firstEnv("STRIPE_WEBHOOK_SECRET", "SECRET_FIRMA"),
		// Vacío ⇒ producto inline. PAYMENTS_STRIPE_PRODUCT_ID (explícito) gana;
		// fallback a ID_PRODUCTO_TEST para correr en test sin renombrar. En
		// producción setear PAYMENTS_STRIPE_PRODUCT_ID al prod_… LIVE.
		StripeProductID:        firstEnv("PAYMENTS_STRIPE_PRODUCT_ID", "ID_PRODUCTO_TEST"),
		StripePMConfig:         firstEnv("PAYMENTS_PM_CONFIG", "ID_METODO_PAGO"),
		ServiceToken:           os.Getenv("PAYMENTS_SERVICE_TOKEN"),
		SuccessURL:             env("PAYMENTS_SUCCESS_URL", "https://app.mindblisspower.com/dashboard/packages/confirmacion?paid=1&session_id={CHECKOUT_SESSION_ID}"),
		CancelURL:              env("PAYMENTS_CANCEL_URL", "https://app.mindblisspower.com/dashboard/packages?canceled=1"),
		PaymentMethods:         splitCSV(env("PAYMENTS_METHODS", "card,crypto")),
		AdminEmails:            splitCSV(env("PAYMENTS_ADMIN_EMAILS", "gabgarluc@outlook.com")),
		SuperAdminEmails:       splitCSV(env("PAYMENTS_SUPER_ADMIN_EMAILS", "devfidubit@gmail.com")),
		CompanyRootAffiliateID: int64(envInt("PAYMENTS_COMPANY_ROOT_AFFILIATE_ID", 0)),
		EngineURL:              env("VP_ENGINE_URL", "http://127.0.0.1:9090"),
		// Sweep cada 15m por defecto; solo intents de >10m de antigüedad. 0 desactiva.
		ReconcileInterval: time.Duration(envInt("PAYMENTS_RECONCILE_INTERVAL_MIN", 15)) * time.Minute,
		ReconcileMinAge:   time.Duration(envInt("PAYMENTS_RECONCILE_MIN_AGE_MIN", 10)) * time.Minute,
		RedisAddr:         env("REDIS_ADDR", ""),
		RedisPassword:     env("REDIS_PASSWORD", ""),
		// Verificación de identidad (H-2). Aliases aceptados para reutilizar los
		// mismos nombres que ya usan los BFFs (COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID).
		CognitoIssuer:           env("COGNITO_ISSUER", ""),
		CognitoUserPoolID:       firstEnv("COGNITO_USER_POOL_ID", "COGNITO_USERPOOL_ID"),
		AWSRegion:               firstEnv("AWS_REGION", "COGNITO_REGION"),
		CognitoClientID:         env("COGNITO_CLIENT_ID", ""),
		RequireVerifiedIdentity: envBool("REQUIRE_VERIFIED_IDENTITY", false),
		KYCBucket:               env("KYC_S3_BUCKET", ""),
		KYCRegion:               firstEnv("KYC_S3_REGION", "AWS_REGION", "COGNITO_REGION"),
	}
	if c.KYCRegion == "" {
		c.KYCRegion = "us-east-1"
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
	// Deriva el issuer Cognito si no vino explícito pero sí el user pool + región.
	if c.CognitoIssuer == "" && c.CognitoUserPoolID != "" && c.AWSRegion != "" {
		c.CognitoIssuer = fmt.Sprintf("https://cognito-idp.%s.amazonaws.com/%s", c.AWSRegion, c.CognitoUserPoolID)
	}
	// Derivación inversa: si el issuer sí está configurado (verificador de id-token
	// activo) pero falta COGNITO_USER_POOL_ID, extrae el pool del issuer. Sin esto
	// el admin de Cognito no se inicializa y el ban NO deshabilita el login, solo
	// aplica el flag de DB. El pool es el último segmento del issuer:
	// https://cognito-idp.<region>.amazonaws.com/<poolID>
	if c.CognitoUserPoolID == "" && c.CognitoIssuer != "" {
		iss := strings.TrimRight(c.CognitoIssuer, "/")
		if i := strings.LastIndex(iss, "/"); i >= 0 && i+1 < len(iss) {
			c.CognitoUserPoolID = iss[i+1:]
		}
	}
	return c, nil
}

// JWKSURL devuelve la URL del JWKS del user pool (issuer + /.well-known/jwks.json).
// Vacío si no hay issuer configurado.
func (c *Config) JWKSURL() string {
	if c.CognitoIssuer == "" {
		return ""
	}
	return strings.TrimRight(c.CognitoIssuer, "/") + "/.well-known/jwks.json"
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

func envBool(key string, fallback bool) bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	switch v {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
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
