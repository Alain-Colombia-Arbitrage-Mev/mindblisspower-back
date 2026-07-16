package payments

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"
)

// ReconcileCandidate es un purchase_intent sin activar que podría estar pagado en
// Stripe (webhook perdido). Se resuelve consultando la sesión a Stripe.
type ReconcileCandidate struct {
	IntentID  string `json:"intent_id"`
	SessionID string `json:"session_id"`
	Status    string `json:"status"`
}

// ListReconcileCandidates lista intents NO activados con sesión Stripe, de más de
// `minAge` de antigüedad (para no competir con el webhook normal) y menos de 30
// días. Solo estados recuperables por activación automática ('created','paid');
// 'needs_placement' requiere intervención manual y se excluye.
func (s *Store) ListReconcileCandidates(ctx context.Context, minAge time.Duration, limit int) ([]ReconcileCandidate, error) {
	rows, err := s.reader().Query(ctx, `
		SELECT id::text, stripe_session_id, status
		  FROM payments.purchase_intent
		 WHERE status IN ('created','paid')
		   AND stripe_session_id IS NOT NULL AND stripe_session_id <> ''
		   AND created_at < now() - $1::interval
		   AND created_at > now() - interval '30 days'
		 ORDER BY created_at
		 LIMIT $2`,
		fmt.Sprintf("%d seconds", int(minAge.Seconds())), limit)
	if err != nil {
		return nil, fmt.Errorf("list reconcile candidates: %w", err)
	}
	defer rows.Close()

	out := []ReconcileCandidate{}
	for rows.Next() {
		var c ReconcileCandidate
		if err := rows.Scan(&c.IntentID, &c.SessionID, &c.Status); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// SweepResult resume una pasada del sweep de reconciliación.
type SweepResult struct {
	Checked   int `json:"checked"`    // candidatos consultados a Stripe
	PaidFound int `json:"paid_found"` // sesiones que Stripe reporta pagadas
	Activated int `json:"activated"`  // realmente activadas en esta pasada
	Errors    int `json:"errors"`     // fallos por candidato (no fatales)
}

// ReconcileStuckPayments busca intents no activados, pregunta a Stripe si su
// sesión está pagada y, de estarlo, re-ejecuta la activación (idempotente). Cubre
// el caso de webhook perdido (vp-payments caído más allá de la ventana de
// reintentos de Stripe). NO cubre ventas por Payment Link sin purchase_intent —
// esas no tienen fila que activar y se reportan solo vía el delta de conciliación.
func (h *Handler) ReconcileStuckPayments(ctx context.Context, minAge time.Duration, limit int) (SweepResult, error) {
	var res SweepResult
	cands, err := h.store.ListReconcileCandidates(ctx, minAge, limit)
	if err != nil {
		return res, err
	}
	for _, c := range cands {
		res.Checked++
		paid, piID, serr := h.gw.SessionPaid(c.SessionID)
		if serr != nil {
			res.Errors++
			h.log.Warn().Err(serr).Str("session", c.SessionID).Msg("reconcile: stripe session lookup failed")
			continue
		}
		if !paid {
			continue
		}
		res.PaidFound++
		ar, aerr := h.store.ActivatePaidPurchase(ctx, c.SessionID, piID)
		if aerr != nil {
			if errors.Is(aerr, ErrIntentNotFound) {
				continue
			}
			res.Errors++
			h.log.Error().Err(aerr).Str("session", c.SessionID).Msg("reconcile: activation failed")
			continue
		}
		if ar.Status == "activated" {
			res.Activated++
			h.log.Info().Str("session", c.SessionID).Int64("affiliate", ar.AffiliateID).
				Msg("reconcile: recovered stuck payment (webhook lost)")
		}
	}
	return res, nil
}

// handleAdminSalesSweep: POST /api/admin/sales/sweep — dispara el sweep de
// reconciliación a demanda desde el panel. Usa minAge=0 (revisa todo, incluidos
// intents recientes) para dar feedback inmediato al operador.
func (h *Handler) handleAdminSalesSweep(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	res, err := h.ReconcileStuckPayments(r.Context(), 0, 500)
	if err != nil {
		h.log.Error().Err(err).Msg("admin sweep")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, res)
}
