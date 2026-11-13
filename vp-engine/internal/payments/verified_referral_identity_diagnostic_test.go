package payments

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

type contractReferralVerifier struct{ err error }

func (v contractReferralVerifier) VerifyEmail(context.Context, string) (string, error) {
	return "member@example.test", v.err
}

func TestVerifiedReferralPendingOwnerPostgresReadOnlyCompatibility(t *testing.T) {
	if testing.Short() {
		t.Skip("isolated PostgreSQL fixture")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	container, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{Started: true,
		ContainerRequest: testcontainers.ContainerRequest{
			Image: "postgres:17.11-bookworm@sha256:858bb5e98eed02eb8cafbcdc007f9a65d1b613972028944a8ec2133ccaf80d27",
			Env:   map[string]string{"POSTGRES_PASSWORD": "synthetic-local-only", "POSTGRES_DB": "synthetic_referral"}, ExposedPorts: []string{"5432/tcp"},
			WaitingFor: wait.ForLog("database system is ready to accept connections").WithOccurrence(2).WithStartupTimeout(time.Minute),
		}})
	if err != nil {
		t.Fatal("start isolated PostgreSQL", err)
	}
	defer func() {
		stop, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = container.Terminate(stop)
	}()
	host, err := container.Host(ctx)
	if err != nil {
		t.Fatal(err)
	}
	port, err := container.MappedPort(ctx, "5432/tcp")
	if err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(ctx, fmt.Sprintf("postgres://postgres:synthetic-local-only@%s:%s/synthetic_referral?sslmode=disable", host, port.Port()))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	_, err = pool.Exec(ctx, `CREATE SCHEMA auth;CREATE SCHEMA identity;CREATE SCHEMA mlm;
 CREATE TYPE mlm.person_status AS ENUM('pending','active','suspended','banned','deleted');
 CREATE TABLE auth."user"(id text PRIMARY KEY,email text,email_verified boolean);
 CREATE TABLE mlm.person(id bigint PRIMARY KEY,user_id text,email text,status mlm.person_status,blacklisted boolean);
 CREATE TABLE identity.auth_binding(subject text PRIMARY KEY,person_id bigint UNIQUE,provider text);
 CREATE TABLE mlm.affiliate(id bigint PRIMARY KEY,person_id bigint UNIQUE,status mlm.person_status NOT NULL);
 CREATE ROLE synthetic_referral_pure_reader NOLOGIN;
 GRANT USAGE ON SCHEMA auth,identity,mlm TO synthetic_referral_pure_reader;
 GRANT SELECT ON auth."user",mlm.person,identity.auth_binding,mlm.affiliate TO synthetic_referral_pure_reader;
 INSERT INTO auth."user" VALUES('synthetic-native-owner','owner@example.test',true);
 INSERT INTO mlm.person VALUES(1,'synthetic-native-owner','owner@example.test','pending',false);
 INSERT INTO identity.auth_binding VALUES('synthetic-native-owner',1,'better_auth');
 INSERT INTO mlm.affiliate VALUES(1,1,'pending');`)
	if err != nil {
		t.Fatal("seed isolated metadata-only fixture", err)
	}
	read := func(subject string) (bool, error) {
		t.Helper()
		tx, err := pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, "SET LOCAL ROLE synthetic_referral_pure_reader"); err != nil {
			t.Fatal(err)
		}
		var readOnly bool
		if err := tx.QueryRow(ctx, `SELECT current_setting('transaction_read_only')='on' AND NOT has_any_column_privilege(current_user,'mlm.person','UPDATE')`).Scan(&readOnly); err != nil || !readOnly {
			t.Fatal("fixture must have SELECT only and a real read-only transaction", readOnly, err)
		}
		return verifiedReferralPosition(ctx, tx, subject, "owner@example.test")
	}
	for _, status := range []string{"pending", "active", "suspended", "banned", "deleted"} {
		if _, err := pool.Exec(ctx, `UPDATE mlm.affiliate SET status=$1::mlm.person_status WHERE id=1`, status); err != nil {
			t.Fatal(err)
		}
		positioned, err := read("synthetic-native-owner")
		allowed := status == "pending" || status == "active"
		if allowed && (err != nil || !positioned) {
			t.Fatal("legitimate existing positioned owner lost old eligibility", status, err)
		}
		if !allowed && (!errors.Is(err, ErrCheckoutIdentityReview) || positioned) {
			t.Fatal("restricted affiliate bypassed canonical guard", status, err)
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE mlm.affiliate SET status='pending' WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	if positioned, err := read("foreign-synthetic-owner"); !errors.Is(err, ErrCheckoutIdentityReview) || positioned {
		t.Fatal("a foreign subject selected another owner")
	}
	if _, err := pool.Exec(ctx, `DELETE FROM mlm.affiliate WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	if positioned, err := read("synthetic-native-owner"); err != nil || positioned {
		t.Fatal("an unpositioned eligible owner was misrepresented")
	}
}
func (v contractReferralVerifier) VerifySubject(context.Context, string) (string, string, error) {
	if v.err != nil {
		return "", "", v.err
	}
	return "synthetic-subject", "member@example.test", nil
}

func TestVerifiedReferralPrivateIdentityReasonIsFixedAndNoFailureReachesPersistence(t *testing.T) {
	for _, tc := range []struct {
		err    error
		reason string
		status int
	}{
		{newIdentityFailure("jwt_issued_in_future", false), "jwt_issued_in_future", 401},
		{classifyBetterAuthJWTError(jwt.ErrTokenSignatureInvalid), "jwt_signature", 401},
		{classifyBetterAuthJWTError(jwt.ErrTokenExpired), "jwt_expired", 401},
		{classifyBetterAuthJWTError(jwt.ErrTokenUnverifiable), "jwt_keys_unavailable", 503},
		{newIdentityFailure("binding_missing", false), "binding_missing", 401},
		{newIdentityFailure("identity_storage_unavailable", true), "identity_storage_unavailable", 503},
		{ErrAuthenticationUnavailable, "identity_unavailable", 503},
		{errors.New("private JWT kid/email/password detail"), "identity_unknown", 401},
		{newIdentityFailure("private attacker-selected reason", false), "identity_unknown", 401},
	} {
		store := &fakeVerifiedReferral{}
		h := &Handler{serviceToken: "synthetic-service-token", verifier: contractReferralVerifier{tc.err}, requireVerified: true, referralPersistence: store, log: zerolog.Nop()}
		r := httptest.NewRequest(http.MethodGet, verifiedReferralPath+"?email=member%40example.test", nil)
		r.Header.Set("X-VP-Service-Token", h.serviceToken)
		r.Header.Set(idTokenHeader, "synthetic.jwt.token")
		w := httptest.NewRecorder()
		(&Config{ReadOnly: true}).ReadOnlyHandler(h.Routes()).ServeHTTP(w, r)
		if w.Code != tc.status || w.Header().Get("X-Mindbliss-Identity-Reason") != tc.reason || store.calls != 0 || w.Header().Get("Set-Cookie") != "" {
			t.Fatal("a failed proof altered a session or reached referral persistence", w.Code, w.Header(), store.calls)
		}
		wanted := "invalid_id_token"
		if tc.status == 503 {
			wanted = "authentication_unavailable"
		}
		if w.Body.String() != "{\"error\":\""+wanted+"\"}\n" || strings.Contains(w.Body.String(), "private") {
			t.Fatal("public identity failure retained private details or changed its contract")
		}
	}
}
