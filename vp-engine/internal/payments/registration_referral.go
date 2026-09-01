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
}

func (s *Store) RecordRegistrationReferral(ctx context.Context, email, code string) (*RegistrationReferral, error) {
	emailNorm := normalizeRegistrationReferralEmail(email)
	code = strings.TrimSpace(code)
	if emailNorm == "" || code == "" {
		return nil, nil
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
			email_norm, referral_code, sponsor_affiliate_id, source,
			created_at, updated_at, consumed_at
		)
		VALUES ($1, $2, $3, 'register', now(), now(), NULL)
		ON CONFLICT (email_norm) DO UPDATE SET
			referral_code = EXCLUDED.referral_code,
			sponsor_affiliate_id = EXCLUDED.sponsor_affiliate_id,
			source = EXCLUDED.source,
			updated_at = now(),
			consumed_at = NULL
	`, emailNorm, code, *sponsor)
	if err != nil {
		return nil, fmt.Errorf("record registration referral: %w", err)
	}

	return &RegistrationReferral{Code: code, SponsorAffiliateID: *sponsor}, nil
}

func (s *Store) LookupRegistrationReferral(ctx context.Context, email string) (*RegistrationReferral, error) {
	emailNorm := normalizeRegistrationReferralEmail(email)
	if emailNorm == "" {
		return nil, nil
	}

	var out RegistrationReferral
	err := s.db.QueryRow(ctx, `
		SELECT referral_code, sponsor_affiliate_id
		  FROM payments.registration_referral
		 WHERE email_norm = $1
		   AND consumed_at IS NULL
		   AND updated_at >= now() - interval '30 days'
		 LIMIT 1
	`, emailNorm).Scan(&out.Code, &out.SponsorAffiliateID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("lookup registration referral: %w", err)
	}
	out.Code = strings.TrimSpace(out.Code)
	if out.Code == "" || out.SponsorAffiliateID <= 0 {
		return nil, nil
	}
	return &out, nil
}

func normalizeRegistrationReferralEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}
