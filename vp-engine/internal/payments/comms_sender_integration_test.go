package payments

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"github.com/vicionpower/vp-engine/internal/comms"
)

type fakeAPIErr struct {
	code   string
	status int
}

func (e fakeAPIErr) Error() string       { return e.code }
func (e fakeAPIErr) ErrorCode() string   { return e.code }
func (e fakeAPIErr) HTTPStatusCode() int { return e.status }

type fakeEmailSender struct {
	mu    sync.Mutex
	sent  []HTMLEmail
	fails map[string]error // por email: error a devolver (una vez)
	n     int
}

func (f *fakeEmailSender) SendHTMLEmail(_ context.Context, m HTMLEmail) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err, ok := f.fails[m.To]; ok {
		delete(f.fails, m.To)
		return "", err
	}
	f.n++
	f.sent = append(f.sent, m)
	return "msg-" + m.To, nil
}

func approvedCampaign(t *testing.T, ctx context.Context, store *Store, emails []string) Campaign {
	t.Helper()
	for _, e := range emails {
		if _, err := store.db.Exec(ctx, `INSERT INTO mlm.person (first_name,last_name,email,phone_number,status)
			VALUES ('Ana','B',$1,'3000000000','active') ON CONFLICT DO NOTHING`, e); err != nil {
			t.Fatal(err)
		}
	}
	// Segmento acotado a los emails recién creados: un segmento vacío ({}) matchea
	// TODA persona activa de la DB (ver comms.AudienceQuery), lo que contaminaría la
	// audiencia con destinatarios de campañas previas dentro del mismo test/container.
	seg := comms.Segment{Emails: emails}
	c, err := store.CreateCampaign(ctx, "admin@x.com", "Asunto largo", "Hola **equipo**", seg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.EnqueueAudience(ctx, c.ID, seg, 0); err != nil {
		t.Fatal(err)
	}
	if err := store.SetCampaignStatus(ctx, c.ID, []string{"draft"}, "approved", ""); err != nil {
		t.Fatal(err)
	}
	return c
}

func newTestSender(store *Store, f *fakeEmailSender) *CommsSender {
	return NewCommsSender(store, f, CommsSenderConfig{
		RatePerSec: 1000, BatchSize: 2, SESConfigSet: "entregas",
		UnsubscribeSecret: []byte("s"), UnsubscribeBase: "https://app.test/baja",
		ReplyTo: "soporte@x.com", UnsubscribeTTL: time.Hour,
	}, zerolog.Nop())
}

func TestCommsSender_SendsAllAndFinishes_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	store := NewStore(pool)
	c := approvedCampaign(t, ctx, store, []string{"a@x.com", "b@x.com", "c@x.com"})
	f := &fakeEmailSender{}
	cs := newTestSender(store, f)

	total := 0
	for i := 0; i < 5; i++ {
		n, err := cs.RunOnce(ctx)
		if err != nil {
			t.Fatal(err)
		}
		total += n
		if n == 0 {
			break
		}
	}
	if total != 3 || len(f.sent) != 3 {
		t.Fatalf("sent = %d / %d", total, len(f.sent))
	}
	got, _ := store.GetCampaign(ctx, c.ID)
	if got.Status != "done" || got.SentCount != 3 || got.FinishedAt == nil {
		t.Fatalf("campaign = %+v", got)
	}
	m := f.sent[0]
	if m.ConfigSet != "entregas" || m.ReplyTo != "soporte@x.com" || m.UnsubscribeURL == "" || m.Subject != "Asunto largo" {
		t.Fatalf("mail = %+v", m)
	}
	if !strings.Contains(m.UnsubscribeURL, "/api/comms/unsubscribe?t=") {
		t.Fatalf("List-Unsubscribe header URL should point to the one-click endpoint, got %q", m.UnsubscribeURL)
	}
	recs, _, _ := store.ListCampaignRecipients(ctx, c.ID, "sent", 10, 0)
	if len(recs) != 3 || recs[0].SESMessageID == "" {
		t.Fatalf("recipients = %+v", recs)
	}
}

