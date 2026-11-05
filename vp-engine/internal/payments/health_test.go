package payments

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestSystemHealth_ChecksPrimaryDatabase(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	replica, err := pgxpool.NewWithConfig(ctx, pool.Config())
	if err != nil {
		t.Fatal(err)
	}
	defer replica.Close()
	store := NewStore(pool)
	store.SetReadPool(replica)
	pool.Close()
	health := store.GetSystemHealth(ctx, nil)
	if len(health.Infra) == 0 || health.Infra[0].Name != "rds" || health.Infra[0].Status != "down" {
		t.Fatalf("health must detect a failed primary even if reads work: %+v", health.Infra)
	}
	if health.Overall != "down" {
		t.Fatalf("overall = %q, want down", health.Overall)
	}
}

func TestPingHealth_ServerErrorsAreDown(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusUnauthorized, http.StatusInternalServerError, http.StatusServiceUnavailable} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(status)
			}))
			defer srv.Close()
			want := "up"
			if status >= 500 {
				want = "down"
			} else if status >= 300 {
				want = "warn"
			}
			if entry := pingHealth(context.Background(), "test", srv.URL); entry.Status != want {
				t.Fatalf("HTTP %d classified as %q, want %q", status, entry.Status, want)
			}
		})
	}
}

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
