package payments

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/vicionpower/vp-engine/internal/nowpayments"
)

var errMembershipProvider = errors.New("invalid membership payment provider")

func membershipProvider(raw string) (string, error) {
	switch raw {
	case "", "stripe":
		return "stripe", nil
	case "nowpayments":
		return "nowpayments", nil
	default:
		return "", errMembershipProvider
	}
}

type nowMembershipClient interface {
	CreateInvoice(context.Context, nowpayments.InvoiceRequest) (nowpayments.Invoice, error)
	GetPayment(context.Context, string) (nowpayments.Payment, error)
	VerifyIPN([]byte, string) (nowpayments.Payment, error)
}

type nowMembershipPersistence interface {
	CreateNOWPaymentsMembership(context.Context, NOWPaymentsMembershipInput) (NOWPaymentsMembershipAttempt, error)
	AttachNOWPaymentsInvoice(context.Context, string, string, string) error
	MarkNOWPaymentsInvoiceUnknown(context.Context, string, string) error
	LookupNOWPaymentsMembership(context.Context, string, string) (NOWPaymentsMembershipAttempt, error)
	RecordNOWPaymentsReceipt(context.Context, string, nowpayments.Payment, nowpayments.Payment, string) (NOWPaymentsReceiptResult, error)
}

type nowPaymentsMemberships struct {
	client                                          nowMembershipClient
	store                                           nowMembershipPersistence
	environment, callbackURL, successURL, cancelURL string
	operational                                     bool
}

// SetNOWPayments configures an explicitly opted-in membership REVIEW flow, not
// the Stripe activator or wallet deposits. Production's read-only config never
// calls it. Merely setting provider credentials cannot opt into collecting money.
func (h *Handler) SetNOWPayments(client *nowpayments.Client, environment, callbackURL, successURL, cancelURL string) error {
	if client == nil || h.store == nil || client.Environment() != environment || !validNOWPaymentsCallbackURL(callbackURL, environment) {
		return nowpayments.ErrConfiguration
	}
	origin := strings.TrimSuffix(callbackURL, "/api/webhooks/nowpayments")
	if successURL != origin+"/dashboard/packages?payment_provider=nowpayments&status=review" ||
		cancelURL != origin+"/dashboard/packages?payment_provider=nowpayments&status=cancelled" {
		return nowpayments.ErrConfiguration
	}
	h.nowMemberships = &nowPaymentsMemberships{client: client, store: h.store, environment: environment,
		callbackURL: callbackURL, successURL: successURL, cancelURL: cancelURL}
	return nil
}

func (h *Handler) SetNOWPaymentsOperational(client *nowpayments.Client, store *Store, settings NOWPaymentsSettings) error {
	if store == nil || !store.nowOperational || !settings.MembershipsEnabled {
		return nowpayments.ErrConfiguration
	}
	if err := h.SetNOWPayments(client, settings.Environment, settings.CallbackURL, settings.SuccessURL, settings.CancelURL); err != nil {
		return err
	}
	h.nowMemberships.store = store
	h.nowMemberships.operational = true
	return nil
}

