package payments

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog"
	"github.com/shopspring/decimal"
)

// These transactions are deterministic fixtures: no database, provider, HTTP,
// real identity, or activation is involved.
type manualPolicyRow struct {
	values []any
	err    error
}

func (r manualPolicyRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	if len(dest) != len(r.values) {
		return errors.New("fixture scan arity")
	}
	for i, value := range r.values {
		out := reflect.ValueOf(dest[i]).Elem()
		if value == nil {
			out.SetZero()
		} else {
			in := reflect.ValueOf(value)
			if !in.Type().AssignableTo(out.Type()) {
				return errors.New("fixture scan type")
			}
			out.Set(in)
		}
	}
	return nil
}

type manualPolicyRows struct {
	pgx.Rows
	data   []manualPolicyRow
	index  int
	err    error
	closed bool
}

func (r *manualPolicyRows) Next() bool {
	if r.index >= len(r.data) {
		return false
	}
	r.index++
	return true
}
func (r *manualPolicyRows) Scan(dest ...any) error { return r.data[r.index-1].Scan(dest...) }
func (r *manualPolicyRows) Err() error             { return r.err }
func (r *manualPolicyRows) Close()                 { r.closed = true }

type manualPolicyTx struct {
	pgx.Tx
	t        *testing.T
	singles  []manualPolicyRow
	sets     []*manualPolicyRows
	queries  []string
	args     [][]any
	queryErr error
}

func (tx *manualPolicyTx) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	tx.queries, tx.args = append(tx.queries, sql), append(tx.args, args)
	if len(tx.singles) == 0 {
		tx.t.Fatal("unexpected fixture QueryRow")
	}
	r := tx.singles[0]
	tx.singles = tx.singles[1:]
	return r
}
func (tx *manualPolicyTx) Query(_ context.Context, sql string, args ...any) (pgx.Rows, error) {
	tx.queries, tx.args = append(tx.queries, sql), append(tx.args, args)
	if tx.queryErr != nil {
		return nil, tx.queryErr
	}
	if len(tx.sets) == 0 {
		tx.t.Fatal("unexpected fixture Query")
	}
	r := tx.sets[0]
	tx.sets = tx.sets[1:]
	return r, nil
}

func manualPolicyFixture(t *testing.T) *manualPolicyTx {
	affiliate := int64(22)
	return &manualPolicyTx{t: t, singles: []manualPolicyRow{
		{values: []any{int64(11), &affiliate}},
		{values: []any{true}},
		{values: []any{true}},
		{values: []any{decimal.Zero, decimal.Zero, decimal.Zero, decimal.Zero}},
	}, sets: []*manualPolicyRows{{}, {}}}
}

func manualMembershipFixture(start, now time.Time, status string, safe, lockValid bool) manualPolicyRow {
	d := decimal.NewFromInt
	return manualPolicyRow{values: []any{d(100), d(100), d(97), d(100), start, start.Add(365 * 24 * time.Hour), status, safe, lockValid, d(10), d(2), now}}
}

func TestManualMemberPolicyRejectsUnverifiedOwnerAndBackendFailure(t *testing.T) {
	for _, tc := range []struct {
		name, email, token, actAs string
		verifier                  IdentityVerifier
	}{
		{"wrong token", "member@example.test", "synthetic", "", fakeNOWSubject{err: errors.New("invalid")}},
		{"another email", "other@example.test", "synthetic", "", fakeNOWSubject{}},
		{"missing token", "member@example.test", "", "", fakeNOWSubject{}},
		{"impersonation", "member@example.test", "synthetic", "other@example.test", fakeNOWSubject{}},
		{"unavailable database", "member@example.test", "synthetic", "", fakeNOWSubject{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := NewHandler(NewStore(nil), nil, "synthetic-service", nil, 0, zerolog.Nop())
			h.verifier = tc.verifier
			r := httptest.NewRequest(http.MethodGet, "/api/payments/me", nil)
			r.Header.Set(idTokenHeader, tc.token)
			r.Header.Set(actAsHeader, tc.actAs)
			summary := MemberSummary{DataSource: recoveredStripeSource, PayoutLocked: true}
			h.attachManualMemberPolicy(r, &summary, tc.email)
			if summary.ManualMemberships.Provider != "manual" || summary.ManualMemberships.ReadModelStatus != "unavailable" ||
				summary.ManualMemberships.Commissions != nil || summary.ManualMemberships.Membership != nil || !summary.PayoutLocked {
				t.Fatal("unverified owner or backend failure exposed a financial result")
			}
			if summary.NOWPayments != nil {
				t.Fatal("manual source fabricated a NOW provider receipt")
			}
		})
	}
	for _, tc := range []struct{ subject, email string }{{"", "member@example.test"}, {"subject", ""}, {strings.Repeat("s", 513), "member@example.test"}, {"subject", strings.Repeat("e", 321)}} {
		if got, err := NewStore(nil).GetManualMemberPolicy(context.Background(), tc.subject, tc.email); err == nil || got != nil {
			t.Fatal("missing identity/database accepted")
		}
	}
}

