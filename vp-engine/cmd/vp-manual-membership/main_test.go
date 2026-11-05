package main

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"github.com/vicionpower/vp-engine/internal/manualmembership"
)

func instruction(t *testing.T) string {
	t.Helper()
	raw, err := json.Marshal(manualmembership.Input{ExpectedDatabase: "synthetic", ID: "00000000-0000-4000-8000-000000000001",
		OperationKey: "manual-membership:synthetic-owner-01", PersonID: 1, AffiliateID: 2, PersonPublicID: "00000000-0000-4000-8000-000000000002", PackageID: 3,
		AuthorizationDigest: strings.Repeat("a", 64), ExpectedAffiliateSHA256: strings.Repeat("b", 64), Authority: "owner_instruction", ActorReason: "Synthetic reviewed instruction"})
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestOperatorInstructionStrictBoundedJSON(t *testing.T) {
	valid := instruction(t)
	if _, err := readInstruction(strings.NewReader(valid)); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{valid + "{}", valid + "\nnull", strings.Repeat(" ", 65537), `null`, strings.Replace(valid, `"id":`, `"unknown":1,"id":`, 1), strings.Replace(valid, `"id":`, `"id":"00000000-0000-4000-8000-000000000003","id":`, 1)} {
		if _, err := readInstruction(strings.NewReader(invalid)); err == nil {
			t.Fatal("ambiguous/oversized instruction accepted")
		}
	}
}

func TestOperatorRequiresExactVerifiedTLSAndExpectedDatabase(t *testing.T) {
	valid := "postgres://operator:synthetic@database.example.test/synthetic?sslmode=verify-full"
	if cfg, err := operatorConfig(valid, "", "synthetic"); err != nil || cfg.ConnConfig.Fallbacks != nil || cfg.MaxConns != 1 || cfg.ConnConfig.TLSConfig.InsecureSkipVerify {
		t.Fatal("valid strict config rejected")
	}
	for _, invalid := range []string{strings.Replace(valid, "verify-full", "require", 1), strings.Replace(valid, "verify-full", "disable", 1), valid + "&sslmode=disable", valid + "&options=-c%20role%3Dother", strings.Replace(valid, "/synthetic?", "/other?", 1)} {
		if _, err := operatorConfig(invalid, "", "synthetic"); err == nil {
			t.Fatal("unsafe/mismatched database config accepted")
		}
	}
	if _, err := operatorConfig(valid, "invalid CA", "synthetic"); err == nil {
		t.Fatal("invalid CA accepted")
	}
}

func TestOperatorRequiresExplicitModeAndRootBeforeReadingCredentials(t *testing.T) {
	for _, args := range [][]string{nil, {"--preflight"}, {"--apply-authorized"},
		{"--preflight", "--apply-authorized", "--root-id=1"}, {"--preflight", "--root-id=0"},
		{"--apply-authorized", "--root-id=1", "unexpected-path"}} {
		reads := 0
		err := run(context.Background(), args, strings.NewReader(instruction(t)), io.Discard, func(string) string { reads++; return "" })
		if err == nil || reads != 0 {
			t.Fatal("implicit/ambiguous activation mode reached credentials")
		}
	}
}
