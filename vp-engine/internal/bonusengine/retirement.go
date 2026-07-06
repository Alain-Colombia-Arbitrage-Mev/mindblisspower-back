package bonusengine

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

// retirementContribConceptID = 1007 'Aporte a plan de jubilación'.
const retirementContribConceptID = 1007

// routeSplit divide un neto (post-θ) entre jubilación y retirable.
// toRetirement = net×pct (RoundDown 2); el remanente exacto va a retirable.
func routeSplit(net, pctToPlan decimal.Decimal) (toRetirement, toWithdrawable decimal.Decimal) {
	if pctToPlan.Sign() <= 0 {
		return decimal.Zero, net
	}
	toRetirement = net.Mul(pctToPlan).RoundDown(2)
	if toRetirement.GreaterThan(net) {
		toRetirement = net
	}
	toWithdrawable = net.Sub(toRetirement)
	return toRetirement, toWithdrawable
}

// pctToPlanFor: fracción del bono que va al plan, según el modo del afiliado.
// Sin retirement_plan o sin fila de routing => 0 (moderado).
func pctToPlanFor(ctx context.Context, tx pgx.Tx, affiliateID int64, conceptKind string) (decimal.Decimal, error) {
	var pct decimal.Decimal
	err := tx.QueryRow(ctx, `
		SELECT COALESCE(rmr.pct_to_plan, 0)
		  FROM mlm.retirement_plan rp
		  LEFT JOIN mlm.retirement_mode_routing rmr
		         ON rmr.mode = rp.mode AND rmr.concept_kind = $2::mlm.concept_kind
		 WHERE rp.affiliate_id = $1`, affiliateID, conceptKind).Scan(&pct)
	if err == pgx.ErrNoRows {
		return decimal.Zero, nil
	}
	if err != nil {
		return decimal.Zero, fmt.Errorf("pctToPlan aff=%d kind=%s: %w", affiliateID, conceptKind, err)
	}
	return pct, nil
}

// ensureRetirementPlan crea la fila si falta. unlocks_at = birthday+age (NULL si sin birthday).
func ensureRetirementPlan(ctx context.Context, tx pgx.Tx, affiliateID int64, retirementAge int) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO mlm.retirement_plan (affiliate_id, mode, opened_at, unlocks_at, balance_usd, updated_at)
		SELECT $1, 'moderado', now(),
		       (SELECT (p.birthday + make_interval(years => $2))::date
		          FROM mlm.affiliate a JOIN mlm.person p ON p.id = a.person_id
		         WHERE a.id = $1 AND p.birthday IS NOT NULL),
		       0, now()
		ON CONFLICT (affiliate_id) DO NOTHING`, affiliateID, retirementAge)
	if err != nil {
		return fmt.Errorf("ensure retirement_plan aff=%d: %w", affiliateID, err)
	}
	return nil
}

// postRetirementContribution postea el aporte 1007 (bloqueado a unlocks_at) y
// suma al balance. Idempotente por extRef (sufijo :ret). walletCache reusa el
// lookup de la wallet USD.
func postRetirementContribution(
	ctx context.Context, tx pgx.Tx,
	affiliateID int64, amount decimal.Decimal,
	baseExtRef string, postedAt time.Time, retirementAge int,
	walletCache map[int64]int64,
) error {
	if amount.Sign() <= 0 {
		return nil
	}
	if err := ensureRetirementPlan(ctx, tx, affiliateID, retirementAge); err != nil {
		return err
	}
	extRef := baseExtRef + ":ret"
	var txnID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO mlm.transaction (external_ref, description, status, posted_at)
		VALUES ($1, 'Aporte a plan de jubilación', 'posted', $2)
		ON CONFLICT (external_ref) DO NOTHING
		RETURNING id`, extRef, postedAt).Scan(&txnID); err != nil {
		if err == pgx.ErrNoRows {
			return nil // ya posteado (reintento) — idempotente
		}
		return fmt.Errorf("upsert retirement txn (%s): %w", extRef, err)
	}
	walletID, ok := walletCache[affiliateID]
	if !ok {
		if err := tx.QueryRow(ctx, `
			SELECT w.id FROM mlm.wallet w JOIN mlm.asset s ON s.id = w.asset_id
			 WHERE w.affiliate_id = $1 AND s.symbol='USD' LIMIT 1`, affiliateID).Scan(&walletID); err != nil {
			return fmt.Errorf("retirement wallet aff=%d: %w", affiliateID, err)
		}
		walletCache[affiliateID] = walletID
	}
	// available_at = unlocks_at del plan (NULL si sin birthday => bloqueado).
	// Concept 1007 tiene factor=-1 (débito del wallet), por lo tanto amount debe
	// ser negativo. El saldo positivo se acumula en retirement_plan.balance_usd.
	if _, err := tx.Exec(ctx, `
		INSERT INTO mlm.wallet_movement (transaction_id, wallet_id, affiliate_id, concept_id, amount, posted_at, available_at)
		SELECT $1, $2, $3, $4, $5, $6, rp.unlocks_at
		  FROM mlm.retirement_plan rp WHERE rp.affiliate_id = $3`,
		txnID, walletID, affiliateID, retirementContribConceptID, amount.Neg(), postedAt); err != nil {
		return fmt.Errorf("retirement movement (%s): %w", extRef, err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE mlm.retirement_plan SET balance_usd = balance_usd + $2, updated_at = now()
		 WHERE affiliate_id = $1`, affiliateID, amount); err != nil {
		return fmt.Errorf("retirement balance aff=%d: %w", affiliateID, err)
	}
	return nil
}
