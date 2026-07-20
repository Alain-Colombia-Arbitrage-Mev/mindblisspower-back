package withdrawals

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

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

// EmailByWithdrawalID resuelve el email con el que se debe verificar en BMP: el
// vínculo aprobado si existe (Task 11), o el de la persona en caso contrario.
func (s *Store) EmailByWithdrawalID(ctx context.Context, id int64) (string, error) {
	var email string
	err := s.db.QueryRow(ctx, `
		SELECT COALESCE(NULLIF(wr.bmp_email_used,''), p.email)
		  FROM mlm.withdrawal_request wr
		  JOIN mlm.affiliate a ON a.id = wr.affiliate_id
		  JOIN mlm.person p    ON p.id = a.person_id
		 WHERE wr.id = $1`, id).Scan(&email)
	if err != nil {
		return "", fmt.Errorf("email by withdrawal: %w", err)
	}
	return strings.ToLower(strings.TrimSpace(email)), nil
}

// WithdrawalResult es el resultado de crear una solicitud de retiro.
//
// GrossUSD es lo que se descuenta del saldo del afiliado (y lo que se guarda en
// amount_usd); NetUSD es lo que efectivamente recibe en BMP. La diferencia es
// FeeUSD. Se devuelven los tres para que el frontend no tenga que recalcular la
// comisión — la aritmética del dinero vive en un solo lugar.
type WithdrawalResult struct {
	ID       int64  `json:"id"`
	Status   string `json:"status"`
	GrossUSD string `json:"gross_usd"`
	FeeUSD   string `json:"fee_usd"`
	NetUSD   string `json:"net_usd"`
}

// RequestWithdrawal crea una solicitud de retiro (status 'requested', queda
// pendiente de aprobación admin). NO escribe el ledger: el débito real
// (wallet_movement) lo hace SetWithdrawalStatus cuando se paga. Valida mínimo +
// saldo disponible (madurado, no congelado) descontando solicitudes pendientes.
//
// El monto pedido es el BRUTO: el mínimo y la validación de saldo aplican sobre
// él, no sobre el neto. Pedir exactamente $100 se acepta (el afiliado recibe
// $96 tras el 4%).
//
// Esta variante NO lleva datos de verificación BMP: la fila queda marcada
// 'unavailable' (equivalente a RequestWithdrawalWithBMP con BlockUnavailable) y
// el candado fail-closed al pagar la volverá a verificar.
func (s *Store) RequestWithdrawal(ctx context.Context, email, amountStr, bankInfo string) (WithdrawalResult, error) {
	return s.RequestWithdrawalWithBMP(ctx, email, amountStr, bankInfo, "",
		BMPVerification{BlockReason: BlockUnavailable, CheckedAt: time.Now().UTC()})
}

// RequestWithdrawalWithBMP es RequestWithdrawal más el resultado de la
// verificación BMP, que se persiste en la fila para que el admin vea el estado
// con el que se solicitó y el candado al pagar tenga qué re-verificar.
//
// bmpEmail es el correo con el que se verificó en BMP: el de sesión, o el
// vínculo alterno aprobado (Task 11). Vacío ⇒ no hubo verificación.
func (s *Store) RequestWithdrawalWithBMP(ctx context.Context, email, amountStr, bankInfo, bmpEmail string, v BMPVerification) (WithdrawalResult, error) {
	amount, err := decimal.NewFromString(amountStr)
	if err != nil {
		return WithdrawalResult{}, ErrMinWithdrawal
	}
	// Cuantizar ANTES de validar. amount_usd es numeric(14,2) pero el disponible
	// sale de wallet_movement.amount numeric(20,8), así que el monto pedido puede
	// traer sub-centavos. Si validáramos el crudo y dejáramos redondear a
	// Postgres, el valor validado y el almacenado diferirían y SUM(amount_usd) no
	// cuadraría contra el ledger. Se trunca (ver QuantizeUSD): el cuantizado
	// nunca es mayor al pedido, así que no puede exceder el disponible validado.
	amount = QuantizeUSD(amount)
	if amount.LessThan(decimal.NewFromInt(MinWithdrawalUSD)) {
		return WithdrawalResult{}, ErrMinWithdrawal
	}

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return WithdrawalResult{}, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var affID, walletID int64
	err = tx.QueryRow(ctx, ResolveUSDWalletSQL, email).Scan(&affID, &walletID)
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

	// El fee se CONGELA al solicitar: fee_pct queda en la fila y el pago lo lee
	// de ahí, no de DefaultFeePct. Si mañana cambia la política, los retiros ya
	// solicitados conservan el porcentaje prometido.
	//
	// amount_usd sigue siendo el BRUTO: es lo que se debita del afiliado al pagar
	// (concepto 1013). net_usd es lo que recibe en BMP; fee_usd es el ingreso.
	fee, net := CalcFee(amount, DefaultFeePct)

	// bmpStatus guarda 'allowed' cuando la verificación pasó, o el motivo del
	// bloqueo. SetWithdrawalStatus exigirá 'allowed' Y frescura para pagar (Task 10).
	bmpStatus := v.BlockReason
	if v.CanWithdraw {
		bmpStatus = "allowed"
	}
	if v.BlockReason == BlockUnavailable {
		// Sin verificación no afirmamos con qué email se validó: dejar ahí el
		// correo de sesión le diría al admin que BMP confirmó algo que nunca
		// llegó a responder.
		bmpEmail = ""
	}

	var id int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO mlm.withdrawal_request
		  (affiliate_id, wallet_id, amount_usd, status, comments,
		   fee_pct, fee_usd, net_usd,
		   bmp_status, bmp_verified_at, bmp_email_used)
		VALUES ($1, $2, $3, 'requested', $4, $5, $6, $7, $8, $9, NULLIF($10,''))
		RETURNING id
	`, affID, walletID, amount, bankInfo,
		DefaultFeePct, fee, net,
		bmpStatus, v.CheckedAt, bmpEmail).Scan(&id); err != nil {
		return WithdrawalResult{}, fmt.Errorf("insert withdrawal: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return WithdrawalResult{}, fmt.Errorf("commit: %w", err)
	}
	return WithdrawalResult{
		ID:       id,
		Status:   "requested",
		GrossUSD: amount.String(),
		FeeUSD:   fee.String(),
		NetUSD:   net.String(),
	}, nil
}
