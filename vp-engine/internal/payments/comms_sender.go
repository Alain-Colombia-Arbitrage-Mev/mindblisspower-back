package payments

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog"
	"github.com/vicionpower/vp-engine/internal/comms"
)

type CommsSenderConfig struct {
	RatePerSec        int
	BatchSize         int
	SESConfigSet      string
	UnsubscribeSecret []byte
	UnsubscribeBase   string
	ReplyTo           string
	UnsubscribeTTL    time.Duration
}

type CommsSender struct {
	store *Store
	email EmailSender
	cfg   CommsSenderConfig
	log   zerolog.Logger
}

func NewCommsSender(store *Store, email EmailSender, cfg CommsSenderConfig, log zerolog.Logger) *CommsSender {
	if cfg.RatePerSec <= 0 {
		cfg.RatePerSec = 10
	}
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = 100
	}
	if cfg.UnsubscribeTTL <= 0 {
		cfg.UnsubscribeTTL = 180 * 24 * time.Hour
	}
	return &CommsSender{store: store, email: email, cfg: cfg, log: log}
}

func (cs *CommsSender) Loop(ctx context.Context) {
	cs.log.Info().Int("rate", cs.cfg.RatePerSec).Int("batch", cs.cfg.BatchSize).Msg("comms sender started")
	for {
		n, err := cs.RunOnce(ctx)
		if err != nil {
			cs.log.Error().Err(err).Msg("comms sender RunOnce failed (non-fatal)")
		}
		wait := time.Second
		if n == 0 {
			wait = 5 * time.Second
		}
		select {
		case <-ctx.Done():
			cs.log.Info().Msg("comms sender stopped")
			return
		case <-time.After(wait):
		}
	}
}

// RunOnce: 1) filas 'sending' atascadas → failed(stale); 2) toma la campaña
// activa (sending, o approved más antigua); 3) envía un lote respetando el ritmo;
// 4) cierra la campaña si no queda trabajo.
func (cs *CommsSender) RunOnce(ctx context.Context) (int, error) {
	if _, err := cs.store.db.Exec(ctx, `UPDATE comms.campaign_recipient SET status='failed', last_error='stale'
		WHERE status='sending' AND updated_at < now() - interval '10 minutes'`); err != nil {
		return 0, fmt.Errorf("stale sweep: %w", err)
	}
	var id int64
	err := cs.store.db.QueryRow(ctx, `UPDATE comms.campaign SET status='sending', started_at=COALESCE(started_at, now())
		WHERE id = (SELECT id FROM comms.campaign WHERE status IN ('sending','approved')
		            ORDER BY (status='sending') DESC, id LIMIT 1 FOR UPDATE SKIP LOCKED)
		RETURNING id`).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil
		}
		return 0, fmt.Errorf("claim campaign: %w", err)
	}
	c, err := cs.store.GetCampaign(ctx, id)
	if err != nil {
		return 0, err
	}
	rows, err := cs.store.db.Query(ctx, `SELECT person_id, email::text, first_name FROM comms.campaign_recipient
		WHERE campaign_id=$1 AND status='queued' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
		ORDER BY person_id LIMIT $2`, id, cs.cfg.BatchSize)
	if err != nil {
		return 0, err
	}
	type rec struct {
		pid   int64
		email string
		name  string
	}
	batch := []rec{}
	for rows.Next() {
		var r rec
		if err := rows.Scan(&r.pid, &r.email, &r.name); err != nil {
			rows.Close()
			return 0, err
		}
		batch = append(batch, r)
	}
	rows.Close()
	if len(batch) == 0 {
		return 0, cs.maybeFinish(ctx, id)
	}
	interval := time.Second / time.Duration(cs.cfg.RatePerSec)
	sent := 0
	for _, r := range batch {
		// re-chequear pausa/cancelación entre envíos
		var st string
		if err := cs.store.db.QueryRow(ctx, `SELECT status::text FROM comms.campaign WHERE id=$1`, id).Scan(&st); err != nil || st != "sending" {
			return sent, err
		}
		tag, err := cs.store.db.Exec(ctx, `UPDATE comms.campaign_recipient SET status='sending', attempts=attempts+1
			WHERE campaign_id=$1 AND person_id=$2 AND status='queued'`, id, r.pid)
		if err != nil || tag.RowsAffected() == 0 {
			continue
		}
		tok := comms.SignUnsubscribe(cs.cfg.UnsubscribeSecret, r.pid, time.Now().Add(cs.cfg.UnsubscribeTTL))
		// El pie visible del correo usa la página de baja; la cabecera List-Unsubscribe
		// (One-Click, RFC 8058) usa el endpoint API separado.
		footerURL := comms.UnsubscribeURL(cs.cfg.UnsubscribeBase, tok)
		headerURL := comms.UnsubscribeURL(strings.Replace(cs.cfg.UnsubscribeBase, "/baja", "/api/comms/unsubscribe", 1), tok)
		rendered, err := comms.Render(comms.RenderInput{Subject: c.Subject, BodyMarkdown: c.BodyMarkdown, FirstName: r.name,
			UnsubscribeURL: footerURL})
		if err != nil {
			_ = cs.store.MarkRecipient(ctx, id, r.pid, "failed", "render: "+err.Error())
			continue
		}
		sendCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		msgID, err := cs.email.SendHTMLEmail(sendCtx, HTMLEmail{To: r.email, Subject: rendered.Subject, HTML: rendered.HTML, Text: rendered.Text,
			ReplyTo: cs.cfg.ReplyTo, ConfigSet: cs.cfg.SESConfigSet, UnsubscribeURL: headerURL})
		cancel()
		switch {
		case err == nil:
			_, _ = cs.store.db.Exec(ctx, `UPDATE comms.campaign_recipient SET status='sent', ses_message_id=$3, sent_at=now(), last_error=NULL
				WHERE campaign_id=$1 AND person_id=$2`, id, r.pid, msgID)
			sent++
		case isAccessDenied(err):
			_, _ = cs.store.db.Exec(ctx, `UPDATE comms.campaign_recipient SET status='queued', attempts=attempts-1 WHERE campaign_id=$1 AND person_id=$2`, id, r.pid)
			_ = cs.store.SetCampaignStatus(ctx, id, []string{"sending"}, "paused", "ses_access_denied: "+err.Error())
			// cs.store.cache puede ser nil (tests): PublishEvent es no-op con receptor nil (cache.go).
			cs.store.cache.PublishEvent(ctx, "comms.campaign_paused", map[string]any{"campaign_id": id, "reason": "ses_access_denied"})
			cs.log.Error().Err(err).Int64("campaign", id).Msg("comms: SES access denied, campaign paused")
			return sent, nil
		case comms.IsTransientSESError(err):
			var attempts int
			_ = cs.store.db.QueryRow(ctx, `SELECT attempts FROM comms.campaign_recipient WHERE campaign_id=$1 AND person_id=$2`, id, r.pid).Scan(&attempts)
			if d := comms.RetryDelay(attempts); d > 0 && attempts <= comms.MaxAttempts {
				_, _ = cs.store.db.Exec(ctx, `UPDATE comms.campaign_recipient SET status='queued', next_attempt_at=now()+$3::interval, last_error=$4
					WHERE campaign_id=$1 AND person_id=$2`, id, r.pid, d.String(), truncErr(err))
			} else {
				_ = cs.store.MarkRecipient(ctx, id, r.pid, "failed", truncErr(err))
			}
		default:
			_ = cs.store.MarkRecipient(ctx, id, r.pid, "failed", truncErr(err))
		}
		select {
		case <-ctx.Done():
			return sent, ctx.Err()
		case <-time.After(interval):
		}
	}
	if err := cs.store.RefreshCampaignCounters(ctx, id); err != nil {
		return sent, err
	}
	return sent, cs.maybeFinish(ctx, id)
}

