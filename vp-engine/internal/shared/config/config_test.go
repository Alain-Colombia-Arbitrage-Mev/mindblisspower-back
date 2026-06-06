package config

import (
	"testing"
)

func TestLoad_RequiresDatabaseURL(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	if _, err := Load(); err == nil {
		t.Fatal("expected error when DATABASE_URL missing")
	}
}

func TestLoad_ProductionRequiresTLS(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://localhost/test")
	t.Setenv("ENV", "production")
	t.Setenv("GRPC_TLS_CERT", "")
	if _, err := Load(); err == nil {
		t.Fatal("expected error: production requires TLS")
	}
}

func TestLoad_DevDefaults(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://localhost/test")
	t.Setenv("ENV", "development")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.HTTPListenAddr == "" {
		t.Error("HTTPListenAddr should default")
	}
	if cfg.LogLevel != "info" {
		t.Errorf("LogLevel default = %q, want info", cfg.LogLevel)
	}
	if !cfg.BonusEngineBinaryCycleEnabled {
		t.Error("BonusEngineBinaryCycleEnabled should default true")
	}
}

func TestLoad_AllowsDisablingBinaryCycle(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://localhost/test")
	t.Setenv("BONUS_ENGINE_BINARY_CYCLE_ENABLED", "false")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.BonusEngineBinaryCycleEnabled {
		t.Error("BonusEngineBinaryCycleEnabled = true, want false")
	}
}
