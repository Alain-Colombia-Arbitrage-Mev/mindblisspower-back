package payments

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
)

type identityReadFixture struct {
	pgx.Tx
	err      error
	calls    int
	owner    bool
	email    string
	publicID string
}

func (q *identityReadFixture) QueryRow(context.Context, string, ...any) pgx.Row {
	q.calls++
	return identityReadRow{fixture: q}
}

type identityReadRow struct{ fixture *identityReadFixture }

func (r identityReadRow) Scan(dest ...any) error {
	q := r.fixture
	if q.err != nil {
		return q.err
	}
	if q.owner {
		*dest[0].(*int64) = 42
	} else {
		*dest[0].(*string) = q.email
	}
	*dest[1].(*string) = q.publicID
	return nil
}

type identitySubjectReadFailure struct{ err error }

func (v identitySubjectReadFailure) VerifyEmail(context.Context, string) (string, error) {
	return "member@example.test", nil
}

func (v identitySubjectReadFailure) VerifySubject(context.Context, string) (string, string, error) {
	return "", "", v.err
}

func TestIdentityInfrastructureFaultIsNotInvalidJWTOrMissingBinding(t *testing.T) {
	crypto, key := betterAuthTestVerifier(t)
	raw := signBetterAuthTestToken(t, key, betterAuthTestClaims())
	for _, dependencyErr := range []error{context.DeadlineExceeded, context.Canceled,
		&pgconn.PgError{Code: "42501", Message: "synthetic-private-permission-detail"},
		&pgconn.PgError{Code: "57014", Message: "synthetic-private-timeout-detail"},
		errors.New("synthetic-private-storage-detail")} {
		q := &identityReadFixture{err: dependencyErr}
		verifier := &boundBetterAuthVerifier{verifier: crypto, db: q}
		subject, email, err := verifier.VerifySubject(context.Background(), raw)
		if subject != "" || email != "" || !errors.Is(err, ErrAuthenticationUnavailable) || q.calls != 1 {
			t.Fatal("storage failure authenticated or looked like invalid proof", subject, email, err, q.calls)
		}
		if err.Error() != ErrAuthenticationUnavailable.Error() {
			t.Fatal("identity error retained private dependency detail")
		}
	}
	for _, q := range []*identityReadFixture{{err: pgx.ErrNoRows}, {email: "different@example.test", publicID: "synthetic-public-id"},
		{email: "member@example.test", publicID: ""}} {
		verifier := &boundBetterAuthVerifier{verifier: crypto, db: q}
		if subject, email, err := verifier.VerifySubject(context.Background(), raw); err == nil || errors.Is(err, ErrAuthenticationUnavailable) || subject != "" || email != "" {
			t.Fatal("missing/mismatched canonical binding lost its identity denial", err)
		}
	}
	q := &identityReadFixture{err: errors.New("synthetic-unreachable-storage")}
	verifier := &boundBetterAuthVerifier{verifier: crypto, db: q}
	if _, _, err := verifier.VerifySubject(context.Background(), "synthetic-tampered-token"); err == nil || errors.Is(err, ErrAuthenticationUnavailable) || q.calls != 0 {
		t.Fatal("invalid signature/format must fail before primary lookup", err, q.calls)
	}
	q = &identityReadFixture{email: " Member@Example.test ", publicID: "synthetic-public-id"}
	verifier = &boundBetterAuthVerifier{verifier: crypto, db: q}
	if subject, email, err := verifier.VerifySubject(context.Background(), raw); err != nil || subject != "synthetic-user" || email != "member@example.test" {
		t.Fatal("healthy canonical proof was changed", subject, email, err)
	}
}

