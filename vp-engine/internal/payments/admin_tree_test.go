package payments

import "testing"

func TestAdminTreeDisplayStatusPrioritizesNonActiveState(t *testing.T) {
	cases := []struct {
		person    string
		affiliate string
		want      string
	}{
		{person: "active", affiliate: "active", want: "active"},
		{person: "active", affiliate: "pending", want: "pending"},
		{person: "pending", affiliate: "active", want: "pending"},
		{person: "active", affiliate: "suspended", want: "suspended"},
		{person: "banned", affiliate: "pending", want: "banned"},
	}

	for _, c := range cases {
		if got := adminTreeDisplayStatus(c.person, c.affiliate); got != c.want {
			t.Fatalf("adminTreeDisplayStatus(%q, %q) = %q, want %q", c.person, c.affiliate, got, c.want)
		}
	}
}
