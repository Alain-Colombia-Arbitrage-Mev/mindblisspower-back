package payments

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/vicionpower/vp-engine/internal/comms"
)

var (
	ErrCampaignNotFound = errors.New("campaign_not_found")
	ErrCampaignState    = errors.New("campaign_invalid_state")
	ErrAudienceTooLarge = errors.New("audience_too_large")
	ErrDailyLimit       = errors.New("daily_campaign_limit")
	ErrTestSendLimit    = errors.New("test_send_limit")
)

type Campaign struct {
	ID                int64           `json:"id"`
	Subject           string          `json:"subject"`
	BodyMarkdown      string          `json:"body_markdown"`
	Segment           json.RawMessage `json:"segment"`
	Status            string          `json:"status"`
	ApprovalRequestID *int64          `json:"approval_request_id,omitempty"`
	CreatedBy         string          `json:"created_by"`
	ApprovedBy        string          `json:"approved_by,omitempty"`
	AudienceCount     *int            `json:"audience_count,omitempty"`
	TestSends         int             `json:"test_sends"`
	SentCount         int             `json:"sent_count"`
	DeliveredCount    int             `json:"delivered_count"`
	BouncedCount      int             `json:"bounced_count"`
	ComplainedCount   int             `json:"complained_count"`
	FailedCount       int             `json:"failed_count"`
	PauseReason       string          `json:"pause_reason,omitempty"`
	StartedAt         *time.Time      `json:"started_at,omitempty"`
	FinishedAt        *time.Time      `json:"finished_at,omitempty"`
	CreatedAt         time.Time       `json:"created_at"`
	UpdatedAt         time.Time       `json:"updated_at"`
}

type AudiencePreview struct {
	Eligible int `json:"eligible"`
	Excluded struct {
		Unsubscribed int `json:"unsubscribed"`
		Suppressed   int `json:"suppressed"`
		Blacklisted  int `json:"blacklisted"`
		Invalid      int `json:"invalid"`
	} `json:"excluded"`
}

type CampaignRecipient struct {
	PersonID     int64      `json:"person_id"`
	Email        string     `json:"email"`
	FirstName    string     `json:"first_name"`
	Status       string     `json:"status"`
	SESMessageID string     `json:"ses_message_id,omitempty"`
	Attempts     int        `json:"attempts"`
	LastError    string     `json:"last_error,omitempty"`
	SkipReason   string     `json:"skip_reason,omitempty"`
	SentAt       *time.Time `json:"sent_at,omitempty"`
}

const campaignCols = `id, subject, body_markdown, segment, status::text, approval_request_id, created_by::text,
	COALESCE(approved_by::text,''), audience_count, test_sends, sent_count, delivered_count, bounced_count,
	complained_count, failed_count, COALESCE(pause_reason,''), started_at, finished_at, created_at, updated_at`

func scanCampaign(row pgx.Row) (Campaign, error) {
	var c Campaign
	err := row.Scan(&c.ID, &c.Subject, &c.BodyMarkdown, &c.Segment, &c.Status, &c.ApprovalRequestID, &c.CreatedBy,
		&c.ApprovedBy, &c.AudienceCount, &c.TestSends, &c.SentCount, &c.DeliveredCount, &c.BouncedCount,
		&c.ComplainedCount, &c.FailedCount, &c.PauseReason, &c.StartedAt, &c.FinishedAt, &c.CreatedAt, &c.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Campaign{}, ErrCampaignNotFound
	}
	return c, err
}

func (s *Store) CreateCampaign(ctx context.Context, createdBy, subject, body string, seg comms.Segment) (Campaign, error) {
	segJSON, _ := json.Marshal(seg.Normalize())
	return scanCampaign(s.db.QueryRow(ctx, `INSERT INTO comms.campaign (subject, body_markdown, segment, created_by)
		VALUES ($1,$2,$3,$4) RETURNING `+campaignCols, subject, body, segJSON, createdBy))
}

func (s *Store) UpdateCampaignDraft(ctx context.Context, id int64, subject, body string, seg comms.Segment) (Campaign, error) {
	segJSON, _ := json.Marshal(seg.Normalize())
	c, err := scanCampaign(s.db.QueryRow(ctx, `UPDATE comms.campaign SET subject=$2, body_markdown=$3, segment=$4
		WHERE id=$1 AND status='draft' RETURNING `+campaignCols, id, subject, body, segJSON))
	if errors.Is(err, ErrCampaignNotFound) {
		if _, gerr := s.GetCampaign(ctx, id); gerr == nil {
			return Campaign{}, ErrCampaignState
		}
	}
	return c, err
}

