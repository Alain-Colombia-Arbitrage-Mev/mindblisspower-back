package payments

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
	"github.com/shopspring/decimal"
)

func TestNOWMemberPolicySeparatesRecoveryAndUnknown(t *testing.T) {
	for _, policy := range []*NOWMemberPolicy{emptyNOWMemberPolicy(), {ReadModelStatus: "unavailable"}} {
		summary := MemberSummary{DataSource: recoveredStripeSource, PayoutLocked: true, NOWPayments: policy}
		wire := memberSummaryJSON(t, summary)
		if wire["wallet_balance_usd"] != nil || wire["commission_available_usd"] != nil || wire["payout_locked"] != true {
			t.Fatal("NOW read model changed recovery liability semantics", wire)
		}
		now := wire["nowpayments"].(map[string]any)
		if now["withdrawals_enabled"] != false || now["read_model_status"] != policy.ReadModelStatus {
			t.Fatal("NOW read model enabled payments", now)
		}
		if policy.ReadModelStatus == "unavailable" && (now["commissions"] != nil || now["membership"] != nil) {
			t.Fatal("backend failure became an invented zero balance", now)
		}
	}
}

func TestNOWMemberPolicyRejectsUnverifiedOwnerAndBackendFailure(t *testing.T) {
	for _, tc := range []struct {
		name, email, token, actAs string
		verifier                  IdentityVerifier
	}{
		{"wrong subject token", "member@example.test", "synthetic", "", fakeNOWSubject{err: errors.New("invalid")}},
		{"another email", "other@example.test", "synthetic", "", fakeNOWSubject{}},
		{"missing token", "member@example.test", "", "", fakeNOWSubject{}},
		{"impersonation", "member@example.test", "synthetic", "other@example.test", fakeNOWSubject{}},
		{"backend unavailable", "member@example.test", "synthetic", "", fakeNOWSubject{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := NewHandler(NewStore(nil), nil, "synthetic-service", nil, 0, zerolog.Nop())
			h.verifier = tc.verifier
			r := httptest.NewRequest(http.MethodGet, "/api/payments/me", nil)
			r.Header.Set(idTokenHeader, tc.token)
			r.Header.Set(actAsHeader, tc.actAs)
			summary := MemberSummary{DataSource: recoveredStripeSource, PayoutLocked: true}
			h.attachNOWMemberPolicy(r, &summary, tc.email)
			if summary.NOWPayments.ReadModelStatus != "unavailable" || summary.NOWPayments.Commissions != nil || !summary.PayoutLocked {
				t.Fatal("unverified owner or backend failure exposed a financial result")
			}
		})
	}
}

func TestNOWMemberCommissionExactTimestampNotLedgerDate(t *testing.T) {
	current := time.Date(2026, 2, 28, 17, 30, 0, 0, time.UTC)
	ten, six, two := decimal.NewFromInt(10), decimal.NewFromInt(6), decimal.NewFromInt(2)
	if got := nowCommissionStatus(true, current.Add(time.Nanosecond), current, six, six, decimal.Zero, two); got != "pending_maturity" {
		t.Fatal("calendar date unlocked exact-time claim early", got)
	}
	if got := nowCommissionStatus(true, current, current, ten, six, decimal.Zero, two); got != "available" {
		t.Fatal("exact due instant stayed locked", got)
	}
	if got := nowCommissionStatus(false, current, current, ten, six, decimal.Zero, two); got != "risk_review" {
		t.Fatal("risk made locked money available", got)
	}
}

