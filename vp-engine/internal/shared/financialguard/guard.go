// Package financialguard prevents operational money mutations on recovered
// evidence databases. Displaying a sale does not authorize allocating funds.
package financialguard

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

var ErrRecoveryReview = errors.New("recovered Stripe funds require reconciliation and commission calculation")

type Queryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

// RequireOperational fails closed on a recovery database or an unavailable
// check. No environment flag, non-empty plan or cached allow decision can unlock
// the recovered source. Resuming operations requires an explicit reviewed change.
func RequireOperational(ctx context.Context, db Queryer) error {
	var recovered bool
	if err := db.QueryRow(ctx, `SELECT to_regclass('payments.stripe_sale') IS NOT NULL`).Scan(&recovered); err != nil {
		return fmt.Errorf("verify financial mutation mode: %w", err)
	}
	if recovered {
		return ErrRecoveryReview
	}
	return nil
}
