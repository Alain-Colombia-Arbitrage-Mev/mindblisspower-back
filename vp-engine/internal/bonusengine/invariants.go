// Invariant monitor: corre mlm.fn_check_payout_invariants() periódicamente,
// expone gauges Prometheus y un readiness check para /ready.
//
// Las cuatro invariantes T1-T4 (ADR 0012 §invariantes, _meta/binary_spec.md §7)
// son la garantía matemática de solvencia. Un FAIL es P0: dispara on-call.
package bonusengine

import (
	"context"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/rs/zerolog"

	"github.com/vicionpower/vp-engine/internal/shared/metrics"
)

// invariantNames son los nombres devueltos por mlm.fn_check_payout_invariants().
// El orden es estable y se usa como índice en Invariants.last.
var invariantNames = []string{
	"T1_no_overspend",
	"T2_package_cap",
	"T3_daily_cap",
	"T4_append_only",
}

// Invariants encapsula el estado de las 4 invariantes y el job de chequeo.
//
// Status() es lock-free (atomic.Bool) — apta para llamarla desde /ready
// en cada request sin contención.
type Invariants struct {
	db    *pgxpool.Pool
	log   zerolog.Logger
	gauge *prometheus.GaugeVec
	last  [4]atomic.Bool // index alineado con invariantNames
}

// NewInvariants registra la gauge y devuelve el monitor.
// Llamar UNA sola vez por proceso (la métrica se registra global).
func NewInvariants(db *pgxpool.Pool, log zerolog.Logger) *Invariants {
	g := prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: "vp",
		Subsystem: "invariant",
		Name:      "status",
		Help:      "1 = OK, 0 = FAIL. Una invariante en 0 es P0.",
	}, []string{"name"})
	metrics.MustRegister(g)

	inv := &Invariants{
		db:    db,
		log:   log.With().Str("component", "invariants").Logger(),
		gauge: g,
	}
	// Estado inicial OK (optimista) hasta que el primer run confirme.
	for i := range inv.last {
		inv.last[i].Store(true)
		inv.gauge.WithLabelValues(invariantNames[i]).Set(1)
	}
	return inv
}

// Run ejecuta una iteración del chequeo. Pensado para gocron @ every 60s.
// No retorna error — un fallo de DB queda loggeado pero no detiene el job
// (el siguiente tick volverá a intentar).
func (i *Invariants) Run(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	rows, err := i.db.Query(ctx,
		"SELECT invariant, status, detail FROM mlm.fn_check_payout_invariants()")
	if err != nil {
		i.log.Error().Err(err).Msg("invariant check query failed")
		return
	}
	defer rows.Close()

	seen := map[string]bool{}
	for rows.Next() {
		var name, status, detail string
		if err := rows.Scan(&name, &status, &detail); err != nil {
			i.log.Error().Err(err).Msg("invariant row scan failed")
			continue
		}
		seen[name] = true
		ok := status == "OK"
		i.update(name, ok)
		if !ok {
			i.log.Error().
				Str("invariant", name).
				Str("detail", detail).
				Msg("INVARIANT BREACH — P0")
		}
	}
	if err := rows.Err(); err != nil {
		i.log.Error().Err(err).Msg("invariant rows iteration failed")
	}

	// Si la query no devolvió todas las invariantes, marcar las faltantes
	// como desconocidas (gauge=0) — fail-closed.
	for _, n := range invariantNames {
		if !seen[n] {
			i.update(n, false)
			i.log.Warn().Str("invariant", n).Msg("invariant missing from result; marking FAIL")
		}
	}
}

func (i *Invariants) update(name string, ok bool) {
	for idx, n := range invariantNames {
		if n == name {
			i.last[idx].Store(ok)
			val := 0.0
			if ok {
				val = 1.0
			}
			i.gauge.WithLabelValues(name).Set(val)
			return
		}
	}
}

// Status devuelve nil si las 4 invariantes están en OK.
// Llamarla desde /ready: si retorna error, devolver 503.
// Lock-free: usa atomic.Bool, sin contención bajo alta concurrencia.
func (i *Invariants) Status() error {
	var failed []string
	for idx, n := range invariantNames {
		if !i.last[idx].Load() {
			failed = append(failed, n)
		}
	}
	if len(failed) == 0 {
		return nil
	}
	return fmt.Errorf("invariant breach: %v", failed)
}
