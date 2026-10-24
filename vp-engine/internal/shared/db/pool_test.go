package db

import (
	"strings"
	"testing"
	"time"
)

func TestPoolConfigInlineCAFailsClosed(t *testing.T) {
	for _, mode := range []string{"disable", "require", "prefer", "verify-ca"} {
		_, err := poolConfig("postgres://app:secret@db/test?sslmode="+mode, 5, time.Minute, "synthetic-ca")
		if err == nil || !strings.Contains(err.Error(), "verify-full") {
			t.Fatalf("mode %s must require verified TLS: %v", mode, err)
		}
	}
	if _, err := poolConfig("postgres://app:secret@db/test?sslmode=verify-full", 5, time.Minute, "not-a-certificate"); err == nil {
		t.Fatal("invalid CA must not fall back to system trust/plaintext")
	}
}

func TestPoolConfigPreservesDefaultsWithoutInlineCA(t *testing.T) {
	cfg, err := poolConfig("postgres://app:secret@db/test?sslmode=disable", 5, time.Minute, "")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MaxConns != 5 || cfg.ConnConfig.RuntimeParams["timezone"] != "UTC" {
		t.Fatal("pool budget/timezone changed")
	}
}
