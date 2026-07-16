package payments

import (
	"testing"
	"time"
)

func TestNormalizeName(t *testing.T) {
	cases := map[string]string{
		"José  Pérez": "jose perez",
		"MARÍA":       "maria",
		"Núñez-Gómez": "nunezgomez",
		"  Ana  ":     "ana",
	}
	for in, want := range cases {
		if got := normalizeName(in); got != want {
			t.Errorf("normalizeName(%q)=%q want %q", in, got, want)
		}
	}
}

func TestNameMatches(t *testing.T) {
	tests := []struct {
		first, last, given, surname string
		want                        bool
	}{
		{"José", "Pérez", "JOSE MANUEL", "PEREZ GOMEZ", true}, // acentos + segundo nombre
		{"Ana", "Núñez", "ANA", "NUNEZ", true},                // ñ
		{"Carlos", "Ruiz", "JUAN", "RUIZ", false},             // nombre no coincide
		{"Carlos", "Ruiz", "CARLOS", "LOPEZ", false},          // apellido no coincide
		{"María", "García", "MARIA FERNANDA", "GARCIA", true}, // primer nombre coincide
		{"", "Perez", "cualquiera", "PEREZ", true},            // sin primer nombre → solo apellido
	}
	for _, tc := range tests {
		if got := nameMatches(tc.first, tc.last, tc.given, tc.surname); got != tc.want {
			t.Errorf("nameMatches(%q,%q,%q,%q)=%v want %v", tc.first, tc.last, tc.given, tc.surname, got, tc.want)
		}
	}
}

func TestParseOCRDate(t *testing.T) {
	if _, ok := parseOCRDate(""); ok {
		t.Error("empty date should not parse")
	}
	if _, ok := parseOCRDate("garbage"); ok {
		t.Error("garbage should not parse")
	}
	if tm, ok := parseOCRDate("2030-12-31"); !ok || tm.Year() != 2030 {
		t.Errorf("iso date parse failed: %v %v", tm, ok)
	}
	if _, ok := parseOCRDate("31/12/2030"); !ok {
		t.Error("dd/mm/yyyy should parse")
	}
}

func TestEvaluatePassport(t *testing.T) {
	future := time.Now().UTC().AddDate(2, 0, 0).Format("2006-01-02")
	past := time.Now().UTC().AddDate(-1, 0, 0).Format("2006-01-02")

	// no es pasaporte
	if d, _, _ := evaluatePassport(PassportOCR{IsPassport: false}, "Ana", "Perez"); d != "rejected" {
		t.Errorf("non-passport should reject, got %s", d)
	}
	// vencido
	if d, _, _ := evaluatePassport(PassportOCR{IsPassport: true, ExpiryDate: past, GivenNames: "ANA", Surname: "PEREZ"}, "Ana", "Perez"); d != "rejected" {
		t.Errorf("expired should reject, got %s", d)
	}
	// vigencia ilegible → error (manual)
	if d, _, _ := evaluatePassport(PassportOCR{IsPassport: true, ExpiryDate: "", GivenNames: "ANA", Surname: "PEREZ"}, "Ana", "Perez"); d != "error" {
		t.Errorf("unreadable expiry should be error, got %s", d)
	}
	// datos no coinciden
	if d, _, _ := evaluatePassport(PassportOCR{IsPassport: true, ExpiryDate: future, GivenNames: "JUAN", Surname: "LOPEZ"}, "Ana", "Perez"); d != "rejected" {
		t.Errorf("name mismatch should reject, got %s", d)
	}
	// todo OK → approved
	if d, _, exp := evaluatePassport(PassportOCR{IsPassport: true, ExpiryDate: future, GivenNames: "ANA MARIA", Surname: "PEREZ GOMEZ"}, "Ana", "Perez"); d != "approved" || exp == nil {
		t.Errorf("valid passport should approve, got %s exp=%v", d, exp)
	}
}
