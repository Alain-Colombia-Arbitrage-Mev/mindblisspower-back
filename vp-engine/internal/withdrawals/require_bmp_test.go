package withdrawals

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/rs/zerolog"
)

// El default de WITHDRAWALS_REQUIRE_BMP es TRUE. Si alguien olvida la variable
// en un despliegue, el candado queda PUESTO: la omisión falla del lado seguro.
func TestLoadConfig_RequireBMP_DefaultsTrue(t *testing.T) {
	setBaseEnv(t)
	t.Setenv("WITHDRAWALS_REQUIRE_BMP", "")

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if !cfg.RequireBMP {
		t.Fatal("RequireBMP = false con la variable ausente, want true (default seguro)")
	}
}

// Sólo un "false" explícito y legible desactiva el candado.
func TestLoadConfig_RequireBMP_ExplicitFalse(t *testing.T) {
	setBaseEnv(t)
	t.Setenv("WITHDRAWALS_REQUIRE_BMP", "false")

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg.RequireBMP {
		t.Fatal("RequireBMP = true con WITHDRAWALS_REQUIRE_BMP=false, want false")
	}
}

// Un valor ilegible (dedazo) NO desactiva el candado: se conserva el default
// seguro. Desactivar la salida de dinero no puede ser el efecto de un typo.
func TestLoadConfig_RequireBMP_GarbageKeepsSafeDefault(t *testing.T) {
	setBaseEnv(t)
	for _, v := range []string{"flase", "nope", "off", "sí"} {
		t.Setenv("WITHDRAWALS_REQUIRE_BMP", v)
		cfg, err := LoadConfig()
		if err != nil {
			t.Fatalf("LoadConfig(%q): %v", v, err)
		}
		if !cfg.RequireBMP {
			t.Fatalf("WITHDRAWALS_REQUIRE_BMP=%q desactivó el candado; want default seguro (true)", v)
		}
	}
}

// Un Store recién construido tiene el candado PUESTO, sin depender de que
// alguien llame a SetRequireBMP. Es la segunda mitad del default seguro: si
// mañana un binario nuevo olvida cablear la config, el candado sigue ahí.
func TestNewStore_RequireBMP_DefaultsTrue(t *testing.T) {
	if !NewStore(nil).requireBMP {
		t.Fatal("NewStore().requireBMP = false, want true (default seguro)")
	}
}

// Con el candado desactivado, el servicio DEBE gritarlo en el arranque: main
// llama a SetRequireBMP en cada boot, así que el Warn queda en los logs de cada
// arranque mientras la bandera esté en false.
func TestSetRequireBMP_False_LogsWarnAtStartup(t *testing.T) {
	var buf bytes.Buffer
	s := NewStore(nil)
	s.SetLogger(zerolog.New(&buf))

	s.SetRequireBMP(false)

	line := buf.String()
	if line == "" {
		t.Fatal("SetRequireBMP(false) no logueó nada; want un Warn de arranque")
	}
	var rec map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(line)), &rec); err != nil {
		t.Fatalf("log no es JSON (%q): %v", line, err)
	}
	if rec["level"] != "warn" {
		t.Fatalf("level = %v, want warn", rec["level"])
	}
	msg, _ := rec["message"].(string)
	if !strings.Contains(msg, "WITHDRAWALS_REQUIRE_BMP") {
		t.Fatalf("mensaje = %q, want mención de WITHDRAWALS_REQUIRE_BMP", msg)
	}
}

// Y con el candado puesto NO hay ruido: un Warn en cada arranque normal
// entrenaría al equipo a ignorarlo justo cuando importa.
func TestSetRequireBMP_True_Silent(t *testing.T) {
	var buf bytes.Buffer
	s := NewStore(nil)
	s.SetLogger(zerolog.New(&buf))

	s.SetRequireBMP(true)

	if buf.Len() != 0 {
		t.Fatalf("SetRequireBMP(true) logueó %q, want silencio", buf.String())
	}
}
