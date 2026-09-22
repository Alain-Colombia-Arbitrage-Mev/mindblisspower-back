package payments

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/vicionpower/vp-engine/internal/comms"
)

// SetComms inyecta el sender de campañas y los límites operativos. Sin esta
// llamada (sender nil), commsReady responde 503 comms_disabled en todos los
// endpoints /api/admin/comms/* y /api/comms/unsubscribe.
func (h *Handler) SetComms(sender *CommsSender, maxAudience, maxPerDay, maxTestSends int, unsubSecret []byte) {
	h.comms.sender = sender
	h.comms.maxAudience = maxAudience
	h.comms.maxPerDay = maxPerDay
	h.comms.maxTestSends = maxTestSends
	h.comms.unsubSecret = unsubSecret
}

func (h *Handler) commsReady(w http.ResponseWriter) bool {
	if h.comms.sender == nil {
		writeErr(w, http.StatusServiceUnavailable, "comms_disabled")
		return false
	}
	return true
}

func writeCommsErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrCampaignNotFound):
		writeErr(w, http.StatusNotFound, "campaign_not_found")
	case errors.Is(err, ErrCampaignState):
		writeErr(w, http.StatusConflict, "campaign_invalid_state")
	case errors.Is(err, ErrSameApprover):
		writeErr(w, http.StatusForbidden, "same_approver")
	case errors.Is(err, ErrAudienceTooLarge):
		writeErr(w, http.StatusUnprocessableEntity, "audience_too_large")
	case errors.Is(err, ErrDailyLimit):
		writeErr(w, http.StatusTooManyRequests, "daily_campaign_limit")
	case errors.Is(err, ErrTestSendLimit):
		writeErr(w, http.StatusTooManyRequests, "test_send_limit")
	case errors.Is(err, ErrAdminPersonMissing):
		writeErr(w, http.StatusUnprocessableEntity, "admin_person_missing")
	case err != nil && (err.Error() == "reason_too_short" || err.Error() == "decision_invalid"):
		writeErr(w, http.StatusBadRequest, err.Error())
	case err != nil && strings.HasPrefix(err.Error(), "segment "):
		writeErr(w, http.StatusBadRequest, "segment_invalid")
	default:
		writeErr(w, http.StatusInternalServerError, "internal")
	}
}

type campaignBody struct {
	ID           int64           `json:"id"`
	Subject      string          `json:"subject"`
	BodyMarkdown string          `json:"body_markdown"`
	Segment      json.RawMessage `json:"segment"`
	Reason       string          `json:"reason"`
	Decision     string          `json:"decision"`
	Action       string          `json:"action"`
	Token        string          `json:"token"`
}

func readCampaignBody(w http.ResponseWriter, r *http.Request) (campaignBody, bool) {
	var b campaignBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&b); err != nil {
		return b, false
	}
	b.Subject = strings.TrimSpace(b.Subject)
	b.BodyMarkdown = strings.TrimSpace(b.BodyMarkdown)
	return b, true
}

func validCampaignText(subject, body string) bool {
	return len(subject) >= 3 && len(subject) <= 150 && len(body) >= 10 && len(body) <= 20000
}

// GET (lista) / POST (crear) /api/admin/comms/campaigns
func (h *Handler) handleCommsCampaigns(w http.ResponseWriter, r *http.Request) {
	adminEmail, ok := h.requireAdmin(w, r)
	if !ok || !h.commsReady(w) {
		return
	}
	switch r.Method {
	case http.MethodGet:
		q := r.URL.Query()
		limit, _ := strconv.Atoi(q.Get("limit"))
		offset, _ := strconv.Atoi(q.Get("offset"))
		items, total, err := h.store.ListCampaigns(r.Context(), q.Get("status"), limit, offset)
		if err != nil {
			h.log.Error().Err(err).Msg("comms list")
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": items, "total": total})
	case http.MethodPost:
		b, ok := readCampaignBody(w, r)
		if !ok || !validCampaignText(b.Subject, b.BodyMarkdown) {
			writeErr(w, http.StatusBadRequest, "subject_body_invalid")
			return
		}
		seg, err := comms.ParseSegment(b.Segment)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "segment_invalid")
			return
		}
		c, err := h.store.CreateCampaign(r.Context(), adminEmail, b.Subject, b.BodyMarkdown, seg)
		if err != nil {
			writeCommsErr(w, err)
			return
		}
		h.store.cache.PublishEvent(r.Context(), "comms.campaign_created", map[string]any{"campaign_id": c.ID, "by": adminEmail})
		writeJSON(w, http.StatusCreated, c)
	default:
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
	}
}

