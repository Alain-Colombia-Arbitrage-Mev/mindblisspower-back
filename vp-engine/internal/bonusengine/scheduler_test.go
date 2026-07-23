package bonusengine

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// TestPickPeriodToClose_OnlyFutureEnd es la protección exacta de la race entre-boxes:
// si el único período abierto es el de la semana en curso (period_end futuro, recién
// abierto por otro box tras cerrar el terminado), NO hay nada que cerrar → ErrNoRows.
// Sin la guarda `period_end <= now()`, un box rezagado cerraría ese período nuevo
// prematuramente y la semana quedaría sin período. Este test falla con el código viejo.
func TestPickPeriodToClose_OnlyFutureEnd(t *testing.T) {
	if testing.Short() {
		t.Skip("requires docker / testcontainers")
	}
	ctx := context.Background()
	pool, cleanup := pgContainer(t)
	defer cleanup()

	seedMinimalTree(t, ctx, pool)
	now := time.Now().UTC()

	// Sólo el período de la semana en curso (period_end futuro) está abierto.
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.binary_period (plan_config_id, period_start, period_end, status)
		SELECT id, $1, $2, 'open' FROM mlm.plan_config WHERE version_label='v1-test'`,
		now.Add(-1*time.Hour), now.Add(6*24*time.Hour)); err != nil {
		t.Fatalf("current period: %v", err)
	}

	if _, err := pickPeriodToClose(ctx, pool); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("esperaba pgx.ErrNoRows (nada terminado que cerrar), got %v", err)
	}
}

// TestPickPeriodToClose_PicksEndedNotCurrent: con el período terminado (period_end
// pasado) y el de la semana en curso (period_end futuro) ambos abiertos, elige el
// terminado y nunca el de la semana en curso.
func TestPickPeriodToClose_PicksEndedNotCurrent(t *testing.T) {
	if testing.Short() {
		t.Skip("requires docker / testcontainers")
	}
	ctx := context.Background()
	pool, cleanup := pgContainer(t)
	defer cleanup()

	seedMinimalTree(t, ctx, pool)
	now := time.Now().UTC()

	var endedID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.binary_period (plan_config_id, period_start, period_end, status)
		SELECT id, $1, $2, 'open' FROM mlm.plan_config WHERE version_label='v1-test'
		RETURNING id`, now.Add(-14*24*time.Hour), now.Add(-1*time.Hour)).Scan(&endedID); err != nil {
		t.Fatalf("ended period: %v", err)
	}
	var currentID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.binary_period (plan_config_id, period_start, period_end, status)
		SELECT id, $1, $2, 'open' FROM mlm.plan_config WHERE version_label='v1-test'
		RETURNING id`, now.Add(-1*time.Hour), now.Add(6*24*time.Hour)).Scan(&currentID); err != nil {
		t.Fatalf("current period: %v", err)
	}

	got, err := pickPeriodToClose(ctx, pool)
	if err != nil {
		t.Fatalf("pickPeriodToClose: %v", err)
	}
	if got != endedID {
		t.Fatalf("eligió period %d; esperaba el terminado %d (nunca el de la semana en curso %d)", got, endedID, currentID)
	}
}
