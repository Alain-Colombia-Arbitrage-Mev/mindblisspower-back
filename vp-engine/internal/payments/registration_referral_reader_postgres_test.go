package payments

import (
	"context"
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
	for _, query := range []string{`SELECT created_at FROM payments.registration_referral`,
		`INSERT INTO payments.registration_referral(email_norm,referral_code,sponsor_affiliate_id) VALUES('forbidden@example.test','x',8101)`,
		`UPDATE payments.registration_referral SET preferred_side='L'`, `DELETE FROM payments.registration_referral`} {
		if _, err := reader.Exec(ctx, query); err == nil {
			t.Fatal("reader acquired an unrelated permission", query)
		}
	}
}