func TestManualMemberPolicySeparatesRecoveryNOWAndUnknown(t *testing.T) {
	for _, p := range []*ManualMemberPolicy{emptyManualMemberPolicy(), unavailableManualMemberPolicy()} {
		wire := memberSummaryJSON(t, MemberSummary{DataSource: recoveredStripeSource, PayoutLocked: true,
			NOWPayments: emptyNOWMemberPolicy(), ManualMemberships: p})
		if wire["wallet_balance_usd"] != nil || wire["commission_available_usd"] != nil || wire["payout_locked"] != true {
			t.Fatal("manual source erased historical recovery liabilities")
		}
		manual := wire["manual_memberships"].(map[string]any)
		if manual["provider"] != "manual" || manual["withdrawals_enabled"] != false || manual["read_model_status"] != p.ReadModelStatus {
			t.Fatal("manual accounting projection asserted provider delivery or enabled withdrawals")
		}
		if p.ReadModelStatus == "unavailable" && (manual["commissions"] != nil || manual["membership"] != nil) {
			t.Fatal("unknown source became invented zero balance")
		}
	}
}

func TestManualMemberPolicyReadSnapshotAndBeneficiarySQL(t *testing.T) {
	tx := manualPolicyFixture(t)
	policy, err := readManualMemberPolicy(context.Background(), tx, "signed-subject", "member@example.test")
	if err != nil || policy.Provider != "manual" || policy.Commissions.AvailableUSD != "0.00" || policy.Membership.PrincipalLockedUSD != "0.00" {
		t.Fatal("confirmed empty fixture", policy, err)
	}
	if len(tx.singles) != 0 || len(tx.sets) != 0 {
		t.Fatal("reader omitted a required snapshot query")
	}
	if !reflect.DeepEqual(tx.args[0], []any{"signed-subject", "member@example.test"}) || !reflect.DeepEqual(tx.args[2], []any{int64(11), int64(22)}) {
		t.Fatal("untrusted owner or mismatched person/affiliate query")
	}
	for _, required := range []string{"p.user_id=b.subject", "u.email_verified", "a.status::text='active'", "mlm.blacklist", "other.id<>p.id", "other.id<>u.id"} {
		if !strings.Contains(manualMemberOwnerSQL, required) {
			t.Fatalf("canonical owner gate missing %q", required)
		}
	}
	if strings.Contains(manualMemberOwnerSQL, "phone_last10") || strings.Contains(manualMemberOwnerSQL, "name_norm") || strings.Contains(manualMemberOwnerSQL, "birthdate") {
		t.Fatal("email-only blacklist reintroduced inherited phone/name restrictions")
	}
	for _, required := range []string{"source_kind='manual'", "manifest.person_id=$1", "manifest.affiliate_id=e.affiliate_id", "manifest.affiliate_package_id=e.affiliate_package_id", "beneficiary.affiliate_id=e.affiliate_id", "e.affiliate_id=$2", "asset.symbol='USD'", "NOT wm.is_frozen", "interval '1 month'", "available_at<=now()"} {
		if !strings.Contains(tx.queries[3], required) {
			t.Fatalf("manual beneficiary projection missing %q", required)
		}
	}
	if strings.Contains(manualMemberCommissionCTE, "s.person_id=$1") || strings.Contains(manualMemberCommissionCTE, "auth_subject") {
		t.Fatal("earning purchaser identity was used instead of the canonical beneficiary")
	}
	if !strings.Contains(manualMemberCommissionCTE, "LEFT JOIN payments.v_compensation_source") || !strings.HasPrefix(manualMemberSafeSQL, "COALESCE(") {
		t.Fatal("a later source risk hold hid the immutable obligation instead of withholding availability")
	}
	if !strings.Contains(manualMemberMembershipSQL, "s.person_id=$1 AND s.affiliate_id=$2") || !strings.Contains(manualMemberMembershipSQL, "interval '365 days'") || strings.Contains(manualMemberMembershipSQL, "payment_id") {
		t.Fatal("manual capital lost owner/annual lock or fabricated provider identity")
	}
}

