package payments

import (
	"context"
	"testing"

	"github.com/rs/zerolog"
)

type fakeQueue struct {
	msgs    []QueueMessage
	deleted []string
}

func (f *fakeQueue) Receive(_ context.Context, max, _ int) ([]QueueMessage, error) {
	if len(f.msgs) == 0 {
		return nil, nil
	}
	n := max
	if n > len(f.msgs) {
		n = len(f.msgs)
	}
	out := f.msgs[:n]
	f.msgs = f.msgs[n:]
	return out, nil
}
func (f *fakeQueue) Delete(_ context.Context, rh string) error {
	f.deleted = append(f.deleted, rh)
	return nil
}

func TestCommsEvents_ApplyDeliveryBounceComplaint_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	store := NewStore(pool)
	c := approvedCampaign(t, ctx, store, []string{"d@x.com", "b@x.com", "c@x.com"})
	for _, r := range []struct{ email, msg string }{{"d@x.com", "m-d"}, {"b@x.com", "m-b"}, {"c@x.com", "m-c"}} {
		if _, err := pool.Exec(ctx, `UPDATE comms.campaign_recipient SET status='sent', ses_message_id=$3 WHERE campaign_id=$1 AND email=$2`, c.ID, r.email, r.msg); err != nil {
			t.Fatal(err)
		}
	}
	q := &fakeQueue{msgs: []QueueMessage{
		{ID: "1", ReceiptHandle: "r1", Body: `{"eventType":"Delivery","mail":{"messageId":"m-d"}}`},
		{ID: "2", ReceiptHandle: "r2", Body: `{"eventType":"Bounce","mail":{"messageId":"m-b"},"bounce":{"bounceType":"Permanent","bouncedRecipients":[{"diagnosticCode":"550"}]}}`},
		{ID: "3", ReceiptHandle: "r3", Body: `{"eventType":"Complaint","mail":{"messageId":"m-c"},"complaint":{"complaintFeedbackType":"abuse"}}`},
		{ID: "4", ReceiptHandle: "r4", Body: `{"eventType":"Delivery","mail":{"messageId":"otp-not-ours"}}`},
		{ID: "5", ReceiptHandle: "r5", Body: `garbage`},
	}}
	ec := NewCommsEventConsumer(store, q, zerolog.Nop())
	n, err := ec.RunOnce(ctx)
	if err != nil || n != 5 {
		t.Fatalf("processed = %d, %v", n, err)
	}
	if len(q.deleted) != 5 {
		t.Fatalf("all messages must be deleted (incl. unmatched/garbage), got %d", len(q.deleted))
	}
	recs, _, _ := store.ListCampaignRecipients(ctx, c.ID, "", 10, 0)
	st := map[string]string{}
	for _, r := range recs {
		st[r.Email] = r.Status
	}
	if st["d@x.com"] != "delivered" || st["b@x.com"] != "bounced" || st["c@x.com"] != "complained" {
		t.Fatalf("statuses = %v", st)
	}
	var supp, unsub int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM comms.suppressed_email WHERE email='b@x.com'`).Scan(&supp)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM comms.unsubscribe WHERE email='c@x.com' AND source='complaint'`).Scan(&unsub)
	if supp != 1 || unsub != 1 {
		t.Fatalf("suppressed=%d unsubscribed=%d", supp, unsub)
	}
	got, _ := store.GetCampaign(ctx, c.ID)
	if got.DeliveredCount != 1 || got.BouncedCount != 1 || got.ComplainedCount != 1 {
		t.Fatalf("counters = %+v", got)
	}
}

func TestCommsEvents_AutoPauseOnBounceRate_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	store := NewStore(pool)
	c := approvedCampaign(t, ctx, store, []string{"z@x.com"})
	if _, err := pool.Exec(ctx, `UPDATE comms.campaign SET status='sending', sent_count=1000, bounced_count=60 WHERE id=$1`, c.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE comms.campaign_recipient SET status='sent', ses_message_id='m-z' WHERE campaign_id=$1`, c.ID); err != nil {
		t.Fatal(err)
	}
	ec := NewCommsEventConsumer(store, &fakeQueue{}, zerolog.Nop())
	// RefreshCampaignCounters recalcula desde recipients (1 sent, 1 bounced) ⇒ simulamos
	// la regla con contadores ya altos: el consumer debe evaluar ANTES de refrescar.
	matched, err := ec.ProcessBody(ctx, []byte(`{"eventType":"Bounce","mail":{"messageId":"m-z"},"bounce":{"bounceType":"Permanent"}}`))
	if err != nil || !matched {
		t.Fatalf("matched=%v err=%v", matched, err)
	}
	got, _ := store.GetCampaign(ctx, c.ID)
	if got.Status != "paused" || got.PauseReason != "bounce_rate" {
		t.Fatalf("expected paused by bounce_rate, got %+v", got)
	}
}
