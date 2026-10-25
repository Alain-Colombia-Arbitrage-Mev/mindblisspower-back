package payments

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

func TestRecoveredStripeJSONDoesNotInventBalances(t *testing.T) {
	f := AdminFinance{DataSource: recoveredStripeSource, StripeRecovery: &StripeRecoveryReview{}, InflowsUSD: "1558.00", RanksAchieved: 42}
	b, err := json.Marshal(f)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	_ = json.Unmarshal(b, &wire)
	for _, key := range []string{"treasury_usd", "net_settled_usd", "commissions_distributed_usd", "ranks_bonus_usd", "withdrawals_paid_usd", "pending_payout_usd", "stripe_fee_usd", "stripe_reserve_usd"} {
		if wire[key] != nil {
			t.Fatalf("unknown %s must be null, got %v", key, wire[key])
		}
	}
	if wire["inflows_usd"] != "1558.00" || wire["ranks_achieved"] != float64(42) {
		t.Fatal("source facts were lost")
	}
	legacy, _ := json.Marshal(AdminFinance{TreasuryUSD: "50.00", StripeFeeUSD: "3.00"})
	_ = json.Unmarshal(legacy, &wire)
	if wire["treasury_usd"] != "50.00" || wire["stripe_fee_usd"] != "3.00" {
		t.Fatal("normal operational contract changed")
	}
	row, _ := json.Marshal(SalesRow{DataSource: recoveredStripeSource})
	_ = json.Unmarshal(row, &wire)
	if wire["created"] != nil || wire["activated"] != nil || wire["amount_usd"] != nil {
		t.Fatal("imported captures cannot prove checkout starts or activations")
	}
}

