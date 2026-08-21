package payments

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var (
	ErrRefundGatewayUnavailable = errors.New("refund gateway unavailable")
	ErrRefundNotAllowed         = errors.New("refund not allowed for current status")
	ErrRefundMissingPI          = errors.New("refund requires stripe payment_intent")
	ErrRefundAmountMismatch     = errors.New("refund amount must match full payment total")
)

type RefundResult struct {
	IntentID           string `json:"id"`
	Status             string `json:"status"`
	RefundID           string `json:"refund_id,omitempty"`
	PaymentIntentID    string `json:"payment_intent_id,omitempty"`
	PreviousStatus     string `json:"previous_status,omitempty"`
	AmountCents        int64  `json:"amount_cents,omitempty"`
	RefundUSD          string `json:"refund_usd,omitempty"`
	AlreadyRefunded    bool   `json:"already_refunded,omitempty"`
	StripeRefundReason string `json:"stripe_refund_reason,omitempty"`
}

// handleAdminPaymentRefund: POST /api/admin/payments/refund {id, reason}
// Ejecuta un reembolso completo en Stripe y marca el purchase_intent como
// refunded. Por riesgo operativo, solo super_admin.
func (h *Handler) handleAdminPaymentRefund(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	adminEmail, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	if !h.isSuperAdmin(adminEmail) {
		writeErr(w, http.StatusForbidden, "super_admin_required")
		return
	}
	var req struct {
		ID          string `json:"id"`
		Reason      string `json:"reason"`
		AmountCents int64  `json:"amount_cents"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}
	req.ID = strings.TrimSpace(req.ID)
	if _, err := uuid.Parse(req.ID); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_payment_id")
		return
	}
	res, err := h.store.RefundPurchaseIntent(r.Context(), h.gw, req.ID, req.AmountCents, req.Reason, adminEmail)
	if errors.Is(err, ErrIntentNotFound) {
		writeErr(w, http.StatusNotFound, "payment_not_found")
		return
	}
	if errors.Is(err, ErrRefundGatewayUnavailable) {
		writeErr(w, http.StatusServiceUnavailable, "stripe_unconfigured")
		return
	}
	if errors.Is(err, ErrRefundNotAllowed) {
		writeErr(w, http.StatusConflict, "refund_not_allowed")
		return
	}
	if errors.Is(err, ErrRefundMissingPI) {
		writeErr(w, http.StatusConflict, "missing_payment_intent")
		return
	}
	if errors.Is(err, ErrRefundAmountMismatch) {
		writeErr(w, http.StatusBadRequest, "refund_amount_mismatch")
		return
	}
	if err != nil {
		h.log.Error().Err(err).Str("payment_id", req.ID).Str("admin", adminEmail).Msg("admin payment refund")
		writeErr(w, http.StatusBadGateway, "refund_failed")
		return
	}
	h.log.Info().
		Str("payment_id", res.IntentID).
		Str("refund_id", res.RefundID).
		Str("previous_status", res.PreviousStatus).
		Str("admin", adminEmail).
		Msg("admin payment refunded")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "refund": res})
}

func (s *Store) RefundPurchaseIntent(ctx context.Context, gw *StripeGateway, intentID string, amountCents int64, note, adminEmail string) (RefundResult, error) {
	if gw == nil {
		return RefundResult{}, ErrRefundGatewayUnavailable
	}
	intentID = strings.TrimSpace(intentID)
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return RefundResult{}, fmt.Errorf("refund begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var res RefundResult
	var totalCents int64
	err = tx.QueryRow(ctx, `
		SELECT id::text, status, COALESCE(stripe_payment_intent_id,''), total_cents,
		       COALESCE(refund_cents, 0), COALESCE((refund_cents::numeric / 100)::text, '0')
		  FROM payments.purchase_intent
		 WHERE id = $1::uuid
		 FOR UPDATE
	`, intentID).Scan(&res.IntentID, &res.PreviousStatus, &res.PaymentIntentID, &totalCents, &res.AmountCents, &res.RefundUSD)
	if errors.Is(err, pgx.ErrNoRows) {
		return RefundResult{}, ErrIntentNotFound
	}
	if err != nil {
		return RefundResult{}, fmt.Errorf("refund load intent: %w", err)
	}

	if res.PreviousStatus == "refunded" {
		res.Status = "refunded"
		res.AlreadyRefunded = true
		return res, nil
	}
	if !refundAllowedStatus(res.PreviousStatus) {
		return res, ErrRefundNotAllowed
	}
	if res.PaymentIntentID == "" || !strings.HasPrefix(res.PaymentIntentID, "pi_") {
		return res, ErrRefundMissingPI
	}
	if amountCents <= 0 {
		amountCents = totalCents
	}
	if amountCents != totalCents {
		return res, ErrRefundAmountMismatch
	}

	stripeReason := normalizeStripeRefundReason(note)
	res.StripeRefundReason = stripeReason
	res.AmountCents = amountCents
	res.RefundUSD = centsToUSD(amountCents)
	refundID, err := gw.RefundPaymentIntent(res.PaymentIntentID, amountCents, stripeReason, refundMetadata(intentID, adminEmail, note, amountCents))
	if err != nil {
		return res, err
	}
	res.RefundID = refundID
	res.Status = "refunded"

	if _, err := tx.Exec(ctx, `
		UPDATE payments.purchase_intent
		   SET status = 'refunded',
		       stripe_present = true,
		       refund_cents = $2,
		       refunded_at = now(),
		       stripe_refund_id = $3,
		       refund_reason = NULLIF($4, ''),
		       refunded_by = lower(NULLIF($5, '')),
		       updated_at = now()
		 WHERE id = $1::uuid
	`, intentID, amountCents, refundID, strings.TrimSpace(note), strings.TrimSpace(adminEmail)); err != nil {
		return res, fmt.Errorf("refund mark intent: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return res, fmt.Errorf("refund commit: %w", err)
	}
	return res, nil
}

func refundAllowedStatus(status string) bool {
	switch status {
	case "paid", "activated", "needs_placement", "security_blocked":
		return true
	default:
		return false
	}
}

func normalizeStripeRefundReason(note string) string {
	switch strings.ToLower(strings.TrimSpace(note)) {
	case "duplicate", "duplicado":
		return "duplicate"
	case "fraudulent", "fraud", "fraude", "security", "seguridad":
		return "fraudulent"
	default:
		return "requested_by_customer"
	}
}

func refundMetadata(intentID, adminEmail, note string, amountCents int64) map[string]string {
	return map[string]string{
		"packmindbliss":      "true",
		"purchase_intent_id": strings.TrimSpace(intentID),
		"admin_refund":       "true",
		"admin_email":        strings.ToLower(strings.TrimSpace(adminEmail)),
		"admin_refund_note":  truncateStripeMetadata(note),
		"refund_cents":       fmt.Sprint(amountCents),
	}
}

func centsToUSD(cents int64) string {
	return fmt.Sprintf("%d.%02d", cents/100, cents%100)
}

func truncateStripeMetadata(s string) string {
	s = strings.TrimSpace(s)
	if len(s) <= 450 {
		return s
	}
	return s[:450]
}
