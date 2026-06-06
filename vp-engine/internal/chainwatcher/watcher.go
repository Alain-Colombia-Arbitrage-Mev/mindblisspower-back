// Package chainwatcher es DEPRECATED tras ADR 0014.
//
// La decisión inicial de operar HD wallets self-custody con watchers de
// blockchain (TRC20, BTC) fue rechazada en favor de integración con un
// proveedor de wallet API externo.
//
// La funcionalidad real vive ahora en internal/walletbridge/, que NO
// observa la blockchain — consume webhooks del proveedor (recibidos por
// vp-api) vía NATS y los traduce a operaciones contables.
//
// Este archivo se mantiene como placeholder hasta que el equipo Go senior
// lo elimine en favor del nuevo módulo.
//
// Ver:
//   - ADR 0014 — wallet via API externa
//   - internal/walletbridge/bridge.go — implementación nueva
package chainwatcher

import (
	"context"

	"github.com/nats-io/nats.go"
	"github.com/rs/zerolog"
)

// Watcher es un stub que NO hace nada. Se mantiene solo para que main.go compile.
// Eliminar cuando walletbridge/ esté implementado y wired en main.go.
type Watcher struct {
	log zerolog.Logger
}

// New retorna un watcher noop.
func New(_ *nats.Conn, log zerolog.Logger) *Watcher {
	return &Watcher{
		log: log.With().Str("component", "chainwatcher-deprecated").Logger(),
	}
}

// Run bloquea hasta ctx.Done. NO observa blockchain (ADR 0014).
func (w *Watcher) Run(ctx context.Context) error {
	w.log.Info().Msg("chainwatcher is deprecated; see internal/walletbridge/ (ADR 0014)")
	<-ctx.Done()
	return nil
}
