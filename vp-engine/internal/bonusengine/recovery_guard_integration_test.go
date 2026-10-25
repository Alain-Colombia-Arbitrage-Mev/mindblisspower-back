package bonusengine

import (
	"context"
	"testing"

	"github.com/rs/zerolog"
)

func TestRecoverySchedulerDoesNotOpenBinaryPeriodIntegration(t *testing.T) {
	if testing.Short() {
		t.Skip("isolated PostgreSQL testcontainer")
	}
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `CREATE SCHEMA IF NOT EXISTS payments;
		CREATE TABLE payments.stripe_sale(payment_intent_id text PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	scheduler := &Scheduler{db: pool, log: zerolog.Nop()}
	// No Engine is needed: the scheduler must stop before any engine call or
	// fn_open_next_binary_period side effect, even when accidentally enabled.
	scheduler.runBinaryCycle(ctx)
	var periods int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM mlm.binary_period`).Scan(&periods); err != nil || periods != 0 {
		t.Fatal("locked recovery scheduler opened a period", periods, err)
	}
}
