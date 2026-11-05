package payments

import (
	"fmt"
	"os"
	"strings"

	"github.com/vicionpower/vp-engine/internal/nowpayments"
)

// Separate credentials/pool: capture never upgrades the service's reader login.
type NOWPaymentsCaptureSettings struct {
	Enabled     bool               `json:"-"`
	DatabaseURL string             `json:"-"`
	Client      nowpayments.Config `json:"-"`
}

func (NOWPaymentsCaptureSettings) String() string     { return "NOWPaymentsCaptureSettings(redacted)" }
func (s NOWPaymentsCaptureSettings) GoString() string { return s.String() }

func loadNOWPaymentsCaptureSettings(readerDSN string) (NOWPaymentsCaptureSettings, error) {
	if os.Getenv("NOWPAYMENTS_WEBHOOK_CAPTURE_ENABLED") != "true" {
		return NOWPaymentsCaptureSettings{}, nil
	}
	s := NOWPaymentsCaptureSettings{Enabled: true,
		DatabaseURL: strings.TrimSpace(os.Getenv("NOWPAYMENTS_WEBHOOK_DATABASE_URL")),
		Client: nowpayments.Config{APIKey: firstEnv("NOWPAYMENTS_API_KEY", "NOWPAYMENTS:API_KEY"),
			IPNSecret: strings.TrimSpace(os.Getenv("NOWPAYMENTS_IPN_SECRET")), Environment: os.Getenv("NOWPAYMENTS_ENV")}}
	if s.DatabaseURL == "" || s.DatabaseURL == strings.TrimSpace(readerDSN) || s.Client.APIKey == "" || s.Client.IPNSecret == "" {
		return NOWPaymentsCaptureSettings{}, fmt.Errorf("NOWPayments capture requires a separate writer DSN and API/IPN credentials")
	}
	runtime := os.Getenv("ENV")
	if (s.Client.Environment != "production" || runtime != "production") &&
		(s.Client.Environment != "sandbox" || (runtime != "development" && runtime != "test")) {
		return NOWPaymentsCaptureSettings{}, fmt.Errorf("NOWPayments capture requires explicit matching environments")
	}
	return s, nil
}
