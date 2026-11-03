package payments

import (
	"context"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog"
)

func TestBlacklistRequiresValidEmailBeforeDatabase(t *testing.T) {
	for _, email := range []string{"", "   ", "not-an-email", "member@", "@example.test", "Member <member@example.test>", "member@example.test,other@example.test", "member\n@example.test", strings.Repeat("a", 255) + "@example.test"} {
		t.Run(email, func(t *testing.T) {
			defer func() {
				if recovered := recover(); recovered != nil {
					t.Errorf("invalid email reached the database instead of validation: %v", recovered)
				}
			}()
			if _, err := (&Store{}).AddBlacklist(context.Background(), "Shared Name", email, "+12025550123", "1990-01-01", "test"); err == nil {
				t.Fatal("an invalid or missing email must not create a phone/name blacklist")
			}
		})
	}
}

type blacklistEmailTestQuery struct {
	query string
	args  []any
	err   error
	calls int
}

func (q *blacklistEmailTestQuery) QueryRow(_ context.Context, query string, args ...any) pgx.Row {
	q.query, q.args = query, args
	q.calls++
	return blacklistEmailTestRow{err: q.err}
}

type blacklistEmailTestRow struct{ err error }

func (r blacklistEmailTestRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	*dest[0].(*int64) = 42
	return nil
}

func TestBlacklistInsertIsEmailOnlyAndParameterized(t *testing.T) {
	q := &blacklistEmailTestQuery{}
	motive := "reason '); UPDATE mlm.person SET status='active'; --"
	id, err := insertBlacklistEmail(context.Background(), q, " Member+Test@Example.Test ", motive)
	if err != nil || id != 42 || q.calls != 1 || len(q.args) != 2 || q.args[0] != "member+test@example.test" || q.args[1] != motive {
		t.Fatal("normalized email and motive must remain separate SQL parameters", id, err, q.calls, q.args)
	}
	for _, fragment := range []string{"INSERT INTO mlm.blacklist", "(email, email_norm, motive, source)", "mlm.norm_email($1)", "RETURNING id"} {
		if !strings.Contains(q.query, fragment) {
			t.Errorf("missing email-only insert fragment %q", fragment)
		}
	}
	for _, forbidden := range []string{"fullname", "birthdate", "phone", "name_norm", "mlm.person", "mlm.affiliate", motive} {
		if strings.Contains(q.query, forbidden) {
			t.Errorf("email-only insert includes unrelated identifier or interpolated input %q", forbidden)
		}
	}
	q.err = errors.New("synthetic database unavailable")
	if id, err := insertBlacklistEmail(context.Background(), q, "member@example.test", "test"); id != 0 || !errors.Is(err, q.err) {
		t.Fatal("failed insert must propagate its error, not report success", id, err)
	}
}

// Structural guard complements the fake SQL tests without requiring a database
// or Cognito. Account state mutations must remain a separate admin operation.
func TestBlacklistMutationsCannotChangeAccountState(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), filepath.Join(findRepoRoot(t), "vp-engine/internal/payments/blacklist_admin.go"), nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	checked := map[string]bool{"AddBlacklist": false, "insertBlacklistEmail": false, "RemoveBlacklistByID": false,
		"RemoveBlacklistByEmail": false, "handleAdminBlacklist": false, "handleAdminBlacklistRemove": false}
	for _, declaration := range file.Decls {
		fn, ok := declaration.(*ast.FuncDecl)
		if !ok {
			continue
		}
		if fn.Name.Name == "applyAccountBan" {
			t.Fatal("blacklist must not retain a helper that conflates list and account state")
		}
		if _, selected := checked[fn.Name.Name]; !selected {
			continue
		}
		checked[fn.Name.Name] = true
		ast.Inspect(fn.Body, func(node ast.Node) bool {
			if selector, ok := node.(*ast.SelectorExpr); ok {
				switch selector.Sel.Name {
				case "SetBlocked", "SetEnabled", "applyAccountBan", "cognitoAdmin":
					t.Errorf("%s can mutate independent account state through %s", fn.Name.Name, selector.Sel.Name)
				}
			}
			if literal, ok := node.(*ast.BasicLit); ok && literal.Kind == token.STRING {
				value, err := strconv.Unquote(literal.Value)
				if err != nil {
					t.Fatal(err)
				}
				for _, relation := range []string{"mlm.person", "mlm.affiliate", "auth."} {
					if strings.Contains(value, relation) {
						t.Errorf("%s references unrelated account relation %s", fn.Name.Name, relation)
					}
				}
			}
			return true
		})
	}
	for name, found := range checked {
		if !found {
			t.Errorf("mutation guard did not inspect %s", name)
		}
	}
}

func TestBlacklistRejectsPhoneOrNameOnlyAtHTTPBoundary(t *testing.T) {
	h := &Handler{store: &Store{}, serviceToken: "synthetic-service-token", adminEmails: []string{"admin@example.test"}, log: zerolog.Nop()}
	for _, body := range []string{`{"fullname":"Shared Name"}`, `{"phone":"+12025550123"}`, `{"email":"not-an-email","fullname":"Shared Name"}`} {
		t.Run(body, func(t *testing.T) {
			defer func() {
				if recovered := recover(); recovered != nil {
					t.Errorf("invalid request reached the database instead of returning 400: %v", recovered)
				}
			}()
			r := httptest.NewRequest(http.MethodPost, "/api/admin/blacklist?email=admin@example.test", strings.NewReader(body))
			r.Header.Set("X-VP-Service-Token", "synthetic-service-token")
			w := httptest.NewRecorder()
			h.handleAdminBlacklist(w, r)
			if w.Code != http.StatusBadRequest || strings.TrimSpace(w.Body.String()) != `{"error":"invalid_blacklist_email"}` {
				t.Fatalf("invalid blacklist request must fail safely: status=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
}
