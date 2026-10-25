package payments

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/vicionpower/vp-engine/internal/shared/financialguard"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// ── Checkout ────────────────────────────────────────────────────────────────

type checkoutRequest struct {
	Email         string `json:"email"`
	PackageID     int    `json:"package_id"`
	Ref           string `json:"ref"`            // código de referido (?ref=CODE) → sponsor para colocar
	PreferredSide string `json:"preferred_side"` // L/R del enlace; se persiste hasta el webhook de pago
	Name          string `json:"name"`           // nombre del token (para auto-provisión de mlm.person)
	Phone         string `json:"phone"`          // teléfono del token (E.164)
}

type checkoutResponse struct {
	URL       string `json:"url"`
	SessionID string `json:"session_id"`
	TotalUSD  string `json:"total_usd"`
	FeeUSD    string `json:"fee_usd"`
}

// handleCheckout crea una sesión de Checkout. Lo llama el BFF Next (que ya
// validó la sesión Cognito) con el token de servicio + el user_id autenticado.
func (h *Handler) handleCheckout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	// Auth servicio-a-servicio (no Cognito aquí; el BFF ya autenticó al usuario).
	if !h.svcAuth(w, r) {
		return
	}

	var req checkoutRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
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
	if err := financialguard.RequireOperational(r.Context(), h.store.db); err != nil {
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

	// Pago único: si el usuario YA tiene esta membresía activa (cupo abierto), no
	// se permite pagarla otra vez (evita doble cobro por doble-click/reintento).
	// Las membresías no son suscripción. Un paquete agotado sí permite recompra.
	// Fail-open ante error de infra (no bloqueamos una compra legítima por un
	// fallo transitorio; la activación sigue siendo idempotente por payment_intent).
	if active, err := h.store.HasActiveMembership(ctx, req.Email, req.PackageID); err != nil {
		h.log.Error().Err(err).Str("email", req.Email).Int("package_id", req.PackageID).Msg("check active membership (fail-open)")
	} else if active {
		writeErr(w, http.StatusConflict, "Ya tienes esta membresía activa. Las membresías son de pago único.")
		return
	}

	// Auto-provisión: usuario nuevo de Cognito sin fila en RDS → crear mlm.person
	// (idempotente) para que el checkout pueda proceder. La colocación en el árbol
	// la hace la activación.
	if _, err := h.store.EnsurePerson(ctx, req.Email, req.Name, req.Phone); err != nil {
		h.log.Error().Err(err).Str("email", req.Email).Msg("ensure person")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}

	buyer, err := h.store.ResolveBuyer(ctx, req.Email)
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
		if errors.Is(err, ErrRecoveryFinancialReview) {
			writeErr(w, http.StatusServiceUnavailable, "stripe_recovery_financial_review_required")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}

	meta := map[string]string{
		"purchase_intent_id": intentID,
		"email":              req.Email,
		"person_id":          strconv.FormatInt(buyer.PersonID, 10),
		"package_id":         strconv.Itoa(pack.ID),
		"pv":                 strconv.Itoa(pack.PV),
	}
	if preferredSideForIntent != "" {
		meta["preferred_side"] = preferredSideForIntent
	}
	url, sessionID, err := h.gw.CreateCheckout(pack, intentID, meta)
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
