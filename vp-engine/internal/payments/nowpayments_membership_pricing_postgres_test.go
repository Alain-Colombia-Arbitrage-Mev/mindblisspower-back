package payments

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestNOWPaymentsIncludedPricingMigrationIntegration(t *testing.T) {
	if testing.Short() {
		t.Skip("isolated PostgreSQL testcontainer")
	}
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	apply := func(name string) {
		t.Helper()
		migration, err := os.ReadFile(filepath.Join(findRepoRoot(t), "_meta", "migration", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(migration)); err != nil {
			t.Fatal(name, err)
		}
	}
	apply("70_stable_identity_bindings.sql")
	apply("74_nowpayments_membership_review.sql")
	const legacyID = "40cf03f1-64ed-465a-8e67-1887530781c8"
	if _, err := pool.Exec(ctx, `INSERT INTO auth.user(id,email,email_verified)
 VALUES('synthetic-included-price','included-price@example.test',true);
 INSERT INTO mlm.person(first_name,last_name,email,phone_number,status,user_id)
 VALUES('Synthetic','Included price','included-price@example.test','0','active','synthetic-included-price');
 INSERT INTO identity.auth_binding(subject,person_id,link_method)
 SELECT 'synthetic-included-price',id,'new_registration' FROM mlm.person WHERE user_id='synthetic-included-price';
 INSERT INTO mlm.package(id,name,amount_usd,pv,type) VALUES
 (6001,'Synthetic legacy price',100,50,'enrollment'),(6002,'Synthetic exact fractional-cent basis',0.50,0,'enrollment');`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO payments.nowpayments_membership_attempt
 (id,environment,auth_subject,person_id,person_public_id,package_id,package_name,pv,amount_usd,fee_usd,total_cents,state,invoice_id)
 SELECT $1::uuid,'production','synthetic-included-price',id,public_id,6001,'Synthetic legacy price',50,100,1,10100,'invoice_created','76001'
 FROM mlm.person WHERE user_id='synthetic-included-price'`, legacyID); err != nil {
		t.Fatal(err)
	}
	var originalLegacy string
	if err := pool.QueryRow(ctx, `SELECT to_jsonb(a)::text FROM payments.nowpayments_membership_attempt a WHERE id=$1::uuid`, legacyID).Scan(&originalLegacy); err != nil {
		t.Fatal(err)
	}
	apply("77_nowpayments_included_pricing.sql")
	var retainedLegacy string
	if err := pool.QueryRow(ctx, `SELECT (to_jsonb(a)-'pricing_policy'-'provider_cost_usd'-'commission_base_usd')::text
 FROM payments.nowpayments_membership_attempt a WHERE id=$1::uuid`, legacyID).Scan(&retainedLegacy); err != nil || retainedLegacy != originalLegacy {
		t.Fatal("migration changed existing order facts", err)
	}
	store := NewStore(pool)
	legacy, err := store.LookupNOWPaymentsMembership(ctx, legacyID, "production")
	if err != nil || legacy.AmountUSD != "100.00" || legacy.FeeUSD != "1.00" || legacy.TotalCents != 10100 ||
		legacy.PricingPolicy != "" || legacy.ProviderCostUSD != "" || legacy.CommissionBaseUSD != "" {
		t.Fatal("legacy order was repriced or assigned a new policy", legacy, err)
	}
	payment := syntheticNOWPayment(legacyID, legacy.InvoiceID, "96001", "finished")
	if err := matchingNOWPaymentsEvidence(legacy, payment, payment); err != nil {
		t.Fatal("new policy rejected original persisted invoice evidence", err)
	}
	if _, err := store.RecordNOWPaymentsReceipt(ctx, "production", payment, payment, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); err != nil {
		t.Fatal("legacy invoice receipt can no longer be reviewed", err)
	}

	current, err := store.CreateNOWPaymentsMembership(ctx, NOWPaymentsMembershipInput{
		Email: "included-price@example.test", Environment: "production", PackageID: 6002,
	})
	if err != nil || current.AmountUSD != "0.50" || current.FeeUSD != "0.00" || current.TotalCents != 50 ||
		current.PricingPolicy != nowPaymentsIncludedPricingPolicy || current.ProviderCostUSD != "0.0050" || current.CommissionBaseUSD != "0.4950" {
		t.Fatal("new order did not persist exact included cost and 99 percent basis", current, err)
	}

	// Every post-migration insertion must declare the new immutable policy;
	// nullable facts are retained only for rows that existed before migration.
	const insert = `INSERT INTO payments.nowpayments_membership_attempt
 (environment,auth_subject,person_id,person_public_id,package_id,package_name,pv,amount_usd,fee_usd,total_cents,
 state,pricing_policy,provider_cost_usd,commission_base_usd)
 SELECT environment,auth_subject,person_id,person_public_id,package_id,package_name,pv,$6::numeric,$4::numeric,$5::bigint,
 'closed_reviewed',$1::text,$2::numeric,$3::numeric FROM payments.nowpayments_membership_attempt WHERE id=$7::uuid`
	for _, tc := range []struct {
		name               string
		policy, cost, base any
		fee, amount        string
		total              int64
	}{
		{"legacy-null-insert", nil, nil, nil, "0", "100", 10000},
		{"missing-cost", nowPaymentsIncludedPricingPolicy, nil, "99", "0", "100", 10000},
		{"missing-base", nowPaymentsIncludedPricingPolicy, "1", nil, "0", "100", 10000},
		{"unknown-policy", "client_supplied", "1", "99", "0", "100", 10000},
		{"customer-surcharge", nowPaymentsIncludedPricingPolicy, "1", "99", "1", "100", 10100},
		{"wrong-total", nowPaymentsIncludedPricingPolicy, "1", "99", "0", "100", 10001},
		{"wrong-cost", nowPaymentsIncludedPricingPolicy, "2", "98", "0", "100", 10000},
		{"gross-commission-base", nowPaymentsIncludedPricingPolicy, "1", "100", "0", "100", 10000},
		{"rounded-fractional-cent-cost", nowPaymentsIncludedPricingPolicy, "0.01", "0.49", "0", "0.50", 50},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := pool.Exec(ctx, insert, tc.policy, tc.cost, tc.base, tc.fee, tc.total, tc.amount, legacyID)
			var pgErr *pgconn.PgError
			if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
				t.Fatal("invalid inserted pricing must fail a check constraint", err)
			}
		})
	}
	for _, query := range []string{
		`UPDATE payments.nowpayments_membership_attempt SET pricing_policy=NULL,provider_cost_usd=NULL,commission_base_usd=NULL WHERE id=$1::uuid`,
		`UPDATE payments.nowpayments_membership_attempt SET pricing_policy='client_supplied' WHERE id=$1::uuid`,
		`UPDATE payments.nowpayments_membership_attempt SET provider_cost_usd=0.01,commission_base_usd=0.49 WHERE id=$1::uuid`,
	} {
		if _, err := pool.Exec(ctx, query, current.ID); err == nil {
			t.Fatal("new order pricing can be changed", query)
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE payments.nowpayments_membership_attempt
 SET pricing_policy=$2,provider_cost_usd=1,commission_base_usd=99 WHERE id=$1::uuid`, legacyID, nowPaymentsIncludedPricingPolicy); err == nil {
		t.Fatal("legacy order can be retrospectively relabelled with new policy")
	}
	var artifacts int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM payments.purchase_intent)+(SELECT count(*) FROM payments.stripe_event)
 +(SELECT count(*) FROM mlm.affiliate_package)+(SELECT count(*) FROM mlm.wallet_movement)+(SELECT count(*) FROM mlm.tree_event)
 +(SELECT count(*) FROM mlm.investment_cd)`).Scan(&artifacts); err != nil || artifacts != 0 {
		t.Fatal("pricing or receipt review created operational financial artifacts", artifacts, err)
	}
}
