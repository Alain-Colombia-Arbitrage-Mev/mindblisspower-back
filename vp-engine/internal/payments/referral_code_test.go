package payments

import (
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

// El código canónico MP{affiliateID} debe parsearse para el fallback de
// ResolveSponsorByCode; los formatos legacy (@handle) o inválidos no.
func TestMPCodeRegex(t *testing.T) {
	cases := map[string]string{
		"MP1":      "1",
		"MP123456": "123456",
		"mp42":     "42",
		"@Adri07":  "", // handle legacy → no match (se resuelve por invitation_link)
		"MP0XZ9K":  "", // base36 viejo → no match (no es decimal)
		"MP":       "", // sin número
		"MP12A":    "", // no del todo numérico
		"":         "", // vacío
		"garbage":  "",
	}
	for in, want := range cases {
		got := ""
		if m := mpCodeRe.FindStringSubmatch(in); m != nil {
			got = m[1]
		}
		if got != want {
			t.Errorf("mpCodeRe(%q) captured %q, want %q", in, got, want)
		}
	}
}

func TestIsUndefinedColumn(t *testing.T) {
	err := fmt.Errorf("wrapped: %w", &pgconn.PgError{Code: "42703"})
	if !isUndefinedColumn(err) {
		t.Fatal("isUndefinedColumn returned false for SQLSTATE 42703")
	}

	other := fmt.Errorf("wrapped: %w", &pgconn.PgError{Code: "23505"})
	if isUndefinedColumn(other) {
		t.Fatal("isUndefinedColumn returned true for non-undefined-column error")
	}
}
