// Package config carga configuración desde variables de entorno.
// Falla rápido al inicio si falta algo crítico.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config holds all runtime configuration for vp-engine.
type Config struct {
	Env string

	// Database
	DatabaseURL    string
	DBMaxConns     int32
	DBConnLifetime time.Duration

	// NATS
	NATSURL      string
	NATSUser     string
	NATSPassword string

	// gRPC
	GRPCListenAddr           string
	GRPCTLSCert              string
	GRPCTLSKey               string
	GRPCTLSClientCA          string
	GRPCTLSRequireClientCert bool

	// HTTP
	HTTPListenAddr string

	// LLM / network intelligence
	OpenRouterAPIKey        string
	OpenRouterModel         string
	OpenRouterFallbackModel string
	OpenRouterEndpoint      string
	OpenRouterReferer       string
	OpenRouterAppTitle      string

	// Observability
	OTLPEndpoint string
	OTLPHeaders  string
	ServiceName  string
	LogLevel     string

	// Bonus engine schedules
	BonusEngineTimezone           string
	BonusEngineBinaryCron         string
	BonusEngineROICron            string
	BonusEngineBinaryCycleEnabled bool
}

// Load reads env vars and validates required fields.
func Load() (*Config, error) {
	c := &Config{
		Env:                           env("ENV", "development"),
		DatabaseURL:                   required("DATABASE_URL"),
		DBMaxConns:                    int32(envInt("DB_MAX_CONNS", 25)),
		DBConnLifetime:                envDuration("DB_CONN_LIFETIME", 30*time.Minute),
		NATSURL:                       env("NATS_URL", "nats://localhost:4222"),
		NATSUser:                      env("NATS_USER", ""),
		NATSPassword:                  env("NATS_PASSWORD", ""),
		GRPCListenAddr:                env("GRPC_LISTEN_ADDR", "0.0.0.0:50051"),
		GRPCTLSCert:                   env("GRPC_TLS_CERT", ""),
		GRPCTLSKey:                    env("GRPC_TLS_KEY", ""),
		GRPCTLSClientCA:               env("GRPC_TLS_CLIENT_CA", ""),
		GRPCTLSRequireClientCert:      envBool("GRPC_TLS_REQUIRE_CLIENT_CERT", true),
		HTTPListenAddr:                env("HTTP_LISTEN_ADDR", "0.0.0.0:9090"),
		OpenRouterAPIKey:              env("OPENROUTER_API_KEY", ""),
		OpenRouterModel:               env("OPENROUTER_MODEL", "deepseek/deepseek-v4-pro"),
		OpenRouterFallbackModel:       env("OPENROUTER_FALLBACK_MODEL", "minimax/minimax-m3"),
		OpenRouterEndpoint:            env("OPENROUTER_ENDPOINT", "https://openrouter.ai/api/v1/chat/completions"),
		OpenRouterReferer:             env("OPENROUTER_REFERER", ""),
		OpenRouterAppTitle:            env("OPENROUTER_APP_TITLE", "Vicion Growth Hub"),
		OTLPEndpoint:                  env("OTEL_EXPORTER_OTLP_ENDPOINT", ""),
		OTLPHeaders:                   env("OTEL_EXPORTER_OTLP_HEADERS", ""),
		ServiceName:                   env("OTEL_SERVICE_NAME", "vp-engine"),
		LogLevel:                      env("LOG_LEVEL", "info"),
		BonusEngineTimezone:           env("BONUS_ENGINE_TIMEZONE", "America/Bogota"),
		BonusEngineBinaryCron:         env("BONUS_ENGINE_BINARY_CRON", "0 2 * * 1"),
		BonusEngineROICron:            env("BONUS_ENGINE_ROI_CRON", "0 1 * * *"),
		BonusEngineBinaryCycleEnabled: envBool("BONUS_ENGINE_BINARY_CYCLE_ENABLED", true),
	}

	if c.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}

	// In production, mTLS is non-negotiable.
	if c.Env == "production" {
		if c.GRPCTLSCert == "" || c.GRPCTLSKey == "" || c.GRPCTLSClientCA == "" {
			return nil, fmt.Errorf("production requires GRPC_TLS_CERT, GRPC_TLS_KEY, GRPC_TLS_CLIENT_CA")
		}
	}

	return c, nil
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func required(key string) string {
	v := os.Getenv(key)
	if v == "" {
		// Don't os.Exit here — Load returns error so main can decide.
		return ""
	}
	return v
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
	if v := os.Getenv(key); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return fallback
}

func envDuration(key string, fallback time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return fallback
}
