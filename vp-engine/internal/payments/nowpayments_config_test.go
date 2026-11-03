package payments

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestNOWPaymentsConfigCanonicalAndLegacyKeys(t *testing.T) {
	t.Setenv("NOWPAYMENTS_MEMBERSHIPS_ENABLED", "")
	t.Setenv("NOWPAYMENTS_API_KEY", "synthetic-canonical")
	t.Setenv("NOWPAYMENTS:API_KEY", "synthetic-legacy")
	t.Setenv("NOWPAYMENTS_PUBLIC_KEY", "synthetic-public")
	t.Setenv("NOWPAYMENTS_IPN_SECRET", "")
	t.Setenv("NOWPAYMENTS_ENV", "")
	settings, err := loadNOWPaymentsSettings(false)
	if err != nil || settings.APIKey != "synthetic-canonical" || settings.Environment != "production" {
		t.Fatal("canonical key and explicit production default required")
	}
	if settings.ClientConfig().IPNSecret != "" {
		t.Fatal("public key must never substitute the missing IPN secret")
	}
	t.Setenv("NOWPAYMENTS_API_KEY", "")
	settings, err = loadNOWPaymentsSettings(false)
	if err != nil || settings.APIKey != "synthetic-legacy" {
		t.Fatal("legacy local alias must be accepted")
	}
}

func TestNOWPaymentsConfigReadOnlyDiscardsAllProviderMaterial(t *testing.T) {
	readOnlyConfigEnv(t)
	for _, name := range []string{"NOWPAYMENTS_API_KEY", "NOWPAYMENTS:API_KEY", "NOWPAYMENTS_IPN_SECRET", "NOWPAYMENTS_PUBLIC_KEY"} {
		t.Setenv(name, "synthetic-must-not-retain")
	}
	t.Setenv("NOWPAYMENTS_ENV", "invalid")
	t.Setenv("NOWPAYMENTS_MEMBERSHIPS_ENABLED", "invalid")
	t.Setenv("NOWPAYMENTS_IPN_URL", "http://invalid.invalid/private")
	settings, err := loadNOWPaymentsSettings(true)
	if err != nil || settings != (NOWPaymentsSettings{}) {
		t.Fatal("read-only must discard all provider material")
	}
	config, err := LoadConfig()
	if err != nil || config.NOWPayments != (NOWPaymentsSettings{}) {
		t.Fatal("read-only service startup must not retain NOWPayments credentials")
	}
}

func TestNOWPaymentsConfigDoesNotLeakOrInferEnvironment(t *testing.T) {
	t.Setenv("NOWPAYMENTS_MEMBERSHIPS_ENABLED", "")
	t.Setenv("NOWPAYMENTS_API_KEY", "synthetic-sensitive-merchant-key")
	t.Setenv("NOWPAYMENTS_IPN_SECRET", "synthetic-sensitive-ipn-key")
	t.Setenv("NOWPAYMENTS_PUBLIC_KEY", "synthetic-public-key")
	t.Setenv("NOWPAYMENTS_ENV", "sandbox")
	settings, err := loadNOWPaymentsSettings(false)
	if err != nil || settings.ClientConfig().Environment != "sandbox" {
		t.Fatal("sandbox must be explicit")
	}
	encoded, err := json.Marshal(settings)
	if err != nil || string(encoded) != "{}" || strings.Contains(fmt.Sprint(settings), "sensitive") || strings.Contains(fmt.Sprintf("%#v", settings), "sensitive") {
		t.Fatal("configuration must not expose provider material")
	}
	t.Setenv("NOWPAYMENTS_ENV", "test")
	if _, err := loadNOWPaymentsSettings(false); err == nil {
		t.Fatal("ambiguous provider environment must fail closed")
	}
}

func configureSyntheticNOWMemberships(t *testing.T) {
	t.Helper()
	t.Setenv("NOWPAYMENTS_MEMBERSHIPS_ENABLED", "true")
	t.Setenv("NOWPAYMENTS_API_KEY", "synthetic-private-merchant-key")
	t.Setenv("NOWPAYMENTS:API_KEY", "")
	t.Setenv("NOWPAYMENTS_IPN_SECRET", "synthetic-private-ipn-secret")
	t.Setenv("NOWPAYMENTS_ENV", "production")
	t.Setenv("NOWPAYMENTS_IPN_URL", "https://mindblisspower.com/api/webhooks/nowpayments")
	t.Setenv("ENV", "production")
}

func TestNOWPaymentsMembershipsOptInAndTrustedReturnURLs(t *testing.T) {
	configureSyntheticNOWMemberships(t)
	settings, err := loadNOWPaymentsSettings(false)
	if err != nil || !settings.MembershipsEnabled {
		t.Fatal("explicit complete production configuration must enable membership routing")
	}
	if settings.SuccessURL != "https://mindblisspower.com/dashboard/packages?payment_provider=nowpayments&status=review" ||
		settings.CancelURL != "https://mindblisspower.com/dashboard/packages?payment_provider=nowpayments&status=cancelled" {
		t.Fatal("membership return URLs must describe review, never successful activation")
	}
	encoded, err := json.Marshal(settings)
	if err != nil || string(encoded) != "{}" || strings.Contains(fmt.Sprintf("%#v", settings), "synthetic") {
		t.Fatal("enabled settings must remain private")
	}
	for _, flag := range []string{"", "false"} {
		t.Setenv("NOWPAYMENTS_MEMBERSHIPS_ENABLED", flag)
		t.Setenv("NOWPAYMENTS_API_KEY", "")
		t.Setenv("NOWPAYMENTS_IPN_SECRET", "")
		t.Setenv("NOWPAYMENTS_IPN_URL", "not a URL")
		settings, err = loadNOWPaymentsSettings(false)
		if err != nil || settings.MembershipsEnabled || settings.CallbackURL != "" || settings.SuccessURL != "" || settings.CancelURL != "" {
			t.Fatal("disabled/default routing must remain disabled without webhook credentials")
		}
	}
}

