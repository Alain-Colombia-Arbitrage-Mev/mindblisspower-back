package payments

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

type RegistrationReferral struct {
	Code               string
	SponsorAffiliateID int64
	PreferredSide      string
}

func (s *Store) RecordRegistrationReferral(ctx context.Context, email, code string, requestedSide ...string) (*RegistrationReferral, error) {
	emailNorm := normalizeRegistrationReferralEmail(email)
	code = strings.TrimSpace(code)
	if emailNorm == "" || code == "" {
		return nil, nil
	}
	preferredSide := ""
	if len(requestedSide) > 0 {
		preferredSide = normalizePreferredSide(requestedSide[0])
	}

	sponsor, err := s.ResolveSponsorByCode(ctx, code)
	if err != nil {
		return nil, fmt.Errorf("record registration referral: %w", err)
	}
	if sponsor == nil {
		return nil, ErrInvalidReferralCode
	}

	_, err = s.db.Exec(ctx, `
		INSERT INTO payments.registration_referral (
			email_norm, referral_code, sponsor_affiliate_id, preferred_side, source,
			created_at, updated_at, consumed_at
		)
		VALUES ($1, $2, $3, NULLIF($4, ''), 'register', now(), now(), NULL)
		ON CONFLICT (email_norm) DO UPDATE SET
			referral_code = EXCLUDED.referral_code,
			sponsor_affiliate_id = EXCLUDED.sponsor_affiliate_id,
			preferred_side = EXCLUDED.preferred_side,
			source = EXCLUDED.source,
			updated_at = now(),
			consumed_at = NULL
	`, emailNorm, code, *sponsor, preferredSide)
	if err != nil {
		return nil, fmt.Errorf("record registration referral: %w", err)
	}

	return &RegistrationReferral{Code: code, SponsorAffiliateID: *sponsor, PreferredSide: preferredSide}, nil
}

func (s *Store) LookupRegistrationReferral(ctx context.Context, email string) (*RegistrationReferral, error) {
	return s.lookupRegistrationReferral(ctx, email, false)
}

// Checkout must not confuse a fresh but ineligible attribution with no hint:
// falling back in that case would silently assign a different sponsor. Other
// readers retain the historical contract of hiding unusable referrals.
func (s *Store) lookupCheckoutRegistrationReferral(ctx context.Context, email string) (*RegistrationReferral, error) {
	return s.lookupRegistrationReferral(ctx, email, true)
}

func (s *Store) lookupRegistrationReferral(ctx context.Context, email string, rejectIneligible bool) (*RegistrationReferral, error) {
	emailNorm := normalizeRegistrationReferralEmail(email)
	if emailNorm == "" {
		return nil, nil
	}

	var out RegistrationReferral
	var eligible bool
	err := s.db.QueryRow(ctx, `
		SELECT rr.referral_code, rr.sponsor_affiliate_id, COALESCE(rr.preferred_side, ''),
		       COALESCE((`+placementSponsorEligibilitySQL+`), false)
		  FROM payments.registration_referral rr
		  LEFT JOIN mlm.affiliate a ON a.id = rr.sponsor_affiliate_id
		  LEFT JOIN mlm.person p ON p.id = a.person_id
		 WHERE rr.email_norm = $1
		   AND rr.consumed_at IS NULL
		   AND rr.updated_at >= now() - interval '30 days'
		 LIMIT 1
	`, emailNorm).Scan(&out.Code, &out.SponsorAffiliateID, &out.PreferredSide, &eligible)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("lookup registration referral: %w", err)
	}
	out.Code = strings.TrimSpace(out.Code)
	out.PreferredSide = normalizePreferredSide(out.PreferredSide)
	if !eligible || out.Code == "" || out.SponsorAffiliateID <= 0 {
		if rejectIneligible {
			return nil, ErrInvalidReferralCode
		}
		return nil, nil
	}
	return &out, nil
}

func normalizePreferredSide(value string) string {
	switch strings.ToUpper(strings.TrimSpace(value)) {
	case "L":
		return "L"
	case "R":
		return "R"
	default:
		return ""
	}
}

// automaticPlacementSide centralizes the public placement contract: a legacy
// L/R hint may be accepted for rollout compatibility, but it has no authority
// over the binary tree. The placement transaction chooses the weak leg.
func automaticPlacementSide(string) string { return "" }

func normalizeRegistrationReferralEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}
