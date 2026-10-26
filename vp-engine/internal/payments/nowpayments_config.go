package payments

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"

	"github.com/vicionpower/vp-engine/internal/nowpayments"
)

// NOWPaymentsSettings is private runtime configuration, never a browser payload.
// Loading credentials does not create invoices or enable wallet/MLM settlement.
type NOWPaymentsSettings struct {
	APIKey             string `json:"-"`
	IPNSecret          string `json:"-"`
	PublicKey          string `json:"-"`
	Environment        string `json:"-"`
	MembershipsEnabled bool   `json:"-"`
	CallbackURL        string `json:"-"`
	SuccessURL         string `json:"-"`
	CancelURL          string `json:"-"`
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
	enabled := strings.TrimSpace(os.Getenv("NOWPAYMENTS_MEMBERSHIPS_ENABLED"))
	if enabled != "" && enabled != "false" && enabled != "true" {
		return NOWPaymentsSettings{}, fmt.Errorf("NOWPAYMENTS_MEMBERSHIPS_ENABLED must be true or false")
	}
	settings := NOWPaymentsSettings{
		APIKey:             firstEnv("NOWPAYMENTS_API_KEY", "NOWPAYMENTS:API_KEY"),
		IPNSecret:          strings.TrimSpace(os.Getenv("NOWPAYMENTS_IPN_SECRET")),
		PublicKey:          strings.TrimSpace(os.Getenv("NOWPAYMENTS_PUBLIC_KEY")),
		Environment:        env("NOWPAYMENTS_ENV", "production"),
		MembershipsEnabled: enabled == "true",
	}
	if settings.Environment != "production" && settings.Environment != "sandbox" {
		return NOWPaymentsSettings{}, fmt.Errorf("NOWPAYMENTS_ENV must be production or sandbox")
	}
	if settings.MembershipsEnabled {
		runtimeEnvironment := strings.TrimSpace(os.Getenv("ENV"))
		if (settings.Environment == "production" && runtimeEnvironment != "production") ||
			(settings.Environment == "sandbox" && runtimeEnvironment != "development" && runtimeEnvironment != "test") {
			return NOWPaymentsSettings{}, fmt.Errorf("NOWPayments memberships require an explicit matching runtime environment")
		}
		if settings.APIKey == "" || settings.IPNSecret == "" {
			return NOWPaymentsSettings{}, fmt.Errorf("NOWPayments memberships require API and IPN credentials")
		}
		settings.CallbackURL = strings.TrimSpace(os.Getenv("NOWPAYMENTS_IPN_URL"))
		if !validNOWPaymentsCallbackURL(settings.CallbackURL, settings.Environment) {
			return NOWPaymentsSettings{}, fmt.Errorf("NOWPAYMENTS_IPN_URL must be a trusted HTTPS membership webhook URL")
		}
		origin := strings.TrimSuffix(settings.CallbackURL, "/api/webhooks/nowpayments")
		settings.SuccessURL = origin + "/dashboard/packages?payment_provider=nowpayments&status=review"
		settings.CancelURL = origin + "/dashboard/packages?payment_provider=nowpayments&status=cancelled"
	}
	return settings, nil
}

func validNOWPaymentsCallbackURL(raw, environment string) bool {
	if raw == "" || len(raw) > 2048 || strings.Contains(raw, "#") {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Opaque != "" || u.User != nil ||
		u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawFragment != "" ||
		u.Path != "/api/webhooks/nowpayments" || u.RawPath != "" {
		return false
	}
	// An exact authority check also rejects ports, trailing dots and aliases.
	if u.Host == "mindblisspower.com" {
		return environment == "production"
	}
	// A sandbox merchant may use an explicitly configured public test hostname,
	// but never target loopback/private hosts or the production portal.
	host := u.Hostname()
	if environment != "sandbox" || host == "" || u.Host != host || strings.HasSuffix(host, ".") ||
		host != strings.ToLower(host) || !strings.Contains(host, ".") ||
		strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") ||
		strings.HasSuffix(host, ".internal") || net.ParseIP(host) != nil {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if label == "" || len(label) > 63 || strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return false
		}
		for _, r := range label {
			if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' {
				return false
			}
		}
	}
	return len(host) <= 253
}

func (s NOWPaymentsSettings) ClientConfig() nowpayments.Config {
	// PublicKey is not an IPN authentication secret and is deliberately unused
	// by hosted invoices. The merchant API key stays on the server.
	return nowpayments.Config{APIKey: s.APIKey, IPNSecret: s.IPNSecret, Environment: s.Environment}
}
