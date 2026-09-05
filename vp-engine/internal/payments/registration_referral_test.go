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
