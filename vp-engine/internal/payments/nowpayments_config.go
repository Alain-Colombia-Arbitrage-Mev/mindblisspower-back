package payments

import (
	"fmt"
	"os"
	"strings"

	"github.com/vicionpower/vp-engine/internal/nowpayments"
)

// NOWPaymentsSettings is private runtime configuration, never a browser payload.
// Loading credentials does not create invoices or enable wallet/MLM settlement.
type NOWPaymentsSettings struct {
	APIKey      string `json:"-"`
	IPNSecret   string `json:"-"`
	PublicKey   string `json:"-"`
	Environment string `json:"-"`
}

// String deliberately does not reveal fields if a configuration is formatted.
func (s NOWPaymentsSettings) String() string   { return "NOWPaymentsSettings(redacted)" }
func (s NOWPaymentsSettings) GoString() string { return s.String() }

func loadNOWPaymentsSettings(readOnly bool) (NOWPaymentsSettings, error) {
	// Production's restricted readers must never retain provider credentials,
	// even when a developer accidentally adds them to the process environment.
	if readOnly {
		return NOWPaymentsSettings{}, nil
	}
	settings := NOWPaymentsSettings{
		APIKey:      firstEnv("NOWPAYMENTS_API_KEY", "NOWPAYMENTS:API_KEY"),
		IPNSecret:   strings.TrimSpace(os.Getenv("NOWPAYMENTS_IPN_SECRET")),
		PublicKey:   strings.TrimSpace(os.Getenv("NOWPAYMENTS_PUBLIC_KEY")),
		Environment: env("NOWPAYMENTS_ENV", "production"),
	}
	if settings.Environment != "production" && settings.Environment != "sandbox" {
		return NOWPaymentsSettings{}, fmt.Errorf("NOWPAYMENTS_ENV must be production or sandbox")
	}
	return settings, nil
}

func (s NOWPaymentsSettings) ClientConfig() nowpayments.Config {
	// PublicKey is not an IPN authentication secret and is deliberately unused
	// by hosted invoices. The merchant API key stays on the server.
	return nowpayments.Config{APIKey: s.APIKey, IPNSecret: s.IPNSecret, Environment: s.Environment}
}
