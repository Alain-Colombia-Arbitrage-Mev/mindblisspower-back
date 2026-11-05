package payments

import (
	"testing"

	"github.com/rs/zerolog"
)

// TestNewCommsSenderDerivesOneClickBase: unit test puro (sin Docker/DB) que verifica
// cómo NewCommsSender resuelve CommsSenderConfig.UnsubscribeOneClickBase.
func TestNewCommsSenderDerivesOneClickBase(t *testing.T) {
	cases := []struct {
		name     string
		cfg      CommsSenderConfig
		wantBase string
	}{
		{
			name:     "deriva /baja -> /api/comms/unsubscribe",
			cfg:      CommsSenderConfig{UnsubscribeBase: "https://app.test/baja"},
			wantBase: "https://app.test/api/comms/unsubscribe",
		},
		{
			name: "respeta un UnsubscribeOneClickBase explícito",
			cfg: CommsSenderConfig{
				UnsubscribeBase:         "https://app.test/baja",
				UnsubscribeOneClickBase: "https://x/y",
			},
			wantBase: "https://x/y",
		},
		{
			name:     "base sin /baja: no se puede derivar, queda igual a UnsubscribeBase",
			cfg:      CommsSenderConfig{UnsubscribeBase: "https://app.test/unsubscribe"},
			wantBase: "https://app.test/unsubscribe",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cs := NewCommsSender(nil, nil, tc.cfg, zerolog.Nop())
			if cs.cfg.UnsubscribeOneClickBase != tc.wantBase {
				t.Fatalf("UnsubscribeOneClickBase = %q, want %q", cs.cfg.UnsubscribeOneClickBase, tc.wantBase)
			}
		})
	}
}
