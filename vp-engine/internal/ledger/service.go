// Package ledger implements the LedgerService gRPC handler.
// Único módulo que escribe mlm.wallet_movement y mlm.transaction (ADR 0008 §4).
package ledger

import (
	"context"
	"errors"
	"fmt"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
	"github.com/rs/zerolog"
	"github.com/shopspring/decimal"

	v1 "github.com/vicionpower/vp-engine/proto/gen/go/vicionpower/v1"
)

var (
	ErrMissingExternalRef = errors.New("external_ref is required")
	ErrEmptyMovements     = errors.New("at least one movement is required")
)

// Service implementa vicionpowerv1connect.LedgerServiceHandler.
// Compile-time assertion en main.go vía NewLedgerServiceHandler(s).
type Service struct {
	db   *pgxpool.Pool
	nats *nats.Conn
	log  zerolog.Logger
}

// New crea el servicio.
func New(db *pgxpool.Pool, nc *nats.Conn, log zerolog.Logger) *Service {
	return &Service{
		db:   db,
		nats: nc,
		log:  log.With().Str("component", "ledger").Logger(),
	}
}

// PostTransaction es el método más caliente del sistema (ADR 0002).
// Idempotente por external_ref. Si ya existe la transacción posted, retorna
// was_idempotent_replay=true sin tocar wallet_movement.
//
// Flujo:
//  1. UPSERT mlm.transaction por external_ref.
//  2. Si era replay (status='posted' antes del UPDATE), early-return.
//  3. INSERT batch de wallet_movements.
//  4. UPDATE transaction.status='posted' — dispara trigger fn_validate_transaction
//     que verifica balance neto = 0 para conceptos requires_pair.
//  5. Publish NATS event "ledger.transaction.posted" (best-effort, no fail si NATS down).
func (s *Service) PostTransaction(
	ctx context.Context,
	req *connect.Request[v1.PostTransactionRequest],
) (*connect.Response[v1.PostTransactionResponse], error) {
	in := req.Msg

	if in.GetExternalRef() == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, ErrMissingExternalRef)
	}
	if len(in.GetMovements()) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, ErrEmptyMovements)
	}

	actor := in.GetActor()
	log := s.log.With().
		Str("external_ref", in.GetExternalRef()).
		Int64("actor_person_id", actor.GetPersonId()).
		Logger()

	// Idempotency: si ya existe posted, retornar tal cual.
	var existingID string
	var existingStatus string
	var existingPostedAt *time.Time
	err := s.db.QueryRow(ctx, `
		SELECT id, status, posted_at
		  FROM mlm.transaction
		 WHERE external_ref = $1
	`, in.GetExternalRef()).Scan(&existingID, &existingStatus, &existingPostedAt)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("lookup txn: %w", err))
	}
	if existingStatus == "posted" {
		log.Info().Str("txn_id", existingID).Msg("idempotent replay")
		resp := &v1.PostTransactionResponse{
			TransactionId:        existingID,
			WasIdempotentReplay:  true,
		}
		if existingPostedAt != nil {
			resp.PostedAt = tsPB(*existingPostedAt)
		}
		return connect.NewResponse(resp), nil
	}

	// Transacción SERIALIZABLE: si dos llamadas concurrentes con el mismo external_ref
	// llegan a la vez, la segunda se serializa y termina en el branch de replay arriba
	// al re-leer dentro de su propia tx.
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("begin tx: %w", err))
	}
	defer tx.Rollback(ctx) // safe to call after Commit

	// 1. UPSERT transaction
	var txnID string
	err = tx.QueryRow(ctx, `
		INSERT INTO mlm.transaction (external_ref, description, status, initiated_by_person_id)
		VALUES ($1, $2, 'pending', $3)
		ON CONFLICT (external_ref) DO UPDATE SET description = EXCLUDED.description
		RETURNING id
	`, in.GetExternalRef(), in.GetDescription(), actor.GetPersonId()).Scan(&txnID)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("upsert txn: %w", err))
	}

	// 2. INSERT movements. Trigger fn_validate_movement valida sign vs concept.factor.
	for i, m := range in.GetMovements() {
		amount, perr := decimal.NewFromString(m.GetAmount())
		if perr != nil {
			return nil, connect.NewError(connect.CodeInvalidArgument,
				fmt.Errorf("movement[%d].amount %q is not a valid decimal: %w", i, m.GetAmount(), perr))
		}

		var postedAt time.Time
		if m.GetPostedAt() != nil {
			postedAt = m.GetPostedAt().AsTime()
		} else {
			postedAt = time.Now().UTC()
		}

		var availableAtArg interface{}
		if m.GetAvailableAt() != nil {
			availableAtArg = m.GetAvailableAt().AsTime()
		}

		var refArg interface{}
		if m.GetReference() != "" {
			refArg = m.GetReference()
		}

		if _, err := tx.Exec(ctx, `
			INSERT INTO mlm.wallet_movement (
				transaction_id, wallet_id, affiliate_id, concept_id,
				amount, reference, posted_at, available_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		`, txnID, m.GetWalletId(), m.GetAffiliateId(), m.GetConceptId(),
			amount, refArg, postedAt, availableAtArg); err != nil {
			return nil, connect.NewError(connect.CodeInternal,
				fmt.Errorf("insert movement[%d]: %w", i, err))
		}
	}

	// 3. Marcar posted — dispara fn_validate_transaction (balance pair-check)
	postedAt := time.Now().UTC()
	if _, err := tx.Exec(ctx, `
		UPDATE mlm.transaction
		   SET status = 'posted', posted_at = $2
		 WHERE id = $1
	`, txnID, postedAt); err != nil {
		// Trigger fallido = validación de negocio (pair imbalance, cap breach, etc).
		// Devolver FailedPrecondition para que vp-api distinga de errores transitorios.
		return nil, connect.NewError(connect.CodeFailedPrecondition,
			fmt.Errorf("validate-on-post: %w", err))
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("commit: %w", err))
	}

	// 4. Publish NATS event (fail-soft)
	if s.nats != nil {
		payload := []byte(fmt.Sprintf(
			`{"transaction_id":%q,"external_ref":%q,"posted_at":%q}`,
			txnID, in.GetExternalRef(), postedAt.Format(time.RFC3339Nano),
		))
		if err := s.nats.Publish("ledger.transaction.posted", payload); err != nil {
			log.Warn().Err(err).Msg("publish posted event failed")
		}
	}

	log.Info().Str("txn_id", txnID).Int("movements", len(in.GetMovements())).Msg("transaction posted")

	return connect.NewResponse(&v1.PostTransactionResponse{
		TransactionId:       txnID,
		PostedAt:            tsPB(postedAt),
		WasIdempotentReplay: false,
	}), nil
}

