package payments

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

type planSimulateReq struct {
	Email   string         `json:"email"`
	Changes map[string]any `json:"changes"`
}

// handleAdminPlanSimulate: proyecta θ bajo los cambios propuestos (preview del
// lock de solvencia, sin persistir nada).
func (h *Handler) handleAdminPlanSimulate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	var req planSimulateReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}
	email, ok := h.requireAdminIdentity(w, r, req.Email)
	if !ok {
		return
	}
	req.Email = email
	sim, err := h.store.SimulatePlanTheta(r.Context(), req.Changes)
	if err != nil {
		h.log.Error().Err(err).Msg("simulate plan")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, sim)
}

// handleAdminPlan: config de comisiones vigente + lista de campos editables.
func (h *Handler) handleAdminPlan(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	cfg, err := h.store.GetActivePlanConfig(r.Context())
	if err != nil {
		h.log.Error().Err(err).Msg("active plan")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	editable := make([]string, 0, len(planEditableFields))
	for _, f := range planEditableFields {
		editable = append(editable, f.Key)
	}
	writeJSON(w, http.StatusOK, map[string]any{"config": cfg, "editable": editable, "bounds": planBounds})
}

func (h *Handler) handleAdminPlanProposals(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	items, err := h.store.ListPlanProposals(r.Context())
	if err != nil {
		h.log.Error().Err(err).Msg("list proposals")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"proposals": items})
}

type planProposeReq struct {
	Email   string         `json:"email"`
	Changes map[string]any `json:"changes"`
	Reason  string         `json:"reason"`
}

func (h *Handler) handleAdminPlanPropose(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	var req planProposeReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}
	email, ok := h.requireAdminIdentity(w, r, req.Email)
	if !ok {
		return
	}
	req.Email = email
	id, err := h.store.ProposePlanChange(r.Context(), req.Email, req.Changes, req.Reason)
	if err != nil {
		if errors.Is(err, ErrPlanFieldNotEditable) || errors.Is(err, ErrPlanFieldOutOfBounds) {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		h.log.Error().Err(err).Msg("propose plan change")
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	h.log.Info().Int64("request_id", id).Str("by", req.Email).Msg("plan change proposed")
	writeJSON(w, http.StatusOK, map[string]any{"request_id": id, "status": "pending"})
}

type planDecideReq struct {
	Email   string `json:"email"`
	ID      int64  `json:"id"`
	Approve bool   `json:"approve"`
	Reason  string `json:"reason"`
}

func (h *Handler) handleAdminPlanDecide(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}
	var req planDecideReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}
	email, ok := h.requireAdminIdentity(w, r, req.Email)
	if !ok {
		return
	}
	req.Email = email
	if req.ID <= 0 {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	status, err := h.store.DecidePlanProposal(r.Context(), req.Email, req.ID, req.Approve, req.Reason)
	if err != nil {
		switch {
		case errors.Is(err, ErrApproverIsInitiator):
			writeErr(w, http.StatusForbidden, "approver_is_initiator")
		case errors.Is(err, ErrProposalNotPending):
			writeErr(w, http.StatusConflict, "not_pending")
		case errors.Is(err, ErrSolvencyLock):
			writeErr(w, http.StatusConflict, err.Error())
		default:
			h.log.Error().Err(err).Msg("decide plan proposal")
			writeErr(w, http.StatusInternalServerError, "internal")
		}
		return
	}
	h.log.Info().Int64("request_id", req.ID).Bool("approve", req.Approve).Str("status", status).Str("by", req.Email).Msg("plan proposal decided")
	writeJSON(w, http.StatusOK, map[string]string{"status": status})
}
