package payments

import "context"

// Existing tree/placement fixtures predate full provider Checkout evidence.
// These helpers exist only in tests, never in a production binary or ingress.
func (s *Store) ActivatePaidPurchase(ctx context.Context, sessionID, paymentIntentID string) (ActivationResult, error) {
	return s.ActivatePaidPurchaseForIntent(ctx, sessionID, paymentIntentID, "")
}

func (s *Store) ActivatePaidPurchaseForIntent(ctx context.Context, sessionID, paymentIntentID, purchaseIntentID string) (ActivationResult, error) {
	return s.activatePaidPurchase(ctx, sessionID, paymentIntentID, purchaseIntentID, nil)
}
