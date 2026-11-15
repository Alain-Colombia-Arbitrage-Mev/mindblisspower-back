package payments

import (
	"context"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5/pgconn"
)

var ErrReferralAttributionRequired = errors.New("referral attribution required")
var ErrReferralSponsorNeedsPlacement = errors.New("referral sponsor needs placement")
var ErrReferralSponsorMismatch = errors.New("referral sponsor mismatch")

func permanentReferralError(err error) error {
	for _, known := range []error{ErrReferralAttributionRequired, ErrReferralSponsorNeedsPlacement, ErrReferralSponsorMismatch, ErrCheckoutIdentityReview} {
		if errors.Is(err, known) {
			return known
		}
	}
	var pgerr *pgconn.PgError
	if errors.As(err, &pgerr) {
		switch pgerr.Message {
		case "referral_attribution_required":
			return ErrReferralAttributionRequired
		case "referral_sponsor_needs_placement":
			return ErrReferralSponsorNeedsPlacement
		case "referral_sponsor_mismatch":
			return ErrReferralSponsorMismatch
		case "referral_identity_review":
			return ErrCheckoutIdentityReview
		}
	}
	return err
}

func (s *Store) permanentCheckoutSponsor(ctx context.Context, subject string, personID int64) (*int64, string, error) {
	var sponsor *int64
	var code string
	err := s.db.QueryRow(ctx, `SELECT sponsor_affiliate_id,referral_code FROM payments.read_permanent_checkout_sponsor($1,$2)`, subject, personID).Scan(&sponsor, &code)
	if err != nil {
		return nil, "", permanentReferralError(err)
	}
	return sponsor, code, nil
}

func writePermanentReferralFailure(w http.ResponseWriter, err error) bool {
	switch permanentReferralError(err) {
	case ErrReferralAttributionRequired:
		writeErr(w, http.StatusConflict, "referral_attribution_required")
	case ErrReferralSponsorNeedsPlacement:
		writeErr(w, http.StatusConflict, "referral_sponsor_needs_placement")
	case ErrReferralSponsorMismatch:
		writeErr(w, http.StatusConflict, "referral_sponsor_mismatch")
	default:
		return false
	}
	return true
}
