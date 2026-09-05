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
	emailNorm := normalizeRegistrationReferralEmail(email)
	if emailNorm == "" {
		return nil, nil
	}

	var out RegistrationReferral
	err := s.db.QueryRow(ctx, `
		SELECT rr.referral_code, rr.sponsor_affiliate_id, COALESCE(rr.preferred_side, '')
		  FROM payments.registration_referral rr
		  JOIN mlm.affiliate a ON a.id = rr.sponsor_affiliate_id
		  JOIN mlm.person p ON p.id = a.person_id
		 WHERE rr.email_norm = $1
		   AND rr.consumed_at IS NULL
		   AND rr.updated_at >= now() - interval '30 days'
		   AND a.status::text = 'active'
		   AND p.status::text = 'active'
		   AND NOT COALESCE(p.blacklisted,false)
		 LIMIT 1
	`, emailNorm).Scan(&out.Code, &out.SponsorAffiliateID, &out.PreferredSide)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("lookup registration referral: %w", err)
	}
	out.Code = strings.TrimSpace(out.Code)
	out.PreferredSide = normalizePreferredSide(out.PreferredSide)
	if out.Code == "" || out.SponsorAffiliateID <= 0 {
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

func normalizeRegistrationReferralEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}
