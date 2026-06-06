// Package walletbridge consume webhooks del wallet provider externo
// (recibidos por vp-api y publicados a NATS) y los traduce a operaciones
// contables internas (mlm.transaction + mlm.wallet_movement).
//
// NO observa blockchain directamente. NO custodia keys. El provider externo
// es source-of-truth on-chain; nosotros somos source-of-truth contable.
//
// Ver:
//   - ADR 0014 — wallet via API externa.
//   - BACKEND_PLAN §3.7 — payments module.
package walletbridge

import (
	"context"
	"errors"
	"sync"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
	"github.com/rs/zerolog"
)

// Bridge consume eventos del wallet provider via NATS.
type Bridge struct {
	db   *pgxpool.Pool
	nats *nats.Conn
	log  zerolog.Logger

	mu   sync.Mutex
	subs []*nats.Subscription
}

func New(db *pgxpool.Pool, nc *nats.Conn, log zerolog.Logger) *Bridge {
	return &Bridge{
		db:   db,
		nats: nc,
		log:  log.With().Str("component", "walletbridge").Logger(),
	}
}

// Run subscribes to NATS subjects and blocks until ctx.Done.
//
// TODO(implementación):
//   1. Subscribe a "payments.deposit_confirmed" — handler crea
//      mlm.transaction (concept = deposit, factor = +1) idempotente
//      por external_ref = "wallet:" + provider_tx_hash.
//   2. Subscribe a "payments.withdrawal_completed" — handler actualiza
//      withdrawal_request.status='paid' y commitea la transacción
//      previamente creada en estado pending.
//   3. Subscribe a "payments.deposit_failed" / "withdrawal_failed" —
//      reverso de holding + notificación.
func (b *Bridge) Run(ctx context.Context) error {
	if b.nats == nil {
		b.log.Warn().Msg("walletbridge disabled: no NATS connection")
		<-ctx.Done()
		return nil
	}
	subjects := []string{
		"payments.deposit_confirmed",
		"payments.withdrawal_completed",
		"payments.deposit_failed",
		"payments.withdrawal_failed",
	}

	for _, subj := range subjects {
		sub, err := b.nats.Subscribe(subj, b.dispatch(subj))
		if err != nil {
			return err
		}
		b.mu.Lock()
		b.subs = append(b.subs, sub)
		b.mu.Unlock()
	}

	b.log.Info().Strs("subjects", subjects).Msg("walletbridge subscribed")

	<-ctx.Done()

	b.mu.Lock()
	defer b.mu.Unlock()
	for _, sub := range b.subs {
		_ = sub.Drain()
	}
	return nil
}

// dispatch retorna un handler que rutea por subject. Por ahora todos retornan
// not-implemented; se llenará en la fase de payments.
func (b *Bridge) dispatch(subject string) nats.MsgHandler {
	return func(msg *nats.Msg) {
		b.log.Info().
			Str("subject", subject).
			Int("payload_bytes", len(msg.Data)).
			Msg("event received (handler not yet implemented)")
		// TODO: parse payload + execute handler. Ack via reply if requested.
	}
}

// HandleDepositConfirmed es invocado por dispatch cuando llega un deposit.
//
// TODO(fase payments):
//   1. Parse payload: { provider_tx_hash, address, amount, asset, n_confirmations }.
//   2. Locate mlm.wallet by address.
//   3. Llamar Ledger.PostTransaction (interno) con:
//        external_ref = "wallet:" + provider_tx_hash
//        movements = [{ wallet_id, affiliate_id, concept_id=deposit,
//                       amount: +amount, posted_at: now }]
//   4. Activar paquete pendiente si el monto coincide con un purchase pendiente.
func (b *Bridge) HandleDepositConfirmed(_ context.Context, _ []byte) error {
	return errors.New("HandleDepositConfirmed not yet implemented (fase payments)")
}

// HandleWithdrawalCompleted es invocado cuando un retiro previamente solicitado
// completó on-chain.
func (b *Bridge) HandleWithdrawalCompleted(_ context.Context, _ []byte) error {
	return errors.New("HandleWithdrawalCompleted not yet implemented (fase payments)")
}
