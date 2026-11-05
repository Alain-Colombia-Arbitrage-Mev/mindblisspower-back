package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/rs/zerolog"
)

func TestNOWReadinessStageLogsOnlySafeClassification(t *testing.T) {
	for _, tc := range []struct {
		name, stage, code, wantCode string
	}{
		{"permission", "engine", "42501", "42501"},
		{"invalid SQLSTATE", "postgres://synthetic-private-user:synthetic-secret@example.test/db", "42501 private@example.test", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var output bytes.Buffer
			logger := zerolog.New(&output)
			privateErr := fmt.Errorf("private@example.test postgres://synthetic-secret:synthetic-password@db: %w", &pgconn.PgError{
				Code: tc.code, Message: "SELECT confidential FROM private_table", Detail: "private-provider-id",
			})
			calls := 0
			got := observeNOWReadinessStage(context.Background(), logger, tc.stage, func() error {
				calls++
				return privateErr
			})
			if got != privateErr || calls != 1 {
				t.Fatal("observation changed result or retried operation")
			}
			var event map[string]any
			if err := json.Unmarshal(output.Bytes(), &event); err != nil {
				t.Fatal(err)
			}
			if event["sqlstate"] != tc.wantCode || event["deadline_exceeded"] != false || event["elapsed_ms"].(float64) < 0 {
				t.Fatal("safe classification missing", event)
			}
			wantStage := tc.stage
			if tc.name == "invalid SQLSTATE" {
				wantStage = "unknown"
			}
			if event["stage"] != wantStage {
				t.Fatal("unexpected stage", event["stage"])
			}
			for _, forbidden := range []string{"postgres://", "password", "private@", "SELECT", "private_table", "private-provider-id", "error"} {
				if strings.Contains(output.String(), forbidden) {
					t.Fatal("private diagnostic leaked", forbidden)
				}
			}
			for key := range event {
				switch key {
				case "level", "stage", "elapsed_ms", "deadline_exceeded", "sqlstate", "message":
				default:
					t.Fatal("unexpected diagnostic field", key)
				}
			}
		})
	}
}

func TestNOWReadinessStageDeadlineAndSuccess(t *testing.T) {
	for _, timeout := range []bool{false, true} {
		var output bytes.Buffer
		ctx := context.Background()
		var cancel context.CancelFunc
		if timeout {
			ctx, cancel = context.WithDeadline(ctx, time.Now().Add(-time.Second))
			defer cancel()
		}
		err := observeNOWReadinessStage(ctx, zerolog.New(&output), "policy", func() error { return ctx.Err() })
		if timeout != errors.Is(err, context.DeadlineExceeded) {
			t.Fatal("deadline result changed")
		}
		var event map[string]any
		if err := json.Unmarshal(output.Bytes(), &event); err != nil {
			t.Fatal(err)
		}
		if event["deadline_exceeded"] != timeout || event["sqlstate"] != "" {
			t.Fatal("deadline classification missing", event)
		}
	}
}