func (h *Handler) handleNOWMembershipCheckout(w http.ResponseWriter, r *http.Request, req checkoutRequest, sponsor *int64, side string) {
	flow := h.nowMemberships
	if flow == nil {
		writeErr(w, http.StatusServiceUnavailable, "nowpayments-unavailable")
		return
	}
	attempt, err := flow.store.CreateNOWPaymentsMembership(r.Context(), NOWPaymentsMembershipInput{
		Email: req.Email, Subject: req.authSubject, Environment: flow.environment, PackageID: req.PackageID,
		SponsorAffiliateID: sponsor, PreferredSide: side, PurchaseRequestID: req.PurchaseRequestID,
	})
	if err != nil {
		switch {
		case errors.Is(err, ErrNOWPurchaseRequestInvalid):
			writeErr(w, http.StatusBadRequest, "invalid_purchase_request_id")
		case errors.Is(err, ErrNOWPurchaseRequestConflict):
			writeErr(w, http.StatusConflict, "purchase_request_conflict")
		case errors.Is(err, ErrNOWPurchaseProcessed):
			writeErr(w, http.StatusConflict, "membership_purchase_already_processed")
		case errors.Is(err, ErrNOWPaymentsOutstanding):
			writeErr(w, http.StatusConflict, "membership_payment_pending_review")
		case errors.Is(err, ErrNOWPaymentsActiveMembership):
			writeErr(w, http.StatusConflict, "membership_already_active")
		case errors.Is(err, ErrCheckoutIdentityReview):
			writeErr(w, http.StatusConflict, "checkout_identity_review_required")
		case errors.Is(err, ErrNOWOperationalPlan):
			writeErr(w, http.StatusServiceUnavailable, "nowpayments_financial_configuration_unavailable")
		case errors.Is(err, ErrPackNotFound):
			writeErr(w, http.StatusNotFound, "package_not_found")
		default:
			writeErr(w, http.StatusServiceUnavailable, "nowpayments-unavailable")
		}
		return
	}
	invoice, err := flow.createInvoice(r.Context(), attempt)
	if err != nil {
		h.log.Error().Msg("NOWPayments invoice requires operational review; no automatic retry")
		writeErr(w, http.StatusServiceUnavailable, "membership_payment_pending_review")
		return
	}
	total, err := nowpayments.FormatUSDMinor(attempt.TotalCents)
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "membership_payment_pending_review")
		return
	}
	fulfillment := "review_required"
	if flow.operational {
		fulfillment = "awaiting_payment"
	}
	writeJSON(w, http.StatusOK, checkoutResponse{URL: invoice.URL, Provider: "nowpayments",
		TotalUSD: total, FeeUSD: attempt.FeeUSD, FulfillmentStatus: fulfillment, OrderID: attempt.ID, Reused: attempt.Reused})
}

func (flow *nowPaymentsMemberships) createInvoice(ctx context.Context, attempt NOWPaymentsMembershipAttempt) (nowpayments.Invoice, error) {
	if attempt.Reused {
		if !flow.operational || !attempt.Reusable || attempt.Environment != flow.environment || attempt.State != "invoice_created" || attempt.TotalCents <= 0 || !validNOWPaymentsOrderID(attempt.ID) {
			return nowpayments.Invoice{}, nowpayments.ErrEvidence
		}
		invoiceURL, err := nowPurchaseInvoiceURL(flow.environment, attempt.InvoiceID)
		return nowpayments.Invoice{ID: attempt.InvoiceID, URL: invoiceURL}, err
	}
	if !validNOWPaymentsOrderID(attempt.ID) || attempt.Environment != flow.environment ||
		attempt.State != "creating_invoice" || attempt.TotalCents <= 0 {
		return nowpayments.Invoice{}, nowpayments.ErrEvidence
	}
	successURL, err := flow.successURLForOrder(attempt.ID)
	if err != nil {
		return nowpayments.Invoice{}, err
	}
	// Creation is never retried automatically. The API does not promise an
	// idempotency key: even a timeout may have created a payable invoice remotely.
	invoice, err := flow.client.CreateInvoice(ctx, nowpayments.InvoiceRequest{
		OrderID: attempt.ID, AmountUSDMinor: attempt.TotalCents, Description: "Mindbliss Power membership",
		CallbackURL: flow.callbackURL, SuccessURL: successURL, CancelURL: flow.cancelURL,
	})
	if err == nil {
		err = flow.store.AttachNOWPaymentsInvoice(ctx, attempt.ID, flow.environment, invoice.ID)
	}
	if err != nil {
		// Record uncertainty even if the browser disconnected. This is a local
		// durable transition, not another provider request or an invoice retry.
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer cancel()
		_ = flow.store.MarkNOWPaymentsInvoiceUnknown(cleanupCtx, attempt.ID, flow.environment)
		return nowpayments.Invoice{}, nowpayments.ErrProvider
	}
	return invoice, nil
}

