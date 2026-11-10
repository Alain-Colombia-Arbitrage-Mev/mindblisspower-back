package payments

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Real PostgreSQL, independent runtime/operator pools and the exact reviewed
// migration. No providers, public database, OTPs, or production data are used.
func TestVerifiedRegistrationReferralRestrictedPostgres(t *testing.T) {
	if testing.Short() {
		t.Skip("isolated PostgreSQL testcontainer")
	}
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	apply := func(name string) {
		t.Helper()
		b, err := os.ReadFile(filepath.Join(findRepoRoot(t), "_meta", "migration", name))
		if err != nil {
			t.Fatal(err)
		}
		if name == "89_verified_registration_referral.sql" {
			// Only the explicit database-name guard is changed for this disposable
			// fixture; the complete function, role ACLs and lock semantics are exact.
			if strings.Count(string(b), "mindbliss_curated_20261025") != 1 {
				t.Fatal("review the fixture database guard substitution")
			}
			b = []byte(strings.Replace(string(b), "mindbliss_curated_20261025", "vicionpower_test", 1))
		}
		if _, err = pool.Exec(ctx, string(b)); err != nil {
			t.Fatal(name, err)
		}
	}
	apply("70_stable_identity_bindings.sql")
	if _, err := pool.Exec(ctx, `CREATE ROLE mindbliss_go_payments_reader_v1 NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 CREATE ROLE synthetic_referral_reader LOGIN INHERIT PASSWORD 'synthetic-referral-only';
 CREATE ROLE synthetic_referral_other NOLOGIN;
 GRANT mindbliss_go_payments_reader_v1 TO synthetic_referral_reader WITH INHERIT TRUE,SET FALSE,ADMIN FALSE;
 GRANT USAGE ON SCHEMA auth,identity,mlm,payments TO mindbliss_go_payments_reader_v1;
 GRANT SELECT ON mlm.person,mlm.affiliate,mlm.blacklist TO mindbliss_go_payments_reader_v1;
 GRANT SELECT(id,email,email_verified) ON auth.user TO mindbliss_go_payments_reader_v1;
 GRANT SELECT(subject,person_id,provider) ON identity.auth_binding TO mindbliss_go_payments_reader_v1;
 GRANT SELECT(email_norm,referral_code,sponsor_affiliate_id,preferred_side,updated_at,consumed_at) ON payments.registration_referral TO synthetic_referral_reader;
 INSERT INTO auth.user(id,email,email_verified) VALUES
 ('synthetic-referral-owner','owner-referral@example.test',true),('synthetic-referral-other','other-referral@example.test',true),
 ('synthetic-referral-unverified','unverified-referral@example.test',false);
 INSERT INTO mlm.person(id,user_id,first_name,last_name,email,phone_number,status,blacklisted) OVERRIDING SYSTEM VALUE VALUES
 (9801,NULL,'Synthetic','First sponsor','first-referral@example.test','0','active',false),
 (9802,NULL,'Synthetic','Second sponsor','second-referral@example.test','0','active',false),
 (9803,'synthetic-referral-owner','Synthetic','Owner','owner-referral@example.test','0','pending',false),
 (9804,'synthetic-referral-unverified','Synthetic','Unverified','unverified-referral@example.test','0','active',false);
 INSERT INTO identity.auth_binding(subject,person_id,link_method) VALUES
 ('synthetic-referral-owner',9803,'new_registration'),('synthetic-referral-unverified',9804,'new_registration');
 INSERT INTO mlm.affiliate(id,person_id,parent_id,position,status,invitation_link) OVERRIDING SYSTEM VALUE VALUES
 (9801,9801,NULL,NULL,'active','@First'),(9802,9802,9801,'L','active','@Second');`); err != nil {
		t.Fatal("seed isolated role/identity fixture", err)
	}
	// Dependency/preflight failures roll back before a privileged callable object
	// exists. Only the fixture database constant is changed for the positive case.
	migration89, err := os.ReadFile(filepath.Join(findRepoRoot(t), "_meta", "migration", "89_verified_registration_referral.sql"))
	if err != nil {
		t.Fatal(err)
	}
	withoutOuter := func(source string) string {
		return strings.TrimSuffix(strings.TrimSpace(strings.Replace(source, "BEGIN;", "", 1)), "COMMIT;")
	}
	preflightTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, err = preflightTx.Exec(ctx, withoutOuter(string(migration89)))
	if err == nil || !strings.Contains(err.Error(), "referral_explicit_database_review_required") {
		_ = preflightTx.Rollback(ctx)
		t.Fatal("wrong-database guard failed", err)
	}
	if err := preflightTx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	preflightTx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := preflightTx.Exec(ctx, `CREATE OR REPLACE FUNCTION mlm.norm_name(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT NULLIF(lower(unaccent(btrim(coalesce(p,'')))),'') $$`); err != nil {
		t.Fatal(err)
	}
	_, err = preflightTx.Exec(ctx, withoutOuter(strings.Replace(string(migration89), "mindbliss_curated_20261025", "vicionpower_test", 1)))
	if err == nil || !strings.Contains(err.Error(), "unaccent") {
		_ = preflightTx.Rollback(ctx)
		t.Fatal("missing normalizer68 prerequisite did not fail closed", err)
	}
	if err := preflightTx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	apply("89_verified_registration_referral.sql")
	var safe bool
	if err := pool.QueryRow(ctx, `SELECT
 NOT has_function_privilege('synthetic_referral_other','payments.verified_registration_referral(text,text,text,text)','EXECUTE')
 AND has_function_privilege('synthetic_referral_reader','payments.verified_registration_referral(text,text,text,text)','EXECUTE')
 AND NOT pg_has_role('synthetic_referral_reader','mindbliss_referral_owner_20261103','MEMBER')
 AND NOT has_table_privilege('synthetic_referral_reader','payments.registration_referral','INSERT,UPDATE,DELETE,TRUNCATE')
 AND NOT has_column_privilege('synthetic_referral_reader','mlm.person','updated_at','UPDATE')
 AND NOT has_table_privilege('synthetic_referral_reader','payments.purchase_intent','INSERT,UPDATE,DELETE,TRUNCATE')
 AND NOT has_column_privilege('synthetic_referral_reader','auth.user','email_verified','UPDATE')
 AND (SELECT p.prosecdef AND p.proowner='mindbliss_referral_owner_20261103'::regrole
  AND 'search_path=pg_catalog, pg_temp'=ANY(p.proconfig) FROM pg_proc p WHERE p.oid='payments.verified_registration_referral(text,text,text,text)'::regprocedure)
 AND (SELECT NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
 FROM pg_roles WHERE rolname='mindbliss_referral_owner_20261103')`).Scan(&safe); err != nil || !safe {
		t.Fatal("capability privileges widened", safe, err)
	}
	cfg := pool.Config()
	cfg.ConnConfig.User = "synthetic_referral_reader"
	cfg.ConnConfig.Password = "synthetic-referral-only"
	reader, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	store := NewStore(reader)
	snapshot := func() string {
		t.Helper()
		var out string
		if err := pool.QueryRow(ctx, `SELECT jsonb_build_object(
 'people',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM mlm.person p),
 'affiliates',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM mlm.affiliate a),
 'intents',(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM payments.purchase_intent i),
 'bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY subject) FROM identity.auth_binding b),
 'users',(SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM auth.user u))::text`).Scan(&out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	before := snapshot()
	call := func(ref *string, side string) (VerifiedReferralAttribution, error) {
		return store.VerifiedRegistrationReferral(ctx, "synthetic-referral-owner", "owner-referral@example.test", ref, side)
	}
	empty, err := call(nil, "")
	if err != nil || !empty.OK || empty.Ref != "" || empty.PreferredSide != "" || empty.Positioned {
		t.Fatal("empty durable hint", empty, err)
	}
	first := "MP9801"
	saved, err := call(&first, "L")
	if err != nil || saved.Ref != first || saved.PreferredSide != "L" || saved.Positioned {
		t.Fatal("first verified touch", saved, err)
	}
	second := "@sEcOnD"
	saved, err = call(&second, "R")
	if err != nil || saved.Ref != second || saved.PreferredSide != "R" || saved.Positioned {
		t.Fatal("latest verified touch", saved, err)
	}
	var rows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM payments.registration_referral WHERE email_norm='owner-referral@example.test'`).Scan(&rows); err != nil || rows != 1 {
		t.Fatal("more than one durable owner hint", rows, err)
	}
	read, err := call(nil, "")
	if err != nil || read != saved {
		t.Fatal("cross-pool durable read", read, saved, err)
	}
	h := &Handler{store: store, companyRoot: 999}
	for _, stale := range []string{"MP9801", "invalid-old-browser-hint", ""} {
		sponsor, code, side, err := h.resolveCheckoutPlacement(ctx, "owner-referral@example.test", Buyer{PersonID: 9803}, stale, "L")
		if err != nil || sponsor == nil || *sponsor != 9802 || code != second || side != "R" {
			t.Fatal("browser cache replaced durable hint", sponsor, code, side, err)
		}
	}
	invalid := "missing-sponsor"
	if _, err := call(&invalid, "R"); !errors.Is(err, ErrInvalidReferralCode) {
		t.Fatal("invalid sponsor persisted", err)
	}
	if got, err := call(nil, ""); err != nil || got != saved {
		t.Fatal("invalid touch removed last valid hint", got, err)
	}
	for _, query := range []string{`UPDATE payments.registration_referral SET referral_code='forbidden'`,
		`INSERT INTO payments.registration_referral(email_norm,referral_code,sponsor_affiliate_id) VALUES('forbidden@example.test','x',9801)`,
		`DELETE FROM payments.registration_referral`, `UPDATE mlm.person SET updated_at=now() WHERE id=9803`,
		`UPDATE auth.user SET email_verified=true`, `INSERT INTO mlm.affiliate(person_id,status) VALUES(9803,'active')`,
		`SET ROLE mindbliss_referral_owner_20261103`} {
		if _, err := reader.Exec(ctx, query); err == nil {
			t.Fatal("runtime acquired unrelated permission", query)
		}
	}
	for _, args := range [][]any{
		{"synthetic-referral-other", "owner-referral@example.test", first, "R"},
		{"synthetic-referral-owner", "other-referral@example.test", first, "R"},
		{"synthetic-referral-unverified", "unverified-referral@example.test", first, "R"},
	} {
		var code, side string
		var positioned bool
		err := reader.QueryRow(ctx, `SELECT * FROM payments.verified_registration_referral($1,$2,$3,$4)`, args...).Scan(&code, &side, &positioned)
		if err == nil || !strings.Contains(err.Error(), "referral_identity_review") {
			t.Fatal("DB owner binding bypass", err)
		}
	}
	if after := snapshot(); after != before {
		t.Fatal("metadata capability changed people, tree, auth or purchases")
	}
	t.Run("ambiguous browser fallback never chooses an arbitrary sponsor", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `UPDATE mlm.affiliate SET invitation_link=CASE id WHEN 9801 THEN '@Foo' ELSE '@foo' END WHERE id IN(9801,9802)`); err != nil {
			t.Fatal(err)
		}
		for _, code := range []string{"@FOO", "MP9999999999999999999999999999999999999999"} {
			if _, _, _, err := h.resolveCheckoutPlacement(ctx, "no-durable-referral@example.test", Buyer{PersonID: 9803}, code, "L"); !errors.Is(err, ErrInvalidReferralCode) {
				t.Fatal("ambiguous/overflow browser fallback accepted", code, err)
			}
			if _, err := call(&code, "L"); !errors.Is(err, ErrInvalidReferralCode) {
				t.Fatal("ambiguous durable hint accepted", code, err)
			}
		}
		for code, want := range map[string]int64{"@Foo": 9801, "@foo": 9802, "MP9801": 9801, "mp0009802": 9802} {
			sponsor, _, _, err := h.resolveCheckoutPlacement(ctx, "no-durable-referral@example.test", Buyer{PersonID: 9803}, code, "R")
			if err != nil || sponsor == nil || *sponsor != want {
				t.Fatal("unique/exact/canonical browser fallback lost", code, sponsor, err)
			}
		}
		if _, err := pool.Exec(ctx, `UPDATE mlm.affiliate SET invitation_link=CASE id WHEN 9801 THEN '@First' ELSE '@Second' END WHERE id IN(9801,9802)`); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("owner and sponsor blacklist remain authoritative", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `INSERT INTO mlm.blacklist(email_norm) VALUES('owner-referral@example.test')`); err != nil {
			t.Fatal(err)
		}
		if _, err := call(&first, "L"); !errors.Is(err, errReferralBlocked) {
			t.Fatal("owner blacklist bypass", err)
		}
		var blockedRef, blockedSide string
		var blockedPositioned bool
		if err := reader.QueryRow(ctx, `SELECT * FROM payments.verified_registration_referral($1,$2,$3,$4)`,
			"synthetic-referral-owner", "owner-referral@example.test", first, "L").Scan(&blockedRef, &blockedSide, &blockedPositioned); err == nil || !strings.Contains(err.Error(), "referral_owner_restricted") {
			t.Fatal("direct DB capability bypassed owner ban", err)
		}
		if _, err := pool.Exec(ctx, `DELETE FROM mlm.blacklist WHERE email_norm='owner-referral@example.test'; INSERT INTO mlm.blacklist(email_norm) VALUES('first-referral@example.test')`); err != nil {
			t.Fatal(err)
		}
		if _, err := call(&first, "L"); !errors.Is(err, ErrInvalidReferralCode) {
			t.Fatal("sponsor blacklist bypass", err)
		}
		if _, err := pool.Exec(ctx, `DELETE FROM mlm.blacklist WHERE email_norm='first-referral@example.test'`); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("stale caller isolation cannot persist a hint", func(t *testing.T) {
		tx, err := reader.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx) //nolint:errcheck
		var ref, side string
		var positioned bool
		err = tx.QueryRow(ctx, `SELECT * FROM payments.verified_registration_referral($1,$2,$3,$4)`, "synthetic-referral-owner", "owner-referral@example.test", first, "L").Scan(&ref, &side, &positioned)
		if err == nil || !strings.Contains(err.Error(), "referral_read_committed_required") {
			t.Fatal("stale transaction isolation accepted", err)
		}
	})
	t.Run("confirmed touch holds the same buyer lock until commit", func(t *testing.T) {
		tx, err := reader.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx) //nolint:errcheck
		var ref, side string
		var positioned bool
		if err := tx.QueryRow(ctx, `SELECT * FROM payments.verified_registration_referral($1,$2,$3,$4)`, "synthetic-referral-owner", "owner-referral@example.test", second, "R").Scan(&ref, &side, &positioned); err != nil || ref != second || side != "R" || positioned {
			t.Fatal("metadata transaction", ref, side, positioned, err)
		}
		conn, err := pool.Acquire(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Release()
		var pid int
		if err := conn.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
			t.Fatal(err)
		}
		result := make(chan error, 1)
		go func() {
			var id int64
			result <- conn.QueryRow(ctx, `SELECT id FROM mlm.person WHERE id=9803 FOR NO KEY UPDATE`).Scan(&id)
		}()
		deadline := time.Now().Add(time.Second)
		waiting := false
		for time.Now().Before(deadline) {
			if err := pool.QueryRow(ctx, `SELECT COALESCE(wait_event_type='Lock',false) FROM pg_stat_activity WHERE pid=$1`, pid).Scan(&waiting); err != nil {
				t.Fatal(err)
			}
			if waiting {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		if !waiting {
			t.Fatal("activation could bypass uncommitted owner touch")
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if err := <-result; err != nil {
			t.Fatal("buyer lock not released after confirmed metadata commit", err)
		}
	})

	// Hold the same buyer lock as activation on an independent connection. The
	// POST waits, then sees the committed affiliate and does not update the hint.
	t.Run("placement wins row-lock race without reassignment", func(t *testing.T) {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx) //nolint:errcheck
		if _, err := tx.Exec(ctx, `SELECT id FROM mlm.person WHERE id=9803 FOR NO KEY UPDATE`); err != nil {
			t.Fatal(err)
		}
		conn, err := reader.Acquire(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Release()
		var pid int
		if err := conn.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
			t.Fatal(err)
		}
		result := make(chan struct {
			out VerifiedReferralAttribution
			err error
		}, 1)
		go func() {
			var out VerifiedReferralAttribution
			err := conn.QueryRow(ctx, `SELECT * FROM payments.verified_registration_referral($1,$2,$3,$4)`, "synthetic-referral-owner", "owner-referral@example.test", first, "L").Scan(&out.Ref, &out.PreferredSide, &out.Positioned)
			result <- struct {
				out VerifiedReferralAttribution
				err error
			}{out, err}
		}()
		deadline := time.Now().Add(time.Second)
		waiting := false
		for time.Now().Before(deadline) {
			if err := pool.QueryRow(ctx, `SELECT COALESCE(wait_event_type='Lock',false) FROM pg_stat_activity WHERE pid=$1`, pid).Scan(&waiting); err != nil {
				t.Fatal(err)
			}
			if waiting {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		if !waiting {
			t.Fatal("POST did not acquire the shared placement lock")
		}
		if _, err := tx.Exec(ctx, `INSERT INTO mlm.affiliate(id,person_id,parent_id,position,sponsor_id,status) OVERRIDING SYSTEM VALUE VALUES(9803,9803,9801,'R',9801,'active')`); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		got := <-result
		if got.err != nil || !got.out.Positioned || got.out.Ref != "" || got.out.PreferredSide != "" {
			t.Fatal("racing POST reassigned positioned buyer", got)
		}
		var code, side string
		if err := pool.QueryRow(ctx, `SELECT referral_code,preferred_side FROM payments.registration_referral WHERE email_norm='owner-referral@example.test'`).Scan(&code, &side); err != nil || code != second || side != "R" {
			t.Fatal("positioned POST mutated durable metadata", code, side, err)
		}
	})
	positionedBefore := snapshot()
	if out, err := call(&first, "L"); err != nil || !out.Positioned || out.Ref != "" || out.PreferredSide != "" {
		t.Fatal("positioned metadata must be a no-op", out, err)
	}
	if out, err := call(nil, ""); err != nil || !out.Positioned || out.Ref != "" || out.PreferredSide != "" {
		t.Fatal("positioned GET exposed stale hint", out, err)
	}
	if snapshot() != positionedBefore {
		t.Fatal("positioned request mutated authoritative rows")
	}
	t.Run("positioned GET needs only canonical read privileges and retains every owner restriction", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `REVOKE EXECUTE ON FUNCTION payments.verified_registration_referral(text,text,text,text) FROM mindbliss_go_payments_reader_v1`); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if _, err := pool.Exec(ctx, `GRANT EXECUTE ON FUNCTION payments.verified_registration_referral(text,text,text,text) TO mindbliss_go_payments_reader_v1`); err != nil {
				t.Error(err)
			}
		}()
		readConfig := reader.Config()
		readConfig.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
		readPool, err := pgxpool.NewWithConfig(ctx, readConfig)
		if err != nil {
			t.Fatal(err)
		}
		defer readPool.Close()
		readStore := NewStore(readPool)
		read := func() (VerifiedReferralAttribution, error) {
			return readStore.VerifiedRegistrationReferral(ctx, "synthetic-referral-owner", "owner-referral@example.test", nil, "")
		}
		if err := readPool.QueryRow(ctx, `SELECT current_setting('transaction_read_only')='on'
 AND NOT has_function_privilege(current_user,'payments.verified_registration_referral(text,text,text,text)','EXECUTE')`).Scan(&safe); err != nil || !safe {
			t.Fatal("positioned fixture retained write/capability authority", safe, err)
		}
		if got, err := read(); err != nil || got != (VerifiedReferralAttribution{OK: true, Positioned: true}) {
			t.Fatal("canonical positioned GET still depends on referral capability", got, err)
		}
		if _, err := readStore.VerifiedRegistrationReferral(ctx, "synthetic-referral-owner", "owner-referral@example.test", &first, "L"); err == nil {
			t.Fatal("POST bypassed the unchanged capability boundary")
		}
		if snapshot() != positionedBefore {
			t.Fatal("read-only confirmation or rejected POST changed people/tree/auth/purchases")
		}
		for _, tc := range []struct {
			name, setup, restore string
			want                 error
		}{
			{"unverified", `UPDATE auth.user SET email_verified=false WHERE id='synthetic-referral-owner'`, `UPDATE auth.user SET email_verified=true WHERE id='synthetic-referral-owner'`, ErrCheckoutIdentityReview},
			{"person suspended", `UPDATE mlm.person SET status='suspended' WHERE id=9803`, `UPDATE mlm.person SET status='pending' WHERE id=9803`, errReferralBlocked},
			{"explicit blacklist", `UPDATE mlm.person SET blacklisted=true WHERE id=9803`, `UPDATE mlm.person SET blacklisted=false WHERE id=9803`, errReferralBlocked},
			{"affiliate suspended", `UPDATE mlm.affiliate SET status='suspended' WHERE id=9803`, `UPDATE mlm.affiliate SET status='active' WHERE id=9803`, errReferralBlocked},
			{"listed email", `INSERT INTO mlm.blacklist(email_norm) VALUES('owner-referral@example.test')`, `DELETE FROM mlm.blacklist WHERE email_norm='owner-referral@example.test'`, errReferralBlocked},
			{"duplicate canonical email", `INSERT INTO mlm.person(id,first_name,last_name,email,phone_number,status,blacklisted) OVERRIDING SYSTEM VALUE VALUES(9805,'Synthetic','Duplicate',' OWNER-REFERRAL@EXAMPLE.TEST ','0','active',false)`, `DELETE FROM mlm.person WHERE id=9805`, ErrCheckoutIdentityReview},
		} {
			t.Run(tc.name, func(t *testing.T) {
				if _, err := pool.Exec(ctx, tc.setup); err != nil {
					t.Fatal(err)
				}
				defer func() {
					if _, err := pool.Exec(ctx, tc.restore); err != nil {
						t.Error(err)
					}
				}()
				if got, err := read(); !errors.Is(err, tc.want) || got.OK || got.Positioned {
					t.Fatal("read-only confirmation bypassed identity/restriction", got, err)
				}
			})
		}
		if got, err := readStore.VerifiedRegistrationReferral(ctx, "synthetic-referral-other", "owner-referral@example.test", nil, ""); !errors.Is(err, ErrCheckoutIdentityReview) || got.OK {
			t.Fatal("a foreign subject read the positioned owner's state", got, err)
		}
		if got, err := read(); err != nil || !got.OK || !got.Positioned {
			t.Fatal("restored canonical owner cannot confirm position", got, err)
		}
		var code, side string
		if err := pool.QueryRow(ctx, `SELECT referral_code,preferred_side FROM payments.registration_referral WHERE email_norm='owner-referral@example.test'`).Scan(&code, &side); err != nil || code != second || side != "R" {
			t.Fatal("position confirmation rewrote the stored referral", code, side, err)
		}
	})
}
