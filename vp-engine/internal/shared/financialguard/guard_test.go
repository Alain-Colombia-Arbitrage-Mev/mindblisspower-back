package financialguard

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
)

type modeDB struct {
	recovered bool
	err       error
	query     string
}

func (d *modeDB) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	d.query = sql
	return d
}

func (d *modeDB) Scan(dest ...any) error {
	if d.err != nil {
		return d.err
	}
	*dest[0].(*bool) = d.recovered
	return nil
}

func TestRequireOperational(t *testing.T) {
	unavailable := errors.New("synthetic database unavailable")
	for _, tc := range []struct {
		name      string
		recovered bool
		err       error
		want      error
	}{
		{"normal operational database", false, nil, nil},
		{"recovery database always locked", true, nil, ErrRecoveryReview},
		{"failed check remains closed", false, unavailable, unavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := &modeDB{recovered: tc.recovered, err: tc.err}
			err := RequireOperational(context.Background(), db)
			if !errors.Is(err, tc.want) {
				t.Fatalf("got %v, want %v", err, tc.want)
			}
			if db.query != `SELECT to_regclass('payments.stripe_sale') IS NOT NULL` {
				t.Fatal("financial mode check must only read canonical source presence")
			}
		})
	}
}