func TestNOWPurchaseOwnerInfrastructurePreservesNotFoundAndFailsUnavailable(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want error
	}{
		{"no canonical owner", pgx.ErrNoRows, ErrCheckoutIdentityReview},
		{"primary deadline", context.DeadlineExceeded, ErrAuthenticationUnavailable},
		{"primary permission", &pgconn.PgError{Code: "42501", Message: "synthetic-private-acl"}, ErrAuthenticationUnavailable},
		{"primary unavailable", errors.New("synthetic-private-connection"), ErrAuthenticationUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := &identityReadFixture{err: tc.err, owner: true}
			person, publicID, err := nowPurchaseOwner(context.Background(), q, "synthetic-subject", "member@example.test")
			if person != 0 || publicID != "" || !errors.Is(err, tc.want) {
				t.Fatal("owner failure exposed an identity or was misclassified", person, publicID, err)
			}
			w := httptest.NewRecorder()
			writeNOWPurchaseError(w, err)
			wantStatus := http.StatusNotFound
			if errors.Is(tc.want, ErrAuthenticationUnavailable) {
				wantStatus = http.StatusServiceUnavailable
			}
			if w.Code != wantStatus || strings.Contains(w.Body.String(), "synthetic-private") {
				t.Fatal("owner HTTP classification leaked detail or erased not-found", w.Code, w.Body.String())
			}
		})
	}
}

func assertAuthenticationUnavailable(t *testing.T, w *httptest.ResponseRecorder) {
	t.Helper()
	if w.Code != http.StatusServiceUnavailable || w.Body.String() != "{\"error\":\"authentication_unavailable\"}\n" ||
		w.Header().Get("Cache-Control") != "private, no-store" || w.Header().Get("Set-Cookie") != "" {
		t.Fatal("dependency outage must not expire a session or expose detail", w.Code, w.Body.String(), w.Header())
	}
}

func TestIdentityInfrastructureSummaryAndNOWRoutesStopBeforePersistenceAndProviders(t *testing.T) {
	for _, dependencyErr := range []error{ErrAuthenticationUnavailable, fmt.Errorf("synthetic wrapper: %w", ErrAuthenticationUnavailable)} {
		t.Run("summary", func(t *testing.T) {
			h := NewHandler(nil, nil, "synthetic-service", nil, 0, zerolog.Nop())
			h.SetIdentityVerifier(fakeNOWSubject{err: dependencyErr}, true)
			w := httptest.NewRecorder()
			h.handleMe(w, purchaseHTTPRequest("GET", "/api/payments/me?email=member%40example.test", ""))
			assertAuthenticationUnavailable(t, w)
		})
		for _, action := range []string{"history", "resume", "cancel"} {
			t.Run(action, func(t *testing.T) {
				h, store, client := newFakeNOWPurchaseHandler()
				h.verifier = fakeNOWSubject{err: dependencyErr}
				w := httptest.NewRecorder()
				if action == "history" {
					h.handleNOWPurchases(w, purchaseHTTPRequest("GET", nowPurchasesPath, ""))
				} else {
					r := purchaseHTTPRequest("POST", nowPurchasesPath+"/"+action, `{"order_id":"`+syntheticNOWOrder+`"}`)
					if action == "resume" {
						h.handleNOWPurchaseResume(w, r)
					} else {
						h.handleNOWPurchaseCancel(w, r)
					}
				}
				assertAuthenticationUnavailable(t, w)
				if store.calls != 0 || client.creates != 0 || client.gets != 0 {
					t.Fatal("identity outage reached persistence/provider")
				}
			})
		}
		t.Run("status", func(t *testing.T) {
			h, client, store := fakeCaptureHandler()
			h.verifier = fakeNOWSubject{err: dependencyErr}
			w := httptest.NewRecorder()
			h.handleNOWPaymentsCaptureStatus(w, purchaseHTTPRequest("GET", "/api/payments/nowpayments/status?order_id="+syntheticNOWOrder, ""))
			assertAuthenticationUnavailable(t, w)
			if store.reads != 0 || store.captures != 0 || client.gets != 0 || client.creates != 0 {
				t.Fatal("identity outage reached status storage/provider")
			}
		})
		t.Run("referral", func(t *testing.T) {
			store := &fakeVerifiedReferral{}
			h := &Handler{serviceToken: "synthetic-service", verifier: fakeNOWSubject{err: dependencyErr}, requireVerified: true, referralPersistence: store}
			w := httptest.NewRecorder()
			h.handleVerifiedReferral(w, purchaseHTTPRequest("GET", verifiedReferralPath+"?email=member%40example.test", ""))
			assertAuthenticationUnavailable(t, w)
			if store.calls != 0 {
				t.Fatal("identity outage reached referral capability")
			}
		})
		t.Run("checkout", func(t *testing.T) {
			h, client, store := fakeNOWMembershipHandler()
			h.serviceToken, h.requireVerified, h.verifier = "synthetic-service", true, fakeNOWSubject{err: dependencyErr}
			w := httptest.NewRecorder()
			h.handleCheckout(w, purchaseHTTPRequest("POST", "/api/payments/checkout", `{"provider":"nowpayments","email":"member@example.test","package_id":1}`))
			assertAuthenticationUnavailable(t, w)
			if store.creates != 0 || client.creates != 0 || client.gets != 0 {
				t.Fatal("identity outage created a purchase/provider request")
			}
		})
		t.Run("checkout subject recheck", func(t *testing.T) {
			h, client, store := fakeNOWMembershipHandler()
			h.serviceToken, h.requireVerified, h.verifier = "synthetic-service", true, identitySubjectReadFailure{err: dependencyErr}
			w := httptest.NewRecorder()
			h.handleCheckout(w, purchaseHTTPRequest("POST", "/api/payments/checkout", `{"provider":"nowpayments","email":"member@example.test","package_id":1}`))
			assertAuthenticationUnavailable(t, w)
			if store.creates != 0 || client.creates != 0 || client.gets != 0 {
				t.Fatal("subject recheck outage created a purchase/provider request")
			}
		})
	}
}