// ReverseTransaction crea una transacción que netea otra existente.
// Requiere approval_request aprobado (ADR 0010) — vp-api valida ANTES de llamar.
// vp-engine confía pero exige el ID del approval para audit trail.
func (s *Service) ReverseTransaction(
	_ context.Context,
	_ *connect.Request[v1.ReverseTransactionRequest],
) (*connect.Response[v1.ReverseTransactionResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented,
		errors.New("ReverseTransaction not yet implemented; see ADR 0010"))
}

// GetWalletBalance lee el balance materializado del wallet.
func (s *Service) GetWalletBalance(
	ctx context.Context,
	req *connect.Request[v1.GetWalletBalanceRequest],
) (*connect.Response[v1.GetWalletBalanceResponse], error) {
	in := req.Msg
	if in.GetWalletId() == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("wallet_id required"))
	}

	var (
		walletID       int64
		affiliateID    int64
		assetID        int32
		balance        decimal.Decimal
		lastMovementAt *time.Time
	)
	err := s.db.QueryRow(ctx, `
		SELECT w.id, w.affiliate_id, w.asset_id, COALESCE(w.balance, 0),
		       (SELECT MAX(posted_at) FROM mlm.wallet_movement WHERE wallet_id = w.id)
		  FROM mlm.wallet w
		 WHERE w.id = $1
	`, in.GetWalletId()).Scan(&walletID, &affiliateID, &assetID, &balance, &lastMovementAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("wallet %d not found", in.GetWalletId()))
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	resp := &v1.GetWalletBalanceResponse{
		WalletId:    walletID,
		AffiliateId: affiliateID,
		AssetId:     assetID,
		Balance:     balance.String(),
	}
	if lastMovementAt != nil {
		resp.LastMovementAt = tsPB(*lastMovementAt)
	}
	return connect.NewResponse(resp), nil
}

// GetMovements lista movements con cursor pagination.
func (s *Service) GetMovements(
	_ context.Context,
	_ *connect.Request[v1.GetMovementsRequest],
) (*connect.Response[v1.GetMovementsResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented,
		errors.New("GetMovements not yet implemented"))
}
