package payments

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestManualMemberPolicyReadOnlyPostgres(t *testing.T) {
	if testing.Short() {
		t.Skip("isolated PostgreSQL fixture; no production database accepted")
	}
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	for _, name := range []string{"70_stable_identity_bindings.sql", "74_nowpayments_membership_review.sql", "75_nowpayments_webhook_capture.sql", "77_nowpayments_included_pricing.sql", "79_nowpayments_operational_orders.sql", "80_nowpayments_scoped_engine.sql", "82_nowpayments_calendar_maturity.sql", "91_manual_compensation_sources.sql"} {
		body, err := os.ReadFile(filepath.Join(findRepoRoot(t), "_meta", "migration", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(body)); err != nil {
			t.Fatal(name, err)
		}
	}
	admin := seedAdmin(t, ctx, pool, "manual-policy-admin@example.invalid")
	seedActivePlan(t, ctx, pool, admin)
	if _, err := pool.Exec(ctx, `INSERT INTO mlm.package(id,name,amount_usd,pv,type) VALUES(9100,'Synthetic manual policy100',100,100,'enrollment');
 INSERT INTO auth.user(id,email,email_verified) VALUES('manual-pending-subject','manual-policy@example.invalid',false),('manual-other-subject','manual-other@example.invalid',true);
 INSERT INTO mlm.person(first_name,last_name,email,phone_number,status) VALUES('Synthetic','Manual policy','manual-policy@example.invalid','0','pending');
 INSERT INTO mlm.person(first_name,last_name,email,phone_number,status,user_id) VALUES('Synthetic','Other policy','manual-other@example.invalid','0','active','manual-other-subject');
 INSERT INTO identity.auth_binding(subject,person_id,link_method) SELECT 'manual-other-subject',id,'new_registration' FROM mlm.person WHERE user_id='manual-other-subject';`); err != nil {
		t.Fatal(err)
	}
	var person, affiliate, otherPerson, otherAffiliate int64
	if err := pool.QueryRow(ctx, `INSERT INTO mlm.affiliate(person_id,parent_id,position,status)
 SELECT id,NULL,NULL,'active' FROM mlm.person WHERE email='manual-policy@example.invalid' RETURNING person_id,id`).Scan(&person, &affiliate); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO mlm.affiliate(person_id,parent_id,position,status)
 SELECT id,$1,'L','active' FROM mlm.person WHERE email='manual-other@example.invalid' RETURNING person_id,id`, affiliate).Scan(&otherPerson, &otherAffiliate); err != nil {
		t.Fatal(err)
	}
	manualID, pkg, cd := seedManualPolicyMembership(t, ctx, pool, person, affiliate)
	otherID, _, _ := seedManualPolicyMembership(t, ctx, pool, otherPerson, otherAffiliate)
	if _, err := pool.Exec(ctx, `CREATE ROLE manual_policy_reader LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-reader-only'`); err != nil {
		t.Fatal(err)
	}
	acl, err := os.ReadFile(filepath.Join(findRepoRoot(t), "_meta", "roles", "manual_compensation_reader.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `SELECT set_config('mindbliss.manual_compensation_reader_role','manual_policy_reader',true);`+string(acl)); err != nil {
		t.Fatal("exact manual reader ACL", err)
	}
	cfg := pool.Config()
	cfg.ConnConfig.User, cfg.ConnConfig.Password = "manual_policy_reader", "synthetic-reader-only"
	cfg.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	reader, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	store := NewStore(reader)
	if got, err := store.GetManualMemberPolicy(ctx, "manual-pending-subject", "manual-policy@example.invalid"); err == nil || got != nil {
		t.Fatal("pending OTP/unbound principal gained financial access")
	}
	if _, err := pool.Exec(ctx, `UPDATE auth.user SET email_verified=true WHERE id='manual-pending-subject';
 UPDATE mlm.person SET user_id='manual-pending-subject' WHERE email='manual-policy@example.invalid';
 INSERT INTO identity.auth_binding(subject,person_id,link_method) SELECT 'manual-pending-subject',id,'new_registration' FROM mlm.person WHERE user_id='manual-pending-subject';`); err != nil {
		t.Fatal(err)
	}
	policy, err := store.GetManualMemberPolicy(ctx, "manual-pending-subject", " MANUAL-POLICY@example.invalid ")
	if err != nil || policy.Membership.PrincipalLockedUSD != "100.00" || policy.Membership.Items[0].FeeUSD != "3.00" || policy.Membership.Items[0].PV != "100" {
		t.Fatal("manual owner/reader permissions/100 principal/3 fee/100 PV", policy, err)
	}
	t.Run("explicit read group preserves login attributes and only inherits SELECT", func(t *testing.T) {
		verifyManualPolicyReaderGroup(t, ctx, pool, acl)
	})
	for _, claims := range [][2]string{{"manual-other-subject", "manual-policy@example.invalid"}, {"manual-pending-subject", "manual-other@example.invalid"}, {"unknown-subject", "manual-policy@example.invalid"}} {
		if got, err := store.GetManualMemberPolicy(ctx, claims[0], claims[1]); err == nil || got != nil {
			t.Fatal("email-only claim selected another owner's capital")
		}
	}
	// The commission beneficiary is this owner even when its source purchaser is
	// a different person. No fake auth_subject/payment_id is added to manual.
	if _, err := pool.Exec(ctx, `WITH period AS(INSERT INTO payments.nowpayments_engine_period(period_start,period_end)
 VALUES(now()-interval '7 days',now()) RETURNING id)
 INSERT INTO payments.nowpayments_engine_obligation(external_ref,source_attempt_id,earning_source_id,period_id,affiliate_id,affiliate_package_id,kind,entitlement_usd,paid_usd,commission_factor,created_at,available_at)
 SELECT 'comp:manual-policy:direct',$1::uuid,$4::uuid,period.id,$2,$3,'direct_bonus',4.85,0,.97,now(),
 ((now() AT TIME ZONE 'America/Bogota')+interval '1 month') AT TIME ZONE 'America/Bogota' FROM period`, manualID, affiliate, pkg, otherID); err != nil {
		t.Fatal(err)
	}
	policy, err = store.GetManualMemberPolicy(ctx, "manual-pending-subject", "manual-policy@example.invalid")
	if err != nil || policy.Commissions.FundingHeldUSD != "4.85" || len(policy.Commissions.Items) != 1 || policy.Commissions.AvailableUSD != "0.00" || policy.Commissions.Items[0].Status != "funding_held" || policy.Commissions.Items[0].SourceProvider != "manual" {
		t.Fatal("downline manual source did not project only to verified beneficiary", policy, err)
	}
	other, err := store.GetManualMemberPolicy(ctx, "manual-other-subject", "manual-other@example.invalid")
	if err != nil || other.Commissions.FundingHeldUSD != "0.00" || other.Membership.PrincipalLockedUSD != "100.00" {
		t.Fatal("cross-owner obligation leakage", other, err)
	}
	encoded, _ := json.Marshal(policy)
	for _, private := range []string{manualID, otherID, "manual-policy@example.invalid", "manual-pending-subject", "authorization_digest"} {
		if strings.Contains(string(encoded), private) {
			t.Fatal("manual read model leaked identity/operator/provider evidence")
		}
	}
	// A broken CD join must not become an empty available balance. Restore only
	// the synthetic record; source manifest immutability stays enabled.
	if _, err := pool.Exec(ctx, `UPDATE mlm.investment_cd SET principal_usd=99 WHERE id=$1`, cd); err != nil {
		t.Fatal(err)
	}
	if got, err := store.GetManualMemberPolicy(ctx, "manual-pending-subject", "manual-policy@example.invalid"); err == nil || got != nil {
		t.Fatal("missing canonical view/FK record match invented zero balance")
	}
	if _, err := pool.Exec(ctx, `UPDATE mlm.investment_cd SET principal_usd=100 WHERE id=$1`, cd); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE payments.manual_membership_order SET state='risk_review' WHERE id=$1::uuid`, otherID); err != nil {
		t.Fatal(err)
	}
	policy, err = store.GetManualMemberPolicy(ctx, "manual-pending-subject", "manual-policy@example.invalid")
	if err != nil || policy.Membership.Items[0].Eligibility != "risk_review" || policy.Membership.PrincipalAvailableUSD != "0.00" ||
		policy.Commissions.FundingHeldUSD != "4.85" || len(policy.Commissions.Items) != 1 || policy.Commissions.Items[0].Status != "risk_review" {
		t.Fatal("risk on another source escaped shared funding freeze", policy, err)
	}
	var noSecrets, noWrites bool
	if err := reader.QueryRow(ctx, `SELECT NOT has_table_privilege(current_user,'auth.account','SELECT')
 AND NOT has_table_privilege(current_user,'auth.session','SELECT')
 AND NOT has_table_privilege(current_user,'auth.verification','SELECT'),
 NOT has_table_privilege(current_user,'payments.manual_membership_order','INSERT,UPDATE,DELETE,TRUNCATE')`).Scan(&noSecrets, &noWrites); err != nil || !noSecrets || !noWrites {
		t.Fatal("reader gained authentication secrets or writes", noSecrets, noWrites, err)
	}
	var movements int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM mlm.wallet_movement`).Scan(&movements); err != nil || movements != 0 || policy.WithdrawalsEnabled {
		t.Fatal("read projection created credit/withdrawal", movements, err)
	}
}

