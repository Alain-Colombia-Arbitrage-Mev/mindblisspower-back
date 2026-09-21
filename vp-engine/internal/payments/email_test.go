package payments

import (
	"strings"
	"testing"
)

func TestLoadSMTPEmailConfig(t *testing.T) {
	t.Setenv("SMTP_HOST", "smtp.example.com")
	t.Setenv("SMTP_PORT", "465")
	t.Setenv("SMTP_USERNAME", "support@example.com")
	t.Setenv("SMTP_PASSWORD", "secret")
	t.Setenv("SMTP_FROM", "BMP Support <support@example.com>")

	cfg, err := loadSMTPEmailConfig()
	if err != nil {
		t.Fatalf("loadSMTPEmailConfig: %v", err)
	}
	if cfg.Host != "smtp.example.com" || cfg.Port != 465 {
		t.Fatalf("smtp endpoint = %s:%d", cfg.Host, cfg.Port)
	}
	if cfg.TLSMode != "tls" {
		t.Fatalf("TLSMode = %q, want tls", cfg.TLSMode)
	}
	if cfg.Username != "support@example.com" || cfg.Password != "secret" {
		t.Fatalf("smtp auth not loaded")
	}
	if cfg.From != "BMP Support <support@example.com>" {
		t.Fatalf("From = %q", cfg.From)
	}
}

func TestBuildPlainSMTPMessageDoesNotExposeRecipients(t *testing.T) {
	msg := string(buildPlainSMTPMessage("BMP Support <support@example.com>", "Ticket creado", "Linea 1\nLinea 2"))
	if !strings.Contains(msg, "To: undisclosed-recipients:;") {
		t.Fatalf("message does not use undisclosed recipients: %q", msg)
	}
	if strings.Contains(strings.ToLower(msg), "bcc:") {
		t.Fatalf("message should not include a Bcc header: %q", msg)
	}
	if !strings.Contains(msg, "Linea 1\r\nLinea 2") {
		t.Fatalf("message body did not normalize CRLF: %q", msg)
	}
}