func TestNOWMemberPolicyReadOnlyPostgres(t *testing.T) {
	if testing.Short() {
		t.Skip("isolated PostgreSQL testcontainer")
	}
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	for _, name := range []string{"70_stable_identity_bindings.sql", "74_nowpayments_membership_review.sql", "75_nowpayments_webhook_capture.sql", "77_nowpayments_included_pricing.sql", "79_nowpayments_operational_orders.sql", "80_nowpayments_scoped_engine.sql", "82_nowpayments_calendar_maturity.sql"} {
		data, err := os.ReadFile(filepath.Join(findRepoRoot(t), "_meta", "migration", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(data)); err != nil {
			t.Fatal(name, err)
		}
	}
	applyNOWPurchaseLifecycleMigration(t, ctx, pool)
	admin := seedAdmin(t, ctx, pool, "policy-admin@example.test")
	seedActivePlan(t, ctx, pool, admin)
	var root int64
	if err := pool.QueryRow(ctx, `INSERT INTO mlm.affiliate(person_id,parent_id,position,status) VALUES($1,NULL,NULL,'active') RETURNING id`, admin).Scan(&root); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO auth.user(id,email,email_verified) VALUES('signed-subject','member@example.test',true);
 INSERT INTO mlm.person(first_name,last_name,email,phone_number,status,user_id) VALUES('Synthetic','Policy','member@example.test','0','active','signed-subject');
 INSERT INTO identity.auth_binding(subject,person_id,link_method) SELECT 'signed-subject',id,'new_registration' FROM mlm.person WHERE user_id='signed-subject';
 INSERT INTO mlm.package(id,name,amount_usd,pv,type) VALUES(8301,'Synthetic NOW policy',100,100,'enrollment');
 INSERT INTO mlm.asset(id,symbol,name,is_fiat,decimals) VALUES(1,'USD','US Dollar',true,2) ON CONFLICT(symbol) DO NOTHING;`); err != nil {
		t.Fatal(err)
	}
	store := NewNOWPaymentsOperationalStore(pool)
	store.SetNOWOperationalReadiness(func(context.Context, pgx.Tx) error { return nil })
	order, err := store.CreateNOWPaymentsMembership(ctx, NOWPaymentsMembershipInput{Subject: "signed-subject", Email: "member@example.test", Environment: "production", PackageID: 8301, SponsorAffiliateID: &root, PurchaseRequestID: uuid.NewString()})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.AttachNOWPaymentsInvoice(ctx, order.ID, "production", "83001"); err != nil {
		t.Fatal(err)
	}
	payment := syntheticNOWPayment(order.ID, "83001", "830001", "finished")
	payment.PriceAmount, payment.PayAmount, payment.ActuallyPaid = "100.00", "100", "100"
	hash := strings.Repeat("a", 64)
	if err := NewNOWPaymentsCaptureStore(pool).Capture(ctx, "production", payment, payment, hash); err != nil {
		t.Fatal(err)
	}
	if state, err := store.processNOWOperationalPayment(ctx, "production", payment, payment, hash); err != nil || state != "activated" {
		t.Fatal(state, err)
	}
	if _, err := pool.Exec(ctx, `DO $$ BEGIN CREATE ROLE mindbliss_payments_20261025 LOGIN NOINHERIT PASSWORD 'synthetic-read-model'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
 GRANT USAGE ON SCHEMA auth,identity,mlm,payments TO mindbliss_payments_20261025;
 GRANT SELECT(id,email,email_verified) ON auth.user TO mindbliss_payments_20261025;
 GRANT SELECT(subject,person_id,provider) ON identity.auth_binding TO mindbliss_payments_20261025;
 GRANT SELECT ON mlm.person,mlm.affiliate,mlm.affiliate_package,mlm.wallet,mlm.asset,mlm.wallet_movement,mlm.investment_cd,mlm.withdrawal_request,mlm.rank,mlm.concept,payments.purchase_intent TO mindbliss_payments_20261025;
 GRANT SELECT(id,external_ref) ON mlm.transaction TO mindbliss_payments_20261025;`); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(findRepoRoot(t), "_meta", "migration", "83_nowpayments_member_reader.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, string(data)); err != nil {
		t.Fatal("exact reader83", err)
	}
	cfg := pool.Config()
	cfg.ConnConfig.User, cfg.ConnConfig.Password = "mindbliss_payments_20261025", "synthetic-read-model"
	cfg.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	reader, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	readStore := NewStore(reader)
	policy, err := readStore.GetNOWMemberPolicy(ctx, "signed-subject", "member@example.test")
	if err != nil || policy.Membership.PrincipalLockedUSD != "100.00" || policy.Membership.PrincipalAvailableUSD != "0.00" {
		t.Fatal("activated owner principal read", policy, err)
	}
	var affiliate, pkg, cd, wallet, period, rootWallet, retirementWallet int64
	if err := pool.QueryRow(ctx, `SELECT affiliate_id,affiliate_package_id,investment_cd_id FROM payments.nowpayments_operational_order WHERE attempt_id=$1::uuid`, order.ID).Scan(&affiliate, &pkg, &cd); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO mlm.wallet(affiliate_id,asset_id,address,balance) SELECT $1,id,'synthetic-policy',0 FROM mlm.asset WHERE symbol='USD' ON CONFLICT(affiliate_id,asset_id) DO UPDATE SET address=EXCLUDED.address RETURNING id`, affiliate).Scan(&wallet); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO mlm.asset(id,symbol,name,is_fiat,decimals) VALUES(8302,'USD-RET','Synthetic retirement',true,2) ON CONFLICT(symbol) DO NOTHING`); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO mlm.wallet(affiliate_id,asset_id,address,balance) SELECT $1,id,'synthetic-policy-root',0 FROM mlm.asset WHERE symbol='USD' ON CONFLICT(affiliate_id,asset_id) DO UPDATE SET address=EXCLUDED.address RETURNING id`, root).Scan(&rootWallet); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO mlm.wallet(affiliate_id,asset_id,address,balance) SELECT $1,id,'synthetic-policy-retirement',0 FROM mlm.asset WHERE symbol='USD-RET' RETURNING id`, affiliate).Scan(&retirementWallet); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO payments.nowpayments_engine_period(period_start,period_end) VALUES(now()-interval '7 days',now()) RETURNING id`).Scan(&period); err != nil {
		t.Fatal(err)
	}
	for i, generated := range []string{"now()", "now()-interval '2 months'"} {
		var obligation int64
		query := `WITH stamp AS(SELECT ` + generated + ` AS at) INSERT INTO payments.nowpayments_engine_obligation(external_ref,source_attempt_id,period_id,affiliate_id,affiliate_package_id,kind,entitlement_usd,paid_usd,commission_factor,created_at,available_at)
 SELECT $1,$2::uuid,$3,$4,$5,'direct_bonus',10,6,.99,at,((at AT TIME ZONE 'America/Bogota')+interval '1 month') AT TIME ZONE 'America/Bogota' FROM stamp RETURNING id`
		ref := fmt.Sprintf("now:policy:%d", i)
		if err := pool.QueryRow(ctx, query, ref, order.ID, period, affiliate, pkg).Scan(&obligation); err != nil {
			t.Fatal(err)
		}
		var transaction string
		if err := pool.QueryRow(ctx, `INSERT INTO mlm.transaction(external_ref,description,status) VALUES($1,'Synthetic NOW read model','posted') RETURNING id`, ref).Scan(&transaction); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO payments.nowpayments_engine_payment(obligation_id,installment,amount_usd,theta,posted_at,transaction_ref) VALUES($1,1,6,1,now(),$2)`, obligation, ref); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO mlm.wallet_movement(transaction_id,wallet_id,affiliate_id,concept_id,amount,posted_at,available_at)
 VALUES($1,$2,$3,1012,2,now(),CURRENT_DATE-1),($1,$4,$5,1012,2,now(),CURRENT_DATE-1),($1,$6,$3,1012,2,now(),CURRENT_DATE-1)`, transaction, wallet, affiliate, rootWallet, root, retirementWallet); err != nil {
			t.Fatal(err)
		}
	}
	policy, err = readStore.GetNOWMemberPolicy(ctx, "signed-subject", "member@example.test")
	if err != nil || policy.Commissions.AvailableUSD != "2.00" || policy.Commissions.PendingUSD != "2.00" || policy.Commissions.CreditedUSD != "12.00" || policy.Commissions.FundingHeldUSD != "8.00" || policy.Commissions.PaidExternalUSD != "0.00" {
		t.Fatal("counter/actual-beneficiary/exact-time/funding categories mixed", policy, err)
	}
	var legacyTransaction string
	if err := pool.QueryRow(ctx, `INSERT INTO mlm.transaction(external_ref,description,status) VALUES('legacy:member:synthetic','Synthetic legacy commission','posted') RETURNING id`).Scan(&legacyTransaction); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO mlm.wallet_movement(transaction_id,wallet_id,affiliate_id,concept_id,amount,posted_at,available_at) VALUES($1,$2,$3,1012,3,now(),CURRENT_DATE-1)`, legacyTransaction, wallet, affiliate); err != nil {
		t.Fatal(err)
	}
	legacy, err := readStore.GetMemberSummaryFresh(ctx, "member@example.test")
	legacyAvailable, _ := decimal.NewFromString(legacy.CommissionAvailable)
	legacyBalance, _ := decimal.NewFromString(legacy.WalletBalanceUSD)
	if err != nil || !legacyAvailable.Equal(decimal.NewFromInt(3)) || !legacyBalance.Equal(decimal.NewFromInt(3)) {
		t.Fatal("legacy DATE fallback counted scoped NOW or lost historical credit", legacy, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE mlm.investment_cd SET start_at=now()-interval '366 days',matures_at=now()-interval '1 day' WHERE id=$1`, cd); err != nil {
		t.Fatal(err)
	}
	policy, err = readStore.GetNOWMemberPolicy(ctx, "signed-subject", "member@example.test")
	if err != nil || policy.Membership.PrincipalAvailableUSD != "100.00" || policy.WithdrawalsEnabled {
		t.Fatal("maturity is eligibility only, no payout", policy, err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO mlm.withdrawal_request(affiliate_id,wallet_id,amount_usd,status) VALUES($1,$2,1,'requested')`, affiliate, wallet); err != nil {
		t.Fatal(err)
	}
	policy, err = readStore.GetNOWMemberPolicy(ctx, "signed-subject", "member@example.test")
	if err != nil || policy.Membership.PrincipalAvailableUSD != "0.00" || policy.Commissions.AvailableUSD != "0.00" || policy.Membership.Items[0].Eligibility != "risk_review" {
		t.Fatal("pending withdrawal failed closed", policy, err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM mlm.withdrawal_request WHERE affiliate_id=$1`, affiliate); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO auth.user(id,email,email_verified) VALUES('other-policy-subject','other-policy@example.test',true);
 INSERT INTO mlm.person(first_name,last_name,email,phone_number,status,user_id) VALUES('Other','Policy','other-policy@example.test','0','active','other-policy-subject');
 INSERT INTO identity.auth_binding(subject,person_id,link_method) SELECT 'other-policy-subject',id,'new_registration' FROM mlm.person WHERE user_id='other-policy-subject';`); err != nil {
		t.Fatal(err)
	}
	other, err := store.CreateNOWPaymentsMembership(ctx, NOWPaymentsMembershipInput{Subject: "other-policy-subject", Email: "other-policy@example.test", Environment: "production", PackageID: 8301, SponsorAffiliateID: &root, PurchaseRequestID: uuid.NewString()})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.AttachNOWPaymentsInvoice(ctx, other.ID, "production", "83002"); err != nil {
		t.Fatal(err)
	}
	otherPayment := syntheticNOWPayment(other.ID, "83002", "830002", "finished")
	otherPayment.PriceAmount, otherPayment.PayAmount, otherPayment.ActuallyPaid = "100.00", "100", "100"
	if err := NewNOWPaymentsCaptureStore(pool).Capture(ctx, "production", otherPayment, otherPayment, strings.Repeat("b", 64)); err != nil {
		t.Fatal(err)
	}
	if state, err := store.processNOWOperationalPayment(ctx, "production", otherPayment, otherPayment, strings.Repeat("b", 64)); err != nil || state != "activated" {
		t.Fatal(state, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE payments.nowpayments_operational_order SET state='risk_review' WHERE attempt_id=$1::uuid`, other.ID); err != nil {
		t.Fatal(err)
	}
	policy, err = readStore.GetNOWMemberPolicy(ctx, "signed-subject", "member@example.test")
	if err != nil || policy.Commissions.AvailableUSD != "0.00" || policy.Membership.PrincipalAvailableUSD != "0.00" || policy.Membership.Items[0].Eligibility != "risk_review" {
		t.Fatal("risk on another NOW sale escaped the global engine freeze", policy, err)
	}
	for _, subject := range []string{"missing-binding", "another-subject"} {
		if _, err := readStore.GetNOWMemberPolicy(ctx, subject, "member@example.test"); err == nil {
			t.Fatal("supplied email selected another subject")
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO mlm.person(first_name,last_name,email,phone_number,status) VALUES('Duplicate','Canonical',' member@example.test ','0','active')`); err != nil {
		t.Fatal(err)
	}
	if _, err := readStore.GetNOWMemberPolicy(ctx, "signed-subject", "member@example.test"); err == nil {
		t.Fatal("ambiguous canonical email selected a financial owner")
	}
	// Neither a read model nor principal maturity creates a capital wallet credit.
	var ledgerTotal string
	if err := pool.QueryRow(ctx, `SELECT sum(amount)::numeric(20,2)::text FROM mlm.wallet_movement`).Scan(&ledgerTotal); err != nil || ledgerTotal != "15.00" {
		t.Fatal("read-only eligibility credited principal or mutated ledger", ledgerTotal, err)
	}
	encoded, _ := json.Marshal(policy)
	if strings.Contains(string(encoded), order.ID) || strings.Contains(string(encoded), "member@example.test") || strings.Contains(string(encoded), "signed-subject") {
		t.Fatal("read model leaked identity/provider/order metadata")
	}
}
