package payments

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/vicionpower/vp-engine/internal/manualmembership"
	"github.com/vicionpower/vp-engine/internal/nowengine"
	"github.com/vicionpower/vp-engine/internal/shared/financialguard"
)

// Only a newly created testcontainer is used. Never accepts a production DSN,
// environment database, email recipient or provider key. Root runs this test
// explicitly with the existing Docker-backed pgContainer harness.
func TestManualMembershipActivationPostgres(t *testing.T) {
	if testing.Short() {
		t.Skip("isolated PostgreSQL testcontainer")
	}
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	for _, name := range []string{"70_stable_identity_bindings.sql", "74_nowpayments_membership_review.sql",
		"75_nowpayments_webhook_capture.sql", "77_nowpayments_included_pricing.sql", "79_nowpayments_operational_orders.sql",
		"80_nowpayments_scoped_engine.sql", "82_nowpayments_calendar_maturity.sql", "91_manual_compensation_sources.sql"} {
		data, err := os.ReadFile(filepath.Join(findRepoRoot(t), "_meta", "migration", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(data)); err != nil {
			t.Fatal(name, err)
		}
	}
	admin := seedAdmin(t, ctx, pool, "operator@manual.example.test")
	var root int64
	if err := pool.QueryRow(ctx, `INSERT INTO mlm.affiliate(person_id,parent_id,position,status) VALUES($1,NULL,NULL,'active') RETURNING id`, admin).Scan(&root); err != nil {
		t.Fatal(err)
	}
	plan, err := os.ReadFile(filepath.Join(findRepoRoot(t), "_meta", "migration", "33_seed_plan_config.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, string(plan)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO mlm.asset(id,symbol,name,is_fiat,decimals) VALUES(1,'USD','US Dollar',true,2) ON CONFLICT(symbol) DO NOTHING;
 INSERT INTO mlm.package(id,name,amount_usd,pv,type) VALUES(9101,'Synthetic manual 100',100,100,'enrollment');
 INSERT INTO mlm.concept(id,kind,name_es,name_en,factor,requires_pair,active) VALUES(1100,'binary_bonus','Binario sintético','Synthetic binary',1,false,true);
 CREATE TABLE payments.stripe_sale(payment_intent_id text PRIMARY KEY);
 INSERT INTO payments.stripe_sale VALUES('pi_synthetic_recovery_unchanged');`); err != nil {
		t.Fatal(err)
	}
	var person, affiliate int64
	var publicID, fingerprint string
	if err := pool.QueryRow(ctx, `INSERT INTO mlm.person(first_name,last_name,email,phone_number,status,is_admin)
 VALUES('Synthetic','Manual','owner@manual.example.test','0','active',false) RETURNING id,public_id::text`).Scan(&person, &publicID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO mlm.affiliate(person_id,parent_id,sponsor_id,position,status)
 VALUES($1,$2,$2,'R','active') RETURNING id`, person, root).Scan(&affiliate); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex') FROM mlm.affiliate a WHERE id=$1`, affiliate).Scan(&fingerprint); err != nil {
		t.Fatal(err)
	}
	in := manualmembership.Input{ExpectedDatabase: "vicionpower_test", ID: uuid.NewString(), OperationKey: "manual-membership:synthetic-" + uuid.NewString(),
		PersonID: person, PersonPublicID: publicID, AffiliateID: affiliate, PackageID: 9101, AuthorizationDigest: strings.Repeat("a", 64),
		Authority: "owner_instruction", ActorReason: "Synthetic reviewed owner instruction for a manual payment", ExpectedAffiliateSHA256: fingerprint}
	service := manualmembership.New(pool, root)
	before := func() string {
		t.Helper()
		var value string
		if err := pool.QueryRow(ctx, `SELECT jsonb_build_object(
 'affiliates',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM mlm.affiliate a),
 'stripe',(SELECT jsonb_agg(to_jsonb(s)) FROM payments.stripe_sale s),
 'auth_users',(SELECT count(*) FROM auth.user),'bindings',(SELECT count(*) FROM identity.auth_binding),
 'now_attempts',(SELECT count(*) FROM payments.nowpayments_membership_attempt),
 'now_receipts',(SELECT count(*) FROM payments.nowpayments_membership_receipt),
 'captures',(SELECT count(*) FROM payments.nowpayments_webhook_capture),
 'tree_events',(SELECT count(*) FROM mlm.tree_event))::text`).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}()
	preflight, err := service.Preflight(ctx, in)
	if err != nil || !preflight.DatabaseMatches || !preflight.TargetMatches || preflight.AffiliateSHA256 != fingerprint {
		t.Fatal("readonly preflight", err)
	}
	result, err := service.Apply(ctx, in)
	if err != nil || result.Replay || result.MaturesAt.Sub(result.EffectiveAt) != 365*24*time.Hour {
		t.Fatal("manual activation", err)
	}
	var amount, fee, net string
	var pv int
	var untouched, source bool
	if err := pool.QueryRow(ctx, `SELECT gross_usd::text,fee_usd::text,net_usd::text,pv FROM payments.manual_membership_order WHERE id=$1::uuid`, in.ID).Scan(&amount, &fee, &net, &pv); err != nil || amount != "100.00" || fee != "3.0000" || net != "97.0000" || pv != 100 {
		t.Fatal("manual manifest", amount, fee, net, pv, err)
	}
	if err := pool.QueryRow(ctx, `SELECT p.user_id IS NULL AND NOT EXISTS(SELECT 1 FROM identity.auth_binding b WHERE b.person_id=p.id),
 EXISTS(SELECT 1 FROM payments.v_compensation_source WHERE source_id=$2::uuid AND source_kind='manual') FROM mlm.person p WHERE p.id=$1`, person, in.ID).Scan(&untouched, &source); err != nil || !untouched || !source {
		t.Fatal("manual payment fabricated auth/evidence", err)
	}
	var after string
	if err := pool.QueryRow(ctx, `SELECT jsonb_build_object(
 'affiliates',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM mlm.affiliate a),
 'stripe',(SELECT jsonb_agg(to_jsonb(s)) FROM payments.stripe_sale s),
 'auth_users',(SELECT count(*) FROM auth.user),'bindings',(SELECT count(*) FROM identity.auth_binding),
 'now_attempts',(SELECT count(*) FROM payments.nowpayments_membership_attempt),
 'now_receipts',(SELECT count(*) FROM payments.nowpayments_membership_receipt),
 'captures',(SELECT count(*) FROM payments.nowpayments_webhook_capture),
 'tree_events',(SELECT count(*) FROM mlm.tree_event))::text`).Scan(&after); err != nil || before != after {
		t.Fatal("business identities/history changed", err)
	}
	checkCount := func(want int) {
		t.Helper()
		var count int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM mlm.affiliate_package WHERE affiliate_id=$1`, affiliate).Scan(&count); err != nil || count != want {
			t.Fatal("package count", count, err)
		}
	}
	checkCount(1)
	replay, err := service.Apply(ctx, in)
	if err != nil || !replay.Replay || replay.AffiliatePackageID != result.AffiliatePackageID || replay.CDID != result.CDID {
		t.Fatal("idempotent replay", err)
	}
	checkCount(1)
	mismatch := in
	mismatch.AuthorizationDigest = strings.Repeat("b", 64)
	if _, err := service.Apply(ctx, mismatch); !errors.Is(err, manualmembership.ErrConflict) {
		t.Fatal("mismatching replay accepted", err)
	}
	checkCount(1)
	engine := nowengine.New(pool, root)
	if err := engine.Run(ctx); err != nil {
		t.Fatal("day-zero scoped run", err)
	}
	var obligations, principalCredit int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM payments.nowpayments_engine_obligation),
 (SELECT count(*) FROM mlm.wallet_movement WHERE affiliate_id=$1)`, affiliate).Scan(&obligations, &principalCredit); err != nil || obligations != 0 || principalCredit != 0 {
		t.Fatal("day zero invented ROI/commission/principal credit", err)
	}
	if err := financialguard.RequireOperational(ctx, pool); !errors.Is(err, financialguard.ErrRecoveryReview) {
		t.Fatal("manual source unlocked legacy finance", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE payments.manual_membership_order SET gross_usd=101 WHERE id=$1::uuid`, in.ID); err == nil {
		t.Fatal("manual source mutable")
	}
	if _, err := pool.Exec(ctx, `UPDATE payments.manual_membership_order SET state='risk_review' WHERE id=$1::uuid`, in.ID); err != nil {
		t.Fatal(err)
	}
	if err := engine.Run(ctx); !errors.Is(err, nowengine.ErrRiskFrozen) {
		t.Fatal("manual risk did not freeze scoped engine", err)
	}
}