func (s *Store) GetCampaign(ctx context.Context, id int64) (Campaign, error) {
	return scanCampaign(s.db.QueryRow(ctx, `SELECT `+campaignCols+` FROM comms.campaign WHERE id=$1`, id))
}

func (s *Store) ListCampaigns(ctx context.Context, status string, limit, offset int) ([]Campaign, int, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	var total int
	if err := s.reader().QueryRow(ctx, `SELECT count(*) FROM comms.campaign WHERE $1='' OR status::text=$1`, status).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.reader().Query(ctx, `SELECT `+campaignCols+` FROM comms.campaign
		WHERE $1='' OR status::text=$1 ORDER BY id DESC LIMIT $2 OFFSET $3`, status, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []Campaign{}
	for rows.Next() {
		c, err := scanCampaign(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, c)
	}
	return out, total, rows.Err()
}

func (s *Store) PreviewAudience(ctx context.Context, seg comms.Segment) (AudiencePreview, error) {
	var p AudiencePreview
	sql, args := comms.AudienceQuery(seg)
	if err := s.reader().QueryRow(ctx, `SELECT count(*) FROM (`+sql+`) q`, args...).Scan(&p.Eligible); err != nil {
		return p, fmt.Errorf("audience count: %w", err)
	}
	sql, args = comms.ExclusionCountsQuery(seg)
	if err := s.reader().QueryRow(ctx, sql, args...).Scan(&p.Excluded.Unsubscribed, &p.Excluded.Suppressed, &p.Excluded.Blacklisted, &p.Excluded.Invalid); err != nil {
		return p, fmt.Errorf("exclusion counts: %w", err)
	}
	return p, nil
}

func (s *Store) SetCampaignStatus(ctx context.Context, id int64, from []string, to, reason string) error {
	tag, err := s.db.Exec(ctx, `UPDATE comms.campaign
		SET status=$3::comms.campaign_status,
		    pause_reason = CASE WHEN $3='paused' THEN NULLIF($4,'') ELSE NULL END,
		    finished_at = CASE WHEN $3 IN ('done','cancelled','rejected') THEN now() ELSE finished_at END
		WHERE id=$1 AND status::text = ANY($2::text[])`, id, from, to, reason)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		if _, gerr := s.GetCampaign(ctx, id); gerr != nil {
			return gerr
		}
		return ErrCampaignState
	}
	return nil
}

// EnqueueAudience resuelve el segmento e inserta los destinatarios en 'queued'.
// Idempotente: ON CONFLICT DO NOTHING. Devuelve el total encolado.
func (s *Store) EnqueueAudience(ctx context.Context, id int64, seg comms.Segment, maxAudience int) (int, error) {
	sql, args := comms.AudienceQuery(seg)
	var n int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM (`+sql+`) q`, args...).Scan(&n); err != nil {
		return 0, err
	}
	if maxAudience > 0 && n > maxAudience {
		return n, ErrAudienceTooLarge
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	insArgs := append([]any{id}, args...)
	// los $ del subquery se desplazan +1 porque $1 es campaign_id
	shifted := shiftParams(sql, 1)
	if _, err := tx.Exec(ctx, `INSERT INTO comms.campaign_recipient (campaign_id, person_id, email, first_name)
		SELECT $1, q.id, q.email, q.first_name FROM (`+shifted+`) q ON CONFLICT DO NOTHING`, insArgs...); err != nil {
		return 0, fmt.Errorf("enqueue: %w", err)
	}
	var total int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM comms.campaign_recipient WHERE campaign_id=$1`, id).Scan(&total); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `UPDATE comms.campaign SET audience_count=$2 WHERE id=$1`, id, total); err != nil {
		return 0, err
	}
	return total, tx.Commit(ctx)
}

// shiftParams renumera $1..$n → $(1+by)..$(n+by). Los placeholders del
// AudienceQuery son $1..$5 y no aparecen otros dígitos tras '$'.
func shiftParams(sql string, by int) string {
	out := make([]byte, 0, len(sql)+8)
	for i := 0; i < len(sql); i++ {
		if sql[i] == '$' && i+1 < len(sql) && sql[i+1] >= '1' && sql[i+1] <= '9' {
			out = append(out, '$', byte('0'+int(sql[i+1]-'0')+by))
			i++
			continue
		}
		out = append(out, sql[i])
	}
	return string(out)
}

