package payments

import "testing"

func TestNormalizePreferredSide(t *testing.T) {
	tests := map[string]string{
		"L":     "L",
		" l ":   "L",
		"R":     "R",
		" r ":   "R",
		"left":  "",
		"right": "",
		"":      "",
	}
	for input, want := range tests {
		if got := normalizePreferredSide(input); got != want {
			t.Fatalf("normalizePreferredSide(%q)=%q, want %q", input, got, want)
		}
	}
}

func TestAutomaticPlacementSideIgnoresEveryClientHint(t *testing.T) {
	for _, input := range []string{"", "L", "R", "left", "ROOT", "  r  "} {
		if got := automaticPlacementSide(input); got != "" {
			t.Fatalf("automaticPlacementSide(%q)=%q, want empty", input, got)
		}
	}
}