func TestIdentityInfrastructureDoesNotChangeInvalidOrMismatchedIdentityStatuses(t *testing.T) {
	for _, tc := range []struct {
		name  string
		err   error
		claim string
		want  int
	}{
		{"invalid proof", errors.New("synthetic-invalid-proof"), "member@example.test", 401},
		{"owner mismatch", nil, "other@example.test", 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := NewHandler(nil, nil, "synthetic-service", nil, 0, zerolog.Nop())
			h.SetIdentityVerifier(fakeNOWSubject{err: tc.err}, true)
			w := httptest.NewRecorder()
			h.handleMe(w, purchaseHTTPRequest("GET", "/api/payments/me?email="+tc.claim, ""))
			if w.Code != tc.want || w.Header().Get("Set-Cookie") != "" {
				t.Fatal("an invalid/mismatched identity was reclassified or authenticated", w.Code, w.Body.String())
			}
		})
	}
}

func TestIdentityInfrastructurePostgresPermissionFaultIsUnavailableNotExpired(t *testing.T) {
	if testing.Short() {
		t.Skip("isolated PostgreSQL testcontainer")
	}
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	migration, err := os.ReadFile(filepath.Join(findRepoRoot(t), "_meta/migration/70_stable_identity_bindings.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, string(migration)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE ROLE synthetic_identity_infra_reader LOGIN INHERIT PASSWORD 'synthetic-identity-reader';
 GRANT USAGE ON SCHEMA auth,identity,mlm TO synthetic_identity_infra_reader;
 GRANT SELECT ON auth.user,identity.auth_binding,mlm.person TO synthetic_identity_infra_reader;
 INSERT INTO auth.user(id,email,email_verified) VALUES('synthetic-user','member@example.test',true);
 INSERT INTO mlm.person(first_name,last_name,email,phone_number,status,user_id)
 VALUES('Synthetic','Identity outage','member@example.test','0','active','synthetic-user');
 INSERT INTO identity.auth_binding(subject,person_id,link_method)
 SELECT 'synthetic-user',id,'approved_claim' FROM mlm.person WHERE user_id='synthetic-user'`); err != nil {
		t.Fatal(err)
	}
	config := pool.Config()
	config.ConnConfig.User, config.ConnConfig.Password = "synthetic_identity_infra_reader", "synthetic-identity-reader"
	config.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	reader, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	crypto, key := betterAuthTestVerifier(t)
	verifier := &boundBetterAuthVerifier{verifier: crypto, db: reader}
	raw := signBetterAuthTestToken(t, key, betterAuthTestClaims())
	if subject, email, err := verifier.VerifySubject(ctx, raw); err != nil || subject != "synthetic-user" || email != "member@example.test" {
		t.Fatal("initial canonical read-only proof failed", subject, email, err)
	}
	snapshot := func() string {
		t.Helper()
		var value string
		if err := pool.QueryRow(ctx, `SELECT jsonb_build_object(
 'people',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM mlm.person p),
 'affiliates',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM mlm.affiliate a),
 'bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY b.subject) FROM identity.auth_binding b),
 'users',(SELECT jsonb_agg(to_jsonb(u) ORDER BY u.id) FROM auth.user u),
 'purchases',(SELECT count(*) FROM payments.purchase_intent),
 'ledger',(SELECT count(*) FROM mlm.wallet_movement))::text`).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	before := snapshot()
	if _, err := pool.Exec(ctx, `REVOKE SELECT ON auth.user FROM synthetic_identity_infra_reader`); err != nil {
		t.Fatal(err)
	}
	if subject, email, err := verifier.VerifySubject(ctx, raw); !errors.Is(err, ErrAuthenticationUnavailable) || subject != "" || email != "" || err.Error() != ErrAuthenticationUnavailable.Error() {
		t.Fatal("primary ACL fault looked like an expired identity", subject, email, err)
	}
	h := NewHandler(nil, nil, "synthetic-service", nil, 0, zerolog.Nop())
	h.SetIdentityVerifier(verifier, true)
	r := purchaseHTTPRequest("GET", "/api/payments/me?email=member%40example.test", "")
	r.Header.Set(idTokenHeader, raw)
	w := httptest.NewRecorder()
	h.handleMe(w, r)
	assertAuthenticationUnavailable(t, w)
	history, store, client := newFakeNOWPurchaseHandler()
	history.verifier = verifier
	r = purchaseHTTPRequest("GET", nowPurchasesPath, "")
	r.Header.Set(idTokenHeader, raw)
	w = httptest.NewRecorder()
	history.handleNOWPurchases(w, r)
	assertAuthenticationUnavailable(t, w)
	if store.calls != 0 || client.creates != 0 || client.gets != 0 {
		t.Fatal("primary identity outage reached provider or purchase persistence")
	}
	tx, err := reader.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatal(err)
	}
	if person, publicID, err := nowPurchaseOwner(ctx, tx, "synthetic-user", "member@example.test"); !errors.Is(err, ErrAuthenticationUnavailable) || person != 0 || publicID != "" {
		_ = tx.Rollback(ctx)
		t.Fatal("purchase-owner ACL fault became missing ownership", person, publicID, err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if _, _, err := verifier.VerifySubject(ctx, "synthetic-tampered-token"); err == nil || errors.Is(err, ErrAuthenticationUnavailable) {
		t.Fatal("bad JWT was relabelled as primary unavailability", err)
	}
	if _, err := pool.Exec(ctx, `GRANT SELECT ON auth.user TO synthetic_identity_infra_reader`); err != nil {
		t.Fatal(err)
	}
	if subject, email, err := verifier.VerifySubject(ctx, raw); err != nil || subject != "synthetic-user" || email != "member@example.test" {
		t.Fatal("same unmodified JWT did not recover after primary restoration", subject, email, err)
	}
	if snapshot() != before {
		t.Fatal("identity/read failures changed people, positions, bindings, auth users, purchases or ledger")
	}
}
