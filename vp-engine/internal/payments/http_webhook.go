package payments

import (
	"context"
	"encoding/json"
	"errors"
	stripe "github.com/stripe/stripe-go/v85"
	"io"
	"net/http"
	"strings"
)

const maxWebhookBody = int64(1 << 18) // 256 KiB

// ── Webhook ──────────────────────────────────────────────────────────────────

func (h *Handler) handleWebhook(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxWebhookBody)
	payload, err := io.ReadAll(r.Body)
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "read_body")
		return
	}

	event, err := h.gw.ConstructEvent(payload, r.Header.Get("Stripe-Signature"))
	if err != nil {
		h.log.Warn().Err(err).Msg("webhook signature verification failed")
		writeErr(w, http.StatusBadRequest, "invalid_signature")
		return
	}

	// Audit (best-effort): registra el evento. No es un gate — la idempotencia
	// real vive en el ledger (external_ref), así que re-procesar es seguro.
	if dup, derr := h.store.EventSeen(r.Context(), event.ID, string(event.Type)); derr != nil {
		h.log.Warn().Err(derr).Str("event", event.ID).Msg("record stripe_event")
	} else if dup {
		h.log.Info().Str("event", event.ID).Str("type", string(event.Type)).Msg("duplicate event (reprocessing, downstream idempotent)")
	}

	switch event.Type {
	case "checkout.session.completed", "checkout.session.async_payment_succeeded":
		if err := h.handlePaid(r.Context(), event); err != nil {
			// 500 ⇒ Stripe reintenta con backoff. Seguro: todo el flujo es idempotente.
			h.log.Error().Err(err).Str("event", event.ID).Msg("process paid event")
			writeErr(w, http.StatusInternalServerError, "processing_error")
			return
		}
	case "checkout.session.async_payment_failed", "payment_intent.payment_failed":
		h.markIntentFromEvent(r.Context(), event, "failed")
	case "checkout.session.expired":
		h.markIntentFromEvent(r.Context(), event, "expired")
	case "charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed":
		h.markRiskFromDispute(r.Context(), event)
	case "review.closed":
		h.markRiskFromReview(r.Context(), event)
	default:
		h.log.Debug().Str("type", string(event.Type)).Msg("unhandled event type")
	}

	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"received":true}`))
}

// markIntentFromEvent extrae el session/payment_intent id de un evento Stripe de
// fallo o expiración y marca el purchase_intent correspondiente (failed/expired).
// Best-effort: loguea y NO falla el webhook (respondemos 200; Stripe no reintenta
// estos eventos). Saca el id según el tipo de objeto del evento.
func (h *Handler) markIntentFromEvent(ctx context.Context, event stripe.Event, newStatus string) {
	var sessionID, piID, intentID string
	if strings.HasPrefix(string(event.Type), "checkout.session.") {
		var cs stripe.CheckoutSession
		if err := json.Unmarshal(event.Data.Raw, &cs); err != nil {
			h.log.Warn().Err(err).Str("event", event.ID).Msg("unmarshal checkout.session (fail/expire)")
			return
		}
		sessionID = cs.ID
		if cs.PaymentIntent != nil {
			piID = cs.PaymentIntent.ID
		}
		if cs.Metadata[MetadataProductTag] == MetadataProductVal {
			intentID = strings.TrimSpace(cs.Metadata["purchase_intent_id"])
		}
	} else {
		var pi stripe.PaymentIntent
		if err := json.Unmarshal(event.Data.Raw, &pi); err != nil {
			h.log.Warn().Err(err).Str("event", event.ID).Msg("unmarshal payment_intent (fail)")
			return
		}
		piID = pi.ID
		if pi.Metadata[MetadataProductTag] == MetadataProductVal {
			intentID = strings.TrimSpace(pi.Metadata["purchase_intent_id"])
		}
	}
	n, err := h.store.MarkIntentStatus(ctx, sessionID, piID, newStatus)
	if err == nil && n == 0 && intentID != "" {
		n, err = h.store.MarkIntentStatusByIntentID(ctx, intentID, piID, newStatus)
	}
	if err != nil {
		h.log.Error().Err(err).Str("event", event.ID).Str("status", newStatus).Msg("mark intent status")
		return
	}
	if n > 0 {
		h.log.Info().Str("event", event.ID).Str("status", newStatus).Int64("intents", n).Msg("payment intent marked")
	}
}

func (h *Handler) markRiskFromDispute(ctx context.Context, event stripe.Event) {
	var d stripe.Dispute
	if err := json.Unmarshal(event.Data.Raw, &d); err != nil {
		h.log.Warn().Err(err).Str("event", event.ID).Msg("unmarshal dispute")
		return
	}

	status := "disputed"
	switch d.Status {
	case stripe.DisputeStatusLost:
		status = "chargeback"
	case stripe.DisputeStatusPrevented:
		status = "security_blocked"
	}

	piID := paymentIntentID(d.PaymentIntent)
	if piID == "" && d.Charge != nil {
		piID = paymentIntentID(d.Charge.PaymentIntent)
	}
	h.markRiskStatus(ctx, event.ID, piID, status)
}

func (h *Handler) markRiskFromReview(ctx context.Context, event stripe.Event) {
	var r stripe.Review
	if err := json.Unmarshal(event.Data.Raw, &r); err != nil {
		h.log.Warn().Err(err).Str("event", event.ID).Msg("unmarshal review")
		return
	}

	status := ""
	switch r.ClosedReason {
	case stripe.ReviewClosedReasonDisputed:
		status = "disputed"
	case stripe.ReviewClosedReasonCanceled,
		stripe.ReviewClosedReasonPaymentNeverSettled,
		stripe.ReviewClosedReasonRefunded,
		stripe.ReviewClosedReasonRefundedAsFraud:
		status = "security_blocked"
	default:
		return
	}

	piID := paymentIntentID(r.PaymentIntent)
	if piID == "" && r.Charge != nil {
		piID = paymentIntentID(r.Charge.PaymentIntent)
	}
	h.markRiskStatus(ctx, event.ID, piID, status)
}

func (h *Handler) markRiskStatus(ctx context.Context, eventID, paymentIntentID, status string) {
	if paymentIntentID == "" {
		h.log.Warn().Str("event", eventID).Str("status", status).Msg("risk event without payment_intent")
		return
	}
	n, err := h.store.MarkIntentRiskStatus(ctx, paymentIntentID, status)
	if err != nil {
		h.log.Error().Err(err).Str("event", eventID).Str("pi", paymentIntentID).Str("status", status).Msg("mark intent risk status")
		return
	}
	if n > 0 {
		h.log.Info().Str("event", eventID).Str("pi", paymentIntentID).Str("status", status).Int64("intents", n).Msg("payment intent risk marked")
	}
}

func paymentIntentID(pi *stripe.PaymentIntent) string {
	if pi == nil {
		return ""
	}
	return pi.ID
}

func (h *Handler) handlePaid(ctx context.Context, event stripe.Event) error {
	var cs stripe.CheckoutSession
	if err := json.Unmarshal(event.Data.Raw, &cs); err != nil {
		return err
	}
	// Guard de cuenta compartida: la cuenta Stripe la comparten varios negocios.
	// Solo activamos sesiones marcadas como "PACK MINDBLISS" (estampado en
	// CreateCheckout). Un evento ajeno que llegue aquí se ignora sin error (200)
	// para no forzar reintentos de Stripe. Defensa-en-profundidad: el flujo ya
	// rechaza sesiones sin purchase_intent, pero este gate lo hace explícito.
	if cs.Metadata[MetadataProductTag] != MetadataProductVal {
		h.log.Warn().Str("session", cs.ID).Str("event", event.ID).
			Msg("checkout.session sin marca packmindbliss; ignorando (cuenta compartida)")
		return nil
	}
	// `payment` mode async (crypto/ACH) puede llegar como completed con
	// payment_status 'unpaid' → solo activar cuando esté pagado.
	if cs.PaymentStatus != stripe.CheckoutSessionPaymentStatusPaid {
		h.log.Info().Str("session", cs.ID).Str("payment_status", string(cs.PaymentStatus)).Msg("session not yet paid; waiting for async_payment_succeeded")
		return nil
	}

	piID := ""
	if cs.PaymentIntent != nil {
		piID = cs.PaymentIntent.ID
	}
	if piID == "" {
		piID = "sess:" + cs.ID // fallback de idempotencia si no llegó el payment_intent
	}
	intentID := strings.TrimSpace(cs.Metadata["purchase_intent_id"])

	// Activación atómica e idempotente (marca pagado + coloca + liga paquete + PV).
	res, err := h.store.ActivatePaidPurchaseForIntent(ctx, cs.ID, piID, intentID)
	if errors.Is(err, ErrIntentNotFound) {
		// Sesión desconocida (creada fuera de este servicio). No reintentar.
		h.log.Warn().Str("session", cs.ID).Msg("paid session has no purchase_intent; skipping")
		return nil
	}
	if err != nil {
		return err // 500 → Stripe reintenta; todo el flujo es idempotente
	}

	switch res.Status {
	case "activated":
		h.log.Info().Str("session", cs.ID).Str("pi", piID).Int64("affiliate_id", res.AffiliateID).Msg("payment confirmed → package activated")
	case "needs_placement":
		// Pago OK pero sin sponsor para colocar: requiere acción de ops/sponsor.
		h.log.Warn().Str("session", cs.ID).Str("pi", piID).Msg("paid but NEEDS MANUAL PLACEMENT (no sponsor)")
	case "security_blocked":
		h.log.Warn().Str("session", cs.ID).Str("pi", piID).Msg("paid session blocked by ban engine; not placed in tree")
	case "replay":
		h.log.Info().Str("session", cs.ID).Msg("activation replay (already activated)")
	}
	// Nota: el asiento contable (capital + 1% platform_fee en wallet_movement)
	// queda diferido y se concilia aparte (ver docs). No bloquea la activación.
	return nil
}