func TestRecoveredStripeReadModelIntegration(t *testing.T) {
	if testing.Short() {
		t.Skip("isolated PostgreSQL testcontainer")
	}
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, recoveredStripeTestFixture); err != nil {
		t.Fatal("source fixture", err)
	}
	store := NewStore(pool)
	allTime := time.Time{}
	f, err := store.GetAdminFinance(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if f.DataSource != recoveredStripeSource || f.InflowsUSD != "1558.00" || f.PacksPaid != 18 || f.RefundedUSD != "41.00" {
		t.Fatal("did not isolate verified live Mindbliss captures from other providers/intents", f.InflowsUSD, f.PacksPaid, f.RefundedUSD)
	}
	if f.StripeRecovery.FinanciallyEligible != 13 || f.StripeRecovery.RefundedSales != 1 || f.StripeRecovery.DisputedSales != 4 {
		t.Fatal("synthetic refund and dispute cases were not preserved")
	}
	funds := f.StripeRecovery.Funds
	if funds.ProcessingEstimateBPS != 300 || funds.SecurityRetentionBPS != 3500 || funds.ProcessingEstimateUSD != "46.74" || funds.SecurityRetainedUSD != "545.30" || funds.CompanyPayoutReportedUSD != "123.00" || funds.HeldUnderReviewUSD != "801.96" {
		t.Fatal("owner allocation not preserved", funds)
	}
	if funds.ActualProcessingFeeUSD == nil || *funds.ActualProcessingFeeUSD != "49.99" || funds.ProcessingDifferenceUSD == nil || *funds.ProcessingDifferenceUSD != "3.25" || funds.CompanySettledVerifiedUSD != nil || funds.AffiliateLiabilityUSD != nil || funds.AutomaticPayoutEnabled || funds.ProviderReconciled {
		t.Fatal("observed provider fees confused with verified payouts/liabilities", funds)
	}
	rows, err := store.SalesReport(ctx, allTime)
	if err != nil || len(rows) != 5 {
		t.Fatal("source catalog, not legacy package IDs, must group sales", len(rows), err)
	}
	if rows[0].AmountUSD != "40.00" || rows[0].Paid != 8 || rows[0].GrossUSD != "328.00" {
		t.Fatal("used the legacy package price", rows[0])
	}
	cash, err := store.SalesCashSummary(ctx, allTime)
	if err != nil || cash.GrossChargedUSD != "1558.00" || cash.PackageSalesUSD != "1520.00" || cash.ActivationFeesUSD != "38.00" {
		t.Fatal("catalog breakdown", cash, err)
	}
	filtered, err := store.SalesCashSummary(ctx, time.Date(2024, 3, 1, 0, 0, 0, 0, time.UTC))
	if err != nil || filtered.SuccessfulCharges != 4 || filtered.GrossChargedUSD != "656.00" || filtered.StripeRecovery.Funds.CompanyPayoutReportedUSD != "123.00" {
		t.Fatal("period facts or explicitly all-time allocation changed", filtered, err)
	}
	totals, err := store.SalesTotalsSince(ctx, allTime)
	if err != nil || totals.Count != 18 || totals.GrossCents != 155800 {
		t.Fatal("reconciliation counts duplicated charge/session/operational intent", totals, err)
	}
	transactions, total, err := store.SalesTransactions(ctx, allTime, "refunded", "", 25, 0)
	if err != nil || total != 1 || len(transactions) != 1 || transactions[0].RefundUSD != "41.00" || !transactions[0].ReadOnly || transactions[0].ActivatedAt != "" {
		t.Fatal("refund or read-only status", total, err)
	}
	unverified, total, err := store.SalesTransactions(ctx, allTime, "", "", 1, 0)
	if err != nil || total != 18 || len(unverified) != 1 || unverified[0].Email != "" || unverified[0].AffiliateID != nil {
		t.Fatal("candidate identity was promoted to an authoritative person/placement", total, err)
	}
	if _, _, err := store.VerifyTransactionStripe(ctx, nil, "pi_recovery1"); !errors.Is(err, ErrRecoveryFinancialReview) {
		t.Fatal("recovered source must not invoke operational Stripe verification mutation", err)
	}
	summary, err := store.AdminSummary(ctx)
	if err != nil || summary.TotalSold != 18 || summary.TotalRevenUSD != "1558.00" {
		t.Fatal("summary omitted canonical recovery captures", summary.TotalSold, err)
	}
	solvency, err := store.GetSolvency(ctx)
	if err != nil || solvency.Health != "UNKNOWN" || solvency.Current != nil {
		t.Fatal("recovery cannot establish solvency", solvency, err)
	}
	h := NewHandler(store, nil, "recovery-unit-service-token", []string{"buyer@t.local"}, 1, zerolog.Nop())
	h.SetIdentityVerifier(fakeVerifier{email: "buyer@t.local"}, true)
	for _, route := range []struct {
		path   string
		handle http.HandlerFunc
	}{
		{"/api/admin/command-center/summary", h.handleCommandCenterSummary},
		{"/api/admin/network/health", h.handleNetworkHealth},
		{"/api/admin/network/sustainability", h.handleNetworkSustainability},
	} {
		r := httptest.NewRequest(http.MethodGet, route.path, nil)
		r.Header.Set("X-VP-Service-Token", "recovery-unit-service-token")
		r.Header.Set(idTokenHeader, "recovery-unit-id-token")
		w := httptest.NewRecorder()
		route.handle(w, r)
		if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "stripe_recovery_financial_review_required") {
			t.Fatal("incomplete financial evidence cannot produce margin/AI health", route.path, w.Code)
		}
	}
	var before int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM payments.purchase_intent`).Scan(&before)
	if before != 1 {
		t.Fatal("read model fabricated operational purchase intents", before)
	}
	// A newer own-product capture may be shown without inventing a catalog,
	// identity or allocation of the historical aggregate USD123 payment.
	if _, err := pool.Exec(ctx, `INSERT INTO payments.stripe_sale VALUES
		('pi_newown',true,'succeeded',now(),now(),'usd',4100,0,0,'{"packmindbliss":"true","package_id":"1001"}','["tag"]',true)`); err != nil {
		t.Fatal(err)
	}
	updated, err := store.SalesCashSummary(ctx, allTime)
	if err != nil || updated.SuccessfulCharges != 19 || updated.GrossChargedUSD != "1599.00" || updated.PackageSalesUSD != "" || updated.StripeRecovery.Funds.PolicyMatchesCurrentSource || updated.StripeRecovery.Status != "owner_policy_snapshot_requires_update" {
		t.Fatal("new capture must not inherit old snapshot allocations/catalog automatically", err)
	}
	if updated.StripeRecovery.Funds.CompanyPayoutReportedUSD != "123.00" || updated.StripeRecovery.Funds.SaleCount != 18 {
		t.Fatal("historical aggregate policy was prorated or reassigned to new sales")
	}
	if _, err := pool.Exec(ctx, `DROP VIEW recovery.v_stripe_funds_provider_comparison`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetAdminFinance(ctx); !errors.Is(err, ErrRecoveryFinancialReview) {
		t.Fatal("incomplete recovery schema must fail closed, never fall back to unrelated intents", err)
	}
}

// Entirely synthetic fixture: prices, counts, dates and money allocations are
// deliberately unrelated to any recovered production database or owner payout.
const recoveredStripeTestFixture = `
CREATE SCHEMA recovery;
CREATE TABLE payments.stripe_sale(payment_intent_id text PRIMARY KEY,livemode boolean,payment_status text,
 payment_created_at timestamptz,charged_at timestamptz,currency text,captured_minor bigint,refunded_minor bigint,
 dispute_count int,metadata jsonb,product_evidence jsonb,source_eligible boolean);
