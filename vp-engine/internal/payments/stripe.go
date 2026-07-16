package payments

import (
	"errors"
	"fmt"
	"strings"
	"time"

	stripe "github.com/stripe/stripe-go/v85"
	"github.com/stripe/stripe-go/v85/checkout/session"
	"github.com/stripe/stripe-go/v85/paymentintent"
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

// MetadataProductTag es el metadato que marca un cobro como propio de "PACK
// MINDBLISS". La cuenta de Stripe es COMPARTIDA con otros negocios, así que lo
// estampamos en la Session y en el PaymentIntent para (a) poder filtrar el
// webhook contra eventos ajenos y (b) reconciliar vía Search API
// (metadata['packmindbliss']:'true'). Coincide con el metadato del Product.
const (
	MetadataProductTag = "packmindbliss"
	MetadataProductVal = "true"
)

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
		// Propaga el metadato al PaymentIntent/Charge subyacente: Stripe NO copia
		// el metadato del Product ni el de la Session hacia el PaymentIntent, así
		// que sin esto el cargo no sería filtrable por product en el Search API.
		PaymentIntentData: &stripe.CheckoutSessionPaymentIntentDataParams{},
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
	// Marca de producto: garantizada aquí (independiente del caller) para blindar
	// el webhook en la cuenta Stripe compartida.
	params.AddMetadata(MetadataProductTag, MetadataProductVal)
	params.PaymentIntentData.AddMetadata(MetadataProductTag, MetadataProductVal)
	for k, v := range metadata {
		params.AddMetadata(k, v)
		params.PaymentIntentData.AddMetadata(k, v)
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

// StripeSalesTotal es el agregado Stripe-nativo de cobros exitosos de PACK
// MINDBLISS (marcados con packmindbliss=true) desde una fecha. GrossCents
// incluye el 1% de activación (es el monto realmente cobrado por Stripe).
type StripeSalesTotal struct {
	Count      int64 `json:"count"`
	GrossCents int64 `json:"gross_cents"`
}

// SearchSalesSince cuenta y suma los PaymentIntents `succeeded` marcados como
// PACK MINDBLISS desde `from`, vía Search API (único endpoint de Stripe que
// filtra por metadato). Aísla las ventas propias en la cuenta compartida sin
// tener que expandir line items evento por evento.
func (g *StripeGateway) SearchSalesSince(from time.Time) (StripeSalesTotal, error) {
	var total StripeSalesTotal
	query := fmt.Sprintf("metadata['%s']:'%s' AND status:'succeeded' AND created>=%d",
		MetadataProductTag, MetadataProductVal, from.Unix())
	params := &stripe.PaymentIntentSearchParams{
		SearchParams: stripe.SearchParams{Query: query, Limit: stripe.Int64(100)},
	}
	iter := paymentintent.Search(params)
	for iter.Next() {
		pi := iter.PaymentIntent()
		total.Count++
		total.GrossCents += pi.Amount
	}
	if err := iter.Err(); err != nil {
		return StripeSalesTotal{}, fmt.Errorf("stripe payment_intent search: %w", err)
	}
	return total, nil
}

// PaymentIntentPresence indica el resultado de verificar un cargo contra Stripe.
type PaymentIntentPresence int

const (
	PIPresenceUnknown PaymentIntentPresence = iota // id no verificable (vacío / "sess:…" / no "pi_")
	PIPresent                                      // existe en la cuenta Stripe (live)
	PIMissing                                      // Stripe respondió resource_missing (posible cargo de PRUEBA)
)

// VerifyPaymentIntent consulta si un payment_intent existe en la cuenta Stripe
// (live) del servicio. Un cargo creado en modo TEST —o un id inexistente— da
// resource_missing ⇒ PIMissing. Ids no consultables (vacío, fallback "sess:…" o
// que no empiezan con "pi_") ⇒ PIPresenceUnknown, sin llamar a Stripe. Cualquier
// otro error de red/API se propaga.
func (g *StripeGateway) VerifyPaymentIntent(piID string) (PaymentIntentPresence, error) {
	piID = strings.TrimSpace(piID)
	if piID == "" || !strings.HasPrefix(piID, "pi_") {
		return PIPresenceUnknown, nil
	}
	_, err := paymentintent.Get(piID, nil)
	if err != nil {
		var serr *stripe.Error
		if errors.As(err, &serr) && serr.Code == stripe.ErrorCodeResourceMissing {
			return PIMissing, nil
		}
		return PIPresenceUnknown, fmt.Errorf("stripe payment_intent get: %w", err)
	}
	return PIPresent, nil
}

// SessionPaid consulta a Stripe el estado de una Checkout Session concreta (para
// el sweep de reconciliación cuando el webhook se perdió). Devuelve (pagada,
// paymentIntentID). Solo confirma pagos de PACK MINDBLISS: exige la marca
// packmindbliss=true en el metadato de la sesión (aísla la cuenta compartida).
func (g *StripeGateway) SessionPaid(sessionID string) (bool, string, error) {
	cs, err := session.Get(sessionID, nil)
	if err != nil {
		return false, "", fmt.Errorf("stripe session get %s: %w", sessionID, err)
	}
	if cs.Metadata[MetadataProductTag] != MetadataProductVal {
		return false, "", nil // sesión ajena a la cuenta compartida; ignorar
	}
	if cs.PaymentStatus != stripe.CheckoutSessionPaymentStatusPaid {
		return false, "", nil
	}
	piID := ""
	if cs.PaymentIntent != nil {
		piID = cs.PaymentIntent.ID
	}
	if piID == "" {
		piID = "sess:" + cs.ID
	}
	return true, piID, nil
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
