package payments

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// checkoutOutstanding must run after locking mlm.person FOR NO KEY UPDATE and
// before inserting the new order in that same transaction. Both provider paths
// use the person row as their shared, database-wide serialization boundary.
// A NOWPayments receipt awaiting review is not an activated membership, but it
// must still prevent collecting payment for that membership again via Stripe.
func checkoutOutstanding(ctx context.Context, tx pgx.Tx, personID int64, packageID int, provider string) error {
	var query string
	switch provider {
	case "stripe":
		// Preserve pre-74 Stripe installations: they cannot contain a NOW order.
		// Catalog/permission errors are not equivalent to an absent relation.
		var installed bool
		if err := tx.QueryRow(ctx, `SELECT to_regclass('payments.nowpayments_membership_attempt') IS NOT NULL`).Scan(&installed); err != nil {
			return fmt.Errorf("inspect membership collection guard: %w", err)
		}
		if !installed {
			return nil
		}
		query = `SELECT EXISTS(SELECT 1 FROM payments.nowpayments_membership_attempt
 WHERE person_id=$1 AND package_id=$2 AND state <> 'closed_reviewed')`
	case "nowpayments":
		// Even an unattached created intent may have produced an external Stripe
		// session before a timeout; do not assume it is safe to charge elsewhere.
		query = `SELECT EXISTS(SELECT 1 FROM payments.purchase_intent
 WHERE person_id=$1 AND package_id=$2 AND status IN ('created','paid','needs_placement','security_blocked','disputed','chargeback'))`
	default:
		return ErrNOWPaymentsEvidence
	}
	var outstanding bool
	if err := tx.QueryRow(ctx, query, personID, packageID).Scan(&outstanding); err != nil {
		return fmt.Errorf("verify membership collection guard: %w", err)
	}
	if outstanding {
		return ErrNOWPaymentsOutstanding
	}
	return nil
}
