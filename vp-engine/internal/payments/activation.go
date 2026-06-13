package payments

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// ActivationResult describe el desenlace de activar una compra pagada.
type ActivationResult struct {
	Status      string // "activated" | "needs_placement" | "replay"
	AffiliateID int64
}

// ActivatePaidPurchase marca la compra como pagada y la ACTIVA de forma atómica
// e idempotente, todo en una transacción:
//  1. resuelve el afiliado del comprador (lo auto-coloca bajo su sponsor si aún
//     no está en el árbol — regla weak-leg),
//  2. liga el paquete (mlm.affiliate_package status='active') — esto es lo que
//     hace que el motor vea el principal/PV,
//  3. acredita PV (mlm.tree_event pv_credit) para que el binario lo propague.
//
// NO escribe el ledger (wallet_movement): el asiento contable capital+1% se
// concilia aparte. Idempotente: re-ejecutar (reintento de Stripe) no duplica
// — dedupe por status='activated' y por transaction_hash/external_ref.
func (s *Store) ActivatePaidPurchase(ctx context.Context, sessionID, paymentIntentID string) (ActivationResult, error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return ActivationResult{}, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // safe tras Commit

	var (
		intentID    string
		personID    int64
		affiliateID *int64
		sponsorID   *int64
		packageID   int
		pv          int
		status      string
	)
	err = tx.QueryRow(ctx, `
		SELECT id::text, person_id, affiliate_id, sponsor_affiliate_id, package_id, pv, status
		  FROM payments.purchase_intent
		 WHERE stripe_session_id = $1
		 FOR UPDATE
	`, sessionID).Scan(&intentID, &personID, &affiliateID, &sponsorID, &packageID, &pv, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return ActivationResult{}, ErrIntentNotFound
	}
	if err != nil {
		return ActivationResult{}, fmt.Errorf("lock intent: %w", err)
	}

	if status == "activated" {
		return ActivationResult{Status: "replay"}, tx.Commit(ctx)
	}

	// Marcar pagado (idempotente).
	if _, err := tx.Exec(ctx, `
		UPDATE payments.purchase_intent
		   SET status = 'paid',
		       stripe_payment_intent_id = $2,
		       paid_at = COALESCE(paid_at, now()),
		       updated_at = now()
		 WHERE id = $1 AND status <> 'paid'
	`, intentID, paymentIntentID); err != nil {
		return ActivationResult{}, fmt.Errorf("mark paid: %w", err)
	}

	// 1. Resolver afiliado del comprador (autoritativo al momento de activar).
	var affID int64
	err = tx.QueryRow(ctx, `SELECT id FROM mlm.affiliate WHERE person_id = $1`, personID).Scan(&affID)
	if errors.Is(err, pgx.ErrNoRows) {
		if sponsorID == nil {
			// No hay sponsor → no podemos colocar. Marcar para colocación manual.
			if _, uerr := tx.Exec(ctx, `UPDATE payments.purchase_intent SET status='needs_placement', updated_at=now() WHERE id=$1`, intentID); uerr != nil {
				return ActivationResult{}, uerr
			}
			if cerr := tx.Commit(ctx); cerr != nil {
				return ActivationResult{}, cerr
			}
			return ActivationResult{Status: "needs_placement"}, nil
		}
		affID, err = autoPlaceAffiliate(ctx, tx, personID, *sponsorID)
		if err != nil {
			return ActivationResult{}, fmt.Errorf("auto-place: %w", err)
		}
	} else if err != nil {
		return ActivationResult{}, fmt.Errorf("resolve affiliate: %w", err)
	}

	// 2. Ligar el paquete (idempotente por transaction_hash). Esto activa al
	//    miembro a ojos del motor (principal = package.amount_usd, PV).
	if _, err := tx.Exec(ctx, `
		INSERT INTO mlm.affiliate_package (
			affiliate_id, package_id, status, payment_method, transaction_hash,
			pv_remaining, activated_at, current_period_date
		)
		SELECT $1, $2, 'active', 'stripe', $3, $4, now(), (now() AT TIME ZONE 'America/Bogota')::date
		 WHERE NOT EXISTS (
			SELECT 1 FROM mlm.affiliate_package WHERE transaction_hash = $3
		 )
	`, affID, packageID, paymentIntentID, pv); err != nil {
		return ActivationResult{}, fmt.Errorf("activate package: %w", err)
	}

	// 3. Acreditar PV (idempotente por external_ref). El trigger fn_apply_tree_event
	//    lo propaga a la pierna correcta de cada ancestro.
	if _, err := tx.Exec(ctx, `
		INSERT INTO mlm.tree_event (external_ref, kind, affiliate_id, pv_delta_left, pv_delta_right)
		VALUES ($1, 'pv_credit', $2, $3, 0)
		ON CONFLICT (external_ref) DO NOTHING
	`, "package_purchase:"+paymentIntentID, affID, pv); err != nil {
		return ActivationResult{}, fmt.Errorf("pv credit: %w", err)
	}

	// 4. Finalizar intent.
	if _, err := tx.Exec(ctx, `
		UPDATE payments.purchase_intent
		   SET status = 'activated', affiliate_id = $2, activated_at = now(), updated_at = now()
		 WHERE id = $1
	`, intentID, affID); err != nil {
		return ActivationResult{}, fmt.Errorf("finalize intent: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return ActivationResult{}, fmt.Errorf("commit: %w", err)
	}
	return ActivationResult{Status: "activated", AffiliateID: affID}, nil
}

// autoPlaceAffiliate coloca al comprador bajo su sponsor siguiendo la regla
// weak-leg (pierna con menor PV; desempate por conteo, luego 'L'). Race-safe vía
// pg_advisory_xact_lock(sponsor) + FOR UPDATE al descender. Port fiel de
// backend/app/src/server/affiliate.ts::autoPlaceAffiliate.
func autoPlaceAffiliate(ctx context.Context, tx pgx.Tx, personID, sponsorID int64) (int64, error) {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, sponsorID); err != nil {
		return 0, fmt.Errorf("advisory lock: %w", err)
	}

	currentID := sponsorID
	const preferred = "L"

	for safety := 0; safety < 64; safety++ {
		// Pierna débil del nodo actual (calculada en SQL para no escanear numeric).
		var side string
		err := tx.QueryRow(ctx, `
			SELECT CASE
			         WHEN left_pv_current < right_pv_current THEN 'L'
			         WHEN right_pv_current < left_pv_current THEN 'R'
			         WHEN left_count < right_count THEN 'L'
			         WHEN right_count < left_count THEN 'R'
			         ELSE $2
			       END
			  FROM mlm.affiliate
			 WHERE id = $1
			 FOR UPDATE
		`, currentID, preferred).Scan(&side)
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, fmt.Errorf("node %d not found", currentID)
		}
		if err != nil {
			return 0, fmt.Errorf("weak-leg select: %w", err)
		}

		// ¿La pierna elegida está ocupada?
		var childID int64
		err = tx.QueryRow(ctx, `
			SELECT id FROM mlm.affiliate WHERE parent_id = $1 AND position = $2 LIMIT 1
		`, currentID, side).Scan(&childID)
		if errors.Is(err, pgx.ErrNoRows) {
			// Hueco encontrado → insertar (trigger fn_compute_affiliate_path llena path/depth).
			var newID int64
			if err := tx.QueryRow(ctx, `
				INSERT INTO mlm.affiliate (person_id, parent_id, position, sponsor_id, path, depth, status)
				VALUES ($1, $2, $3, $4, ''::ltree, 0, 'active')
				RETURNING id
			`, personID, currentID, side, sponsorID).Scan(&newID); err != nil {
				return 0, fmt.Errorf("insert affiliate: %w", err)
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO mlm.tree_event (external_ref, kind, affiliate_id, occurred_at)
				VALUES ($1, 'enrollment', $2, now())
				ON CONFLICT (external_ref) DO NOTHING
			`, fmt.Sprintf("enroll:%d", newID), newID); err != nil {
				return 0, fmt.Errorf("enrollment event: %w", err)
			}
			return newID, nil
		}
		if err != nil {
			return 0, fmt.Errorf("child lookup: %w", err)
		}
		currentID = childID // descender
	}
	return 0, errors.New("auto_place_depth_exceeded")
}
