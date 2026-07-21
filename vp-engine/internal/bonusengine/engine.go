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

// DefaultTimezone es la zona de negocio del plan (Bogota, UTC−5 sin DST). Todas
// las fechas de calendario (devengo diario, disponibilidad, vencimiento) se
// interpretan en esta zona; el TimeZone de la sesión Postgres (UTC, ver
// shared/db.pool) es un detalle de infraestructura que NO debe filtrarse al
// cálculo. Override por BONUS_ENGINE_TIMEZONE vía Option WithTimezone.
const DefaultTimezone = "America/Bogota"

// Option configura el Engine en New.
type Option func(*Engine)

// WithTimezone fija la zona de negocio usada para resolver fechas de calendario.
// Vacío = se conserva DefaultTimezone.
func WithTimezone(tz string) Option {
	return func(e *Engine) {
		if tz != "" {
			e.tz = tz
		}
	}
}

// Engine ejecuta los runs de bonos. Una sola instancia compartida.
type Engine struct {
	db   *pgxpool.Pool
	nats *nats.Conn
	log  zerolog.Logger
	tz   string // zona de negocio para fechas de calendario

	// Métricas (ADR 0011)
	closeRunDuration  prometheus.Histogram
	candidatesCounter prometheus.Counter
	payoutsTotalUSD   prometheus.Counter
	thetaGauge        prometheus.Gauge
	solvencyBreaches  prometheus.Counter
	roiRunDuration    prometheus.Histogram
	lastBinaryClose   prometheus.Gauge
	lastROIRun        prometheus.Gauge
}

// New initializes the engine and registers metrics.
func New(db *pgxpool.Pool, nc *nats.Conn, log zerolog.Logger, opts ...Option) *Engine {
	e := &Engine{
		db:   db,
		nats: nc,
		log:  log.With().Str("component", "bonusengine").Logger(),
		tz:   DefaultTimezone,

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

	for _, opt := range opts {
		opt(e)
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
// RunROIDaily devenga el ROI diario de los CDs de inversión (concept 1006),
// por tier y calificación (ver AccrueCDROIDaily). Corre aunque el cierre binario
// esté apagado: es el mecanismo de ROI de la red (CD para todos).
func (e *Engine) RunROIDaily(ctx context.Context) error {
	res, err := e.AccrueCDROIDaily(ctx)
	if err != nil {
		return err
	}
	e.log.Info().
		Int("cds", res.CDsProcessed).
		Int("posted", res.Posted).
		Int("matured", res.Matured).
		Str("total_usd", res.TotalUSD.StringFixed(2)).
		Msg("CD ROI daily accrual complete")
	return nil
}

// RunLeadershipBonus mensual.
// TODO(fase 2).
func (e *Engine) RunLeadershipBonus(_ context.Context) error {
	return errors.New("RunLeadershipBonus not yet implemented")
}