// The return URL carries only the server-persisted order's opaque identifier.
// A browser redirect is never evidence of payment or ownership; the portal must
// still obtain the authenticated, persisted status before showing confirmation.
func (flow *nowPaymentsMemberships) successURLForOrder(orderID string) (string, error) {
	if !validNOWPaymentsOrderID(orderID) || !validNOWPaymentsCallbackURL(flow.callbackURL, flow.environment) {
		return "", nowpayments.ErrEvidence
	}
	origin := strings.TrimSuffix(flow.callbackURL, "/api/webhooks/nowpayments")
	if flow.successURL != origin+"/dashboard/packages?payment_provider=nowpayments&status=review" ||
		flow.cancelURL != origin+"/dashboard/packages?payment_provider=nowpayments&status=cancelled" {
		return "", nowpayments.ErrConfiguration
	}
	result, err := url.Parse(flow.successURL)
	if err != nil {
		return "", nowpayments.ErrConfiguration
	}
	query := result.Query()
	query.Set("order_id", orderID)
	result.RawQuery = query.Encode()
	return result.String(), nil
}

// A signed callback is evidence for manual membership review only. It must not
// invoke activateVerifiedCheckout (Stripe-specific), post a wallet movement,
// change a node/rank, or infer the old Stripe reserve/commission percentages.
func (h *Handler) handleNOWPaymentsWebhook(w http.ResponseWriter, r *http.Request) {
	if h.nowCapture != nil {
		h.handleNOWPaymentsCapture(w, r)
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	flow := h.nowMemberships
	if flow == nil {
		writeErr(w, http.StatusServiceUnavailable, "nowpayments-unavailable")
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeErr(w, http.StatusUnsupportedMediaType, "json_required")
		return
	}
	signature := r.Header.Get("x-nowpayments-sig")
	if len(signature) != 128 {
		writeErr(w, http.StatusUnauthorized, "invalid_payment_signature")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 128<<10))
	if err != nil {
		writeErr(w, http.StatusRequestEntityTooLarge, "request_too_large")
		return
	}
	signed, err := flow.client.VerifyIPN(body, signature)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "invalid_payment_signature")
		return
	}
	orderID, err := uuid.Parse(signed.OrderID)
	if err != nil || orderID == uuid.Nil || orderID.String() != signed.OrderID {
		writeErr(w, http.StatusBadRequest, "invalid_membership_payment")
		return
	}
	// NOWPayments requests a prompt callback acknowledgement. On timeout return
	// a retryable failure, never acknowledge evidence that was not persisted.
	ctx, cancel := context.WithTimeout(r.Context(), 2500*time.Millisecond)
	defer cancel()
	attempt, err := flow.store.LookupNOWPaymentsMembership(ctx, signed.OrderID, flow.environment)
	if errors.Is(err, ErrNOWPaymentsAttemptNotFound) {
		writeErr(w, http.StatusNotFound, "membership_order_not_found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "payment_verification_unavailable")
		return
	}
	if attempt.InvoiceID == "" || attempt.InvoiceID != string(signed.InvoiceID) {
		writeErr(w, http.StatusConflict, "membership_payment_mismatch")
		return
	}
	authoritative, err := flow.client.GetPayment(ctx, string(signed.PaymentID))
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "payment_verification_unavailable")
		return
	}
	hash := sha256.Sum256(body)
	result, err := flow.store.RecordNOWPaymentsReceipt(ctx, flow.environment, signed, authoritative, hex.EncodeToString(hash[:]))
	if errors.Is(err, ErrNOWPaymentsEvidence) {
		writeErr(w, http.StatusConflict, "membership_payment_mismatch")
		return
	}
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "payment_verification_unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"received": true, "state": result.State, "fulfillment_status": "review_required"})
}