func TestManualMemberPolicyCapitalFeePVAndExactAnnualMaturity(t *testing.T) {
	start := time.Date(2026, 1, 31, 17, 30, 0, 0, time.UTC)
	maturity := start.Add(365 * 24 * time.Hour)
	for _, tc := range []struct {
		name, status, eligibility                                    string
		now                                                          time.Time
		safe, lockValid                                              bool
		principalLocked, principalAvailable, roiLocked, roiAvailable string
	}{
		{"before exact annual instant", "active", "locked", maturity.Add(-time.Nanosecond), true, true, "100.00", "0.00", "10.00", "0.00"},
		{"annual instant", "matured", "eligible", maturity, true, true, "0.00", "100.00", "8.00", "2.00"},
		{"risk does not unlock", "active", "risk_review", maturity, false, true, "100.00", "0.00", "10.00", "0.00"},
		{"invalid maturity does not unlock", "active", "risk_review", maturity, true, false, "100.00", "0.00", "10.00", "0.00"},
		{"closed capital not available again", "closed", "closed", maturity, true, true, "0.00", "0.00", "10.00", "0.00"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tx := manualPolicyFixture(t)
			tx.sets[1].data = []manualPolicyRow{manualMembershipFixture(start, tc.now, tc.status, tc.safe, tc.lockValid)}
			policy, err := readManualMemberPolicy(context.Background(), tx, "signed-subject", "member@example.test")
			if err != nil {
				t.Fatal(err)
			}
			m := policy.Membership
			if m.PrincipalLockedUSD != tc.principalLocked || m.PrincipalAvailableUSD != tc.principalAvailable || m.ROILockedUSD != tc.roiLocked || m.ROIAvailableUSD != tc.roiAvailable {
				t.Fatal("gross principal/posted ROI/annual lock changed", m)
			}
			item := m.Items[0]
			if item.PrincipalUSD != "100.00" || item.GrossUSD != "100.00" || item.FeeUSD != "3.00" || item.NetUSD != "97.00" || item.PV != "100" || item.Eligibility != tc.eligibility {
				t.Fatal("manual fee repriced principal/PV or eligibility", item)
			}
		})
	}
}

func TestManualMemberPolicyFailureIsUnknownNotZero(t *testing.T) {
	boom := errors.New("synthetic unavailable")
	for _, stage := range []string{"owner", "schema", "schema missing", "coverage", "coverage missing", "aggregate", "negative aggregate", "query", "commission scan", "commission rows", "membership scan", "membership rows", "repriced principal", "wrong fee", "wrong pv", "negative paid"} {
		t.Run(stage, func(t *testing.T) {
			tx := manualPolicyFixture(t)
			switch stage {
			case "owner":
				tx.singles[0].err = boom
			case "schema":
				tx.singles[1].err = boom
			case "schema missing":
				tx.singles[1].values = []any{false}
			case "coverage":
				tx.singles[2].err = boom
			case "coverage missing":
				tx.singles[2].values = []any{false}
			case "aggregate":
				tx.singles[3].err = boom
			case "negative aggregate":
				tx.singles[3].values[2] = decimal.NewFromInt(-1)
			case "query":
				tx.queryErr = boom
			case "commission scan":
				tx.sets[0].data = []manualPolicyRow{{err: boom}}
			case "commission rows":
				tx.sets[0].err = boom
			case "membership scan":
				tx.sets[1].data = []manualPolicyRow{{err: boom}}
			case "membership rows":
				tx.sets[1].err = boom
			default:
				row := manualMembershipFixture(time.Now(), time.Now(), "active", true, true)
				switch stage {
				case "repriced principal":
					row.values[0] = decimal.NewFromInt(97)
				case "wrong fee":
					row.values[2] = decimal.NewFromInt(99)
				case "wrong pv":
					row.values[3] = decimal.NewFromInt(97)
				case "negative paid":
					row.values[9] = decimal.NewFromInt(-1)
				}
				tx.sets[1].data = []manualPolicyRow{row}
			}
			if got, err := readManualMemberPolicy(context.Background(), tx, "signed-subject", "member@example.test"); err == nil || got != nil {
				t.Fatal("failed source read became zero or partially available balance", got, err)
			}
		})
	}
}

