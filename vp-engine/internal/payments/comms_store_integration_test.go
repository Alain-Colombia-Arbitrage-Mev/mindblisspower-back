package payments

import (
	"context"
	"testing"

	"github.com/vicionpower/vp-engine/internal/comms"
)

func TestCommsStore_CampaignLifecycle_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	store := NewStore(pool)

	// 3 activos, 1 baneado, 1 pendiente, 1 con email inválido
	for _, r := range []struct {
		email, status string
		black         bool
	}{
		{"a@x.com", "active", false}, {"b@x.com", "active", false}, {"c@x.com", "active", false},
		{"ban@x.com", "active", true}, {"pend@x.com", "pending", false}, {"bad-email", "active", false},
	} {
		if _, err := pool.Exec(ctx, `INSERT INTO mlm.person (first_name,last_name,email,phone_number,status,blacklisted)
			VALUES ('N','A',$1,'3000000000',$2::mlm.person_status,$3)`, r.email, r.status, r.black); err != nil {
			t.Fatalf("seed %s: %v", r.email, err)
		}
	}
	if err := store.AddUnsubscribe(ctx, "c@x.com", nil, "link"); err != nil {
		t.Fatalf("unsubscribe: %v", err)
	}

	seg, _ := comms.ParseSegment([]byte(`{"status":["active"]}`))
	prev, err := store.PreviewAudience(ctx, seg)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if prev.Eligible != 2 || prev.Excluded.Unsubscribed != 1 || prev.Excluded.Blacklisted != 1 || prev.Excluded.Invalid != 1 {
		t.Fatalf("preview = %+v", prev)
	}

	c, err := store.CreateCampaign(ctx, "admin@x.com", "Asunto de prueba", "Cuerpo de prueba largo", seg)
	if err != nil || c.Status != "draft" {
		t.Fatalf("create = %+v, %v", c, err)
	}
	if _, err := store.EnqueueAudience(ctx, c.ID, seg, 1); err != ErrAudienceTooLarge {
		t.Fatalf("expected ErrAudienceTooLarge, got %v", err)
	}
	n, err := store.EnqueueAudience(ctx, c.ID, seg, 150000)
	if err != nil || n != 2 {
		t.Fatalf("enqueue = %d, %v", n, err)
	}
	recs, total, err := store.ListCampaignRecipients(ctx, c.ID, "", 50, 0)
	if err != nil || total != 2 || len(recs) != 2 || recs[0].Status != "queued" {
		t.Fatalf("recipients = %+v total=%d err=%v", recs, total, err)
	}

	if err := store.SetCampaignStatus(ctx, c.ID, []string{"draft"}, "pending_approval", ""); err != nil {
		t.Fatalf("set status: %v", err)
	}
	if err := store.SetCampaignStatus(ctx, c.ID, []string{"draft"}, "approved", ""); err != ErrCampaignState {
		t.Fatalf("expected ErrCampaignState, got %v", err)
	}
	if _, err := store.UpdateCampaignDraft(ctx, c.ID, "x", "y", seg); err != ErrCampaignState {
		t.Fatalf("draft edit after submit should fail: %v", err)
	}

	if err := store.MarkRecipient(ctx, c.ID, recs[0].PersonID, "sent", ""); err != nil {
		t.Fatalf("mark: %v", err)
	}
	if err := store.RefreshCampaignCounters(ctx, c.ID); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	got, _ := store.GetCampaign(ctx, c.ID)
	if got.SentCount != 1 || got.AudienceCount == nil || *got.AudienceCount != 2 {
		t.Fatalf("counters = %+v", got)
	}
	if _, err := store.GetCampaign(ctx, 999999); err != ErrCampaignNotFound {
		t.Fatalf("expected not found, got %v", err)
	}
}
