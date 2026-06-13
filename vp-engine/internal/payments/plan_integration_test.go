package payments

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// seedAdmin crea una persona admin y devuelve (person_id, email).
func seedAdmin(t *testing.T, ctx context.Context, pool *pgxpool.Pool, email string) int64 {
	t.Helper()
	var id int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.person (first_name, last_name, email, phone_number, status, is_admin)
		VALUES ('a','dmin',$1,'0','active',true) RETURNING id`, email).Scan(&id); err != nil {
		t.Fatalf("seed admin %s: %v", email, err)
	}
	return id
}

// seedActivePlan inserta una plan_config activa (bypass) para editar.
func seedActivePlan(t *testing.T, ctx context.Context, pool *pgxpool.Pool, createdBy int64) {
	t.Helper()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SET LOCAL app.bypass_approval = 'on'`); err != nil {
		t.Fatalf("bypass: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO mlm.plan_config (
		  version_label, effective_from, block_size, bonus_per_block, depth_cap,
		  daily_cap_factor, lifetime_cap_factor, treasury_alpha, carry_decay_days,
		  qualified_directs_left, qualified_directs_right, created_by_person_id)
		VALUES ('v-base', now(), 500, 10.00, 10, 3.0, 2.0, 0.45, 14, 1, 1, $1)`, createdBy); err != nil {
		t.Fatalf("seed plan: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
}

// TestPlanFourEyes_HappyPath: admin1 propone, admin2 aprueba → nueva config
// vigente con el valor cambiado, la anterior cerrada.
func TestPlanFourEyes_HappyPath(t *testing.T) {
	ctx := context.Background()
	pool, cleanup := pgContainer(t)
	defer cleanup()
	store := NewStore(pool)

	a1 := seedAdmin(t, ctx, pool, "a1@t.local")
	_ = seedAdmin(t, ctx, pool, "a2@t.local")
	seedActivePlan(t, ctx, pool, a1)

	// admin1 propone subir treasury_alpha a 0.50 y royalty_rate a 0.06.
	reqID, err := store.ProposePlanChange(ctx, "a1@t.local",
		map[string]any{"treasury_alpha": 0.50, "royalty_rate": 0.06}, "subir alpha y regalía")
	if err != nil {
		t.Fatalf("propose: %v", err)
	}

	// admin2 aprueba → publica.
	status, err := store.DecidePlanProposal(ctx, "a2@t.local", reqID, true, "ok revisado")
	if err != nil {
		t.Fatalf("approve: %v", err)
	}
	if status != "executed" {
		t.Fatalf("status = %q, want executed", status)
	}

	// Nueva config vigente con los valores cambiados; lo demás copiado.
	var alpha, royalty, lifetime string
	var nOpen int
	if err := pool.QueryRow(ctx, `
		SELECT treasury_alpha::text, royalty_rate::text, lifetime_cap_factor::text
		  FROM mlm.plan_config WHERE effective_to IS NULL`).Scan(&alpha, &royalty, &lifetime); err != nil {
		t.Fatalf("active config: %v", err)
	}
	if alpha != "0.450000" && alpha[:4] != "0.50" {
		t.Fatalf("treasury_alpha = %s, want 0.50", alpha)
	}
	if royalty[:4] != "0.06" {
		t.Fatalf("royalty_rate = %s, want 0.06", royalty)
	}
	if lifetime[:3] != "2.0" {
		t.Fatalf("lifetime_cap_factor copiado mal: %s, want 2.0", lifetime)
	}
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM mlm.plan_config WHERE effective_to IS NULL`).Scan(&nOpen)
	if nOpen != 1 {
		t.Fatalf("debe haber exactamente 1 config abierta, hay %d", nOpen)
	}
}

// TestPlanFourEyes_InitiatorCannotApprove: el proponente no puede aprobar su
// propia propuesta (constraint DB).
func TestPlanFourEyes_InitiatorCannotApprove(t *testing.T) {
	ctx := context.Background()
	pool, cleanup := pgContainer(t)
	defer cleanup()
	store := NewStore(pool)

	a1 := seedAdmin(t, ctx, pool, "solo@t.local")
	seedActivePlan(t, ctx, pool, a1)

	reqID, err := store.ProposePlanChange(ctx, "solo@t.local",
		map[string]any{"treasury_alpha": 0.50}, "intento aprobar solo")
	if err != nil {
		t.Fatalf("propose: %v", err)
	}
	if _, err := store.DecidePlanProposal(ctx, "solo@t.local", reqID, true, "me apruebo"); err == nil {
		t.Fatal("esperaba error: el proponente no puede aprobar su propia propuesta")
	}
}

// TestPlanFourEyes_RejectsOutOfBounds: alpha fuera de [0.30,0.60] se rechaza al proponer.
func TestPlanFourEyes_RejectsOutOfBounds(t *testing.T) {
	ctx := context.Background()
	pool, cleanup := pgContainer(t)
	defer cleanup()
	store := NewStore(pool)

	a1 := seedAdmin(t, ctx, pool, "b1@t.local")
	seedActivePlan(t, ctx, pool, a1)

	if _, err := store.ProposePlanChange(ctx, "b1@t.local",
		map[string]any{"treasury_alpha": 0.95}, "alpha absurdo"); err == nil {
		t.Fatal("esperaba rechazo por cota (alpha 0.95 > 0.60)")
	}

	// Campo no editable también se rechaza.
	if _, err := store.ProposePlanChange(ctx, "b1@t.local",
		map[string]any{"version_label": "hack"}, "campo prohibido"); err == nil {
		t.Fatal("esperaba rechazo por campo no editable")
	}
}

// sanity: el JSON de GetActivePlanConfig trae los campos esperados.
func TestGetActivePlanConfig(t *testing.T) {
	ctx := context.Background()
	pool, cleanup := pgContainer(t)
	defer cleanup()
	store := NewStore(pool)
	a1 := seedAdmin(t, ctx, pool, "c1@t.local")
	seedActivePlan(t, ctx, pool, a1)

	js, err := store.GetActivePlanConfig(ctx)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(js, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if m["treasury_alpha"] == nil || m["founder_referral_rate"] == nil || m["version_label"] != "v-base" {
		t.Fatalf("config JSON incompleto: %v", m)
	}
}
