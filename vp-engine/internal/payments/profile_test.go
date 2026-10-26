package payments

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestProfileNameOnlyPreservesOmittedFields(t *testing.T) {
	req, err := decodeProfileUpdate(strings.NewReader(`{"email":"member@example.test","name":"  Ana Maria Perez  "}`))
	if err != nil {
		t.Fatal(err)
	}
	patch, invalid := profilePatch(req)
	if invalid != "" || patch.FirstName == nil || *patch.FirstName != "Ana" || patch.LastName == nil || *patch.LastName != "Maria Perez" {
		t.Fatal("legal name was not normalized", patch, invalid)
	}
	if patch.Phone != nil || patch.Country != nil || patch.PayoutWalletUSDC != nil {
		t.Fatal("name-only KYC must not write other profile fields")
	}
}

func TestProfileExplicitClearsRemainDistinctFromOmission(t *testing.T) {
	req, err := decodeProfileUpdate(strings.NewReader(`{"phone":"  ","country":"","payout_wallet_usdc":""}`))
	if err != nil {
		t.Fatal(err)
	}
	p, invalid := profilePatch(req)
	if invalid != "" || p.FirstName != nil || p.LastName != nil || p.Phone == nil || *p.Phone != "-" || p.Country == nil || *p.Country != "" || p.PayoutWalletUSDC == nil || *p.PayoutWalletUSDC != "" {
		t.Fatal("explicit clears must remain explicit", p, invalid)
	}
}

func TestProfileSingleNamePartDoesNotOverwriteOtherPart(t *testing.T) {
	req, err := decodeProfileUpdate(strings.NewReader(`{"first_name":" Ana "}`))
	if err != nil {
		t.Fatal(err)
	}
	p, invalid := profilePatch(req)
	if invalid != "" || p.FirstName == nil || *p.FirstName != "Ana" || p.LastName != nil {
		t.Fatal("partial name update changed an omitted surname", p, invalid)
	}
}

func TestProfilePatchValidation(t *testing.T) {
	for _, input := range []string{`null`, `[]`, `true`, `{"name":1}`, `{"name":"Ana"}{}`, `{"name":"Ana","is_admin":true}`, `{"name":"Ana"} trailing`} {
		if _, err := decodeProfileUpdate(strings.NewReader(input)); err == nil {
			t.Errorf("accepted invalid profile %s", input)
		}
	}
	for _, input := range []string{`{}`, `{"email":"member@example.test"}`, `{"phone":null}`} {
		req, err := decodeProfileUpdate(strings.NewReader(input))
		if err != nil {
			t.Fatal(err)
		}
		if _, invalid := profilePatch(req); invalid != "missing_profile_fields" {
			t.Fatal("empty patch accepted", input)
		}
	}
	req, err := decodeProfileUpdate(strings.NewReader(`{"payout_wallet_usdc":"not-a-wallet"}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, invalid := profilePatch(req); invalid != "invalid_wallet" {
		t.Fatal("invalid wallet accepted")
	}
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"name":"`+strings.Repeat("a", 1<<16)+`"}`))
	if _, err := decodeProfileUpdate(http.MaxBytesReader(httptest.NewRecorder(), r.Body, 1<<16)); err == nil {
		t.Fatal("oversized profile accepted")
	}
}

type profileTestRow struct {
	values []*string
	err    error
}

func (r profileTestRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	for index, value := range r.values {
		*dest[index].(**string) = value
	}
	return nil
}

type profileTestQuery struct {
	query string
	args  []any
	row   pgx.Row
	calls int
}

func (q *profileTestQuery) QueryRow(_ context.Context, query string, args ...any) pgx.Row {
	q.query, q.args = query, args
	q.calls++
	return q.row
}

func TestProfilePartialUpdateIsAtomicAndReturnsPersistedRecord(t *testing.T) {
	first, last, phone, country := "Ana", "Perez", "+573001234567", "Colombia"
	wallet := "0x" + strings.Repeat("1", 40)
	query := &profileTestQuery{row: profileTestRow{values: []*string{&first, &last, &phone, &country, &wallet}}}
	req, err := decodeProfileUpdate(strings.NewReader(`{"name":"Ana Perez"}`))
	if err != nil {
		t.Fatal(err)
	}
	patch, _ := profilePatch(req)
	profile, err := updateMemberProfile(context.Background(), query, "member@example.test", patch)
	if err != nil {
		t.Fatal(err)
	}
	if query.calls != 1 || query.query != updateMemberProfileSQL || len(query.args) != 6 {
		t.Fatal("profile update must be one parameterized statement")
	}
	for _, index := range []int{3, 4, 5} {
		if pointer, ok := query.args[index].(*string); !ok || pointer != nil {
			t.Fatalf("omitted field %d was sent as a replacement", index)
		}
	}
	for _, clause := range []string{"COALESCE($2::text, first_name)", "COALESCE($3::text, last_name)", "COALESCE($4::text, phone_number)", "WHEN $5::text IS NULL THEN country", "WHEN $6::text IS NULL THEN payout_wallet_usdc", "RETURNING first_name"} {
		if !strings.Contains(query.query, clause) {
			t.Fatal("missing presence-aware SQL clause", clause)
		}
	}
	if profile.Phone != phone || profile.Country != country || profile.PayoutWalletUSDC != wallet {
		t.Fatal("response must include actual unchanged values from RETURNING", profile)
	}
}

func TestProfilePartialUpdateNoRowsAndNullReads(t *testing.T) {
	query := &profileTestQuery{row: profileTestRow{err: pgx.ErrNoRows}}
	if _, err := updateMemberProfile(context.Background(), query, "member@example.test", memberProfilePatch{}); !errors.Is(err, ErrBuyerNotFound) {
		t.Fatal(err)
	}
	phone := "-"
	p, err := scanMemberProfile(profileTestRow{values: []*string{nil, nil, &phone, nil, nil}})
	if err != nil || p != (MemberProfile{}) {
		t.Fatal("nullable fields were not normalized", p, err)
	}
}
