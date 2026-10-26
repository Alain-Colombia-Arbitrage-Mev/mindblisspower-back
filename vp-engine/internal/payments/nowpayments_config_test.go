package payments

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestNOWPaymentsConfigCanonicalAndLegacyKeys(t *testing.T) {
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
