package payments

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/vicionpower/vp-engine/internal/shared/financialguard"
	"io"
	"net/http"
	"strings"
)

// ── Checkout ────────────────────────────────────────────────────────────────

type checkoutRequest struct {
	authSubject       string // Verified server identity; never decoded from browser JSON.
	Email             string `json:"email"`
	PackageID         int    `json:"package_id"`
	Ref               string `json:"ref"`            // código de referido (?ref=CODE) → sponsor para colocar
	PreferredSide     string `json:"preferred_side"` // L/R del enlace; se persiste hasta el webhook de pago
	Name              string `json:"name"`           // nombre del token (para auto-provisión de mlm.person)
	Phone             string `json:"phone"`          // teléfono del token (E.164)
	Provider          string `json:"provider"`       // stripe (default) or nowpayments; membership purchase only
	PurchaseRequestID string `json:"purchase_request_id"`
}

type checkoutResponse struct {
	URL               string `json:"url"`
	SessionID         string `json:"session_id"`
	TotalUSD          string `json:"total_usd"`
	FeeUSD            string `json:"fee_usd"`
	Provider          string `json:"provider"`
	FulfillmentStatus string `json:"fulfillment_status,omitempty"`
	OrderID           string `json:"order_id,omitempty"`
	Reused            bool   `json:"reused"`
}