func TestCommsSender_RetryTransientFailPermanentPauseOnDenied_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	store := NewStore(pool)
	c := approvedCampaign(t, ctx, store, []string{"t@x.com", "p@x.com"})
	f := &fakeEmailSender{fails: map[string]error{
		"t@x.com": fakeAPIErr{"TooManyRequestsException", 429},
		"p@x.com": fakeAPIErr{"BadRequestException", 400},
	}}
	cs := newTestSender(store, f)
	if _, err := cs.RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	recs, _, _ := store.ListCampaignRecipients(ctx, c.ID, "", 10, 0)
	byEmail := map[string]CampaignRecipient{}
	for _, r := range recs {
		byEmail[r.Email] = r
	}
	if byEmail["t@x.com"].Status != "queued" || byEmail["t@x.com"].Attempts != 1 {
		t.Fatalf("transient = %+v", byEmail["t@x.com"])
	}
	if byEmail["p@x.com"].Status != "failed" {
		t.Fatalf("permanent = %+v", byEmail["p@x.com"])
	}
	// el reintento aún no vence (next_attempt_at en 1 min) ⇒ RunOnce no envía nada
	if n, _ := cs.RunOnce(ctx); n != 0 {
		t.Fatalf("should wait for backoff, sent %d", n)
	}
	if _, err := pool.Exec(ctx, `UPDATE comms.campaign_recipient SET next_attempt_at = now() - interval '1s' WHERE campaign_id=$1`, c.ID); err != nil {
		t.Fatal(err)
	}
	if n, _ := cs.RunOnce(ctx); n != 1 {
		t.Fatalf("retry should send 1, sent %d", n)
	}

	// AccessDenied pausa la campaña
	c2 := approvedCampaign(t, ctx, store, []string{"d@x.com"})
	f2 := &fakeEmailSender{fails: map[string]error{"d@x.com": fakeAPIErr{"AccessDeniedException", 403}}}
	cs2 := newTestSender(store, f2)
	_, _ = cs2.RunOnce(ctx)
	got, _ := store.GetCampaign(ctx, c2.ID)
	if got.Status != "paused" || got.PauseReason == "" {
		t.Fatalf("expected paused, got %+v", got)
	}
}

func TestCommsSender_StaleSendingIsFailedNotResent_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	store := NewStore(pool)
	c := approvedCampaign(t, ctx, store, []string{"s@x.com"})
	// comms.campaign_recipient_touch (BEFORE UPDATE) fuerza updated_at=now() en cada
	// UPDATE, así que backdatear directamente no alcanza; se desactiva el trigger
	// solo para esta transacción (SET LOCAL) para simular una fila realmente atascada.
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SET LOCAL session_replication_role = replica`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE comms.campaign_recipient SET status='sending', updated_at = now() - interval '20 min' WHERE campaign_id=$1`, c.ID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	f := &fakeEmailSender{}
	cs := newTestSender(store, f)
	_, _ = cs.RunOnce(ctx)
	_, _ = cs.RunOnce(ctx)
	if len(f.sent) != 0 {
		t.Fatal("stale row must not be resent")
	}
	recs, _, _ := store.ListCampaignRecipients(ctx, c.ID, "failed", 10, 0)
	if len(recs) != 1 || recs[0].LastError != "stale" {
		t.Fatalf("recs = %+v", recs)
	}
}

func TestCommsSender_SendTest_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	store := NewStore(pool)
	seg, _ := comms.ParseSegment([]byte(`{}`))
	c, _ := store.CreateCampaign(ctx, "admin@x.com", "Asunto largo", "Cuerpo de prueba largo", seg)
	f := &fakeEmailSender{}
	cs := newTestSender(store, f)
	if err := cs.SendTest(ctx, c, "admin@x.com"); err != nil {
		t.Fatal(err)
	}
	if len(f.sent) != 1 || f.sent[0].Subject != "[PRUEBA] Asunto largo" || f.sent[0].To != "admin@x.com" {
		t.Fatalf("test mail = %+v", f.sent)
	}
}
