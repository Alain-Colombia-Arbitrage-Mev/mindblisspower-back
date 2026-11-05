package main

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/rs/zerolog"
)

// Readiness diagnostics expose fixed stage names and error classification only.
// Never attach err, SQL, provider replies, identity fields or connection data.
func observeNOWReadinessStage(ctx context.Context, logger zerolog.Logger, stage string, run func() error) error {
	switch stage {
	case "begin", "policy", "engine", "commit":
	default:
		stage = "unknown"
	}
	started := time.Now()
	err := run()
	event := logger.Info()
	if err != nil {
		event = logger.Warn()
	}
	event.Str("stage", stage).
		Int64("elapsed_ms", time.Since(started).Milliseconds()).
		Bool("deadline_exceeded", errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded)).
		Str("sqlstate", nowReadinessSQLState(err)).
		Msg("NOWPayments readiness stage completed")
	return err
}

func nowReadinessSQLState(err error) string {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || len(pgErr.Code) != 5 {
		return ""
	}
	for _, ch := range pgErr.Code {
		if ch < '0' || ch > '9' {
			if ch < 'A' || ch > 'Z' {
				return ""
			}
		}
	}
	return pgErr.Code
}