// GET ?id= / PUT {id,...} /api/admin/comms/campaign
func (h *Handler) handleCommsCampaign(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok || !h.commsReady(w) {
		return
	}
	switch r.Method {
	case http.MethodGet:
		id, _ := strconv.ParseInt(r.URL.Query().Get("id"), 10, 64)
		c, err := h.store.GetCampaign(r.Context(), id)
		if err != nil {
			writeCommsErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, c)
	case http.MethodPut:
		b, ok := readCampaignBody(w, r)
		if !ok || b.ID == 0 || !validCampaignText(b.Subject, b.BodyMarkdown) {
			writeErr(w, http.StatusBadRequest, "subject_body_invalid")
			return
		}
		seg, err := comms.ParseSegment(b.Segment)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "segment_invalid")
			return
		}
		c, err := h.store.UpdateCampaignDraft(r.Context(), b.ID, b.Subject, b.BodyMarkdown, seg)
		if err != nil {
			writeCommsErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, c)
	default:
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
	}
}

// POST /api/admin/comms/campaign/preview — {id} o {subject, body_markdown, segment}
func (h *Handler) handleCommsPreview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if _, ok := h.requireAdmin(w, r); !ok || !h.commsReady(w) {
		return
	}
	b, ok := readCampaignBody(w, r)
	if !ok {
		writeErr(w, http.StatusBadRequest, "bad_json")
		return
	}
	subject, body, segRaw := b.Subject, b.BodyMarkdown, b.Segment
	if b.ID != 0 {
		c, err := h.store.GetCampaign(r.Context(), b.ID)
		if err != nil {
			writeCommsErr(w, err)
			return
		}
		subject, body, segRaw = c.Subject, c.BodyMarkdown, c.Segment
	}
	seg, err := comms.ParseSegment(segRaw)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "segment_invalid")
		return
	}
	prev, err := h.store.PreviewAudience(r.Context(), seg)
	if err != nil {
		h.log.Error().Err(err).Msg("comms preview")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	rendered, err := comms.Render(comms.RenderInput{Subject: subject, BodyMarkdown: body, FirstName: "Nombre",
		UnsubscribeURL: comms.UnsubscribeURL(h.comms.sender.cfg.UnsubscribeBase, "preview")})
	if err != nil {
		writeErr(w, http.StatusBadRequest, "render_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"audience": prev, "html": rendered.HTML, "text": rendered.Text})
}

// POST /api/admin/comms/campaign/test — {id}: envía al admin autenticado (máx maxTestSends)
func (h *Handler) handleCommsTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	adminEmail, ok := h.requireAdmin(w, r)
	if !ok || !h.commsReady(w) {
		return
	}
	b, ok := readCampaignBody(w, r)
	if !ok || b.ID == 0 {
		writeErr(w, http.StatusBadRequest, "id_required")
		return
	}
	c, err := h.store.GetCampaign(r.Context(), b.ID)
	if err != nil {
		writeCommsErr(w, err)
		return
	}
	if err := h.store.IncrementTestSends(r.Context(), c.ID, h.comms.maxTestSends); err != nil {
		writeCommsErr(w, err)
		return
	}
	if err := h.comms.sender.SendTest(r.Context(), c, adminEmail); err != nil {
		h.log.Error().Err(err).Int64("campaign", c.ID).Msg("comms test send")
		_ = h.store.DecrementTestSends(r.Context(), c.ID)
		writeErr(w, http.StatusBadGateway, "email_send_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sent": true, "to": adminEmail})
}

// POST /api/admin/comms/campaign/submit — {id, reason}
func (h *Handler) handleCommsSubmit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	adminEmail, ok := h.requireAdmin(w, r)
	if !ok || !h.commsReady(w) {
		return
	}
	b, ok := readCampaignBody(w, r)
	if !ok || b.ID == 0 {
		writeErr(w, http.StatusBadRequest, "id_required")
		return
	}
	c, err := h.store.SubmitCampaign(r.Context(), b.ID, adminEmail, b.Reason)
	if err != nil {
		writeCommsErr(w, err)
		return
	}
	h.store.cache.PublishEvent(r.Context(), "comms.campaign_submitted", map[string]any{"campaign_id": c.ID, "by": adminEmail, "audience": c.AudienceCount})
	writeJSON(w, http.StatusOK, c)
}

