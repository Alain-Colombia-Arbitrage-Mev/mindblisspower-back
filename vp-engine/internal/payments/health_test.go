package payments

import (
	"testing"
	"time"
)

func TestClassifyAge(t *testing.T) {
	now := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	warn, down := 26*time.Hour, 50*time.Hour
	if got := classifyAge(nil, now, warn, down); got != "unknown" {
		t.Fatalf("nil => %s", got)
	}
	recent := now.Add(-1 * time.Hour)
	if got := classifyAge(&recent, now, warn, down); got != "ok" {
		t.Fatalf("recent => %s", got)
	}
	stale := now.Add(-30 * time.Hour)
	if got := classifyAge(&stale, now, warn, down); got != "stale" {
		t.Fatalf("stale => %s", got)
	}
	old := now.Add(-60 * time.Hour)
	if got := classifyAge(&old, now, warn, down); got != "error" {
		t.Fatalf("old => %s", got)
	}
}

func TestOverallStatus(t *testing.T) {
	ok := []HealthEntry{{Status: "ok"}, {Status: "up"}}
	if overallStatus(ok) != "ok" {
		t.Fatal("all ok")
	}
	warn := []HealthEntry{{Status: "ok"}, {Status: "stale"}}
	if overallStatus(warn) != "warn" {
		t.Fatal("has stale => warn")
	}
	down := []HealthEntry{{Status: "warn"}, {Status: "down"}}
	if overallStatus(down) != "down" {
		t.Fatal("has down => down")
	}
}
