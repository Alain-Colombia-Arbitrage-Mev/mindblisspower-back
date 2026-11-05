// Package db provee la pgx pool compartida.
// vp-engine NO usa PgBouncer; mantiene su propio pool con conexiones largas
// (50-100 cuando hace bonus runs batch).
package db

import (
	"context"
	"crypto/x509"
	"fmt"
	"net/url"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Open creates a pgx pool and verifies connectivity.
func Open(ctx context.Context, dsn string, maxConns int32, connLifetime time.Duration) (*pgxpool.Pool, error) {
	cfg, err := poolConfig(dsn, maxConns, connLifetime, os.Getenv("DATABASE_CA_PEM"))
	if err != nil {
		return nil, err
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return pool, nil
}

func poolConfig(dsn string, maxConns int32, connLifetime time.Duration, caPEM string) (*pgxpool.Config, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("invalid PostgreSQL connection configuration")
	}
	if caPEM != "" {
		uri, parseErr := url.Parse(dsn)
		if parseErr != nil || uri.Query().Get("sslmode") != "verify-full" || cfg.ConnConfig.TLSConfig == nil {
			return nil, fmt.Errorf("DATABASE_CA_PEM requires a PostgreSQL URL with sslmode=verify-full")
		}
		roots := x509.NewCertPool()
		if !roots.AppendCertsFromPEM([]byte(caPEM)) {
			return nil, fmt.Errorf("invalid DATABASE_CA_PEM")
		}
		cfg.ConnConfig.TLSConfig.RootCAs = roots
		cfg.ConnConfig.Fallbacks = nil
	}

	cfg.MaxConns = maxConns
	cfg.MinConns = 2
	cfg.MaxConnLifetime = connLifetime
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.HealthCheckPeriod = 30 * time.Second

	// Set application_name for pg_stat_statements traceability.
	cfg.ConnConfig.RuntimeParams["application_name"] = "vp-engine"
	// Postgres timezone — keep UTC, convert in app code (ADR 0001).
	cfg.ConnConfig.RuntimeParams["timezone"] = "UTC"

	return cfg, nil
}