func verifyManualPolicyReaderGroup(t *testing.T, ctx context.Context, pool *pgxpool.Pool, acl []byte) {
	t.Helper()
	if _, err := pool.Exec(ctx, `CREATE ROLE manual_policy_read_group NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 CREATE ROLE manual_policy_inheriting_login LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-inheriting-reader';
 GRANT manual_policy_read_group TO manual_policy_inheriting_login;
 CREATE ROLE manual_policy_noninherit_group NOLOGIN NOINHERIT;
 CREATE ROLE manual_policy_parented_group NOLOGIN INHERIT;
 GRANT manual_policy_read_group TO manual_policy_parented_group;
 CREATE ROLE manual_policy_write_group NOLOGIN INHERIT;
 GRANT UPDATE ON auth.user TO manual_policy_write_group;`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `SELECT set_config('mindbliss.manual_compensation_reader_role','manual_policy_read_group',true);`+string(acl)); err != nil {
		t.Fatal("explicit INHERIT NOLOGIN read group rejected", err)
	}
	for _, target := range []string{"manual_policy_inheriting_login", "manual_policy_noninherit_group", "manual_policy_parented_group", "manual_policy_write_group"} {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `SELECT set_config('mindbliss.manual_compensation_reader_role',$1,true)`, target); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatal(err)
		}
		_, grantErr := tx.Exec(ctx, string(acl))
		_ = tx.Rollback(ctx)
		if grantErr == nil {
			t.Fatal("unsafe role profile accepted by read-only manifest", target)
		}
	}
	cfg := pool.Config()
	cfg.ConnConfig.User, cfg.ConnConfig.Password = "manual_policy_inheriting_login", "synthetic-inheriting-reader"
	cfg.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	reader, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	p, err := NewStore(reader).GetManualMemberPolicy(ctx, "manual-pending-subject", "manual-policy@example.invalid")
	if err != nil || p.Membership.PrincipalLockedUSD != "100.00" || p.Membership.Items[0].NetUSD != "97.00" {
		t.Fatal("login did not inherit effective invoker-view SELECT", p, err)
	}
	var unchanged, noWrites, noSecrets bool
	if err := reader.QueryRow(ctx, `SELECT
 (SELECT rolcanlogin AND rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
  FROM pg_roles WHERE rolname=current_user)
 AND EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles group_role ON group_role.oid=m.roleid
  JOIN pg_roles login_role ON login_role.oid=m.member WHERE group_role.rolname='manual_policy_read_group' AND login_role.rolname=current_user)
 AND (SELECT NOT rolcanlogin AND rolinherit FROM pg_roles WHERE rolname='manual_policy_read_group'),
 NOT has_table_privilege(current_user,'payments.manual_membership_order','INSERT,UPDATE,DELETE,TRUNCATE')
 AND NOT has_any_column_privilege(current_user,'auth.user','INSERT,UPDATE,REFERENCES')
 AND NOT has_schema_privilege(current_user,'auth','CREATE')
 AND NOT has_schema_privilege(current_user,'identity','CREATE')
 AND NOT has_schema_privilege(current_user,'mlm','CREATE')
 AND NOT has_schema_privilege(current_user,'payments','CREATE'),
 NOT has_table_privilege(current_user,'auth.account','SELECT')
 AND NOT has_table_privilege(current_user,'auth.session','SELECT')
 AND NOT has_table_privilege(current_user,'auth.verification','SELECT')
 AND NOT has_table_privilege(current_user,'auth.jwks','SELECT')`).Scan(&unchanged, &noWrites, &noSecrets); err != nil || !unchanged || !noWrites || !noSecrets {
		t.Fatal("read-group manifest altered login attributes/membership or granted writes/secrets", unchanged, noWrites, noSecrets, err)
	}
}

