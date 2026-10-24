package payments

import (
	"context"
	"strings"
	"testing"
	"time"

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
	c := approvedCampaign(t, ctx, store, []string{"d@x.com", "b@x.com", "c@x.com", "x@x.com"})
	for _, r := range []struct{ email, msg string }{{"d@x.com", "m-d"}, {"b@x.com", "m-b"}, {"c@x.com", "m-c"}} {
		if _, err := pool.Exec(ctx, `UPDATE comms.campaign_recipient SET status='sent', ses_message_id=$3 WHERE campaign_id=$1 AND email=$2`, c.ID, r.email, r.msg); err != nil {
			t.Fatal(err)
		}
	}
	// x@x.com: enviado hace 1h; un rebote transitorio no debe tocar su sent_at.
	if _, err := pool.Exec(ctx, `UPDATE comms.campaign_recipient SET status='sent', ses_message_id='m-x', sent_at = now() - interval '1 hour' WHERE campaign_id=$1 AND email='x@x.com'`, c.ID); err != nil {
		t.Fatal(err)
	}
	q := &fakeQueue{msgs: []QueueMessage{
		{ID: "1", ReceiptHandle: "r1", Body: `{"eventType":"Delivery","mail":{"messageId":"m-d"}}`},
		{ID: "2", ReceiptHandle: "r2", Body: `{"eventType":"Bounce","mail":{"messageId":"m-b"},"bounce":{"bounceType":"Permanent","bouncedRecipients":[{"diagnosticCode":"550"}]}}`},
		{ID: "3", ReceiptHandle: "r3", Body: `{"eventType":"Complaint","mail":{"messageId":"m-c"},"complaint":{"complaintFeedbackType":"abuse"}}`},
		{ID: "4", ReceiptHandle: "r4", Body: `{"eventType":"Delivery","mail":{"messageId":"otp-not-ours"}}`},
		{ID: "5", ReceiptHandle: "r5", Body: `garbage`},
		{ID: "6", ReceiptHandle: "r6", Body: `{"eventType":"Bounce","mail":{"messageId":"m-x"},"bounce":{"bounceType":"Transient","bouncedRecipients":[{"diagnosticCode":"421 try later"}]}}`},
	}}
	ec := NewCommsEventConsumer(store, q, zerolog.Nop())
	n, err := ec.RunOnce(ctx)
	if err != nil || n != 6 {
		t.Fatalf("processed = %d, %v", n, err)
	}
	if len(q.deleted) != 6 {
		t.Fatalf("all messages must be deleted (incl. unmatched/garbage), got %d", len(q.deleted))
	}
	recs, _, _ := store.ListCampaignRecipients(ctx, c.ID, "", 10, 0)
	st := map[string]string{}
	byEmail := map[string]CampaignRecipient{}
	for _, r := range recs {
		st[r.Email] = r.Status
		byEmail[r.Email] = r
	}
	if st["d@x.com"] != "delivered" || st["b@x.com"] != "bounced" || st["c@x.com"] != "complained" {
		t.Fatalf("statuses = %v", st)
	}
	xRec := byEmail["x@x.com"]
	if xRec.Status != "sent" {
		t.Fatalf("x@x.com status = %q, want sent (transient bounce must not change status)", xRec.Status)
	}
	if !strings.HasPrefix(xRec.LastError, "bounce_transient:") {
		t.Fatalf("x@x.com last_error = %q, want prefix bounce_transient:", xRec.LastError)
	}
	if xRec.SentAt == nil || !xRec.SentAt.Before(time.Now().Add(-30*time.Minute)) {
		t.Fatalf("x@x.com sent_at = %v, must remain older than 30 minutes (transient bounce must not reset it)", xRec.SentAt)
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
	// I2: el freno arma a partir de 100 envíos (antes 1000: con el tope de 3
	// campañas/día una campaña chica podía quemar la reputación sin frenarse).
	// 6/100 = 6% > 5% ⇒ pausa.
	if _, err := pool.Exec(ctx, `UPDATE comms.campaign SET status='sending', sent_count=100, bounced_count=6 WHERE id=$1`, c.ID); err != nil {
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

	// Caso negativo: 4+1 = 5 rebotes sobre 100 envíos = 5%, NO supera el umbral.
	c2 := approvedCampaign(t, ctx, store, []string{"y@x.com"})
	if _, err := pool.Exec(ctx, `UPDATE comms.campaign SET status='sending', sent_count=100, bounced_count=4 WHERE id=$1`, c2.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE comms.campaign_recipient SET status='sent', ses_message_id='m-y' WHERE campaign_id=$1`, c2.ID); err != nil {
		t.Fatal(err)
	}
	matched, err = ec.ProcessBody(ctx, []byte(`{"eventType":"Bounce","mail":{"messageId":"m-y"},"bounce":{"bounceType":"Permanent"}}`))
	if err != nil || !matched {
		t.Fatalf("matched=%v err=%v", matched, err)
	}
	got2, _ := store.GetCampaign(ctx, c2.ID)
	if got2.Status != "sending" {
		t.Fatalf("5%% de rebotes no debe pausar; status = %q", got2.Status)
	}
}

// TestCommsEvents_KeepsMessageOnDBError_Integration: si el evento SÍ es de campaña
// (matched=true) pero falla al aplicarlo en DB, el mensaje NO debe borrarse (para
// que SQS lo redelivere). Forzamos el fallo renombrando comms.campaign: la búsqueda
// por ses_message_id y el UPDATE en campaign_recipient siguen funcionando, pero
// RefreshCampaignCounters (que hace UPDATE comms.campaign ...) falla porque la
// tabla ya no existe con ese nombre. Postgres conserva la FK por OID al renombrar,
// así que campaign_recipient sigue intacta.
func TestCommsEvents_KeepsMessageOnDBError_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	store := NewStore(pool)
	c := approvedCampaign(t, ctx, store, []string{"err@x.com"})
	if _, err := pool.Exec(ctx, `UPDATE comms.campaign_recipient SET status='sent', ses_message_id='m-err' WHERE campaign_id=$1 AND email='err@x.com'`, c.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `ALTER TABLE comms.campaign RENAME TO campaign_x`); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = pool.Exec(context.Background(), `ALTER TABLE comms.campaign_x RENAME TO campaign`)
	}()
	q := &fakeQueue{msgs: []QueueMessage{
		{ID: "1", ReceiptHandle: "r1", Body: `{"eventType":"Delivery","mail":{"messageId":"m-err"}}`},
	}}
	ec := NewCommsEventConsumer(store, q, zerolog.Nop())
	n, err := ec.RunOnce(ctx)
	if err != nil || n != 1 {
		t.Fatalf("processed = %d, %v", n, err)
	}
	if len(q.deleted) != 0 {
		t.Fatalf("message must NOT be deleted when the DB update fails, got %d deletes", len(q.deleted))
	}
}
