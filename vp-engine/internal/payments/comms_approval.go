package payments

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/vicionpower/vp-engine/internal/comms"
)

var (
	ErrSameApprover       = errors.New("same_approver")
	ErrAdminPersonMissing = errors.New("admin_person_missing")
)

func (s *Store) personIDByEmail(ctx context.Context, email string) (int64, error) {
	var id int64
	err := s.db.QueryRow(ctx, `SELECT id FROM mlm.person WHERE email = $1 LIMIT 1`, strings.ToLower(strings.TrimSpace(email))).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrAdminPersonMissing
	}
	return id, err
}

// SubmitCampaign: draft → pending_approval, creando la approval_request.
func (s *Store) SubmitCampaign(ctx context.Context, id int64, adminEmail, reason string) (Campaign, error) {
	reason = strings.TrimSpace(reason)
	if len(reason) < 10 {
		return Campaign{}, fmt.Errorf("reason_too_short")
	}
	c, err := s.GetCampaign(ctx, id)
	if err != nil {
		return Campaign{}, err
	}
	if c.Status != "draft" {
		return Campaign{}, ErrCampaignState
	}
	initiator, err := s.personIDByEmail(ctx, adminEmail)
	if err != nil {
		return Campaign{}, err
	}
	seg, err := comms.ParseSegment(c.Segment)
	if err != nil {
		return Campaign{}, err
	}
	prev, err := s.PreviewAudience(ctx, seg)
	if err != nil {
		return Campaign{}, err
	}
	payload, _ := json.Marshal(map[string]any{
		"campaign_id": c.ID, "subject": c.Subject, "audience_count": prev.Eligible, "segment": json.RawMessage(c.Segment),
	})
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Campaign{}, err
	}
	defer tx.Rollback(ctx)
	var arID int64
	if err := tx.QueryRow(ctx, `INSERT INTO mlm.approval_request
		(operation_type, payload, requires_n_approvers, initiator_person_id, initiator_reason)
		VALUES ('comms_campaign', $1, 1, $2, $3) RETURNING id`, payload, initiator, reason).Scan(&arID); err != nil {
		return Campaign{}, fmt.Errorf("approval_request: %w", err)
	}
	tag, err := tx.Exec(ctx, `UPDATE comms.campaign SET status='pending_approval', approval_request_id=$2, audience_count=$3
		WHERE id=$1 AND status='draft'`, id, arID, prev.Eligible)
	if err != nil {
		return Campaign{}, err
	}
	if tag.RowsAffected() == 0 {
		return Campaign{}, ErrCampaignState
	}
	if err := tx.Commit(ctx); err != nil {
		return Campaign{}, err
	}
	return s.GetCampaign(ctx, id)
}

// DecideCampaign: approve|reject por un super_admin distinto del creador.
// approve encola la audiencia (recalculada) y valida límites.
func (s *Store) DecideCampaign(ctx context.Context, id int64, superEmail, decision, reason string, maxAudience, maxPerDay int) (Campaign, error) {
	decision = strings.ToLower(strings.TrimSpace(decision))
	if decision != "approve" && decision != "reject" {
		return Campaign{}, fmt.Errorf("decision_invalid")
	}
	c, err := s.GetCampaign(ctx, id)
	if err != nil {
		return Campaign{}, err
	}
	if c.Status != "pending_approval" || c.ApprovalRequestID == nil {
		return Campaign{}, ErrCampaignState
	}
	if strings.EqualFold(c.CreatedBy, superEmail) {
		return Campaign{}, ErrSameApprover
	}
	approver, err := s.personIDByEmail(ctx, superEmail)
	if err != nil {
		return Campaign{}, err
	}
	arStatus, cStatus := "approved", "approved"
	if decision == "reject" {
		arStatus, cStatus = "rejected", "rejected"
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Campaign{}, err
	}
	defer tx.Rollback(ctx)

	if decision == "approve" {
		if maxPerDay > 0 {
			n, err := s.CountCampaignsApprovedToday(ctx)
			if err != nil {
				return Campaign{}, err
			}
			if n >= maxPerDay {
				return Campaign{}, ErrDailyLimit
			}
		}
		seg, err := comms.ParseSegment(c.Segment)
		if err != nil {
			return Campaign{}, err
		}
		if _, err := s.enqueueAudienceTx(ctx, tx, id, seg, maxAudience); err != nil {
			return Campaign{}, err
		}
	}

	tag, err := tx.Exec(ctx, `UPDATE mlm.approval_request
		SET approver_1_person_id=$2, approver_1_decision=$3, approver_1_reason=$4, approver_1_at=now(), status=$5::mlm.approval_status
		WHERE id=$1 AND status='pending'`, *c.ApprovalRequestID, approver, decision, reason, arStatus)
	if err != nil {
		return Campaign{}, fmt.Errorf("approval decide: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return Campaign{}, ErrCampaignState
	}

	tag2, err := tx.Exec(ctx, `UPDATE comms.campaign SET status=$2::comms.campaign_status, approved_by=$3,
		finished_at = CASE WHEN $2='rejected' THEN now() ELSE NULL END
		WHERE id=$1 AND status='pending_approval'`, id, cStatus, strings.ToLower(superEmail))
	if err != nil {
		return Campaign{}, err
	}
	if tag2.RowsAffected() == 0 {
		return Campaign{}, ErrCampaignState
	}

	if err := tx.Commit(ctx); err != nil {
		return Campaign{}, err
	}
	return s.GetCampaign(ctx, id)
}