// handleCheckout crea una sesión de Checkout. Lo llama el BFF Next (que ya
// validó la sesión Cognito) con el token de servicio + el user_id autenticado.
func (h *Handler) handleCheckout(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	// Auth servicio-a-servicio (no Cognito aquí; el BFF ya autenticó al usuario).
	if !h.svcAuth(w, r) {
		return
	}

	var req checkoutRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16))
	if err := decoder.Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}
	provider, err := membershipProvider(req.Provider)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_payment_provider")
		return
	}
	req.Provider = provider
	// Fail closed before identity verification, database access or provisioning.
	// Missing provider still means Stripe, so legacy callers cannot bypass this.
	if provider == "stripe" && !h.stripeCheckoutEnabled {
		writeErr(w, http.StatusServiceUnavailable, "stripe_checkout_disabled")
		return
	}
	if req.Email == "" || req.PackageID <= 0 {
		writeErr(w, http.StatusBadRequest, "missing email or package_id")
		return
	}
	identity, ok := h.resolveIdentity(w, r, req.Email)
	if !ok {
		return
	}
	req.Email = identity
	var boundNOWBuyer *Buyer
	if provider == "nowpayments" && (h.nowMemberships == nil || !h.requireVerified || strings.TrimSpace(r.Header.Get(idTokenHeader)) == "") {
		writeErr(w, http.StatusServiceUnavailable, "nowpayments-unavailable")
		return
	}
	if provider == "nowpayments" {
		verifier, ok := h.verifier.(nowSubjectVerifier)
		if !ok || r.Header.Get(actAsHeader) != "" {
			writeErr(w, http.StatusUnauthorized, "invalid_id_token")
			return
		}
		subject, email, err := verifier.VerifySubject(r.Context(), strings.TrimSpace(r.Header.Get(idTokenHeader)))
		if err != nil || strings.TrimSpace(subject) == "" || email != identity {
			writeErr(w, http.StatusUnauthorized, "invalid_id_token")
			return
		}
		req.authSubject = subject
		buyer, err := h.store.resolveNOWBuyer(r.Context(), subject, email)
		if err != nil {
			writeErr(w, http.StatusConflict, "checkout_identity_review_required")
			return
		}
		boundNOWBuyer = &buyer
	}
	nowOperational := provider == "nowpayments" && h.nowMemberships != nil && h.nowMemberships.operational
	if nowOperational && !validNOWPaymentsOrderID(req.PurchaseRequestID) {
		writeErr(w, http.StatusBadRequest, "invalid_purchase_request_id")
		return
	}
	if err := financialguard.RequireOperational(r.Context(), h.store.db); err != nil && !nowOperational {
		if errors.Is(err, ErrRecoveryFinancialReview) {
			writeErr(w, http.StatusServiceUnavailable, "stripe_recovery_financial_review_required")
		} else {
			h.log.Error().Err(err).Msg("checkout financial mode unavailable")
			writeErr(w, http.StatusServiceUnavailable, "financial_mutations_unavailable")
		}
		return
	}

	ctx := r.Context()
	// Wallet congelada: un usuario baneado/suspendido no puede comprar. Se
	// evalúa email + señales del token Cognito para bloquear también teléfono y
	// nombre exacto normalizado.
	if h.rejectIfBanned(ctx, w, BanCandidate{Email: req.Email, Phone: req.Phone, Name: req.Name}) {
		return
	}
	pack, err := h.store.LookupPack(ctx, req.PackageID)
	if errors.Is(err, ErrPackNotFound) {
		writeErr(w, http.StatusNotFound, "package_not_found")
		return
	}
	if err != nil {
		h.log.Error().Err(err).Msg("lookup pack")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}

	// Preserve Stripe/review eligibility. NOW operational purchases use their own
	// durable request key and one-open-SKU constraint; multiple active CDs are
	// allowed only there, never by weakening the legacy collection guard.
	if !nowOperational {
		if active, err := h.store.HasActiveMembership(ctx, req.Email, req.PackageID); err != nil {
			h.log.Error().Msg("membership eligibility unavailable")
			writeErr(w, http.StatusServiceUnavailable, "membership_eligibility_unavailable")
			return
		} else if active {
			writeErr(w, http.StatusConflict, "Ya tienes esta membresía activa. Las membresías son de pago único.")
			return
		}
	}

	// Auto-provisión: usuario nuevo de Cognito sin fila en RDS → crear mlm.person
	// (idempotente) para que el checkout pueda proceder. La colocación en el árbol
	// la hace la activación.
	if provider == "stripe" {
		if _, err := h.store.EnsurePerson(ctx, req.Email, req.Name, req.Phone); err != nil {
			h.log.Error().Err(err).Str("email", req.Email).Msg("ensure person")
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
	}

	var buyer Buyer
	if boundNOWBuyer != nil {
		buyer = *boundNOWBuyer
	} else {
		buyer, err = h.store.ResolveBuyer(ctx, req.Email)
	}
	if errors.Is(err, ErrBuyerNotFound) {
		writeErr(w, http.StatusNotFound, "buyer_not_found")
		return
	}
	if err != nil {
		h.log.Error().Err(err).Msg("resolve buyer")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}

	if strings.TrimSpace(req.PreferredSide) != "" && normalizePreferredSide(req.PreferredSide) == "" {
		writeErr(w, http.StatusBadRequest, "invalid_preferred_side")
		return
	}
	sponsor, referralCodeForIntent, preferredSideForIntent, err := h.resolveCheckoutPlacement(ctx, req.Email, buyer, req.Ref, req.PreferredSide)
	if errors.Is(err, ErrInvalidReferralCode) {
		writeErr(w, http.StatusBadRequest, "invalid_referral_code")
		return
	}
	if err != nil {
		h.log.Error().Err(err).Str("email", req.Email).Msg("resolve checkout sponsor")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	if buyer.AffiliateID != nil && sponsor != nil {
		aligned, err := h.store.SponsorIsBinaryAncestor(ctx, *buyer.AffiliateID, *sponsor)
		if err != nil {
			h.log.Error().Err(err).Str("email", req.Email).Msg("checkout sponsor/tree alignment")
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
		if !aligned {
			h.log.Warn().
				Str("email", req.Email).
				Int64("affiliate_id", *buyer.AffiliateID).
				Int64("sponsor_affiliate_id", *sponsor).
				Msg("checkout blocked: sponsor is not a binary ancestor")
			writeErr(w, http.StatusConflict, "tree_relocation_required")
			return
		}
	}

	if provider == "nowpayments" {
		h.handleNOWMembershipCheckout(w, r, req, sponsor, preferredSideForIntent)
		return
	}
	if h.gw == nil {
		writeErr(w, http.StatusServiceUnavailable, "stripe_unavailable")
		return
	}
	intentID, err := h.store.CreatePurchaseIntent(ctx, PurchaseIntent{
		UserID:             req.Email, // traceability: identificador externo del comprador
		PersonID:           buyer.PersonID,
		AffiliateID:        buyer.AffiliateID,
		SponsorAffiliateID: sponsor,
		ReferralCode:       referralCodeForIntent,
		PreferredSide:      preferredSideForIntent,
		PackageID:          pack.ID,
		PV:                 pack.PV,
		AmountUSD:          pack.AmountUSD,
		FeeUSD:             pack.FeeUSD(),
		TotalCents:         pack.TotalCents(),
		Currency:           "usd",
	})
	if err != nil {
		h.log.Error().Err(err).Msg("create purchase intent")
		if errors.Is(err, ErrNOWPaymentsOutstanding) {
			writeErr(w, http.StatusConflict, "membership_payment_pending_review")
			return
		}
		if errors.Is(err, ErrRecoveryFinancialReview) {
			writeErr(w, http.StatusServiceUnavailable, "stripe_recovery_financial_review_required")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}

	checkoutIdentity, err := h.store.checkoutIdentityForIntent(ctx, intentID)
	if err != nil {
		h.log.Error().Err(err).Msg("stable checkout owner unavailable")
		writeErr(w, http.StatusConflict, "checkout_identity_review_required")
		return
	}
	url, sessionID, err := h.gw.CreateCheckout(pack, intentID, checkoutIdentity)
	if err != nil {
		h.log.Error().Err(err).Str("intent", intentID).Msg("stripe checkout create")
		writeErr(w, http.StatusBadGateway, "stripe_error")
		return
	}
	if err := h.store.AttachSession(ctx, intentID, sessionID); err != nil {
		h.log.Error().Err(err).Msg("attach session")
		// La sesión ya existe en Stripe; no abortamos. El webhook resuelve por
		// session_id o por purchase_intent_id en metadata si el attach falló.
	}

	writeJSON(w, http.StatusOK, checkoutResponse{
		URL: url, SessionID: sessionID,
		TotalUSD: pack.TotalUSD().StringFixed(2), FeeUSD: pack.FeeUSD().StringFixed(2),
		Provider: "stripe",
	})
}

func (h *Handler) resolveCheckoutSponsor(ctx context.Context, email string, buyer Buyer, ref string) (*int64, string, error) {
	sponsor, referralCode, _, err := h.resolveCheckoutPlacement(ctx, email, buyer, ref, "")
	return sponsor, referralCode, err
}

func (h *Handler) resolveCheckoutPlacement(ctx context.Context, email string, buyer Buyer, ref, requestedSide string) (*int64, string, string, error) {
	// Sponsor: el del afiliado existente es autoritativo. Un ?ref=CODE sólo se
	// usa para compradores aún no colocados; aplicar refs nuevos sobre afiliados
	// existentes mezcla sesiones/navegadores y puede atribuir sponsors falsos.
	sponsor := buyer.SponsorAffiliateID
	referralCode := strings.TrimSpace(ref)
	referralCodeForIntent := ""
	preferredSideForIntent := ""

	if buyer.AffiliateID == nil && sponsor == nil {
		if referralCode != "" {
			resolvedSponsor, err := h.store.ResolveSponsorByCode(ctx, referralCode)
			if err != nil {
				return nil, "", "", err
			}
			if resolvedSponsor == nil {
				return nil, "", "", ErrInvalidReferralCode
			}
			sponsor = resolvedSponsor
			referralCodeForIntent = referralCode
			preferredSideForIntent = normalizePreferredSide(requestedSide)

			// El registro persistido es autoritativo cuando corresponde al mismo
			// código. Evita que un almacenamiento local viejo cambie L/R al pagar.
			registeredReferral, lookupErr := h.store.LookupRegistrationReferral(ctx, email)
			if lookupErr != nil {
				return nil, "", "", lookupErr
			}
			if registeredReferral != nil && strings.EqualFold(registeredReferral.Code, referralCode) {
				preferredSideForIntent = registeredReferral.PreferredSide
			}
		} else {
			registeredReferral, err := h.store.LookupRegistrationReferral(ctx, email)
			if err != nil {
				return nil, "", "", err
			}
			if registeredReferral != nil {
				sid := registeredReferral.SponsorAffiliateID
				sponsor = &sid
				referralCodeForIntent = registeredReferral.Code
				preferredSideForIntent = registeredReferral.PreferredSide
			}
		}
	}

	// Sin sponsor (sin ?ref ni afiliado previo) → root de empresa (la activación
	// derrama bajo él). Así nadie queda huérfano y el pago nunca se bloquea.
	if sponsor == nil && h.companyRoot > 0 {
		cr := h.companyRoot
		sponsor = &cr
	}
	return sponsor, referralCodeForIntent, preferredSideForIntent, nil
}
