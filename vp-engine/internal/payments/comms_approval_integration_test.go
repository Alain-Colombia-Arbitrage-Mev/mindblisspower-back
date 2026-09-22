package payments

import (
	"context"
	"errors"
	"testing"

	"github.com/vicionpower/vp-engine/internal/comms"
)

func TestCommsApproval_FourEyes_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	store := NewStore(pool)
	seedAdmin(t, ctx, pool, "admin@x.com")
	seedAdmin(t, ctx, pool, "super@x.com")
	if _, err := pool.Exec(ctx, `INSERT INTO mlm.person (first_name,last_name,email,phone_number,status)
		VALUES ('M','B','member@x.com','3000000000','active')`); err != nil {
		t.Fatal(err)
	}
	seg, _ := comms.ParseSegment([]byte(`{}`))
	c, err := store.CreateCampaign(ctx, "admin@x.com", "Asunto largo", "Cuerpo de prueba largo", seg)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := store.SubmitCampaign(ctx, c.ID, "admin@x.com", "corto"); err == nil {
		t.Fatal("reason < 10 chars should fail")
	}
	c, err = store.SubmitCampaign(ctx, c.ID, "admin@x.com", "comunicado mensual de septiembre")
	if err != nil || c.Status != "pending_approval" || c.ApprovalRequestID == nil {
		t.Fatalf("submit = %+v, %v", c, err)
	}

	if _, err := store.DecideCampaign(ctx, c.ID, "admin@x.com", "approve", "yo mismo", 150000, 3); !errors.Is(err, ErrSameApprover) {
		t.Fatalf("self-approval must fail, got %v", err)
	}
	c, err = store.DecideCampaign(ctx, c.ID, "super@x.com", "approve", "ok aprobado", 150000, 3)
	if err != nil || c.Status != "approved" || c.ApprovedBy != "super@x.com" || c.AudienceCount == nil || *c.AudienceCount != 1 {
		t.Fatalf("approve = %+v, %v", c, err)
	}
	var st string
	if err := pool.QueryRow(ctx, `SELECT status::text FROM mlm.approval_request WHERE id=$1`, *c.ApprovalRequestID).Scan(&st); err != nil || st != "approved" {
		t.Fatalf("approval_request status = %q, %v", st, err)
	}

	// límite diario: la siguiente campaña no puede aprobarse con maxPerDay=1
	c2, _ := store.CreateCampaign(ctx, "admin@x.com", "Otro asunto", "Otro cuerpo largo", seg)
	c2, _ = store.SubmitCampaign(ctx, c2.ID, "admin@x.com", "segunda campaña del día")
	if _, err := store.DecideCampaign(ctx, c2.ID, "super@x.com", "approve", "ok", 150000, 1); !errors.Is(err, ErrDailyLimit) {
		t.Fatalf("expected ErrDailyLimit, got %v", err)
	}
	c2, err = store.DecideCampaign(ctx, c2.ID, "super@x.com", "reject", "no procede ahora", 150000, 3)
	if err != nil || c2.Status != "rejected" {
		t.Fatalf("reject = %+v, %v", c2, err)
	}
}