func seedManualPolicyMembership(t *testing.T, ctx context.Context, pool *pgxpool.Pool, person, affiliate int64) (string, int64, int64) {
	t.Helper()
	id := uuid.NewString()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	var pkg, cd int64
	if err := tx.QueryRow(ctx, `INSERT INTO mlm.affiliate_package(affiliate_id,package_id,status,payment_method,transaction_hash,pv_remaining,activated_at)
 VALUES($1,9100,'active','manual','manual:production:'||$2,100,now()) RETURNING id`, affiliate, id).Scan(&pkg); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `INSERT INTO mlm.investment_cd(affiliate_id,affiliate_package_id,principal_usd,roi_tier_id,start_at,matures_at)
 VALUES($1,$2,100,1,now(),now()+interval '365 days') RETURNING id`, affiliate, pkg).Scan(&cd); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO payments.manual_membership_order(id,operation_key,person_id,affiliate_id,package_id,affiliate_package_id,investment_cd_id,
 plan_config_id,roi_tier_id,cd_lock_days,lifetime_cap_factor,plan_snapshot,roi_base_annual_rate,roi_qualified_annual_rate,gross_usd,fee_rate,fee_usd,net_usd,pv,
 effective_at,approved_at,actor_reason,authorization_digest)
 SELECT $1::uuid,$2,$3,$4,9100,$5,$6,p.id,1,365,2,to_jsonb(p),.25,.30,100,.03,3,97,100,
 now(),now(),'Synthetic manual membership read-only projection',repeat('a',64) FROM mlm.plan_config p WHERE p.version_label='v-base'`, id, "manual-membership:synthetic:"+id, person, affiliate, pkg, cd); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return id, pkg, cd
}