func (s *Store) CountCampaignsApprovedToday(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRow(ctx, `SELECT count(*) FROM comms.campaign
		WHERE status IN ('approved','sending','paused','done')
		  AND COALESCE(started_at, updated_at) >= date_trunc('day', now())`).Scan(&n)
	return n, err
}

func (s *Store) IncrementTestSends(ctx context.Context, id int64, max int) error {
	tag, err := s.db.Exec(ctx, `UPDATE comms.campaign SET test_sends = test_sends + 1 WHERE id=$1 AND test_sends < $2`, id, max)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrTestSendLimit
	}
	return nil
}

func (s *Store) ListCampaignRecipients(ctx context.Context, id int64, status string, limit, offset int) ([]CampaignRecipient, int, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	var total int
	if err := s.reader().QueryRow(ctx, `SELECT count(*) FROM comms.campaign_recipient WHERE campaign_id=$1 AND ($2='' OR status::text=$2)`, id, status).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.reader().Query(ctx, `SELECT person_id, email::text, first_name, status::text, COALESCE(ses_message_id,''), attempts,
		COALESCE(last_error,''), COALESCE(skip_reason,''), sent_at
		FROM comms.campaign_recipient WHERE campaign_id=$1 AND ($2='' OR status::text=$2)
		ORDER BY person_id LIMIT $3 OFFSET $4`, id, status, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []CampaignRecipient{}
	for rows.Next() {
		var r CampaignRecipient
		if err := rows.Scan(&r.PersonID, &r.Email, &r.FirstName, &r.Status, &r.SESMessageID, &r.Attempts, &r.LastError, &r.SkipReason, &r.SentAt); err != nil {
			return nil, 0, err
		}
		out = append(out, r)
	}
	return out, total, rows.Err()
}

func (s *Store) RecipientByMessageID(ctx context.Context, msgID string) (int64, int64, string, bool, error) {
	var cid, pid int64
	var email string
	err := s.db.QueryRow(ctx, `SELECT campaign_id, person_id, email::text FROM comms.campaign_recipient WHERE ses_message_id=$1`, msgID).Scan(&cid, &pid, &email)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, 0, "", false, nil
	}
	return cid, pid, email, err == nil, err
}

func (s *Store) MarkRecipient(ctx context.Context, campaignID, personID int64, status, lastError string) error {
	_, err := s.db.Exec(ctx, `UPDATE comms.campaign_recipient
		SET status=$3::comms.recipient_status, last_error=NULLIF($4,''),
		    sent_at = CASE WHEN $3='sent' THEN now() ELSE sent_at END
		WHERE campaign_id=$1 AND person_id=$2`, campaignID, personID, status, lastError)
	return err
}

func (s *Store) AddUnsubscribe(ctx context.Context, email string, personID *int64, source string) error {
	_, err := s.db.Exec(ctx, `INSERT INTO comms.unsubscribe (email, person_id, source) VALUES ($1,$2,$3) ON CONFLICT (email) DO NOTHING`, email, personID, source)
	return err
}

func (s *Store) AddSuppressed(ctx context.Context, email, reason string) error {
	_, err := s.db.Exec(ctx, `INSERT INTO comms.suppressed_email (email, reason) VALUES ($1,$2) ON CONFLICT (email) DO NOTHING`, email, reason)
	return err
}

func (s *Store) RefreshCampaignCounters(ctx context.Context, id int64) error {
	_, err := s.db.Exec(ctx, `UPDATE comms.campaign c SET
		sent_count       = (SELECT count(*) FROM comms.campaign_recipient r WHERE r.campaign_id=c.id AND r.status IN ('sent','delivered','bounced','complained')),
		delivered_count  = (SELECT count(*) FROM comms.campaign_recipient r WHERE r.campaign_id=c.id AND r.status='delivered'),
		bounced_count    = (SELECT count(*) FROM comms.campaign_recipient r WHERE r.campaign_id=c.id AND r.status='bounced'),
		complained_count = (SELECT count(*) FROM comms.campaign_recipient r WHERE r.campaign_id=c.id AND r.status='complained'),
		failed_count     = (SELECT count(*) FROM comms.campaign_recipient r WHERE r.campaign_id=c.id AND r.status='failed')
		WHERE c.id=$1`, id)
	return err
}
