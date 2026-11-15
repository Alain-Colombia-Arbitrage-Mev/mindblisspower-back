package payments

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/rs/zerolog"
)

func TestPermanentReferralTypedFailuresDoNotExposeStorageDetails(t *testing.T) {
	for _, tc := range []struct {
		code     string
		expected error
	}{
		{"referral_attribution_required", ErrReferralAttributionRequired},
		{"referral_sponsor_needs_placement", ErrReferralSponsorNeedsPlacement},
		{"referral_sponsor_mismatch", ErrReferralSponsorMismatch},
		{"referral_identity_review", ErrCheckoutIdentityReview},
	} {
		err := fmt.Errorf("storage wrapper: %w", &pgconn.PgError{Code: "55000", Message: tc.code, Detail: "private database context"})
		if permanentReferralError(err) != tc.expected {
			t.Fatalf("wrong typed classification for %s", tc.code)
		}
		if permanentReferralError(fmt.Errorf("wrapped: %w", tc.expected)) != tc.expected {
			t.Fatal("typed wrapper lost")
		}
		if tc.expected == ErrCheckoutIdentityReview {
			continue
		}
		response := httptest.NewRecorder()
		if !writePermanentReferralFailure(response, err) || response.Code != http.StatusConflict {
			t.Fatal("typed conflict was not handled")
		}
		if !strings.Contains(response.Body.String(), tc.code) || strings.Contains(response.Body.String(), "private") {
			t.Fatal("unsafe failure projection")
		}
	}
	unknown := errors.New("unrecognized private storage failure")
	if permanentReferralError(unknown) != unknown || writePermanentReferralFailure(httptest.NewRecorder(), unknown) || writePermanentReferralFailure(httptest.NewRecorder(), nil) {
		t.Fatal("unknown failure was invented or swallowed")
	}
}

func TestPermanentReferralExistingSponsorIsImmutableAndDoesNotRequirePackageOrHint(t *testing.T) {
	affiliate, sponsor := int64(81), int64(17)
	h := &Handler{permanentReferrals: true, companyRoot: 999}
	for _, ref := range []string{"", "other-member", "unknown-code"} {
		actual, code, side, err := h.resolveCheckoutPlacement(context.Background(), "synthetic@example.invalid", Buyer{PersonID: 42, AffiliateID: &affiliate, SponsorAffiliateID: &sponsor}, ref, "L")
		if err != nil || actual == nil || *actual != sponsor || code != "" || side != "" {
			t.Fatal("existing sponsor or placement changed")
		}
	}
}

func TestPermanentReferralUnpositionedCheckoutCannotUseMissingOrBrowserIdentity(t *testing.T) {
	h := &Handler{permanentReferrals: true, companyRoot: 999}
	for _, subjects := range [][]string{nil, {""}, {" "}, {"one", "two"}} {
		_, _, _, err := h.resolveCheckoutPlacement(context.Background(), "synthetic@example.invalid", Buyer{PersonID: 42}, "", "", subjects...)
		if !errors.Is(err, ErrCheckoutIdentityReview) {
			t.Fatal("missing verified subject reached storage or company fallback")
		}
	}
}

func TestPermanentReferralFeatureIsExplicitAndDoesNotEnableStripe(t *testing.T) {
	for _, tc := range []struct {
		value    string
		expected bool
	}{{"", false}, {"false", false}, {"true", true}} {
		t.Setenv("MEMBER_REFERRAL_ENABLED", tc.value)
		h := NewHandler(nil, nil, "", nil, 999, zerolog.Nop())
		if h.permanentReferrals != tc.expected || h.stripeCheckoutEnabled {
			t.Fatal("referral feature widened financial admission")
		}
	}
}
