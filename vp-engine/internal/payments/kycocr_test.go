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

func TestEvaluateDoc(t *testing.T) {
	future := time.Now().UTC().AddDate(2, 0, 0).Format("2006-01-02")
	past := time.Now().UTC().AddDate(-1, 0, 0).Format("2006-01-02")

	// ilegible → rechazado
	if d, _, _ := evaluateDoc("passport", DocOCR{IsReadable: false}, "Ana", "Perez"); d != "rejected" {
		t.Errorf("unreadable should reject, got %s", d)
	}
	// no es pasaporte
	if d, _, _ := evaluateDoc("passport", DocOCR{IsReadable: true, DocumentKind: "national_id"}, "Ana", "Perez"); d != "rejected" {
		t.Errorf("non-passport should reject, got %s", d)
	}
	// pasaporte vencido
	if d, _, _ := evaluateDoc("passport", DocOCR{IsReadable: true, DocumentKind: "passport", ExpiryDate: past, GivenNames: "ANA", Surname: "PEREZ"}, "Ana", "Perez"); d != "rejected" {
		t.Errorf("expired should reject, got %s", d)
	}
	// datos no coinciden
	if d, _, _ := evaluateDoc("passport", DocOCR{IsReadable: true, DocumentKind: "passport", ExpiryDate: future, GivenNames: "JUAN", Surname: "LOPEZ"}, "Ana", "Perez"); d != "rejected" {
		t.Errorf("name mismatch should reject, got %s", d)
	}
	// pasaporte OK → approved
	if d, _, exp := evaluateDoc("passport", DocOCR{IsReadable: true, DocumentKind: "passport", ExpiryDate: future, GivenNames: "ANA MARIA", Surname: "PEREZ GOMEZ"}, "Ana", "Perez"); d != "approved" || exp == nil {
		t.Errorf("valid passport should approve, got %s exp=%v", d, exp)
	}

	// cédula: tipo correcto + nombre coincide → approved
	if d, _, _ := evaluateDoc("identity_card", DocOCR{IsReadable: true, DocumentKind: "national_id", GivenNames: "ANA", Surname: "PEREZ"}, "Ana", "Perez"); d != "approved" {
		t.Errorf("national_id with matching name should approve, got %s", d)
	}
	// cédula sin nombre en el perfil → rechazado (fail-closed, no se puede verificar)
	if d, _, _ := evaluateDoc("identity_card", DocOCR{IsReadable: true, DocumentKind: "national_id"}, "", ""); d != "rejected" {
		t.Errorf("id with empty profile name should reject (fail-closed), got %s", d)
	}
	// default: tipo desconocido → rechazado (fail-closed)
	if d, _, _ := evaluateDoc("unknown_type", DocOCR{IsReadable: true, DocumentKind: "national_id"}, "Ana", "Perez"); d != "rejected" {
		t.Errorf("unknown doc type should reject (fail-closed), got %s", d)
	}
	// cédula: tipo incorrecto → rechazado
	if d, _, _ := evaluateDoc("identity_card", DocOCR{IsReadable: true, DocumentKind: "address_proof"}, "", ""); d != "rejected" {
		t.Errorf("wrong kind for id should reject, got %s", d)
	}
	// comprobante con dirección → approved
	if d, _, _ := evaluateDoc("proof_address", DocOCR{IsReadable: true, DocumentKind: "address_proof", HasAddress: true}, "", ""); d != "approved" {
		t.Errorf("address proof should approve, got %s", d)
	}
	// comprobante sin dirección → rechazado
	if d, _, _ := evaluateDoc("proof_address", DocOCR{IsReadable: true, DocumentKind: "address_proof", HasAddress: false}, "", ""); d != "rejected" {
		t.Errorf("no-address proof should reject, got %s", d)
	}
	// selfie sosteniendo doc → approved
	if d, _, _ := evaluateDoc("selfie", DocOCR{IsReadable: true, PersonHoldingDoc: true}, "", ""); d != "approved" {
		t.Errorf("selfie holding doc should approve, got %s", d)
	}
	// selfie sin doc → rechazado
	if d, _, _ := evaluateDoc("selfie", DocOCR{IsReadable: true, PersonHoldingDoc: false}, "", ""); d != "rejected" {
		t.Errorf("selfie without doc should reject, got %s", d)
	}
}