// POST /api/admin/comms/campaign/decide — {id, decision, reason} (super_admin)
func (h *Handler) handleCommsDecide(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	superEmail, ok := h.requireSuperAdmin(w, r)
	if !ok || !h.commsReady(w) {
		return
	}
	b, ok := readCampaignBody(w, r)
	if !ok || b.ID == 0 {
		writeErr(w, http.StatusBadRequest, "id_required")
		return
	}
	c, err := h.store.DecideCampaign(r.Context(), b.ID, superEmail, b.Decision, strings.TrimSpace(b.Reason), h.comms.maxAudience, h.comms.maxPerDay)
	if err != nil {
		writeCommsErr(w, err)
		return
	}
	h.store.cache.PublishEvent(r.Context(), "comms.campaign_decided", map[string]any{"campaign_id": c.ID, "by": superEmail, "decision": b.Decision})
	h.log.Info().Int64("campaign", c.ID).Str("by", superEmail).Str("decision", b.Decision).Msg("comms campaign decided")
	writeJSON(w, http.StatusOK, c)
}

// POST /api/admin/comms/campaign/control — {id, action: pause|resume|cancel} (super_admin)
func (h *Handler) handleCommsControl(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	superEmail, ok := h.requireSuperAdmin(w, r)
	if !ok || !h.commsReady(w) {
		return
	}
	b, ok := readCampaignBody(w, r)
	if !ok || b.ID == 0 {
		writeErr(w, http.StatusBadRequest, "id_required")
		return
	}
	var err error
	switch b.Action {
	case "pause":
		err = h.store.SetCampaignStatus(r.Context(), b.ID, []string{"approved", "sending"}, "paused", "manual: "+superEmail)
	case "resume":
		err = h.store.SetCampaignStatus(r.Context(), b.ID, []string{"paused"}, "approved", "")
	case "cancel":
		err = h.store.CancelCampaign(r.Context(), b.ID, []string{"pending_approval", "approved", "sending", "paused"})
	default:
		writeErr(w, http.StatusBadRequest, "action_invalid")
		return
	}
	if err != nil {
		writeCommsErr(w, err)
		return
	}
	c, err := h.store.GetCampaign(r.Context(), b.ID)
	if err != nil {
		writeCommsErr(w, err)
		return
	}
	h.log.Info().Int64("campaign", c.ID).Str("by", superEmail).Str("action", b.Action).Msg("comms campaign control")
	writeJSON(w, http.StatusOK, c)
}

// GET /api/admin/comms/campaign/recipients?id=&status=&limit=&offset=
func (h *Handler) handleCommsRecipients(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if _, ok := h.requireAdmin(w, r); !ok || !h.commsReady(w) {
		return
	}
	q := r.URL.Query()
	id, _ := strconv.ParseInt(q.Get("id"), 10, 64)
	limit, _ := strconv.Atoi(q.Get("limit"))
	offset, _ := strconv.Atoi(q.Get("offset"))
	items, total, err := h.store.ListCampaignRecipients(r.Context(), id, q.Get("status"), limit, offset)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "total": total})
}

// POST /api/comms/unsubscribe — {token}; solo service token (lo llama el BFF público de growth-hub)
func (h *Handler) handleCommsUnsubscribe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	if len(h.comms.unsubSecret) == 0 {
		writeErr(w, http.StatusServiceUnavailable, "comms_disabled")
		return
	}
	b, ok := readCampaignBody(w, r)
	if !ok || b.Token == "" {
		writeErr(w, http.StatusBadRequest, "invalid_token")
		return
	}
	pid, err := comms.VerifyUnsubscribe(h.comms.unsubSecret, b.Token, time.Now())
	switch {
	case errors.Is(err, comms.ErrUnsubscribeExpired):
		writeErr(w, http.StatusGone, "expired_token")
		return
	case err != nil:
		writeErr(w, http.StatusBadRequest, "invalid_token")
		return
	}
	var email string
	if err := h.store.db.QueryRow(r.Context(), `SELECT email::text FROM mlm.person WHERE id=$1`, pid).Scan(&email); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_token")
		return
	}
	if err := h.store.AddUnsubscribe(r.Context(), email, &pid, "link"); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	h.log.Info().Int64("person", pid).Msg("comms unsubscribe")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
