package payments

import (
	"fmt"

	stripe "github.com/stripe/stripe-go/v85"
	"github.com/stripe/stripe-go/v85/checkout/session"
	"github.com/stripe/stripe-go/v85/webhook"
)

// StripeGateway envuelve la API de Stripe (Checkout hosted + verificación de
// webhook). Tarjeta + crypto se habilitan vía PaymentMethods.
type StripeGateway struct {
	webhookSecret  string
	successURL     string
	cancelURL      string
	paymentMethods []string
	pmConfig       string // payment_method_configuration (pmc_…) gestionada en el dashboard; si está, gana sobre paymentMethods
	productID      string // "PACK MINDBLISS" (prod_…); si está, el cargo se asocia a ese producto
}

func NewStripeGateway(secretKey, webhookSecret, successURL, cancelURL, productID, pmConfig string, methods []string) *StripeGateway {
	stripe.Key = secretKey // la API clásica usa la key global del paquete
	return &StripeGateway{
		webhookSecret:  webhookSecret,
		successURL:     successURL,
		cancelURL:      cancelURL,
		paymentMethods: methods,
		pmConfig:       pmConfig,
		productID:      productID,
	}
}

// CreateCheckout crea una sesión de Checkout hosted de pago único por el total
// (pack + 1%). Devuelve (url, sessionID).
func (g *StripeGateway) CreateCheckout(pack Pack, intentID string, metadata map[string]string) (string, string, error) {
	params := &stripe.CheckoutSessionParams{
		Mode:              stripe.String(string(stripe.CheckoutSessionModePayment)),
		SuccessURL:        stripe.String(g.successURL),
		CancelURL:         stripe.String(g.cancelURL),
		ClientReferenceID: stripe.String(intentID),
		LineItems: []*stripe.CheckoutSessionLineItemParams{{
			Quantity:  stripe.Int64(1),
			PriceData: g.priceData(pack),
		}},
	}

	// payment_method_configuration (pmc_…) y payment_method_types son mutuamente
	// excluyentes. Si hay PMC, los métodos los gestiona el dashboard de Stripe.
	if g.pmConfig != "" {
		params.PaymentMethodConfiguration = stripe.String(g.pmConfig)
	} else {
		pmTypes := make([]*string, 0, len(g.paymentMethods))
		for _, m := range g.paymentMethods {
			pmTypes = append(pmTypes, stripe.String(m))
		}
		params.PaymentMethodTypes = pmTypes
	}
	for k, v := range metadata {
		params.AddMetadata(k, v)
	}

	sess, err := session.New(params)
	if err != nil {
		return "", "", fmt.Errorf("stripe checkout create: %w", err)
	}
	return sess.URL, sess.ID, nil
}

// priceData construye el precio dinámico (total = pack + 1%). Si hay productID
// configurado, asocia el cargo al producto "PACK MINDBLISS" de Stripe; si no,
// crea el producto inline con nombre por pack. El monto SIEMPRE incluye el 1%
// (los Price fijos de Stripe son el valor base sin activación).
func (g *StripeGateway) priceData(pack Pack) *stripe.CheckoutSessionLineItemPriceDataParams {
	pd := &stripe.CheckoutSessionLineItemPriceDataParams{
		Currency:   stripe.String("usd"),
		UnitAmount: stripe.Int64(pack.TotalCents()),
	}
	if g.productID != "" {
		pd.Product = stripe.String(g.productID)
	} else {
		pd.ProductData = &stripe.CheckoutSessionLineItemPriceDataProductDataParams{
			Name:        stripe.String(fmt.Sprintf("Pack %s (incl. 1%% activación)", pack.Name)),
			Description: stripe.String(fmt.Sprintf("Activación de paquete · %d PV", pack.PV)),
		}
	}
	return pd
}

// ConstructEvent verifica la firma del webhook contra el payload crudo.
// IgnoreAPIVersionMismatch=true: desde stripe-go v73, ConstructEvent falla si
// la versión de API del evento (la del endpoint en el dashboard) no coincide
// con la fijada por el SDK. Ignoramos solo esa comprobación de versión — la
// FIRMA se sigue verificando completa —, así un upgrade del SDK o un endpoint
// con versión distinta no rompe el cobro.
func (g *StripeGateway) ConstructEvent(payload []byte, sigHeader string) (stripe.Event, error) {
	return webhook.ConstructEventWithOptions(payload, sigHeader, g.webhookSecret, webhook.ConstructEventOptions{
		IgnoreAPIVersionMismatch: true,
	})
}
