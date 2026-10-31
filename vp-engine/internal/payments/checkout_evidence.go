package payments

import (
	"errors"
	"fmt"
	"strings"

	stripe "github.com/stripe/stripe-go/v85"
)

var ErrCheckoutEvidence = errors.New("checkout evidence does not match purchase intent")
var ErrActivationState = errors.New("purchase intent state requires manual review")

// checkoutEvidence is produced only from a signed webhook or a Stripe API
// response. It is compared with the intent snapshot while that row is locked.
type checkoutEvidence struct {
	sessionID, paymentIntentID, purchaseIntentID, currency string
	totalCents                                             int64
}

func evidenceFromCheckout(cs *stripe.CheckoutSession, requireLive bool) (checkoutEvidence, error) {
	if cs == nil || cs.Metadata[MetadataProductTag] != MetadataProductVal ||
		cs.PaymentStatus != stripe.CheckoutSessionPaymentStatusPaid ||
		cs.Mode != stripe.CheckoutSessionModePayment || (requireLive && !cs.Livemode) ||
		cs.Currency != stripe.CurrencyUSD || cs.AmountTotal <= 0 ||
		!strings.HasPrefix(cs.ID, "cs_") || cs.PaymentIntent == nil ||
		!strings.HasPrefix(cs.PaymentIntent.ID, "pi_") {
		return checkoutEvidence{}, ErrCheckoutEvidence
	}
	return checkoutEvidence{sessionID: cs.ID, paymentIntentID: cs.PaymentIntent.ID,
		purchaseIntentID: strings.TrimSpace(cs.Metadata["purchase_intent_id"]),
		currency:         string(cs.Currency), totalCents: cs.AmountTotal}, nil
}

func (e checkoutEvidence) matchesIntent(intentID, sessionID, paymentIntentID, currency string, totalCents int64) error {
	if e.totalCents != totalCents || totalCents <= 0 || e.currency != currency || currency != "usd" ||
		(e.purchaseIntentID != "" && e.purchaseIntentID != intentID) ||
		(sessionID != "" && e.sessionID != sessionID) ||
		(paymentIntentID != "" && e.paymentIntentID != paymentIntentID) {
		return ErrCheckoutEvidence
	}
	return nil
}

func activationStateAllowed(status string) error {
	switch status {
	case "created", "paid", "needs_placement", "activated":
		return nil
	default:
		return fmt.Errorf("%w: %s", ErrActivationState, status)
	}
}
