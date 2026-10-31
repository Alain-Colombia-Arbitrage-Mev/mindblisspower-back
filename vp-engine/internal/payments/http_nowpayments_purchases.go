package payments

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"
)

const nowPurchasesPath = "/api/payments/nowpayments/purchases"

type nowPurchasePersistence interface {
	ListNOWPurchases(context.Context, string, string, string) (NOWPurchaseHistory, error)
	ResumeNOWPurchase(context.Context, string, string, string, string) (NOWPaymentsMembershipAttempt, error)
	CancelNOWPurchase(context.Context, string, string, string, string) (NOWPurchaseCancellationResult, error)
}

// These routes never call a provider. Resume reconstructs only a previously
// persisted, owner-checked invoice URL; cancel is expressly local abandonment.
func (h *Handler) nowPurchaseIdentity(w http.ResponseWriter, r *http.Request, method, path string) (nowPurchasePersistence, string, string, bool) {
	w.Header().Set("Cache-Control", "private, no-store")
	if r.Method != method || r.URL.Path != path || r.URL.RawPath != "" || r.URL.RawQuery != "" || r.URL.ForceQuery {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return nil, "", "", false
	}
	if !h.svcAuth(w, r) {
		return nil, "", "", false
	}
	flow := h.nowMemberships
	if !h.requireVerified || !validNOWPaymentsEnvironment(h.nowPurchaseEnvironment()) || (method != http.MethodGet && (flow == nil || !flow.operational)) {
		writeErr(w, http.StatusServiceUnavailable, "nowpayments-unavailable")
		return nil, "", "", false
	}
	var store nowPurchasePersistence
	if method == http.MethodGet && h.store != nil {
		store = h.store
	} else if flow != nil {
		store, _ = flow.store.(nowPurchasePersistence)
	}
	if store == nil {
		writeErr(w, http.StatusServiceUnavailable, "nowpayments-unavailable")
		return nil, "", "", false
	}
	verifier, ok := h.verifier.(nowSubjectVerifier)
	raw := strings.TrimSpace(r.Header.Get(idTokenHeader))
	if !ok || raw == "" || r.Header.Get(actAsHeader) != "" {
		writeErr(w, http.StatusUnauthorized, "id_token_required")
		return nil, "", "", false
	}
	subject, email, err := verifier.VerifySubject(r.Context(), raw)
	if err != nil || subject == "" || email == "" {
		writeErr(w, http.StatusUnauthorized, "invalid_id_token")
		return nil, "", "", false
	}
	return store, subject, email, true
}

func (h *Handler) nowPurchaseEnvironment() string {
	if h.nowCapture != nil {
		return h.nowCapture.environment
	}
	if h.nowMemberships != nil {
		return h.nowMemberships.environment
	}
	return ""
}

func (h *Handler) handleNOWPurchases(w http.ResponseWriter, r *http.Request) {
	store, subject, email, ok := h.nowPurchaseIdentity(w, r, http.MethodGet, nowPurchasesPath)
	if !ok {
		return
	}
	// Production history uses the dedicated report reader. The operational
	// writer remains confined to the explicit POST workflow below.
	if h.store != nil {
		store = h.store
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	history, err := store.ListNOWPurchases(ctx, h.nowPurchaseEnvironment(), subject, email)
	if err != nil {
		writeNOWPurchaseError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, history)
}

func decodeNOWPurchaseOrder(w http.ResponseWriter, r *http.Request) (string, bool) {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		writeErr(w, http.StatusUnsupportedMediaType, "json_required")
		return "", false
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	start, err := decoder.Token()
	var orderID string
	key, keyErr := decoder.Token()
	if err != nil || start != json.Delim('{') || keyErr != nil || key != "order_id" || decoder.Decode(&orderID) != nil || decoder.More() {
		writeErr(w, http.StatusBadRequest, "invalid_purchase_request")
		return "", false
	}
	end, err := decoder.Token()
	if err != nil || end != json.Delim('}') || !validNOWPaymentsOrderID(orderID) || !errors.Is(decoder.Decode(&struct{}{}), io.EOF) {
		writeErr(w, http.StatusBadRequest, "invalid_purchase_request")
		return "", false
	}
	return orderID, true
}

func (h *Handler) handleNOWPurchaseResume(w http.ResponseWriter, r *http.Request) {
	store, subject, email, ok := h.nowPurchaseIdentity(w, r, http.MethodPost, nowPurchasesPath+"/resume")
	if !ok {
		return
	}
	order, ok := decodeNOWPurchaseOrder(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	attempt, err := store.ResumeNOWPurchase(ctx, h.nowMemberships.environment, subject, email, order)
	if err != nil {
		writeNOWPurchaseError(w, err)
		return
	}
	invoiceURL, err := nowPurchaseInvoiceURL(h.nowMemberships.environment, attempt.InvoiceID)
	if err != nil || !attempt.Reused || !attempt.Reusable || attempt.ID != order {
		writeNOWPurchaseError(w, ErrNOWPurchaseCannotResume)
		return
	}
	total, err := nowPaymentsTotalUSD(attempt.TotalCents)
	if err != nil {
		writeNOWPurchaseError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, checkoutResponse{URL: invoiceURL, OrderID: order, Reused: true, Provider: "nowpayments", TotalUSD: total, FeeUSD: attempt.FeeUSD, FulfillmentStatus: "awaiting_payment"})
}

func (h *Handler) handleNOWPurchaseCancel(w http.ResponseWriter, r *http.Request) {
	store, subject, email, ok := h.nowPurchaseIdentity(w, r, http.MethodPost, nowPurchasesPath+"/cancel")
	if !ok {
		return
	}
	order, ok := decodeNOWPurchaseOrder(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	result, err := store.CancelNOWPurchase(ctx, h.nowMemberships.environment, subject, email, order)
	if err != nil {
		writeNOWPurchaseError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func writeNOWPurchaseError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrNOWPaymentsAttemptNotFound), errors.Is(err, ErrCheckoutIdentityReview):
		writeErr(w, http.StatusNotFound, "purchase_not_found")
	case errors.Is(err, ErrNOWPurchaseCannotResume):
		writeErr(w, http.StatusConflict, "purchase_cannot_resume")
	case errors.Is(err, ErrNOWPurchaseCannotCancel):
		writeErr(w, http.StatusConflict, "purchase_cannot_cancel")
	case errors.Is(err, ErrNOWPaymentsEvidence), errors.Is(err, ErrNOWPurchaseRequestInvalid):
		writeErr(w, http.StatusBadRequest, "invalid_purchase_request")
	default:
		writeErr(w, http.StatusServiceUnavailable, "purchase_service_unavailable")
	}
}
