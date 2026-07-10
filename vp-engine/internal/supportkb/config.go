// Package supportkb implementa el indexer del RAG de soporte: lee chunks
// pendientes de support.kb_chunks (Postgres = fuente de verdad), los embebe
// vía OpenRouter (intfloat/multilingual-e5-large) y los upserta en Qdrant
// (índice DERIVADO, reconstruible con --rebuild).
package supportkb

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Constantes del modelo — CONGELADAS con el índice. Cambiar cualquiera de
// estas implica rebuild total de la colección (los vectores viejos quedan
// incompatibles). El indexer valida dims contra la colección al arrancar.
const (
	EmbedModel = "intfloat/multilingual-e5-large"
	EmbedDims  = 1024
	// e5 corta en 512 tokens y TRUNCA EN SILENCIO: los chunks deben venir
	// ya recortados a ~400 tokens desde el chunker de la app.
)

type Config struct {
	Env         string
	LogLevel    string
	DatabaseURL string

	OpenRouterAPIKey string // secreto OPENROUTER_API_RAG en Secrets Manager
	OpenRouterURL    string

	QdrantURL    string // ej. http://localhost:6333 (bind privado en WORKER)
	QdrantAPIKey string
	Collection   string

	BatchSize    int           // chunks por request de embeddings
	PollInterval time.Duration // frecuencia del loop incremental

	DBMaxConns     int32
	DBConnLifetime time.Duration

	// --- Solo vp-support (API HTTP del bot) ---------------------------------
	HTTPListenAddr string
	ServiceToken   string   // shared secret con el BFF (X-VP-Service-Token)
	AdminEmails    []string // allowlist de admins (rol admin en la KB)

	// Verificación de identidad Cognito (misma defensa H-2 que vp-payments):
	// el backend re-verifica el id token que reenvía el BFF en X-VP-Id-Token.
	CognitoIssuer   string
	CognitoClientID string

	ChatModel string // LLM del bot vía OpenRouter (iterable sin tocar embeddings)
	ChatURL   string
	MinScore  float64 // score coseno mínimo del top hit para intentar responder
}

// JWKSURL devuelve la URL del JWKS del user pool (issuer + /.well-known/jwks.json).
func (c *Config) JWKSURL() string {
	if c.CognitoIssuer == "" {
		return ""
	}
	return strings.TrimRight(c.CognitoIssuer, "/") + "/.well-known/jwks.json"
}

// LoadServiceConfig carga la config del servicio HTTP (vp-support): todo lo
// del indexer + auth y chat.
func LoadServiceConfig() (Config, error) {
	cfg, err := LoadConfig()
	if err != nil {
		return cfg, err
	}
	cfg.HTTPListenAddr = getenv("SUPPORT_HTTP_ADDR", "0.0.0.0:9096")
	cfg.ServiceToken = os.Getenv("SERVICE_TOKEN")
	cfg.AdminEmails = splitCSV(os.Getenv("ADMIN_EMAILS"))
	cfg.CognitoIssuer = os.Getenv("COGNITO_ISSUER")
	cfg.CognitoClientID = os.Getenv("COGNITO_CLIENT_ID")
	cfg.ChatModel = getenv("SUPPORT_CHAT_MODEL", "openai/gpt-4o-mini")
	cfg.ChatURL = getenv("OPENROUTER_CHAT_URL", "https://openrouter.ai/api/v1/chat/completions")
	cfg.MinScore = getenvFloat("SUPPORT_MIN_SCORE", 0.45)
	if cfg.ServiceToken == "" {
		return cfg, fmt.Errorf("SERVICE_TOKEN requerido")
	}
	return cfg, nil
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

func getenvFloat(k string, def float64) float64 {
	if v := os.Getenv(k); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}

func LoadConfig() (Config, error) {
	cfg := Config{
		Env:              getenv("APP_ENV", "dev"),
		LogLevel:         getenv("LOG_LEVEL", "info"),
		DatabaseURL:      os.Getenv("DATABASE_URL"),
		OpenRouterAPIKey: os.Getenv("OPENROUTER_API_KEY"),
		OpenRouterURL:    getenv("OPENROUTER_URL", "https://openrouter.ai/api/v1/embeddings"),
		QdrantURL:        getenv("QDRANT_URL", "http://localhost:6333"),
		QdrantAPIKey:     os.Getenv("QDRANT_API_KEY"),
		Collection:       getenv("QDRANT_COLLECTION", "kb"),
		BatchSize:        getenvInt("KB_BATCH_SIZE", 128),
		PollInterval:     getenvDur("KB_POLL_INTERVAL", 30*time.Second),
		DBMaxConns:       int32(getenvInt("DB_MAX_CONNS", 4)),
		DBConnLifetime:   getenvDur("DB_CONN_LIFETIME", 30*time.Minute),
	}
	if cfg.DatabaseURL == "" {
		return cfg, fmt.Errorf("DATABASE_URL requerido")
	}
	if cfg.OpenRouterAPIKey == "" {
		return cfg, fmt.Errorf("OPENROUTER_API_KEY requerido (secreto OPENROUTER_API_RAG)")
	}
	return cfg, nil
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func getenvInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func getenvDur(k string, def time.Duration) time.Duration {
	if v := os.Getenv(k); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}
