package withdrawals

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
	"github.com/shopspring/decimal"
)

// MinWithdrawalUSD: monto mínimo de retiro (política). Aplica al BRUTO.
const MinWithdrawalUSD = 100

var (
	ErrMinWithdrawal = errors.New("monto menor al mínimo")
	ErrInsufficient  = errors.New("saldo disponible insuficiente")
	ErrNoWallet      = errors.New("sin wallet de comisiones")
)

// Store es el acceso a datos de retiros.
type Store struct {
	db  *pgxpool.Pool
	log zerolog.Logger
}

func NewStore(db *pgxpool.Pool) *Store {
	return &Store{db: db, log: zerolog.Nop()}
}

func (s *Store) SetLogger(l zerolog.Logger) { s.log = l }

// WithdrawalResult es el resultado de crear una solicitud de retiro.
type WithdrawalResult struct {
	ID     int64  `json:"id"`
	Status string `json:"status"`
}

// RequestWithdrawal crea una solicitud de retiro (status 'requested', queda
// pendiente de aprobación admin). NO escribe el ledger: el débito real
// (wallet_movement) lo hace SetWithdrawalStatus cuando se paga. Valida mínimo +
// saldo disponible (madurado, no congelado) descontando solicitudes pendientes.
func (s *Store) RequestWithdrawal(ctx context.Context, email, amountStr, bankInfo string) (WithdrawalResult, error) {
	amount, err := decimal.NewFromString(amountStr)
	if err != nil || amount.LessThan(decimal.NewFromInt(MinWithdrawalUSD)) {
		return WithdrawalResult{}, ErrMinWithdrawal
	}

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return WithdrawalResult{}, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var affID, walletID int64
	err = tx.QueryRow(ctx, `
		SELECT a.id, w.id
		  FROM mlm.person p
		  JOIN mlm.affiliate a ON a.person_id = p.id
		  JOIN mlm.wallet w    ON w.affiliate_id = a.id
		  JOIN mlm.asset s     ON s.id = w.asset_id AND s.symbol = 'USD'
		 WHERE lower(p.email) = lower($1)
		 LIMIT 1
	`, email).Scan(&affID, &walletID)
	if errors.Is(err, pgx.ErrNoRows) {
		return WithdrawalResult{}, ErrNoWallet
	}
	if err != nil {
		return WithdrawalResult{}, fmt.Errorf("resolve wallet: %w", err)
	}

	var availStr, pendingStr string
	if err := tx.QueryRow(ctx, AvailableBalanceSQL, walletID).Scan(&availStr); err != nil {
		return WithdrawalResult{}, fmt.Errorf("available: %w", err)
	}
	if err := tx.QueryRow(ctx, PendingWithdrawalsSQL, affID).Scan(&pendingStr); err != nil {
		return WithdrawalResult{}, fmt.Errorf("pending: %w", err)
	}
	avail, _ := decimal.NewFromString(availStr)
	pending, _ := decimal.NewFromString(pendingStr)
	if amount.GreaterThan(avail.Sub(pending)) {
		return WithdrawalResult{}, ErrInsufficient
	}

	var id int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO mlm.withdrawal_request (affiliate_id, wallet_id, amount_usd, status, comments)
		VALUES ($1, $2, $3, 'requested', $4)
		RETURNING id
	`, affID, walletID, amount, bankInfo).Scan(&id); err != nil {
		return WithdrawalResult{}, fmt.Errorf("insert withdrawal: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return WithdrawalResult{}, fmt.Errorf("commit: %w", err)
	}
	return WithdrawalResult{ID: id, Status: "requested"}, nil
}
