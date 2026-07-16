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

	// Marcar pagado (idempotente). stripe_present=true: este pago llegó por el
	// webhook de Stripe live, así que el cargo es real (a diferencia de registros
	// de prueba sembrados que quedan con stripe_present NULL/false).
	if _, err := tx.Exec(ctx, `
		UPDATE payments.purchase_intent
		   SET status = 'paid',
		       stripe_payment_intent_id = $2,
		       paid_at = COALESCE(paid_at, now()),
		       stripe_present = true,
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
			// Dinero recibido aunque sin colocar: comprobante + evento (best-effort).
			s.afterPaymentConfirmed(ctx, intentID, "payment.paid", nil)
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

	// 2b. Abrir el CD de inversión: ROI diario por tier (25% base → tasa calificada
	//     con 2 directos), principal bloqueado cd_lock_days (365). El tier se
	//     resuelve por el monto del paquete; matures_at = now + cd_lock_days del
	//     plan activo. Idempotente por affiliate_package (NOT EXISTS). El devengo
	//     diario lo hace el motor (bonusengine.AccrueCDROIDaily, concepto 1006).
	if _, err := tx.Exec(ctx, `
		INSERT INTO mlm.investment_cd (affiliate_id, affiliate_package_id, principal_usd, roi_tier_id, matures_at)
		SELECT $1, ap.id, p.amount_usd,
		       (SELECT id FROM mlm.cd_roi_tier
		         WHERE min_amount_usd <= p.amount_usd
		           AND (max_amount_usd IS NULL OR p.amount_usd < max_amount_usd)
		           AND active
		         ORDER BY id DESC LIMIT 1),
		       now() + (COALESCE((
		           SELECT cd_lock_days FROM mlm.plan_config
		            WHERE effective_from <= now() AND (effective_to IS NULL OR effective_to > now())
		            ORDER BY effective_from DESC LIMIT 1), 365) || ' days')::interval
		  FROM mlm.affiliate_package ap
		  JOIN mlm.package p ON p.id = ap.package_id
		 WHERE ap.affiliate_id = $1 AND ap.transaction_hash = $2
		   AND NOT EXISTS (SELECT 1 FROM mlm.investment_cd cd WHERE cd.affiliate_package_id = ap.id)
		   AND EXISTS (SELECT 1 FROM mlm.cd_roi_tier
		                WHERE min_amount_usd <= p.amount_usd
		                  AND (max_amount_usd IS NULL OR p.amount_usd < max_amount_usd) AND active)
	`, affID, paymentIntentID); err != nil {
		return ActivationResult{}, fmt.Errorf("open investment_cd: %w", err)
	}

	// 2c. Asegurar wallet USD del afiliado (para que el ROI/comisiones tengan dónde
	//     postearse). Idempotente.
	if _, err := tx.Exec(ctx, `
		INSERT INTO mlm.wallet (affiliate_id, asset_id, address, balance)
		SELECT $1, (SELECT id FROM mlm.asset WHERE symbol='USD' LIMIT 1), $2, 0
		 WHERE EXISTS (SELECT 1 FROM mlm.asset WHERE symbol='USD')
		   AND NOT EXISTS (
		       SELECT 1 FROM mlm.wallet w JOIN mlm.asset s ON s.id = w.asset_id
		        WHERE w.affiliate_id = $1 AND s.symbol='USD')
	`, affID, fmt.Sprintf("ledger:%d", affID)); err != nil {
		return ActivationResult{}, fmt.Errorf("ensure usd wallet: %w", err)
	}

	// 2d. Registrar el INFLOW en el ledger (concepto 1004 package_purchase, +monto)
	//     en la wallet USD del comprador. Esto es lo que el motor binario suma como
	//     inflows del período (α×inflows = techo de bonos / θ). Idempotente por
	//     external_ref. NO es ganancia del miembro: member.go/finance.go excluyen
	//     package_purchase de los balances retirables.
	if _, err := tx.Exec(ctx, `
		WITH txn AS (
		  INSERT INTO mlm.transaction (external_ref, description, status, posted_at)
		  VALUES ('pkgbuy:'||$2, 'Compra de pack (inflow)', 'posted', now())
		  ON CONFLICT (external_ref) DO NOTHING
		  RETURNING id)
		INSERT INTO mlm.wallet_movement (transaction_id, wallet_id, affiliate_id, concept_id, amount, posted_at)
		SELECT t.id, w.id, $1, 1004, pi.amount_usd, now()
		  FROM txn t
		  JOIN mlm.wallet w ON w.affiliate_id = $1 AND w.asset_id = (SELECT id FROM mlm.asset WHERE symbol='USD')
		  JOIN payments.purchase_intent pi ON pi.stripe_session_id = $3
	`, affID, paymentIntentID, sessionID); err != nil {
		return ActivationResult{}, fmt.Errorf("post inflow: %w", err)
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
	// Nueva compra/activación → cambian inflows, packs y el período → invalidar
	// los agregados cacheados (el resumen del miembro se refresca por TTL).
	s.cache.del(ctx, "fin:admin", "solvency")
	// Evento de dominio enriquecido (feed) + comprobante al cliente (best-effort).
	s.afterPaymentConfirmed(ctx, intentID, "payment.activated", &affID)
	return ActivationResult{Status: "activated", AffiliateID: affID}, nil
}

// afterPaymentConfirmed corre TRAS el commit de un pago confirmado (best-effort):
//  (1) publica el evento de dominio enriquecido (email/plan/monto) para el feed
//      de actividad del panel, y
//  (2) envía el comprobante de compra al cliente UNA sola vez (claim atómico
//      sobre receipt_sent_at, anti-doble-envío; libera el claim si el correo
//      falla para permitir reintento vía el sweep de reconciliación).
// Nunca retorna error: cualquier fallo se loguea y no afecta la activación.
func (s *Store) afterPaymentConfirmed(ctx context.Context, intentID, eventType string, affID *int64) {
	var email, name, plan, amount, total, ref, paidAt string
	err := s.db.QueryRow(ctx, `
		SELECT pi.user_id,
		       COALESCE((SELECT trim(p.first_name||' '||p.last_name) FROM mlm.person p WHERE p.id = pi.person_id), ''),
		       pk.name, pi.amount_usd::text, (pi.amount_usd + pi.fee_usd)::text,
		       COALESCE(pi.stripe_payment_intent_id, ''),
		       COALESCE(to_char(pi.paid_at,'YYYY-MM-DD'), '')
		  FROM payments.purchase_intent pi
		  JOIN mlm.package pk ON pk.id = pi.package_id
		 WHERE pi.id = $1
	`, intentID).Scan(&email, &name, &plan, &amount, &total, &ref, &paidAt)
	if err != nil {
		s.log.Error().Err(err).Str("intent", intentID).Msg("post-pago: cargar datos")
		return
	}

	// (1) Evento de dominio enriquecido (fan-out async vía Redis Stream).
	if s.cache != nil {
		payload := map[string]any{"email": email, "plan": plan, "amount_usd": amount, "reference": ref}
		if affID != nil {
			payload["affiliate_id"] = *affID
		}
		s.cache.PublishEvent(ctx, eventType, payload)
	}

	// (2) Comprobante al cliente — claim atómico anti-doble-envío.
	ct, err := s.db.Exec(ctx,
		`UPDATE payments.purchase_intent SET receipt_sent_at = now() WHERE id = $1 AND receipt_sent_at IS NULL`,
		intentID)
	if err != nil {
		s.log.Error().Err(err).Str("intent", intentID).Msg("comprobante: claim")
		return
	}
	if ct.RowsAffected() == 0 {
		return // ya enviado antes (idempotente)
	}
	subject := "Confirmación de tu compra — MindBliss Power"
	greeting := "Hola"
	if name != "" {
		greeting = "Hola " + name
	}
	body := fmt.Sprintf(`%s,

¡Gracias por tu compra en MindBliss Power! Tu pago fue confirmado.

  Membresía:  %s
  Monto:      $%s USD
  Total:      $%s USD (incluye 1%% de activación)
  Referencia: %s
  Fecha:      %s

Ya puedes ingresar a tu panel para ver tu membresía activa.

— Equipo MindBliss Power
Este es un mensaje automático; por favor no respondas a este correo.`,
		greeting, plan, amount, total, ref, paidAt)

	if err := s.SendEmail(ctx, []string{email}, subject, body); err != nil {
		s.log.Error().Err(err).Str("intent", intentID).Str("to", email).Msg("comprobante: envío falló")
		// Liberar el claim para permitir reintento (p.ej. por el sweep de reconciliación).
		if _, rerr := s.db.Exec(ctx,
			`UPDATE payments.purchase_intent SET receipt_sent_at = NULL WHERE id = $1`, intentID); rerr != nil {
			s.log.Error().Err(rerr).Str("intent", intentID).Msg("comprobante: liberar claim")
		}
		return
	}
	s.log.Info().Str("intent", intentID).Str("to", email).Msg("comprobante de compra enviado")
}

// autoPlaceAffiliate coloca al comprador bajo su sponsor siguiendo la regla
// weak-leg (pierna con menor PV; desempate por conteo, luego 'L'). Race-safe vía
// pg_advisory_xact_lock(sponsor) + FOR UPDATE al descender. Port fiel de
// backend/app/src/server/affiliate.ts::autoPlaceAffiliate.
func autoPlaceAffiliate(ctx context.Context, tx pgx.Tx, personID, sponsorID int64) (int64, error) {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, sponsorID); err != nil {
		return 0, fmt.Errorf("advisory lock: %w", err)
	}

	const preferred = "L"

	// Descenso weak-leg SET-BASED: un solo CTE recursivo baja desde el sponsor
	// eligiendo en cada nodo la pierna débil (menor PV; desempate por conteo,
	// luego 'L') y siguiendo el hijo de esa pierna, hasta el primer hueco (el
	// nodo más profundo cuya pierna elegida no tiene hijo). Reemplaza el loop de
	// O(prof) round-trips (~382 a prof 191) por 1 query, encogiendo la ventana del
	// advisory_lock(sponsor) → mucha más throughput de colocación concurrente.
	//
	// Race-safety: el advisory lock serializa las colocaciones del MISMO sponsor.
	// El INSERT usa ON CONFLICT (parent_id, position): si una colocación
	// CROSS-sponsor concurrente tomó el hueco (posible cuando los subárboles se
	// solapan), 0 filas → re-descendemos (el CTE ya ve la fila nueva bajo READ
	// COMMITTED). El reintento sustituye al FOR UPDATE por-nodo del descenso viejo.
	// Tope de profundidad 512: el bosque migrado llega a ~191 niveles.
	for attempt := 0; attempt < 16; attempt++ {
		var parentID int64
		var side string
		err := tx.QueryRow(ctx, `
			WITH RECURSIVE walk AS (
			  SELECT a.id AS node_id,
			         CASE WHEN a.left_pv_current < a.right_pv_current THEN 'L'
			              WHEN a.right_pv_current < a.left_pv_current THEN 'R'
			              WHEN a.left_count < a.right_count THEN 'L'
			              WHEN a.right_count < a.left_count THEN 'R'
			              ELSE $2 END AS side,
			         0 AS lvl
			    FROM mlm.affiliate a
			   WHERE a.id = $1
			  UNION ALL
			  SELECT c.id,
			         CASE WHEN c.left_pv_current < c.right_pv_current THEN 'L'
			              WHEN c.right_pv_current < c.left_pv_current THEN 'R'
			              WHEN c.left_count < c.right_count THEN 'L'
			              WHEN c.right_count < c.left_count THEN 'R'
			              ELSE $2 END,
			         w.lvl + 1
			    FROM walk w
			    JOIN mlm.affiliate c
			      ON c.parent_id = w.node_id AND c.position = w.side::mlm.tree_position
			   WHERE w.lvl < 512
			)
			SELECT node_id, side FROM walk
			 ORDER BY lvl DESC
			 LIMIT 1
		`, sponsorID, preferred).Scan(&parentID, &side)
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, fmt.Errorf("node %d not found", sponsorID)
		}
		if err != nil {
			return 0, fmt.Errorf("weak-leg descent: %w", err)
		}

		// Insertar en el hueco (trigger fn_compute_affiliate_path llena path/depth).
		// ON CONFLICT (parent_id, position): si el slot ya se tomó, 0 filas → reintentar.
		var newID int64
		err = tx.QueryRow(ctx, `
			INSERT INTO mlm.affiliate (person_id, parent_id, position, sponsor_id, path, depth, status)
			VALUES ($1, $2, $3::mlm.tree_position, $4, ''::ltree, 0, 'active')
			ON CONFLICT (parent_id, position) WHERE parent_id IS NOT NULL DO NOTHING
			RETURNING id
		`, personID, parentID, side, sponsorID).Scan(&newID)
		if errors.Is(err, pgx.ErrNoRows) {
			continue // slot tomado por colocación concurrente → re-descender
		}
		if err != nil {
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
	return 0, errors.New("auto_place_retries_exhausted")
}