func TestManualMemberFundsRiskGuardPreservesPreMigrationNOW(t *testing.T) {
	for _, tc := range []struct {
		name string
		rows []manualPolicyRow
		safe bool
		err  bool
	}{
		{"before migration", []manualPolicyRow{{values: []any{false}}}, true, false},
		{"manual source clean", []manualPolicyRow{{values: []any{true}}, {values: []any{true}}}, true, false},
		{"manual risk hold", []manualPolicyRow{{values: []any{true}}, {values: []any{false}}}, false, false},
		{"metadata unavailable", []manualPolicyRow{{err: errors.New("metadata")}}, false, true},
		{"manual ACL unavailable", []manualPolicyRow{{values: []any{true}}, {err: errors.New("denied")}}, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tx := &manualPolicyTx{t: t, singles: tc.rows}
			got, err := manualMemberFundsSafe(context.Background(), tx)
			if got != tc.safe || (err != nil) != tc.err {
				t.Fatal("unknown risk became available or pre-migration NOW broke", got, err)
			}
		})
	}
	if !strings.Contains(nowMemberSafeSQL, "$4::boolean") || !strings.Contains(manualMemberSafeSQL, memberNOWGlobalSafeSQL) {
		t.Fatal("shared funding risk did not gate both accounting projections")
	}
}

func TestManualMemberCommissionOriginIsExplicitNotBeneficiaryPaymentMethod(t *testing.T) {
	for _, value := range []string{"manual", "nowpayments", "mixed", "unattributed", "", "legacy", "MANUAL"} {
		want := value
		if value != "manual" && value != "nowpayments" && value != "mixed" {
			want = "unattributed"
		}
		if got := memberCommissionProvider(value); got != want {
			t.Fatal("unrecorded origin became an asserted payment provider", value, got)
		}
	}
	if strings.Contains(memberCommissionOriginSQL(nowMemberCommissionCTE, false), "FROM payments.v_compensation_obligation_origin") {
		t.Fatal("pre-91 NOW fallback requires a nonexistent lineage view")
	}
	if !strings.Contains(memberCommissionOriginSQL(manualMemberCommissionCTE, true), "FROM payments.v_compensation_obligation_origin") {
		t.Fatal("manual reader ignored source lineage")
	}
	start := time.Date(2026, 1, 31, 17, 30, 0, 0, time.UTC)
	d := decimal.NewFromInt
	tx := manualPolicyFixture(t)
	tx.singles[3].values = []any{d(2), decimal.Zero, d(4), d(6)}
	tx.sets[0].data = []manualPolicyRow{{values: []any{start, start.AddDate(0, 1, 0), "binary_bonus", "mixed", d(10), d(6), decimal.Zero, d(2), false, start}}}
	p, err := readManualMemberPolicy(context.Background(), tx, "signed-subject", "member@example.test")
	if err != nil || p.Commissions.Items[0].SourceProvider != "mixed" || p.Commissions.Items[0].Status != "risk_review" || p.Commissions.FundingHeldUSD != "4.00" {
		t.Fatal("source risk lost truthful mixed origin or obligation", p, err)
	}
}
