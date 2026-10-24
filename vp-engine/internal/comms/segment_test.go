package comms

import (
	"strings"
	"testing"
)

func TestParseSegmentDefaults(t *testing.T) {
	s, err := ParseSegment([]byte(`{}`))
	if err != nil {
		t.Fatalf("ParseSegment: %v", err)
	}
	if len(s.Status) != 1 || s.Status[0] != "active" {
		t.Fatalf("Status default = %v, want [active]", s.Status)
	}
	if s.Membership != "any" {
		t.Fatalf("Membership default = %q, want any", s.Membership)
	}
}

func TestParseSegmentRejectsBadValues(t *testing.T) {
	for _, raw := range []string{
		`{"status":["hacker"]}`,
		`{"membership":"maybe"}`,
		`{"emails":["not-an-email"]}`,
		`[]`,
	} {
		if _, err := ParseSegment([]byte(raw)); err == nil {
			t.Fatalf("expected error for %s", raw)
		}
	}
}

func TestParseSegmentNormalizesEmails(t *testing.T) {
	s, err := ParseSegment([]byte(`{"emails":[" A@X.com ", "b@y.com", "a@x.com"]}`))
	if err != nil {
		t.Fatalf("ParseSegment: %v", err)
	}
	if len(s.Emails) != 2 || s.Emails[0] != "a@x.com" || s.Emails[1] != "b@y.com" {
		t.Fatalf("Emails = %v, want [a@x.com b@y.com]", s.Emails)
	}
}

func TestAudienceQueryAlwaysExcludesBlacklistUnsubscribeAndAdmins(t *testing.T) {
	sql, args := AudienceQuery(Segment{Status: []string{"active"}, Membership: "any"})
	// I12: el filtro debe comparar contra el enum nativo (índice utilizable), no
	// castear la columna a text en cada fila.
	for _, must := range []string{"p.status = ANY($1::text[]::mlm.person_status[])", "NOT p.blacklisted", "p.is_admin = false", "comms.unsubscribe", "comms.suppressed_email", "ORDER BY p.id"} {
		if !strings.Contains(sql, must) {
			t.Fatalf("sql missing %q:\n%s", must, sql)
		}
	}
	if len(args) != 5 {
		t.Fatalf("args = %d, want 5 (status, ranks, countries, membership, emails)", len(args))
	}
}

func TestAudienceQueryEmailsListIgnoresFilters(t *testing.T) {
	sql, args := AudienceQuery(Segment{Status: []string{"active"}, RankIDs: []int16{3}, Membership: "active", Emails: []string{"a@x.com"}})
	if !strings.Contains(sql, "$5::text[]") {
		t.Fatalf("sql should filter by email list:\n%s", sql)
	}
	// con lista de emails, ranks/countries/membership viajan como NULL/any
	if args[1] != nil || args[2] != nil || args[3] != "any" {
		t.Fatalf("filters not neutralized: %v", args)
	}
	// ...y el status se abre a los 3 válidos: la lista explícita manda, no el
	// default "active" (si no, un email de una persona 'pending' se caería en silencio).
	st, ok := args[0].([]string)
	if !ok || len(st) != 3 {
		t.Fatalf("status not widened for email list: %#v", args[0])
	}
	for _, want := range []string{"pending", "active", "suspended"} {
		if !contains(st, want) {
			t.Fatalf("status = %v, want pending/active/suspended", st)
		}
	}
}

func contains(xs []string, v string) bool {
	for _, x := range xs {
		if x == v {
			return true
		}
	}
	return false
}
