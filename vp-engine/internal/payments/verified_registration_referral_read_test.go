package payments

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

type referralPositionQuery struct {
	query      string
	args       []any
	positioned bool
	err        error
}

func (q *referralPositionQuery) QueryRow(_ context.Context, query string, args ...any) pgx.Row {
	q.query, q.args = query, args
	return referralPositionRow{q.positioned, q.err}
}

type referralPositionRow struct {
	positioned bool
	err        error
}

func (r referralPositionRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	*dest[0].(*bool) = r.positioned
	return nil
}

func TestVerifiedReferralPositionReadPreservesCanonicalRestrictionsWithoutCapabilityOrLocks(t *testing.T) {
	q := &referralPositionQuery{positioned: true}
	positioned, err := verifiedReferralPosition(context.Background(), q, "synthetic-subject", "synthetic-member@example.test")
	if err != nil || !positioned || len(q.args) != 2 || q.args[0] != "synthetic-subject" || q.args[1] != "synthetic-member@example.test" {
		t.Fatal("positioned owner lost canonical parameterized read", positioned, err, q.args)
	}
	for _, required := range []string{"b.subject=$1", "b.provider='better_auth'", "u.email_verified", "p.user_id=b.subject",
		"lower(btrim(u.email))=$2", "lower(btrim(p.email::text))=$2", "p.status::text IN('active','pending')",
		"NOT COALESCE(p.blacklisted,false)", "restricted.person_id=p.id", "restricted.status::text IN('suspended','banned','deleted')", "other.id<>p.id", "lower(btrim(other.email::text))=$2"} {
		if !strings.Contains(q.query, required) {
			t.Errorf("canonical read lost guard %q", required)
		}
	}
	for _, forbidden := range []string{"verified_registration_referral(", "registration_referral", "FOR UPDATE", "FOR NO KEY UPDATE",
		"INSERT ", "UPDATE ", "DELETE ", "sponsor_id", "synthetic-subject", "synthetic-member@example.test"} {
		if strings.Contains(q.query, forbidden) {
			t.Errorf("position confirmation depends on mutation, hint, lock or interpolated input %q", forbidden)
		}
	}
}

func TestVerifiedReferralPositionReadDistinguishesUnpositionedIdentityReviewAndUnavailable(t *testing.T) {
	unavailable := errors.New("synthetic-private-storage-detail")
	for _, tc := range []struct {
		name       string
		positioned bool
		dbErr      error
		wantErr    error
	}{
		{"positioned", true, nil, nil},
		{"unpositioned", false, nil, nil},
		{"identity restrictions", false, pgx.ErrNoRows, ErrCheckoutIdentityReview},
		{"storage unavailable", false, unavailable, unavailable},
		{"request cancelled", false, context.Canceled, context.Canceled},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := &referralPositionQuery{positioned: tc.positioned, err: tc.dbErr}
			positioned, err := verifiedReferralPosition(context.Background(), q, "synthetic-subject", "synthetic-member@example.test")
			if positioned != tc.positioned || !errors.Is(err, tc.wantErr) {
				t.Fatal("read must not turn a restriction/outage into confirmed placement", positioned, err)
			}
		})
	}
}