CREATE TABLE recovery.stripe_sale_identity(payment_intent_id text PRIMARY KEY,person_id bigint,affiliate_id bigint,identity_verified boolean,catalog_verified boolean);
CREATE TABLE recovery.package_catalog_snapshot(source_package_id bigint PRIMARY KEY,currency text,base_minor bigint,fee_minor bigint);
INSERT INTO recovery.package_catalog_snapshot VALUES(1001,'usd',4000,100),(1002,'usd',8000,200),(1003,'usd',12000,300),(1004,'usd',16000,400),(1005,'usd',20000,500);
INSERT INTO mlm.person(id,first_name,last_name,email,phone_number,status) OVERRIDING SYSTEM VALUE VALUES(1,'Test','Buyer','buyer@t.local','0','active');
INSERT INTO mlm.affiliate(person_id,status,path,depth) VALUES(1,'active',''::ltree,0);
INSERT INTO mlm.package(id,name,amount_usd,pv,type) VALUES(1001,'WRONG legacy catalog',7777,42,'enrollment');
INSERT INTO payments.purchase_intent(user_id,person_id,package_id,pv,amount_usd,fee_usd,total_cents,currency,status,stripe_session_id,stripe_present,paid_at)
 VALUES('unrelated@t.local',1,1001,42,7777000,77770,785477000,'usd','activated','cs_unrelated',true,now());
INSERT INTO payments.stripe_sale
 SELECT 'pi_recovery'||i,true,'succeeded','2024-01-10T00:00:00Z'::timestamptz,
 CASE WHEN i=18 THEN '2024-03-21T00:00:00Z'::timestamptz WHEN i>14 THEN '2024-03-20T00:00:00Z'::timestamptz ELSE '2024-01-10T00:00:00Z'::timestamptz END,
 'usd',c.base_minor+c.fee_minor,CASE WHEN i=1 THEN 4100 ELSE 0 END,
 CASE WHEN i BETWEEN 2 AND 5 THEN 1 ELSE 0 END,
 jsonb_build_object('packmindbliss','true','package_id',c.source_package_id::text),'["explicit_product_tag"]'::jsonb,i>5
 FROM generate_series(1,18) i JOIN recovery.package_catalog_snapshot c ON c.source_package_id=
 CASE WHEN i<=8 THEN 1001 WHEN i<=12 THEN 1002 WHEN i<=15 THEN 1003 WHEN i<=17 THEN 1004 ELSE 1005 END;
INSERT INTO recovery.stripe_sale_identity SELECT payment_intent_id,1,1,payment_intent_id<>'pi_recovery18',true FROM payments.stripe_sale;
INSERT INTO payments.stripe_sale VALUES
 ('pi_otherproduct',true,'succeeded',now(),now(),'usd',99999999,0,0,'{"packmindbliss":"false"}','["other"]',true),
 ('pi_testmode',false,'succeeded',now(),now(),'usd',99999999,0,0,'{"packmindbliss":"true"}','["tag"]',true),
 ('pi_eur',true,'succeeded',now(),now(),'eur',99999999,0,0,'{"packmindbliss":"true"}','["tag"]',true);
CREATE VIEW recovery.v_stripe_funds_review AS SELECT 'policy_v1'::text AS policy_key,now() AS recorded_at,
 'owner_declaration'::text AS source_kind,'company_payout'::text AS paid_scope,'gross'::text AS base_kind,'usd'::text AS currency,
 18::bigint AS sale_count,155800::bigint AS gross_collected_minor,4100::bigint AS refunded_minor,
 300 AS processing_estimate_bps,3500 AS security_retention_bps,4674::bigint AS processing_estimate_minor,
 54530::bigint AS security_retained_minor,12300::bigint AS company_payout_reported_minor,80196::bigint AS held_under_review_minor,
 NULL::bigint AS company_settled_verified_minor,NULL::bigint AS affiliate_commission_liability_minor,
 false AS provider_settlement_reconciled,false AS automatic_payout_enabled,true AS allocation_balanced;
CREATE VIEW recovery.v_stripe_funds_provider_comparison AS SELECT 'policy_v1'::text AS policy_key,
 true AS complete_charge_fee_coverage,4999::bigint AS actual_processing_fee_minor,325::bigint AS processing_difference_under_review_minor,
 'paid_reported_by_owner_bank_allocation_not_verified'::text AS company_payout_status;
`
