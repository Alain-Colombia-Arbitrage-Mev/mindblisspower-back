package payments

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRegistrationReferralCheckoutReaderPostgres(t *testing.T) {
	if testing.Short() {
		t.Skip("isolated PostgreSQL testcontainer")
	}
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	// The generic fixture includes old migrations 62/64. Only its empty,
	// disposable table is removed to reproduce the production missing-table case.
	var rows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM payments.registration_referral`).Scan(&rows); err != nil || rows != 0 {
		t.Fatal("disposable fixture is not empty", rows, err)
	}
	if _, err := pool.Exec(ctx, `DROP TABLE payments.registration_referral;
 CREATE ROLE mindbliss_payments_20261025 LOGIN NOINHERIT PASSWORD 'synthetic-reader-only';
 GRANT USAGE ON SCHEMA payments,mlm TO mindbliss_payments_20261025;
 GRANT SELECT ON mlm.affiliate,mlm.person,mlm.blacklist TO mindbliss_payments_20261025;`); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(findRepoRoot(t), "_meta", "migration", "81_registration_referral_checkout_reader.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, string(data)); err != nil {
		t.Fatal("reviewed migration81", err)
	}
	var restricted bool
	if err := pool.QueryRow(ctx, `SELECT NOT has_table_privilege('mindbliss_payments_20261025','payments.registration_referral','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 AND has_column_privilege('mindbliss_payments_20261025','payments.registration_referral','preferred_side','SELECT')
 AND NOT has_column_privilege('mindbliss_payments_20261025','payments.registration_referral','created_at','SELECT')
 AND NOT has_column_privilege('mindbliss_payments_20261025','payments.registration_referral','source','SELECT')
 AND NOT has_table_privilege('vp_engine','payments.registration_referral','INSERT,UPDATE,DELETE,TRUNCATE')`).Scan(&restricted); err != nil || !restricted {
		t.Fatal("migration widened reader or legacy writer permissions", restricted, err)
	}
	cfg := pool.Config()
	cfg.ConnConfig.User = "mindbliss_payments_20261025"
	cfg.ConnConfig.Password = "synthetic-reader-only"
	reader, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	store := NewStore(reader)
	if referral, err := store.LookupRegistrationReferral(ctx, "synthetic-buyer@example.test"); err != nil || referral != nil {
		t.Fatal("empty referral lookup must continue to company-root fallback", referral, err)
	}
	// An operator-only synthetic row proves the complete query, including sponsor
	// eligibility/blacklist functions and the preferred-side column, is readable.
	if _, err := pool.Exec(ctx, `INSERT INTO mlm.person(id,first_name,last_name,email,phone_number,status,blacklisted)
 OVERRIDING SYSTEM VALUE VALUES(8101,'Synthetic','Sponsor','synthetic-sponsor@example.test','0','active',false);
 INSERT INTO mlm.affiliate(id,person_id,parent_id,position,status)
 OVERRIDING SYSTEM VALUE VALUES(8101,8101,NULL,NULL,'active');
 INSERT INTO payments.registration_referral(email_norm,referral_code,sponsor_affiliate_id,preferred_side)
 VALUES('synthetic-buyer@example.test','synthetic-code',8101,'R');`); err != nil {
		t.Fatal(err)
	}
	referral, err := store.LookupRegistrationReferral(ctx, " SYNTHETIC-BUYER@example.test ")
	if err != nil || referral == nil || referral.Code != "synthetic-code" || referral.SponsorAffiliateID != 8101 || referral.PreferredSide != "R" {
		t.Fatal("exact restricted-reader lookup", referral, err)
	}
	h := &Handler{store: store, companyRoot: 999}
	assertRootFallback := func(t *testing.T, email string) {
		t.Helper()
		sponsor, code, side, err := h.resolveCheckoutPlacement(ctx, email, Buyer{PersonID: 8102}, "", "")
		if err != nil || sponsor == nil || *sponsor != 999 || code != "" || side != "" {
			t.Fatalf("absent, expired or consumed hint must retain company-root fallback: sponsor=%v code=%q side=%q err=%v", sponsor, code, side, err)
		}
	}
	t.Run("eligible hint retains attribution", func(t *testing.T) {
		sponsor, code, side, err := h.resolveCheckoutPlacement(ctx, "synthetic-buyer@example.test", Buyer{PersonID: 8102}, "stale-browser-ref", "L")
		if err != nil || sponsor == nil || *sponsor != 8101 || code != "synthetic-code" || side != "R" {
			t.Fatal("durable referral must retain its sponsor and side", sponsor, code, side, err)
		}
	})
	for _, tc := range []struct{ name, restrict, restore string }{
		{"suspended affiliate", `UPDATE mlm.affiliate SET status='suspended' WHERE id=8101`, `UPDATE mlm.affiliate SET status='active' WHERE id=8101`},
		{"suspended person", `UPDATE mlm.person SET status='suspended' WHERE id=8101`, `UPDATE mlm.person SET status='active' WHERE id=8101`},
		{"blacklisted person", `UPDATE mlm.person SET blacklisted=true WHERE id=8101`, `UPDATE mlm.person SET blacklisted=false WHERE id=8101`},
		{"blacklist-only sponsor", `INSERT INTO mlm.blacklist(email_norm) VALUES('synthetic-sponsor@example.test')`, `DELETE FROM mlm.blacklist WHERE email_norm='synthetic-sponsor@example.test'`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := pool.Exec(ctx, tc.restrict); err != nil {
				t.Fatal(err)
			}
			defer func() {
				if _, err := pool.Exec(ctx, tc.restore); err != nil {
					t.Error(err)
				}
			}()
			if referral, err := store.LookupRegistrationReferral(ctx, "synthetic-buyer@example.test"); err != nil || referral != nil {
				t.Fatal("legacy readers must continue hiding ineligible hints", referral, err)
			}
			for _, browserRef := range []string{"", "MP8101", "stale-browser-ref"} {
				sponsor, code, side, err := h.resolveCheckoutPlacement(ctx, "synthetic-buyer@example.test", Buyer{PersonID: 8102}, browserRef, "L")
				if !errors.Is(err, ErrInvalidReferralCode) || sponsor != nil || code != "" || side != "" {
					t.Errorf("fresh ineligible hint must not silently reassign a new buyer: sponsor=%v code=%q side=%q err=%v", sponsor, code, side, err)
				}
			}
			// Existing network identity is authoritative even if a later browser or
			// stored hint has become unusable. This lookup must never move a member.
			affiliateID, originalSponsor := int64(8102), int64(8101)
			sponsor, code, side, err := h.resolveCheckoutPlacement(ctx, "synthetic-buyer@example.test",
				Buyer{PersonID: 8102, AffiliateID: &affiliateID, SponsorAffiliateID: &originalSponsor}, "stale-browser-ref", "L")
			if err != nil || sponsor == nil || *sponsor != originalSponsor || code != "" || side != "" {
				t.Error("ineligible stored hint changed a positioned member", sponsor, code, side, err)
			}
		})
	}
	t.Run("no stored hint retains fallback", func(t *testing.T) {
		assertRootFallback(t, "absent-buyer@example.test")
	})
	for _, tc := range []struct{ name, expire string }{
		{"expired hint retains fallback", `UPDATE payments.registration_referral SET updated_at=now()-interval '31 days'`},
		{"consumed hint retains fallback", `UPDATE payments.registration_referral SET consumed_at=now()`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Freshness/consumption still take precedence even if the old sponsor
			// is ineligible; no valid recent attribution is being discarded here.
			if _, err := pool.Exec(ctx, `UPDATE mlm.affiliate SET status='suspended' WHERE id=8101;`+tc.expire); err != nil {
				t.Fatal(err)
			}
			defer func() {
				if _, err := pool.Exec(ctx, `UPDATE mlm.affiliate SET status='active' WHERE id=8101; UPDATE payments.registration_referral SET updated_at=now(), consumed_at=NULL`); err != nil {
					t.Error(err)
				}
			}()
			assertRootFallback(t, "synthetic-buyer@example.test")
		})
	}
	for _, query := range []string{`SELECT created_at FROM payments.registration_referral`,
		`INSERT INTO payments.registration_referral(email_norm,referral_code,sponsor_affiliate_id) VALUES('forbidden@example.test','x',8101)`,
		`UPDATE payments.registration_referral SET preferred_side='L'`, `DELETE FROM payments.registration_referral`} {
		if _, err := reader.Exec(ctx, query); err == nil {
			t.Fatal("reader acquired an unrelated permission", query)
		}
	}
}
