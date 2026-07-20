package withdrawals

import (
	"strings"
	"testing"
)

// setBaseEnv fija las variables mínimas que LoadConfig exige siempre, para que
// los tests de este archivo ejerciten sólo la regla de BMP_BASE_URL.
func setBaseEnv(t *testing.T) {
	t.Helper()
	t.Setenv("DATABASE_URL", "postgres://user:pass@localhost:5432/db")
	t.Setenv("SERVICE_TOKEN", "test-service-token")
}

// En producción, si BMP_BASE_URL no fue provisto explícitamente el servicio
// debe fallar al arrancar en vez de decidir pagos contra el backend de dev de
// BMP en silencio.
func TestLoadConfig_Production_MissingBMPBaseURL_Fails(t *testing.T) {
	setBaseEnv(t)
	t.Setenv("ENV", "production")
	t.Setenv("BMP_BASE_URL", "")

	_, err := LoadConfig()
	if err == nil {
		t.Fatal("err = nil, want error (BMP_BASE_URL faltante en producción)")
	}
	if !strings.Contains(err.Error(), "BMP_BASE_URL") {
		t.Fatalf("err = %q, want mención de BMP_BASE_URL", err.Error())
	}
}

// Con BMP_BASE_URL explícito, producción arranca normalmente y respeta el
// valor provisto.
func TestLoadConfig_Production_WithBMPBaseURL_Succeeds(t *testing.T) {
	setBaseEnv(t)
	t.Setenv("ENV", "production")
	t.Setenv("BMP_BASE_URL", "https://backend.be-mindpower.net")

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg.BMPBaseURL != "https://backend.be-mindpower.net" {
		t.Fatalf("BMPBaseURL = %q, want el valor explícito de producción", cfg.BMPBaseURL)
	}
}

// Fuera de producción, el default de dev se conserva aunque falte la variable.
func TestLoadConfig_NonProduction_DefaultsToDevBMPBaseURL(t *testing.T) {
	setBaseEnv(t)
	t.Setenv("ENV", "dev")
	t.Setenv("BMP_BASE_URL", "")

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg.BMPBaseURL != "https://dev-backend.be-mindpower.net" {
		t.Fatalf("BMPBaseURL = %q, want default de dev", cfg.BMPBaseURL)
	}
}