func TestNOWPaymentsMembershipsConfigFailsClosed(t *testing.T) {
	tests := []struct{ name, variable, value string }{
		{"invalid flag", "NOWPAYMENTS_MEMBERSHIPS_ENABLED", "1"},
		{"ambiguous flag", "NOWPAYMENTS_MEMBERSHIPS_ENABLED", "TRUE"},
		{"missing API key", "NOWPAYMENTS_API_KEY", ""},
		{"missing IPN secret", "NOWPAYMENTS_IPN_SECRET", ""},
		{"missing callback", "NOWPAYMENTS_IPN_URL", ""},
		{"implicit runtime", "ENV", ""},
		{"live merchant development runtime", "ENV", "development"},
		{"HTTP callback", "NOWPAYMENTS_IPN_URL", "http://mindblisspower.com/api/webhooks/nowpayments"},
		{"foreign callback", "NOWPAYMENTS_IPN_URL", "https://attacker.example/api/webhooks/nowpayments"},
		{"callback alias", "NOWPAYMENTS_IPN_URL", "https://app.mindblisspower.com/api/webhooks/nowpayments"},
		{"wrong path", "NOWPAYMENTS_IPN_URL", "https://mindblisspower.com/api/payments/checkout"},
		{"escaped path", "NOWPAYMENTS_IPN_URL", "https://mindblisspower.com/api/webhooks/%6eowpayments"},
		{"trailing path slash", "NOWPAYMENTS_IPN_URL", "https://mindblisspower.com/api/webhooks/nowpayments/"},
		{"callback userinfo", "NOWPAYMENTS_IPN_URL", "https://user@mindblisspower.com/api/webhooks/nowpayments"},
		{"callback query", "NOWPAYMENTS_IPN_URL", "https://mindblisspower.com/api/webhooks/nowpayments?token=synthetic"},
		{"empty callback query", "NOWPAYMENTS_IPN_URL", "https://mindblisspower.com/api/webhooks/nowpayments?"},
		{"callback fragment", "NOWPAYMENTS_IPN_URL", "https://mindblisspower.com/api/webhooks/nowpayments#synthetic"},
		{"empty callback fragment", "NOWPAYMENTS_IPN_URL", "https://mindblisspower.com/api/webhooks/nowpayments#"},
		{"callback port", "NOWPAYMENTS_IPN_URL", "https://mindblisspower.com:443/api/webhooks/nowpayments"},
		{"callback trailing dot", "NOWPAYMENTS_IPN_URL", "https://mindblisspower.com./api/webhooks/nowpayments"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			configureSyntheticNOWMemberships(t)
			t.Setenv(tt.variable, tt.value)
			settings, err := loadNOWPaymentsSettings(false)
			if err == nil || settings != (NOWPaymentsSettings{}) {
				t.Fatal("invalid opt-in configuration must fail without retaining provider settings")
			}
			if strings.Contains(err.Error(), "synthetic") {
				t.Fatal("configuration error must not echo environment values")
			}
		})
	}
}

func TestNOWPaymentsMembershipsSandboxRequiresSeparatePublicHost(t *testing.T) {
	configureSyntheticNOWMemberships(t)
	t.Setenv("NOWPAYMENTS_ENV", "sandbox")
	t.Setenv("ENV", "test")
	t.Setenv("NOWPAYMENTS_IPN_URL", "https://payments-sandbox.example.com/api/webhooks/nowpayments")
	settings, err := loadNOWPaymentsSettings(false)
	if err != nil || settings.SuccessURL != "https://payments-sandbox.example.com/dashboard/packages?payment_provider=nowpayments&status=review" {
		t.Fatal("explicit sandbox test configuration must retain its separate public origin")
	}
	for _, host := range []string{"mindblisspower.com", "localhost", "example.localhost", "127.0.0.1", "10.0.0.1", "192.168.0.1", "[::1]", "test.local", "test.internal", "test.example:443", "test.example.", "-invalid.example", "invalid-.example", "bad_host.example"} {
		t.Run(host, func(t *testing.T) {
			t.Setenv("NOWPAYMENTS_IPN_URL", "https://"+host+"/api/webhooks/nowpayments")
			if _, err := loadNOWPaymentsSettings(false); err == nil {
				t.Fatal("sandbox callback must be separate and public")
			}
		})
	}
	t.Setenv("NOWPAYMENTS_IPN_URL", "https://payments-sandbox.example.com/api/webhooks/nowpayments")
	t.Setenv("ENV", "production")
	if _, err := loadNOWPaymentsSettings(false); err == nil {
		t.Fatal("production runtime must not accidentally initialize sandbox invoices")
	}
}
