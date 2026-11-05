package payments

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestAdminUsersRecoveryReadNeverUsesLegacyIntentOrEmailGuess(t *testing.T) {
	query := adminUsersReadSQL(true)
	for _, required := range []string{"payments.stripe_sale", "recovery.stripe_sale_identity", "i.person_id=p.id AND i.identity_verified", recoveredStripePredicate} {
		if !strings.Contains(query, required) {
			t.Fatalf("recovery user query missing %q", required)
		}
	}
	for _, forbidden := range []string{"purchase_intent", "stripe_present", "s.metadata->>'email'", "SUM(amount_usd+fee_usd)"} {
		if strings.Contains(query, forbidden) {
			t.Fatalf("recovery user query uses unsafe source %q", forbidden)
		}
	}
	if !strings.Contains(adminUsersReadSQL(false), "payments.purchase_intent") {
		t.Fatal("ordinary operational database contract changed")
	}
}

func TestAdminUsersRecoveryReadWithoutStripePresentIntegration(t *testing.T) {
	if testing.Short() {
		t.Skip("isolated PostgreSQL testcontainer")
	}
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, recoveredStripeTestFixture); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `ALTER TABLE payments.purchase_intent DROP COLUMN stripe_present;
		CREATE ROLE fixture_payments_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
		GRANT USAGE ON SCHEMA mlm,payments,recovery TO fixture_payments_reader;
		GRANT SELECT ON mlm.person,mlm.affiliate,mlm.rank,mlm.affiliate_package,
			payments.stripe_sale,recovery.stripe_sale_identity TO fixture_payments_reader;`); err != nil {
		t.Fatal(err)
	}
	readerConfig := pool.Config().Copy()
	readerConfig.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		_, err := conn.Exec(ctx, "SET ROLE fixture_payments_reader; SET default_transaction_read_only=on")
		return err
	}
	reader, err := pgxpool.NewWithConfig(ctx, readerConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	rows, total, err := NewStore(reader).ListUsers(ctx, "buyer@t.local", 25, 0)
	if err != nil || total != 1 || len(rows) != 1 {
		t.Fatalf("canonical users read: total=%d rows=%d error=%v", total, len(rows), err)
	}
	// Gross capture is known, not commission/activation/net. The synthetic
	// unverified identity (205.00), wrong product, test and non-USD captures,
	// and an unrelated legacy intent (millions) must all remain excluded.
	if rows[0].TotalPaidUSD != "1353.00" || rows[0].DataSource != recoveredStripeSource {
		t.Fatalf("attributed unverified/unrelated purchases: %+v", rows[0])
	}
}
