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

// BMP_BASE_URL debe ser SOLO el origen. Un valor con ruta produce una URL
// duplicada y BMP responde 404 en todas las verificaciones; con el candado en
// enforce, nadie cobra. Se rechaza al arrancar, no en el primer pago.
func TestValidateBMPBaseURL(t *testing.T) {
	for _, tc := range []struct {
		name    string
		raw     string
		wantErr bool
	}{
		{"host_pelado", "https://apis.be-mindpower.net", false},
		{"host_con_barra", "https://apis.be-mindpower.net/", false},
		{"dev", "https://dev-backend.be-mindpower.net", false},
		{"con_puerto", "http://localhost:8080", false},

		// El valor que estaba en .env.local: trae el prefijo de la ruta.
		{"con_prefijo_de_ruta", "https://apis.be-mindpower.net/api/v1/mindpower", true},
		// La URL completa del endpoint, que vive en otra variable.
		{"url_completa", "https://apis.be-mindpower.net/api/v1/mindpower/user-verification", true},
		{"con_query", "https://apis.be-mindpower.net?email=x", true},
		{"sin_esquema", "apis.be-mindpower.net", true},
		{"vacia", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := validateBMPBaseURL(tc.raw)
			if tc.wantErr && err == nil {
				t.Fatalf("validateBMPBaseURL(%q) = nil, want error", tc.raw)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("validateBMPBaseURL(%q) = %v, want nil", tc.raw, err)
			}
		})
	}
}

// El error debe decir qué poner, no solo que está mal.
func TestValidateBMPBaseURL_ErrorGuia(t *testing.T) {
	err := validateBMPBaseURL("https://apis.be-mindpower.net/api/v1/mindpower")
	if err == nil {
		t.Fatal("err = nil, want error")
	}
	if !strings.Contains(err.Error(), "https://apis.be-mindpower.net") {
		t.Fatalf("el error no sugiere el valor correcto: %v", err)
	}
}
