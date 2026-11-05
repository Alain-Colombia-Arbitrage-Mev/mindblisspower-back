package manualmembership

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const syntheticFingerprint = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func validInput() Input {
	return Input{ExpectedDatabase: "manual_synthetic", ID: "00000000-0000-4000-8000-000000000001",
		OperationKey: "manual-membership:synthetic-reviewed-01", PersonID: 101, AffiliateID: 202,
		PersonPublicID: "00000000-0000-4000-8000-000000000002", PackageID: 303,
		AuthorizationDigest: strings.Repeat("b", 64), ExpectedAffiliateSHA256: syntheticFingerprint,
		Authority: "owner_instruction", ActorReason: "Reviewed synthetic owner instruction"}
}

// This SQL-contract fixture never connects to PostgreSQL or providers. All
// results are synthetic; unexpected queries fail rather than falling through.
type syntheticTx struct {
	pgx.Tx
	t                                                                           *testing.T
	queries, mutations                                                          []string
	arguments                                                                   map[string][]any
	failAt                                                                      string
	rowsExisting                                                                int
	replayMatches, operator, origin, blocked, listed, catalog, reviewedTriggers bool
	status, fingerprint, afterFingerprint, database                             string
	sourceCount, tiers                                                          int
	capTotal, capPaid                                                           string
	capClosed                                                                   bool
	commits, rollbacks                                                          int
	commitErr                                                                   error
	effective                                                                   time.Time
}

func newSyntheticTx(t *testing.T) *syntheticTx {
	return &syntheticTx{t: t, arguments: map[string][]any{}, operator: true, origin: true,
		replayMatches: true, catalog: true, reviewedTriggers: true, status: "active", sourceCount: 1, tiers: 1,
		fingerprint: syntheticFingerprint, afterFingerprint: syntheticFingerprint, database: "manual_synthetic",
		capTotal: "200.0000", capPaid: "0.00", effective: time.Date(2026, 11, 5, 18, 0, 0, 123456000, time.UTC)}
}

type syntheticRow struct {
	values []any
	err    error
}

func (r syntheticRow) Scan(targets ...any) error {
	if r.err != nil {
		return r.err
	}
	if len(targets) != len(r.values) {
		return errors.New("synthetic row arity mismatch")
	}
	for i, target := range targets {
		to, from := reflect.ValueOf(target).Elem(), reflect.ValueOf(r.values[i])
		if !from.Type().AssignableTo(to.Type()) {
			return errors.New("synthetic row type mismatch")
		}
		to.Set(from)
	}
	return nil
}

func (tx *syntheticTx) QueryRow(_ context.Context, query string, args ...any) pgx.Row {
	tx.queries = append(tx.queries, query)
	tx.arguments[query] = append([]any(nil), args...)
	if tx.failAt != "" && strings.Contains(query, tx.failAt) {
		return syntheticRow{err: errors.New("SYNTHETIC_PRIVATE_DETAIL")}
	}
	row := func(values ...any) pgx.Row { return syntheticRow{values: values} }
	switch {
	case strings.Contains(query, "SELECT current_database()"):
		return row(tx.database, tx.effective, tx.operator, tx.origin)
	case strings.Contains(query, "SELECT count(*) FROM payments.manual_membership_order"):
		return row(tx.rowsExisting)
	case strings.Contains(query, "SELECT id::text,affiliate_package_id"):
		return row(validInput().ID, int64(700), int64(900), tx.effective, tx.effective.Add(365*24*time.Hour), tx.replayMatches)
	case strings.Contains(query, "SELECT p.public_id::text"):
		return row(validInput().PersonPublicID, tx.status, tx.blocked, tx.listed, tx.fingerprint)
	case strings.Contains(query, "SELECT amount_usd=100"):
		return row(tx.catalog)
	case strings.Contains(query, "SELECT id,cd_lock_days"):
		return row(int64(4), 365, "2.0000", `{"synthetic":true}`)
	case strings.Contains(query, "SELECT count(*) FROM mlm.cd_roi_tier"):
		return row(tx.tiers)
	case strings.Contains(query, "SELECT id,base_annual_rate"):
		return row(6, "0.2500", "0.3000")
	case strings.Contains(query, "FROM pg_trigger"):
		return row(tx.reviewedTriggers)
	case strings.Contains(query, "INSERT INTO mlm.affiliate_package"):
		tx.mutations = append(tx.mutations, query)
		return row(int64(700))
	case strings.Contains(query, "SELECT cap_total::text"):
		return row(tx.capTotal, tx.capPaid, tx.capClosed)
	case strings.Contains(query, "INSERT INTO mlm.investment_cd"):
		tx.mutations = append(tx.mutations, query)
		return row(int64(900))
	case strings.Contains(query, "SELECT encode(sha256"):
		return row(tx.afterFingerprint, tx.sourceCount)
	default:
		tx.t.Errorf("unexpected SQL contract query: %.80s", query)
		return syntheticRow{err: errors.New("unexpected synthetic query")}
	}
}

