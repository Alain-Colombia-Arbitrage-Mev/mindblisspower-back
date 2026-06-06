// Package bonusengine implementa los runs de bonos: ROI, binario, liderazgo, directo.
//
// Cada algoritmo es un job idempotente con `external_ref` único por
// (run_date, kind, affiliate_id). Re-correr es seguro.
//
// Ver:
//   - ADR 0012 — parámetros y invariantes del binario.
//   - _meta/sketches/binary_close.go.md — pseudocódigo completo del binary close.
//   - mlm_binario_estabilidad.md / mlm_binario_margen_operativo.md — diseño.
package bonusengine

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/rs/zerolog"

	"github.com/vicionpower/vp-engine/internal/shared/metrics"
)

var (
	ErrPeriodNotOpen      = errors.New("period is not in open status")
	ErrConcurrentClose    = errors.New("another close is already in progress")
	ErrSolvencyBreach     = errors.New("calculated payouts breach treasury alpha")
	ErrNoActivePlanConfig = errors.New("no active plan_config")
)

// Engine ejecuta los runs de bonos. Una sola instancia compartida.
type Engine struct {
	db   *pgxpool.Pool
	nats *nats.Conn
	log  zerolog.Logger

	// Métricas (ADR 0011)
	closeRunDuration   prometheus.Histogram
	candidatesCounter  prometheus.Counter
	payoutsTotalUSD    prometheus.Counter
	thetaGauge         prometheus.Gauge
	solvencyBreaches   prometheus.Counter
	roiRunDuration     prometheus.Histogram
	lastBinaryClose    prometheus.Gauge
	lastROIRun         prometheus.Gauge
}

// New initializes the engine and registers metrics.
func New(db *pgxpool.Pool, nc *nats.Conn, log zerolog.Logger) *Engine {
	e := &Engine{
		db:   db,
		nats: nc,
		log:  log.With().Str("component", "bonusengine").Logger(),

		closeRunDuration: prometheus.NewHistogram(prometheus.HistogramOpts{
			Namespace: "binary",
			Name:      "close_duration_seconds",
			Help:      "Duración del cierre de período binario.",
			Buckets:   prometheus.ExponentialBuckets(0.5, 2, 10),
		}),
		candidatesCounter: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: "binary", Name: "close_candidates_total",
			Help: "Total de candidates evaluados (ancestor × event).",
		}),
		payoutsTotalUSD: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: "binary", Name: "close_payouts_usd_total",
			Help: "USD totales pagados por bonus runs (acumulado).",
		}),
		thetaGauge: prometheus.NewGauge(prometheus.GaugeOpts{
			Namespace: "binary", Name: "close_theta",
			Help: "Último theta calculado (1 = sin throttle).",
		}),
		solvencyBreaches: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: "binary", Name: "close_solvency_breaches_total",
			Help: "Veces que el invariant T1 fue violado. DEBE ser 0 siempre.",
		}),
		roiRunDuration: prometheus.NewHistogram(prometheus.HistogramOpts{
			Namespace: "roi", Name: "run_duration_seconds",
			Help:    "Duración del run diario de ROI.",
			Buckets: prometheus.ExponentialBuckets(0.5, 2, 10),
		}),
		lastBinaryClose: prometheus.NewGauge(prometheus.GaugeOpts{
			Namespace: "bonus_run", Name: "last_completed_binary_seconds",
			Help: "Unix timestamp del último cierre binario exitoso.",
		}),
		lastROIRun: prometheus.NewGauge(prometheus.GaugeOpts{
			Namespace: "bonus_run", Name: "last_completed_roi_seconds",
			Help: "Unix timestamp del último ROI run exitoso.",
		}),
	}

	metrics.MustRegister(
		e.closeRunDuration, e.candidatesCounter, e.payoutsTotalUSD,
		e.thetaGauge, e.solvencyBreaches, e.roiRunDuration,
		e.lastBinaryClose, e.lastROIRun,
	)

	return e
}

// CloseBinaryPeriod vive en binary_close.go.
//
// RunROIDaily distribuye ROI sobre paquetes activos.
// TODO(fase 2): leer mlm.affiliate_package WHERE status='active', calcular ROI
// según plan_config, postear via ledger.PostTransaction (vía service interno).
func (e *Engine) RunROIDaily(_ context.Context) error {
	return errors.New("RunROIDaily not yet implemented")
}

// RunLeadershipBonus mensual.
// TODO(fase 2).
func (e *Engine) RunLeadershipBonus(_ context.Context) error {
	return errors.New("RunLeadershipBonus not yet implemented")
}
