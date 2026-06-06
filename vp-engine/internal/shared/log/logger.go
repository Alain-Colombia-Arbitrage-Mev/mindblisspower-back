// Package log centraliza la configuración de zerolog.
// Output JSON estructurado en stdout, parseado por Vector → Grafana Cloud Loki.
package log

import (
	"os"
	"time"

	"github.com/rs/zerolog"
)

// New returns a configured logger for the service.
func New(serviceName, level string) zerolog.Logger {
	zerolog.TimeFieldFormat = time.RFC3339Nano
	zerolog.TimestampFieldName = "timestamp"
	zerolog.LevelFieldName = "level"
	zerolog.MessageFieldName = "msg"

	lvl, err := zerolog.ParseLevel(level)
	if err != nil {
		lvl = zerolog.InfoLevel
	}

	return zerolog.New(os.Stdout).
		Level(lvl).
		With().
		Timestamp().
		Str("service", serviceName).
		Logger()
}