func (tx *syntheticTx) Exec(_ context.Context, query string, args ...any) (pgconn.CommandTag, error) {
	tx.queries = append(tx.queries, query)
	tx.arguments[query] = append([]any(nil), args...)
	if tx.failAt != "" && strings.Contains(query, tx.failAt) {
		return pgconn.CommandTag{}, errors.New("SYNTHETIC_PRIVATE_DETAIL")
	}
	if strings.HasPrefix(query, "INSERT INTO ") {
		tx.mutations = append(tx.mutations, query)
	}
	return pgconn.NewCommandTag("INSERT 0 1"), nil
}

func (tx *syntheticTx) Commit(context.Context) error   { tx.commits++; return tx.commitErr }
func (tx *syntheticTx) Rollback(context.Context) error { tx.rollbacks++; return nil }

func serviceFor(t *testing.T, tx *syntheticTx) (*Service, *int) {
	t.Helper()
	readinessCalls := new(int)
	return &Service{root: 1, begin: func(ctx context.Context, options pgx.TxOptions) (pgx.Tx, error) {
		if options.IsoLevel != pgx.Serializable {
			t.Fatal("activation is not serializable")
		}
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > 15*time.Second {
			t.Fatal("activation has no bounded deadline")
		}
		return tx, nil
	}, ready: func(context.Context, pgx.Tx) error { *readinessCalls++; return nil }}, readinessCalls
}

func TestActivationKeepsSourceManualPrincipalLockedAndNoTreeAuthOrProviderWrites(t *testing.T) {
	tx := newSyntheticTx(t)
	s, ready := serviceFor(t, tx)
	result, err := s.Apply(context.Background(), validInput())
	if err != nil {
		t.Fatal(err)
	}
	if result.ID != validInput().ID || result.AffiliatePackageID != 700 || result.CDID != 900 || result.Replay ||
		!result.EffectiveAt.Equal(tx.effective) || result.MaturesAt.Sub(tx.effective) != 365*24*time.Hour || tx.commits != 1 || *ready != 1 {
		t.Fatal("activation contract changed")
	}
	if len(tx.mutations) != 4 {
		t.Fatalf("expected only package/CD/wallet/manifest inserts, got %d", len(tx.mutations))
	}
	all := strings.Join(tx.queries, "\n")
	for _, forbidden := range []string{"UPDATE mlm.affiliate", "INSERT INTO mlm.tree_event", "INSERT INTO mlm.wallet_movement",
		"INSERT INTO mlm.transaction", "INSERT INTO auth.", "UPDATE auth.", "INSERT INTO payments.nowpayments_", "stripe_present",
		"norm_phone10", "norm_name", "phone_last10", "b.birthdate"} {
		if strings.Contains(all, forbidden) {
			t.Fatalf("forbidden mutation: %s", forbidden)
		}
	}
	if !strings.Contains(all, "nowpayments-scoped-engine-v1") || !strings.Contains(all, "statement_timeout='8s'") ||
		!strings.Contains(all, "lock_timeout='2s'") || !strings.Contains(all, "FOR NO KEY UPDATE OF p,a") {
		t.Fatal("missing concurrency/timeout guards")
	}
	for query, args := range tx.arguments {
		if strings.HasPrefix(query, "INSERT INTO payments.manual_membership_order") {
			if args[0] != validInput().ID || args[12] != "owner_instruction: "+validInput().ActorReason || args[13] != validInput().AuthorizationDigest {
				t.Fatal("operator authority confused with auth subject")
			}
			if !strings.Contains(query, "100,.03,3,97,100,now(),now()") {
				t.Fatal("manual money/time snapshot changed")
			}
		}
	}
}

func TestIdenticalReplayDoesNotCreateAnotherMembershipOrRunEngine(t *testing.T) {
	tx := newSyntheticTx(t)
	tx.rowsExisting = 1
	s, ready := serviceFor(t, tx)
	result, err := s.Apply(context.Background(), validInput())
	if err != nil || !result.Replay || len(tx.mutations) != 0 || *ready != 0 || tx.commits != 1 {
		t.Fatal("replay repeated an activation")
	}
}

