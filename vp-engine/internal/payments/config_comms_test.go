package payments

import "testing"

func TestLoadConfigCommsDefaults(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("STRIPE_SECRET_KEY", "sk_test_x")
	t.Setenv("STRIPE_WEBHOOK_SECRET", "whsec_x")
	t.Setenv("PAYMENTS_SERVICE_TOKEN", "tok")
	t.Setenv("COMMS_ENABLED", "true")
	t.Setenv("COMMS_UNSUBSCRIBE_SECRET", "abc")
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if !cfg.CommsEnabled || cfg.CommsSendRatePerSec != 10 || cfg.CommsBatchSize != 100 || cfg.CommsSESConfigSet != "entregas" ||
		cfg.CommsMaxAudience != 150000 || cfg.CommsMaxPerDay != 3 || cfg.CommsMaxTestSends != 5 ||
		cfg.CommsReplyTo != "soporte@mindblisspower.com" || cfg.CommsUnsubscribeBaseURL != "https://app.mindblisspower.com/baja" ||
		cfg.CommsUnsubscribeOneClickURL != "" {
		t.Fatalf("comms defaults wrong: %+v", cfg)
	}
	t.Setenv("COMMS_UNSUBSCRIBE_SECRET", "")
	if _, err := LoadConfig(); err == nil {
		t.Fatal("COMMS_ENABLED sin COMMS_UNSUBSCRIBE_SECRET debe fallar")
	}
}