func (cs *CommsSender) maybeFinish(ctx context.Context, id int64) error {
	var pending int
	if err := cs.store.db.QueryRow(ctx, `SELECT count(*) FROM comms.campaign_recipient WHERE campaign_id=$1 AND status IN ('queued','sending')`, id).Scan(&pending); err != nil {
		return err
	}
	if pending > 0 {
		return nil
	}
	if err := cs.store.RefreshCampaignCounters(ctx, id); err != nil {
		return err
	}
	if err := cs.store.SetCampaignStatus(ctx, id, []string{"sending"}, "done", ""); err != nil && !errors.Is(err, ErrCampaignState) {
		return err
	}
	cs.log.Info().Int64("campaign", id).Msg("comms: campaign done")
	return nil
}

// SendTest envía la campaña renderizada al email del admin, sin tocar recipients.
func (cs *CommsSender) SendTest(ctx context.Context, c Campaign, toEmail string) error {
	tok := comms.SignUnsubscribe(cs.cfg.UnsubscribeSecret, 0+1, time.Now().Add(time.Hour)) // person 1 = placeholder; la baja de prueba no aplica
	url := comms.UnsubscribeURL(cs.cfg.UnsubscribeBase, tok)
	rendered, err := comms.Render(comms.RenderInput{Subject: c.Subject, BodyMarkdown: c.BodyMarkdown, FirstName: "", UnsubscribeURL: url})
	if err != nil {
		return err
	}
	_, err = cs.email.SendHTMLEmail(ctx, HTMLEmail{To: toEmail, Subject: "[PRUEBA] " + rendered.Subject, HTML: rendered.HTML, Text: rendered.Text,
		ReplyTo: cs.cfg.ReplyTo, ConfigSet: cs.cfg.SESConfigSet})
	return err
}

func isAccessDenied(err error) bool {
	var c interface{ ErrorCode() string }
	return errors.As(err, &c) && c.ErrorCode() == "AccessDeniedException"
}

func truncErr(err error) string {
	s := err.Error()
	if len(s) > 300 {
		return s[:300]
	}
	return s
}
