package payments

import (
	"context"
	"errors"
	"fmt"
	"strconv"

	"github.com/google/uuid"
)

// CheckoutIdentity is server-derived from a persisted purchase intent. It contains
// stable references only, not email, contact data, balance or a network snapshot.
type CheckoutIdentity struct {
	PersonPublicID     string
	PersonID           int64
	AffiliateID        *int64
	SponsorAffiliateID *int64
	PackageID          int
}

var ErrCheckoutIdentityReview = errors.New("checkout identity requires verified stable identifiers")

func (s *Store) checkoutIdentityForIntent(ctx context.Context, intentID string) (CheckoutIdentity, error) {
	var out CheckoutIdentity
	var storedAffiliate *int64
	err := s.db.QueryRow(ctx, `SELECT p.public_id::text,p.id,a.id,pi.affiliate_id,pi.sponsor_affiliate_id,pi.package_id
		FROM payments.purchase_intent pi JOIN mlm.person p ON p.id=pi.person_id
		LEFT JOIN mlm.affiliate a ON a.person_id=p.id WHERE pi.id=$1::uuid`, intentID).
		Scan(&out.PersonPublicID, &out.PersonID, &out.AffiliateID, &storedAffiliate, &out.SponsorAffiliateID, &out.PackageID)
	if err != nil {
		return CheckoutIdentity{}, fmt.Errorf("%w: stable purchase owner unavailable", ErrCheckoutIdentityReview)
	}
	if storedAffiliate != nil && (out.AffiliateID == nil || *storedAffiliate != *out.AffiliateID) {
		return CheckoutIdentity{}, ErrCheckoutIdentityReview
	}
	if out.SponsorAffiliateID != nil {
		eligible, err := sponsorCanReceivePlacement(ctx, s.db, *out.SponsorAffiliateID)
		if err != nil || !eligible {
			return CheckoutIdentity{}, ErrCheckoutIdentityReview
		}
	}
	return out, nil
}

func (i CheckoutIdentity) metadata(intentID string, pack Pack) (map[string]string, error) {
	publicID, err := uuid.Parse(i.PersonPublicID)
	if err != nil || publicID == uuid.Nil || publicID.String() != i.PersonPublicID || i.PersonID <= 0 || pack.ID <= 0 || pack.PV < 0 || !pack.AmountUSD.IsPositive() || i.PackageID != pack.ID {
		return nil, ErrCheckoutIdentityReview
	}
	intent, err := uuid.Parse(intentID)
	if err != nil || intent == uuid.Nil {
		return nil, ErrCheckoutIdentityReview
	}
	metadata := map[string]string{
		MetadataProductTag: MetadataProductVal, "identity_version": "1", "person_public_id": i.PersonPublicID,
		"person_id": strconv.FormatInt(i.PersonID, 10), "buyer_id": strconv.FormatInt(i.PersonID, 10),
		"purchase_intent_id": intent.String(), "package_id": strconv.Itoa(pack.ID), "pv": strconv.Itoa(pack.PV),
	}
	if i.AffiliateID != nil {
		if *i.AffiliateID <= 0 {
			return nil, ErrCheckoutIdentityReview
		}
		metadata["affiliate_id"] = strconv.FormatInt(*i.AffiliateID, 10)
	}
	if i.SponsorAffiliateID != nil {
		if *i.SponsorAffiliateID <= 0 {
			return nil, ErrCheckoutIdentityReview
		}
		metadata["sponsor_affiliate_id"] = strconv.FormatInt(*i.SponsorAffiliateID, 10)
	}
	return metadata, nil
}