func TestInputRejectedBeforeOpeningAnyTransaction(t *testing.T) {
	changes := []func(*Input){
		func(in *Input) { in.ID = "invalid" }, func(in *Input) { in.ID = "00000000-0000-1000-8000-000000000001" },
		func(in *Input) { in.PersonPublicID = "" }, func(in *Input) { in.PersonID = 0 }, func(in *Input) { in.AffiliateID = -1 },
		func(in *Input) { in.PackageID = 0 }, func(in *Input) { in.ExpectedDatabase = "db;drop" },
		func(in *Input) { in.OperationKey = "manual-without-reviewed-prefix" }, func(in *Input) { in.Authority = "better_auth" },
		func(in *Input) { in.AuthorizationDigest = strings.Repeat("0", 64) }, func(in *Input) { in.AuthorizationDigest = "raw secret" },
		func(in *Input) { in.ActorReason = "short" }, func(in *Input) { in.ActorReason = "reason with\ncontrol" },
		func(in *Input) { in.ExpectedAffiliateSHA256 = "" },
	}
	for i, change := range changes {
		in := validInput()
		change(&in)
		if _, err := New(nil, 1).Apply(context.Background(), in); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("invalid case %d reached database", i)
		}
	}
}

func TestActivationFailsClosedAndRollsBackConflictsDriftOrRestrictedTarget(t *testing.T) {
	for name, change := range map[string]func(*syntheticTx){
		"wrong database": func(tx *syntheticTx) { tx.database = "other" }, "runtime role": func(tx *syntheticTx) { tx.operator = false },
		"disabled triggers": func(tx *syntheticTx) { tx.origin = false }, "two conflicting keys": func(tx *syntheticTx) { tx.rowsExisting = 2 },
		"replay mismatch": func(tx *syntheticTx) { tx.rowsExisting = 1; tx.replayMatches = false },
		"blocked":         func(tx *syntheticTx) { tx.blocked = true }, "listed": func(tx *syntheticTx) { tx.listed = true },
		"inactive": func(tx *syntheticTx) { tx.status = "suspended" }, "changed tree before": func(tx *syntheticTx) { tx.fingerprint = strings.Repeat("c", 64) },
		"inactive catalog": func(tx *syntheticTx) { tx.catalog = false }, "ambiguous tiers": func(tx *syntheticTx) { tx.tiers = 2 },
		"unexpected trigger": func(tx *syntheticTx) { tx.reviewedTriggers = false }, "wrong cap": func(tx *syntheticTx) { tx.capTotal = "100" },
		"used cap": func(tx *syntheticTx) { tx.capPaid = "1" }, "closed cap": func(tx *syntheticTx) { tx.capClosed = true },
		"changed tree after": func(tx *syntheticTx) { tx.afterFingerprint = strings.Repeat("c", 64) },
		"source missing":     func(tx *syntheticTx) { tx.sourceCount = 0 }, "source duplicated": func(tx *syntheticTx) { tx.sourceCount = 2 },
		"late manifest failure": func(tx *syntheticTx) { tx.failAt = "INSERT INTO payments.manual_membership_order" },
	} {
		t.Run(name, func(t *testing.T) {
			tx := newSyntheticTx(t)
			change(tx)
			s, _ := serviceFor(t, tx)
			if _, err := s.Apply(context.Background(), validInput()); err == nil || strings.Contains(err.Error(), "SYNTHETIC_PRIVATE_DETAIL") {
				t.Fatal("failure was accepted or exposed private database detail")
			}
			if tx.commits != 0 || tx.rollbacks != 1 {
				t.Fatal("failed transaction did not roll back")
			}
		})
	}
}

func TestCommitFailureIsUnknownAndNeverAutomaticallyRetried(t *testing.T) {
	tx := newSyntheticTx(t)
	tx.commitErr = errors.New("SYNTHETIC_PRIVATE_DETAIL")
	s, _ := serviceFor(t, tx)
	if _, err := s.Apply(context.Background(), validInput()); !errors.Is(err, ErrCommitUnknown) {
		t.Fatal("commit ambiguity hidden")
	}
	if tx.commits != 1 || len(tx.mutations) != 4 {
		t.Fatal("automatic activation retry occurred")
	}
}
