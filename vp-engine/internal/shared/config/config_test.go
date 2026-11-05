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

func TestLoad_CompanyRootFallbackAndOverride(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://localhost/test")
	t.Setenv("PAYMENTS_COMPANY_ROOT_AFFILIATE_ID", "117475")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.BonusEngineCompanyRootAffiliateID != 117475 {
		t.Fatalf("fallback company root = %d, want 117475", cfg.BonusEngineCompanyRootAffiliateID)
	}

	t.Setenv("BONUS_ENGINE_COMPANY_ROOT_AFFILIATE_ID", "999")
	cfg, err = Load()
	if err != nil {
		t.Fatalf("unexpected error after override: %v", err)
	}
	if cfg.BonusEngineCompanyRootAffiliateID != 999 {
		t.Fatalf("override company root = %d, want 999", cfg.BonusEngineCompanyRootAffiliateID)
	}
}

func TestLoad_AppPlatformInlineTLSAndDisabledScheduler(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://localhost/test")
	t.Setenv("ENV", "production")
	for _, name := range []string{"GRPC_TLS_CERT", "GRPC_TLS_KEY", "GRPC_TLS_CLIENT_CA"} {
		t.Setenv(name, "")
	}
	t.Setenv("GRPC_TLS_CERT_PEM", "synthetic-cert")
	t.Setenv("GRPC_TLS_KEY_PEM", "synthetic-key")
	t.Setenv("GRPC_TLS_CLIENT_CA_PEM", "synthetic-ca")
	t.Setenv("GRPC_TLS_REQUIRE_CLIENT_CERT", "true")
	t.Setenv("BONUS_ENGINE_SCHEDULER_ENABLED", "false")
	t.Setenv("NATS_URL", "")
	cfg, err := Load()
	if err != nil || cfg.BonusEngineSchedulerEnabled || cfg.NATSURL != "" {
		t.Fatalf("inline TLS/disabled scheduler: %v", err)
	}
	t.Setenv("GRPC_TLS_REQUIRE_CLIENT_CERT", "false")
	if _, err := Load(); err == nil {
		t.Fatal("production must not disable client verification")
	}
	t.Setenv("GRPC_TLS_REQUIRE_CLIENT_CERT", "true")
	t.Setenv("GRPC_TLS_CERT", "/cert")
	if _, err := Load(); err == nil {
		t.Fatal("ambiguous file/inline credentials must fail")
	}
}
