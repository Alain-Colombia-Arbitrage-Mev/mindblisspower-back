package payments

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	adminTreeRelocationReasonMin = 12
	adminTreeAdvisoryBase        = int64(2_000_000_000_000)
)

type adminTreeRelocationReq struct {
	Email                   string `json:"email"`
	PersonID                int64  `json:"person_id"`
	NewSponsor              string `json:"new_sponsor"`
	TargetParentAffiliateID *int64 `json:"target_parent_affiliate_id"`
	TargetPosition          string `json:"target_position"`
	Reason                  string `json:"reason"`
	DryRun                  bool   `json:"dry_run"`
	Confirm                 string `json:"confirm"`
}

type AdminTreeRelocationInput struct {
	PersonID                int64
	NewSponsor              string
	TargetParentAffiliateID *int64
	TargetPosition          string
	Reason                  string
	DryRun                  bool
	RequestedBy             string
}

type AdminTreeRelocationRef struct {
	ID       int64  `json:"id"`
	PersonID int64  `json:"person_id,omitempty"`
	Email    string `json:"email,omitempty"`
	Name     string `json:"name,omitempty"`
	Handle   string `json:"handle,omitempty"`
	Status   string `json:"status,omitempty"`
}

type AdminTreeRelocationPlacement struct {
	Sponsor  *AdminTreeRelocationRef `json:"sponsor,omitempty"`
	Parent   *AdminTreeRelocationRef `json:"parent,omitempty"`
	ParentID *int64                  `json:"parent_id,omitempty"`
	Position *string                 `json:"position,omitempty"`
	Depth    int                     `json:"depth"`
}

type AdminTreeRelocationSummary struct {
	OK                          bool                         `json:"ok"`
	DryRun                      bool                         `json:"dry_run"`
	Changed                     bool                         `json:"changed"`
	Target                      AdminTreeRelocationRef       `json:"target"`
	OldPlacement                AdminTreeRelocationPlacement `json:"old_placement"`
	NewPlacement                AdminTreeRelocationPlacement `json:"new_placement"`
	SubtreeCount                int64                        `json:"subtree_count"`
	EnrollmentsMoved            int64                        `json:"enrollments_moved"`
	PVMoved                     string                       `json:"pv_moved"`
	OldAncestors                int64                        `json:"old_ancestors"`
	NewAncestors                int64                        `json:"new_ancestors"`
	PurchaseIntentsUpdated      int64                        `json:"purchase_intents_updated"`
	RegistrationReferralUpdated bool                         `json:"registration_referral_updated"`
	TreeEventInserted           bool                         `json:"tree_event_inserted"`
	AuditInserted               bool                         `json:"audit_inserted"`
	Warnings                    []string                     `json:"warnings,omitempty"`
}

type adminTreeRelocationError struct {
	code   string
	status int
}

func (e adminTreeRelocationError) Error() string { return e.code }

func errAdminTreeRelocation(code string, status int) error {
	return adminTreeRelocationError{code: code, status: status}
}

func writeAdminTreeRelocationErr(w http.ResponseWriter, err error) bool {
	var e adminTreeRelocationError
	if !errors.As(err, &e) {
		return false
	}
	writeErr(w, e.status, e.code)
	return true
}

func (h *Handler) handleAdminUserTreeRelocation(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !h.svcAuth(w, r) {
		return
	}

	var req adminTreeRelocationReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}
	_, caller, ok := h.effectiveIdentity(w, r, req.Email)
	if !ok {
		return
	}
	if !h.isSuperAdmin(caller) {
		writeErr(w, http.StatusForbidden, "not_super_admin")
		return
	}

	req.NewSponsor = strings.TrimSpace(req.NewSponsor)
	req.TargetPosition = normalizeAdminTreePosition(req.TargetPosition)
	req.Reason = strings.TrimSpace(req.Reason)

	if req.PersonID <= 0 {
		writeErr(w, http.StatusBadRequest, "missing_person_id")
		return
	}
	if req.NewSponsor == "" {
		writeErr(w, http.StatusBadRequest, "missing_sponsor")
		return
	}
	if len(req.NewSponsor) > 160 {
		writeErr(w, http.StatusBadRequest, "invalid_sponsor")
		return
	}
	if len(req.Reason) < adminTreeRelocationReasonMin {
		writeErr(w, http.StatusBadRequest, "reason_required")
		return
	}
	if req.TargetParentAffiliateID != nil && *req.TargetParentAffiliateID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid_target_parent")
		return
	}
	if req.TargetParentAffiliateID == nil && req.TargetPosition != "" {
		writeErr(w, http.StatusBadRequest, "target_parent_required")
		return
	}
	if req.TargetParentAffiliateID != nil && req.TargetPosition == "" {
		writeErr(w, http.StatusBadRequest, "target_position_required")
		return
	}
	if req.TargetPosition != "" && req.TargetPosition != "L" && req.TargetPosition != "R" {
		writeErr(w, http.StatusBadRequest, "invalid_position")
		return
	}
	if !req.DryRun && req.Confirm != "MOVE" {
		writeErr(w, http.StatusBadRequest, "confirm_required")
		return
	}

	out, err := h.store.PreviewOrMoveAdminTreeRelocation(r.Context(), AdminTreeRelocationInput{
		PersonID:                req.PersonID,
		NewSponsor:              req.NewSponsor,
		TargetParentAffiliateID: req.TargetParentAffiliateID,
		TargetPosition:          req.TargetPosition,
		Reason:                  req.Reason,
		DryRun:                  req.DryRun,
		RequestedBy:             caller,
	})
	if err != nil {
		if writeAdminTreeRelocationErr(w, err) {
			return
		}
		h.log.Error().Err(err).Int64("person_id", req.PersonID).Msg("admin tree relocation")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}

	if !req.DryRun {
		h.store.invalidateMemberCaches(r.Context(), out.Target.Email)
		if out.OldPlacement.Sponsor != nil {
			h.store.invalidateMemberCaches(r.Context(), out.OldPlacement.Sponsor.Email)
		}
		if out.NewPlacement.Sponsor != nil {
			h.store.invalidateMemberCaches(r.Context(), out.NewPlacement.Sponsor.Email)
		}
		h.log.Info().Str("by", caller).Int64("person_id", req.PersonID).
			Int64("affiliate_id", out.Target.ID).
			Bool("changed", out.Changed).
			Msg("admin user: sponsor/tree relocation applied")
	}

	writeJSON(w, http.StatusOK, out)
}

type adminTreeAffiliateSnapshot struct {
	ID              int64
	PersonID        int64
	Email           string
	Name            string
	Handle          string
	PersonStatus    string
	Blacklisted     bool
	AffiliateStatus string
	ParentID        *int64
	Position        *string
	SponsorID       *int64
	Path            string
	Depth           int
}

func (s adminTreeAffiliateSnapshot) ref() AdminTreeRelocationRef {
	return AdminTreeRelocationRef{
		ID:       s.ID,
		PersonID: s.PersonID,
		Email:    s.Email,
		Name:     strings.TrimSpace(s.Name),
		Handle:   s.Handle,
		Status:   s.AffiliateStatus,
	}
}

func (s adminTreeAffiliateSnapshot) active() bool {
	return strings.EqualFold(s.PersonStatus, "active") &&
		strings.EqualFold(s.AffiliateStatus, "active") &&
		!s.Blacklisted
}

func normalizeAdminTreePosition(v string) string {
	v = strings.ToUpper(strings.TrimSpace(v))
	if v == "AUTO" {
		return ""
	}
	return v
}

func (s *Store) PreviewOrMoveAdminTreeRelocation(ctx context.Context, in AdminTreeRelocationInput) (AdminTreeRelocationSummary, error) {
	if s == nil || s.db == nil {
		return AdminTreeRelocationSummary{}, fmt.Errorf("tree relocation store not configured")
	}
	in.NewSponsor = strings.TrimSpace(in.NewSponsor)
	in.TargetPosition = normalizeAdminTreePosition(in.TargetPosition)
	in.Reason = strings.TrimSpace(in.Reason)
	in.RequestedBy = strings.TrimSpace(in.RequestedBy)

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return AdminTreeRelocationSummary{}, fmt.Errorf("tree relocation begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `SET LOCAL lock_timeout = '10s'`); err != nil {
		return AdminTreeRelocationSummary{}, fmt.Errorf("tree relocation set lock timeout: %w", err)
	}
	if _, err := tx.Exec(ctx, `SET LOCAL statement_timeout = '120s'`); err != nil {
		return AdminTreeRelocationSummary{}, fmt.Errorf("tree relocation set statement timeout: %w", err)
	}
	if err := createAdminTreeRelocationTempTables(ctx, tx); err != nil {
		return AdminTreeRelocationSummary{}, err
	}

	target, found, err := s.getAdminTreeAffiliateByPerson(ctx, tx, in.PersonID)
	if err != nil {
		return AdminTreeRelocationSummary{}, err
	}
	if !found {
		return AdminTreeRelocationSummary{}, errAdminTreeRelocation("target_not_found", http.StatusNotFound)
	}
	if target.ParentID == nil || target.Position == nil {
		return AdminTreeRelocationSummary{}, errAdminTreeRelocation("cannot_move_root", http.StatusConflict)
	}
	if !target.active() {
		return AdminTreeRelocationSummary{}, errAdminTreeRelocation("target_not_active", http.StatusConflict)
	}

	sponsorID, found, err := s.resolveAdminTreeSponsorID(ctx, tx, in.NewSponsor)
	if err != nil {
		return AdminTreeRelocationSummary{}, err
	}
	if !found {
		return AdminTreeRelocationSummary{}, errAdminTreeRelocation("sponsor_not_found", http.StatusNotFound)
	}
	sponsor, found, err := s.getAdminTreeAffiliateByID(ctx, tx, sponsorID)
	if err != nil {
		return AdminTreeRelocationSummary{}, err
	}
	if !found {
		return AdminTreeRelocationSummary{}, errAdminTreeRelocation("sponsor_not_found", http.StatusNotFound)
	}
	if sponsor.ID == target.ID {
		return AdminTreeRelocationSummary{}, errAdminTreeRelocation("sponsor_is_target", http.StatusConflict)
	}
	if !sponsor.active() {
		return AdminTreeRelocationSummary{}, errAdminTreeRelocation("sponsor_not_active", http.StatusConflict)
	}

	lockIDs := []int64{target.ID, sponsor.ID}
	if target.SponsorID != nil {
		lockIDs = append(lockIDs, *target.SponsorID)
	}
	if err := lockAdminTreeAffiliates(ctx, tx, lockIDs); err != nil {
		return AdminTreeRelocationSummary{}, err
	}
	if err := s.captureAdminMovedSubtree(ctx, tx, target.ID); err != nil {
		return AdminTreeRelocationSummary{}, err
	}
	if err := lockAdminTreeMovedRows(ctx, tx); err != nil {
		return AdminTreeRelocationSummary{}, err
	}

	var sponsorInside bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM _admin_tree_moved WHERE id = $1)`, sponsor.ID).Scan(&sponsorInside); err != nil {
		return AdminTreeRelocationSummary{}, fmt.Errorf("tree relocation sponsor subtree check: %w", err)
	}
	if sponsorInside {
		return AdminTreeRelocationSummary{}, errAdminTreeRelocation("sponsor_inside_subtree", http.StatusConflict)
	}

	newParentID := int64(0)
	newPosition := ""
	var manualParent *adminTreeAffiliateSnapshot
	if in.TargetParentAffiliateID != nil {
		parent, ok, err := s.getAdminTreeAffiliateByID(ctx, tx, *in.TargetParentAffiliateID)
		if err != nil {
			return AdminTreeRelocationSummary{}, err
		}
		if !ok {
			return AdminTreeRelocationSummary{}, errAdminTreeRelocation("target_parent_not_found", http.StatusNotFound)
		}
		if !parent.active() {
			return AdminTreeRelocationSummary{}, errAdminTreeRelocation("target_parent_not_active", http.StatusConflict)
		}
		var parentInside bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM _admin_tree_moved WHERE id = $1)`, parent.ID).Scan(&parentInside); err != nil {
			return AdminTreeRelocationSummary{}, fmt.Errorf("tree relocation parent subtree check: %w", err)
		}
		if parentInside {
			return AdminTreeRelocationSummary{}, errAdminTreeRelocation("target_parent_inside_subtree", http.StatusConflict)
		}
		var parentUnderSponsor bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM mlm.affiliate_closure
				 WHERE ancestor_id = $1 AND descendant_id = $2
			)`, sponsor.ID, parent.ID).Scan(&parentUnderSponsor); err != nil {
			return AdminTreeRelocationSummary{}, fmt.Errorf("tree relocation parent sponsor check: %w", err)
		}
		if !parentUnderSponsor {
			return AdminTreeRelocationSummary{}, errAdminTreeRelocation("target_parent_not_under_sponsor", http.StatusConflict)
		}
		if err := lockAdminTreeAffiliates(ctx, tx, []int64{parent.ID}); err != nil {
			return AdminTreeRelocationSummary{}, err
		}
		newParentID = parent.ID
		newPosition = in.TargetPosition
		manualParent = &parent
	} else {
		var alreadyUnderSponsor bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM mlm.affiliate_closure
				 WHERE ancestor_id = $1 AND descendant_id = $2 AND distance > 0
			)`, sponsor.ID, target.ID).Scan(&alreadyUnderSponsor); err != nil {
			return AdminTreeRelocationSummary{}, fmt.Errorf("tree relocation current sponsor subtree check: %w", err)
		}
		if alreadyUnderSponsor {
			newParentID = *target.ParentID
			newPosition = *target.Position
		} else {
			if err := tx.QueryRow(ctx, `
				WITH RECURSIVE walk AS (
					SELECT a.id AS node_id,
					       CASE WHEN a.left_pv_current < a.right_pv_current THEN 'L'
					            WHEN a.right_pv_current < a.left_pv_current THEN 'R'
					            WHEN a.left_count < a.right_count THEN 'L'
					            WHEN a.right_count < a.left_count THEN 'R'
					            ELSE 'L' END AS side,
					       0 AS lvl
					  FROM mlm.affiliate a
					 WHERE a.id = $1
					UNION ALL
					SELECT c.id,
					       CASE WHEN c.left_pv_current < c.right_pv_current THEN 'L'
					            WHEN c.right_pv_current < c.left_pv_current THEN 'R'
					            WHEN c.left_count < c.right_count THEN 'L'
					            WHEN c.right_count < c.left_count THEN 'R'
					            ELSE 'L' END,
					       w.lvl + 1
					  FROM walk w
					  JOIN mlm.affiliate c
					    ON c.parent_id = w.node_id
					   AND c.position = w.side::mlm.tree_position
					 WHERE w.lvl < 512
				)
				SELECT node_id, side
				  FROM walk
				 ORDER BY lvl DESC
				 LIMIT 1
			`, sponsor.ID).Scan(&newParentID, &newPosition); err != nil {
				return AdminTreeRelocationSummary{}, fmt.Errorf("tree relocation weak leg: %w", err)
			}
		}
	}

	if newParentID <= 0 || (newPosition != "L" && newPosition != "R") {
		return AdminTreeRelocationSummary{}, errAdminTreeRelocation("invalid_target_slot", http.StatusConflict)
	}
	if err := lockAdminTreeAffiliates(ctx, tx, []int64{newParentID}); err != nil {
		return AdminTreeRelocationSummary{}, err
	}
	if err := validateAdminTreeSlot(ctx, tx, target.ID, newParentID, newPosition); err != nil {
		return AdminTreeRelocationSummary{}, err
	}

	newPath, newDepth, err := computeAdminTreeNewPath(ctx, tx, target.ID, newParentID, newPosition)
	if err != nil {
		return AdminTreeRelocationSummary{}, err
	}
	structureChanged := *target.ParentID != newParentID || *target.Position != newPosition
	sponsorChanged := target.SponsorID == nil || *target.SponsorID != sponsor.ID

	if structureChanged {
		if err := insertAdminTreeAncestorLegs(ctx, tx, "_admin_tree_old_ancestors", target.ID, target.Path); err != nil {
			return AdminTreeRelocationSummary{}, err
		}
		if err := insertAdminTreeNewAncestorLegs(ctx, tx, newParentID, newPath); err != nil {
			return AdminTreeRelocationSummary{}, err
		}
		if err := lockAdminTreeAffectedAncestors(ctx, tx); err != nil {
			return AdminTreeRelocationSummary{}, err
		}
	} else {
		newPath = target.Path
		newDepth = target.Depth
	}

	summary, err := s.buildAdminTreeRelocationSummary(ctx, tx, target, sponsor, newParentID, newPosition, newDepth, structureChanged || sponsorChanged)
	if err != nil {
		return AdminTreeRelocationSummary{}, err
	}
	summary.DryRun = in.DryRun
	if manualParent != nil {
		summary.NewPlacement.Parent = adminTreeRefPtr(manualParent.ref())
	}

	if !structureChanged && !sponsorChanged {
		summary.Warnings = append(summary.Warnings, "no_change")
		if !in.DryRun {
			return AdminTreeRelocationSummary{}, errAdminTreeRelocation("no_change", http.StatusConflict)
		}
		return summary, nil
	}
	if in.DryRun {
		summary.Warnings = append(summary.Warnings, "dry_run_only")
		return summary, nil
	}

	if structureChanged {
		if err := applyAdminTreeStructureMove(ctx, tx, target, sponsor.ID, newParentID, newPosition, newPath, newDepth, summary.SubtreeCount, summary.PVMoved); err != nil {
			return AdminTreeRelocationSummary{}, err
		}
	} else {
		if _, err := tx.Exec(ctx, `
			UPDATE mlm.affiliate
			   SET sponsor_id = $2, updated_at = now()
			 WHERE id = $1
		`, target.ID, sponsor.ID); err != nil {
			return AdminTreeRelocationSummary{}, fmt.Errorf("tree relocation sponsor update: %w", err)
		}
	}

	paymentRows, referralUpdated, err := updateAdminTreeReferralAttribution(ctx, tx, target, sponsor)
	if err != nil {
		return AdminTreeRelocationSummary{}, err
	}
	treeEventInserted, auditInserted, err := insertAdminTreeRelocationAudit(ctx, tx, in, target, sponsor, newParentID, newPosition, newPath, newDepth, summary.SubtreeCount, summary.PVMoved, paymentRows)
	if err != nil {
		return AdminTreeRelocationSummary{}, err
	}
	if err := validateAdminTreeRelocationIntegrity(ctx, tx, target.ID, structureChanged); err != nil {
		return AdminTreeRelocationSummary{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return AdminTreeRelocationSummary{}, fmt.Errorf("tree relocation commit: %w", err)
	}

	summary.PurchaseIntentsUpdated = paymentRows
	summary.RegistrationReferralUpdated = referralUpdated
	summary.TreeEventInserted = treeEventInserted
	summary.AuditInserted = auditInserted
	summary.OK = true
	return summary, nil
}

func createAdminTreeRelocationTempTables(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `
		CREATE TEMP TABLE _admin_tree_moved(
			id bigint PRIMARY KEY,
			old_path ltree NOT NULL,
			old_depth int NOT NULL
		) ON COMMIT DROP;
		CREATE TEMP TABLE _admin_tree_old_ancestors(
			ancestor_id bigint PRIMARY KEY,
			leg mlm.tree_position NOT NULL
		) ON COMMIT DROP;
		CREATE TEMP TABLE _admin_tree_new_ancestors(
			ancestor_id bigint PRIMARY KEY,
			leg mlm.tree_position NOT NULL
		) ON COMMIT DROP;
	`)
	if err != nil {
		return fmt.Errorf("tree relocation temp tables: %w", err)
	}
	return nil
}

func (s *Store) getAdminTreeAffiliateByPerson(ctx context.Context, tx pgx.Tx, personID int64) (adminTreeAffiliateSnapshot, bool, error) {
	var a adminTreeAffiliateSnapshot
	err := tx.QueryRow(ctx, adminTreeAffiliateSnapshotSQL()+`
		 WHERE p.id = $1
		 LIMIT 1
		 FOR UPDATE OF a
	`, personID).Scan(adminTreeAffiliateScanDest(&a)...)
	if errors.Is(err, pgx.ErrNoRows) {
		return a, false, nil
	}
	if err != nil {
		return a, false, fmt.Errorf("tree relocation target lookup: %w", err)
	}
	return a, true, nil
}

func (s *Store) getAdminTreeAffiliateByID(ctx context.Context, tx pgx.Tx, affiliateID int64) (adminTreeAffiliateSnapshot, bool, error) {
	var a adminTreeAffiliateSnapshot
	err := tx.QueryRow(ctx, adminTreeAffiliateSnapshotSQL()+`
		 WHERE a.id = $1
		 LIMIT 1
		 FOR UPDATE OF a
	`, affiliateID).Scan(adminTreeAffiliateScanDest(&a)...)
	if errors.Is(err, pgx.ErrNoRows) {
		return a, false, nil
	}
	if err != nil {
		return a, false, fmt.Errorf("tree relocation affiliate lookup: %w", err)
	}
	return a, true, nil
}

func adminTreeAffiliateSnapshotSQL() string {
	return `
		SELECT a.id,
		       a.person_id,
		       p.email::text,
		       trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
		       COALESCE(NULLIF(a.invitation_link,''), 'MP' || a.id),
		       p.status::text,
		       coalesce(p.blacklisted,false),
		       a.status::text,
		       a.parent_id,
		       a.position::text,
		       a.sponsor_id,
		       a.path::text,
		       a.depth
		  FROM mlm.affiliate a
		  JOIN mlm.person p ON p.id = a.person_id`
}

func adminTreeAffiliateScanDest(a *adminTreeAffiliateSnapshot) []any {
	return []any{
		&a.ID,
		&a.PersonID,
		&a.Email,
		&a.Name,
		&a.Handle,
		&a.PersonStatus,
		&a.Blacklisted,
		&a.AffiliateStatus,
		&a.ParentID,
		&a.Position,
		&a.SponsorID,
		&a.Path,
		&a.Depth,
	}
}

func (s *Store) resolveAdminTreeSponsorID(ctx context.Context, tx pgx.Tx, raw string) (int64, bool, error) {
	ref := strings.ToLower(strings.TrimSpace(raw))
	refID := int64(0)
	if n, err := strconv.ParseInt(ref, 10, 64); err == nil && n > 0 {
		refID = n
	}

	var id int64
	err := tx.QueryRow(ctx, `
		WITH candidates AS (
			SELECT a.id, 1 AS priority
			  FROM mlm.affiliate a
			 WHERE $2::bigint > 0 AND a.id = $2
			UNION ALL
			SELECT a.id, 2 AS priority
			  FROM mlm.affiliate a
			  JOIN mlm.person p ON p.id = a.person_id
			 WHERE lower(p.email::text) = $1
			UNION ALL
			SELECT a.id, 3 AS priority
			  FROM mlm.affiliate a
			 WHERE lower(COALESCE(NULLIF(a.invitation_link,''), 'MP' || a.id)) = $1
		)
		SELECT id
		  FROM candidates
		 ORDER BY priority, id
		 LIMIT 1
	`, ref, refID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("tree relocation sponsor lookup: %w", err)
	}
	return id, true, nil
}

func lockAdminTreeAffiliates(ctx context.Context, tx pgx.Tx, ids []int64) error {
	uniq := make(map[int64]struct{}, len(ids))
	out := make([]int64, 0, len(ids))
	for _, id := range ids {
		if id <= 0 {
			continue
		}
		if _, ok := uniq[id]; ok {
			continue
		}
		uniq[id] = struct{}{}
		out = append(out, id)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	for _, id := range out {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1::bigint)`, adminTreeAdvisoryBase+id); err != nil {
			return fmt.Errorf("tree relocation advisory lock %d: %w", id, err)
		}
	}
	return nil
}

func (s *Store) captureAdminMovedSubtree(ctx context.Context, tx pgx.Tx, targetID int64) error {
	tag, err := tx.Exec(ctx, `
		INSERT INTO _admin_tree_moved(id, old_path, old_depth)
		SELECT a.id, a.path, a.depth
		  FROM mlm.affiliate_closure c
		  JOIN mlm.affiliate a ON a.id = c.descendant_id
		 WHERE c.ancestor_id = $1
		 ORDER BY c.distance, a.id
	`, targetID)
	if err != nil {
		return fmt.Errorf("tree relocation capture subtree: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return errAdminTreeRelocation("target_not_found", http.StatusNotFound)
	}
	return nil
}

func lockAdminTreeMovedRows(ctx context.Context, tx pgx.Tx) error {
	rows, err := tx.Query(ctx, `
		SELECT a.id
		  FROM mlm.affiliate a
		  JOIN _admin_tree_moved m ON m.id = a.id
		 ORDER BY a.id
		 FOR UPDATE OF a
	`)
	if err != nil {
		return fmt.Errorf("tree relocation lock subtree: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("tree relocation lock subtree rows: %w", err)
	}
	return nil
}

func validateAdminTreeSlot(ctx context.Context, tx pgx.Tx, targetID, parentID int64, position string) error {
	var occupant *int64
	err := tx.QueryRow(ctx, `
		SELECT id
		  FROM mlm.affiliate
		 WHERE parent_id = $1
		   AND position = $2::mlm.tree_position
		 LIMIT 1
	`, parentID, position).Scan(&occupant)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("tree relocation target slot: %w", err)
	}
	if occupant != nil && *occupant == targetID {
		return nil
	}
	return errAdminTreeRelocation("target_slot_taken", http.StatusConflict)
}

func computeAdminTreeNewPath(ctx context.Context, tx pgx.Tx, targetID, parentID int64, position string) (string, int, error) {
	var path string
	var depth int
	err := tx.QueryRow(ctx, `
		SELECT (path || text2ltree($2::text || '_' || $3::bigint::text))::text,
		       depth + 1
		  FROM mlm.affiliate
		 WHERE id = $1
		 FOR UPDATE
	`, parentID, position, targetID).Scan(&path, &depth)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", 0, errAdminTreeRelocation("target_parent_not_found", http.StatusNotFound)
	}
	if err != nil {
		return "", 0, fmt.Errorf("tree relocation compute path: %w", err)
	}
	return path, depth, nil
}

func insertAdminTreeAncestorLegs(ctx context.Context, tx pgx.Tx, tableName string, targetID int64, rootPath string) error {
	sql := fmt.Sprintf(`
		INSERT INTO %s(ancestor_id, leg)
		SELECT c.ancestor_id,
		       CASE WHEN substring(ltree2text(subpath($2::ltree, a.depth + 1, 1)) from 1 for 1) = 'L'
		            THEN 'L'::mlm.tree_position
		            ELSE 'R'::mlm.tree_position
		        END
		  FROM mlm.affiliate_closure c
		  JOIN mlm.affiliate a ON a.id = c.ancestor_id
		 WHERE c.descendant_id = $1
		   AND c.distance > 0
	`, tableName)
	if _, err := tx.Exec(ctx, sql, targetID, rootPath); err != nil {
		return fmt.Errorf("tree relocation ancestor legs: %w", err)
	}
	return nil
}

func insertAdminTreeNewAncestorLegs(ctx context.Context, tx pgx.Tx, newParentID int64, newRootPath string) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO _admin_tree_new_ancestors(ancestor_id, leg)
		SELECT c.ancestor_id,
		       CASE WHEN substring(ltree2text(subpath($2::ltree, a.depth + 1, 1)) from 1 for 1) = 'L'
		            THEN 'L'::mlm.tree_position
		            ELSE 'R'::mlm.tree_position
		        END
		  FROM mlm.affiliate_closure c
		  JOIN mlm.affiliate a ON a.id = c.ancestor_id
		 WHERE c.descendant_id = $1
	`, newParentID, newRootPath)
	if err != nil {
		return fmt.Errorf("tree relocation new ancestor legs: %w", err)
	}
	return nil
}

func lockAdminTreeAffectedAncestors(ctx context.Context, tx pgx.Tx) error {
	rows, err := tx.Query(ctx, `
		WITH affected AS (
			SELECT ancestor_id FROM _admin_tree_old_ancestors
			UNION
			SELECT ancestor_id FROM _admin_tree_new_ancestors
		)
		SELECT a.id
		  FROM mlm.affiliate a
		  JOIN affected x ON x.ancestor_id = a.id
		 ORDER BY a.id
		 FOR UPDATE OF a
	`)
	if err != nil {
		return fmt.Errorf("tree relocation lock ancestors: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("tree relocation lock ancestor rows: %w", err)
	}
	return nil
}

func (s *Store) buildAdminTreeRelocationSummary(ctx context.Context, tx pgx.Tx, target, sponsor adminTreeAffiliateSnapshot, newParentID int64, newPosition string, newDepth int, changed bool) (AdminTreeRelocationSummary, error) {
	var subtreeCount, enrollmentsMoved, oldAncestors, newAncestors int64
	var pvMoved string
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM _admin_tree_moved`).Scan(&subtreeCount); err != nil {
		return AdminTreeRelocationSummary{}, fmt.Errorf("tree relocation subtree count: %w", err)
	}
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE te.kind = 'enrollment')::bigint,
		       COALESCE(SUM(te.pv_delta_left + te.pv_delta_right), 0)::text
		  FROM mlm.tree_event te
		  JOIN _admin_tree_moved m ON m.id = te.affiliate_id
	`).Scan(&enrollmentsMoved, &pvMoved); err != nil {
		return AdminTreeRelocationSummary{}, fmt.Errorf("tree relocation event totals: %w", err)
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM _admin_tree_old_ancestors`).Scan(&oldAncestors); err != nil {
		return AdminTreeRelocationSummary{}, fmt.Errorf("tree relocation old ancestor count: %w", err)
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM _admin_tree_new_ancestors`).Scan(&newAncestors); err != nil {
		return AdminTreeRelocationSummary{}, fmt.Errorf("tree relocation new ancestor count: %w", err)
	}

	oldSponsor, err := s.adminTreeOptionalRef(ctx, tx, target.SponsorID)
	if err != nil {
		return AdminTreeRelocationSummary{}, err
	}
	oldParent, err := s.adminTreeOptionalRef(ctx, tx, target.ParentID)
	if err != nil {
		return AdminTreeRelocationSummary{}, err
	}
	parentSnap, found, err := s.getAdminTreeAffiliateByID(ctx, tx, newParentID)
	if err != nil {
		return AdminTreeRelocationSummary{}, err
	}
	if !found {
		return AdminTreeRelocationSummary{}, errAdminTreeRelocation("target_parent_not_found", http.StatusNotFound)
	}
	newParent := parentSnap.ref()

	warnings := []string{}
	if subtreeCount > 1 {
		warnings = append(warnings, "subtree_move")
	}

	return AdminTreeRelocationSummary{
		OK:               true,
		DryRun:           true,
		Changed:          changed,
		Target:           target.ref(),
		OldPlacement:     AdminTreeRelocationPlacement{Sponsor: oldSponsor, Parent: oldParent, ParentID: target.ParentID, Position: target.Position, Depth: target.Depth},
		NewPlacement:     AdminTreeRelocationPlacement{Sponsor: adminTreeRefPtr(sponsor.ref()), Parent: &newParent, ParentID: &newParentID, Position: &newPosition, Depth: newDepth},
		SubtreeCount:     subtreeCount,
		EnrollmentsMoved: enrollmentsMoved,
		PVMoved:          pvMoved,
		OldAncestors:     oldAncestors,
		NewAncestors:     newAncestors,
		Warnings:         warnings,
	}, nil
}

func (s *Store) adminTreeOptionalRef(ctx context.Context, tx pgx.Tx, id *int64) (*AdminTreeRelocationRef, error) {
	if id == nil || *id <= 0 {
		return nil, nil
	}
	snap, found, err := s.getAdminTreeAffiliateByID(ctx, tx, *id)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, errAdminTreeRelocation("affiliate_ref_not_found", http.StatusConflict)
	}
	return adminTreeRefPtr(snap.ref()), nil
}

func adminTreeRefPtr(v AdminTreeRelocationRef) *AdminTreeRelocationRef { return &v }

func applyAdminTreeStructureMove(ctx context.Context, tx pgx.Tx, target adminTreeAffiliateSnapshot, sponsorID, newParentID int64, newPosition, newPath string, newDepth int, subtreeCount int64, pvMoved string) error {
	if _, err := tx.Exec(ctx, `
		UPDATE mlm.affiliate
		   SET parent_id = $2,
		       position = $3::mlm.tree_position,
		       sponsor_id = $4,
		       path = $5::ltree,
		       depth = $6,
		       updated_at = now()
		 WHERE id = $1
	`, target.ID, newParentID, newPosition, sponsorID, newPath, newDepth); err != nil {
		return fmt.Errorf("tree relocation update root: %w", err)
	}

	if _, err := tx.Exec(ctx, `
		UPDATE mlm.affiliate d
		   SET path = $2::ltree || subpath(m.old_path, nlevel($3::ltree)),
		       depth = $4 + (m.old_depth - $5),
		       updated_at = now()
		  FROM _admin_tree_moved m
		 WHERE d.id = m.id
		   AND d.id <> $1
	`, target.ID, newPath, target.Path, newDepth, target.Depth); err != nil {
		return fmt.Errorf("tree relocation update descendants: %w", err)
	}

	if _, err := tx.Exec(ctx, `
		DELETE FROM mlm.affiliate_closure c
		 USING _admin_tree_moved m
		 WHERE c.descendant_id = m.id
		   AND NOT EXISTS (
		     SELECT 1 FROM _admin_tree_moved im WHERE im.id = c.ancestor_id
		   )
	`); err != nil {
		return fmt.Errorf("tree relocation delete external closure: %w", err)
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO mlm.affiliate_closure(ancestor_id, descendant_id, distance)
		SELECT c.ancestor_id,
		       m.id,
		       c.distance + 1 + (m.old_depth - $2)
		  FROM mlm.affiliate_closure c
		  JOIN _admin_tree_moved m ON true
		 WHERE c.descendant_id = $1
		ON CONFLICT (ancestor_id, descendant_id)
		DO UPDATE SET distance = EXCLUDED.distance
	`, newParentID, target.Depth); err != nil {
		return fmt.Errorf("tree relocation insert external closure: %w", err)
	}

	if _, err := tx.Exec(ctx, `
		UPDATE mlm.affiliate a
		   SET left_count        = left_count        - CASE WHEN o.leg = 'L' THEN $1 ELSE 0 END,
		       right_count       = right_count       - CASE WHEN o.leg = 'R' THEN $1 ELSE 0 END,
		       left_pv_lifetime  = left_pv_lifetime  - CASE WHEN o.leg = 'L' THEN $2::numeric ELSE 0 END,
		       right_pv_lifetime = right_pv_lifetime - CASE WHEN o.leg = 'R' THEN $2::numeric ELSE 0 END,
		       left_pv_current   = left_pv_current   - CASE WHEN o.leg = 'L' THEN $2::numeric ELSE 0 END,
		       right_pv_current  = right_pv_current  - CASE WHEN o.leg = 'R' THEN $2::numeric ELSE 0 END,
		       updated_at = now()
		  FROM _admin_tree_old_ancestors o
		 WHERE a.id = o.ancestor_id
	`, subtreeCount, pvMoved); err != nil {
		return fmt.Errorf("tree relocation subtract aggregates: %w", err)
	}

	if _, err := tx.Exec(ctx, `
		UPDATE mlm.affiliate a
		   SET left_count        = left_count        + CASE WHEN n.leg = 'L' THEN $1 ELSE 0 END,
		       right_count       = right_count       + CASE WHEN n.leg = 'R' THEN $1 ELSE 0 END,
		       left_pv_lifetime  = left_pv_lifetime  + CASE WHEN n.leg = 'L' THEN $2::numeric ELSE 0 END,
		       right_pv_lifetime = right_pv_lifetime + CASE WHEN n.leg = 'R' THEN $2::numeric ELSE 0 END,
		       left_pv_current   = left_pv_current   + CASE WHEN n.leg = 'L' THEN $2::numeric ELSE 0 END,
		       right_pv_current  = right_pv_current  + CASE WHEN n.leg = 'R' THEN $2::numeric ELSE 0 END,
		       updated_at = now()
		  FROM _admin_tree_new_ancestors n
		 WHERE a.id = n.ancestor_id
	`, subtreeCount, pvMoved); err != nil {
		return fmt.Errorf("tree relocation add aggregates: %w", err)
	}
	return nil
}

func updateAdminTreeReferralAttribution(ctx context.Context, tx pgx.Tx, target, sponsor adminTreeAffiliateSnapshot) (int64, bool, error) {
	tag, err := tx.Exec(ctx, `
		UPDATE payments.purchase_intent
		   SET sponsor_affiliate_id = $2,
		       referral_code = $3,
		       updated_at = now()
		 WHERE (affiliate_id = $1 OR person_id = $4)
		   AND status IN ('created','paid','activated','needs_placement')
	`, target.ID, sponsor.ID, sponsor.Handle, target.PersonID)
	if err != nil {
		return 0, false, fmt.Errorf("tree relocation update purchase intents: %w", err)
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO payments.registration_referral(email_norm, referral_code, sponsor_affiliate_id, source, created_at, updated_at, consumed_at)
		VALUES (lower(btrim($1)), $2, $3, 'admin_tree_relocation', now(), now(), now())
		ON CONFLICT (email_norm) DO UPDATE SET
			referral_code = EXCLUDED.referral_code,
			sponsor_affiliate_id = EXCLUDED.sponsor_affiliate_id,
			source = EXCLUDED.source,
			updated_at = now(),
			consumed_at = now()
	`, target.Email, sponsor.Handle, sponsor.ID)
	if err != nil {
		return 0, false, fmt.Errorf("tree relocation upsert registration referral: %w", err)
	}
	return tag.RowsAffected(), true, nil
}

func insertAdminTreeRelocationAudit(ctx context.Context, tx pgx.Tx, in AdminTreeRelocationInput, target, sponsor adminTreeAffiliateSnapshot, newParentID int64, newPosition, newPath string, newDepth int, subtreeCount int64, pvMoved string, paymentRows int64) (bool, bool, error) {
	before := map[string]any{
		"sponsor_id": target.SponsorID,
		"parent_id":  target.ParentID,
		"position":   target.Position,
		"path":       target.Path,
		"depth":      target.Depth,
	}
	after := map[string]any{
		"sponsor_id": sponsor.ID,
		"parent_id":  newParentID,
		"position":   newPosition,
		"path":       newPath,
		"depth":      newDepth,
	}
	payload := map[string]any{
		"reason":                   in.Reason,
		"requested_by":             in.RequestedBy,
		"old":                      before,
		"new":                      after,
		"subtree_count":            subtreeCount,
		"pv_moved":                 pvMoved,
		"purchase_intents_updated": paymentRows,
	}
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return false, false, fmt.Errorf("tree relocation event payload: %w", err)
	}
	beforeJSON, err := json.Marshal(before)
	if err != nil {
		return false, false, fmt.Errorf("tree relocation audit before: %w", err)
	}
	afterJSON, err := json.Marshal(map[string]any{
		"requested_by":             in.RequestedBy,
		"reason":                   in.Reason,
		"sponsor_id":               sponsor.ID,
		"parent_id":                newParentID,
		"position":                 newPosition,
		"path":                     newPath,
		"depth":                    newDepth,
		"subtree_count":            subtreeCount,
		"pv_moved":                 pvMoved,
		"purchase_intents_updated": paymentRows,
	})
	if err != nil {
		return false, false, fmt.Errorf("tree relocation audit after: %w", err)
	}

	tag, err := tx.Exec(ctx, `
		INSERT INTO mlm.tree_event(external_ref, kind, affiliate_id, payload, occurred_at)
		VALUES ($1, 'position_move', $2, $3::jsonb, now())
	`, "admin:tree_relocation:"+target.Email+":"+uuid.NewString(), target.ID, string(payloadJSON))
	if err != nil {
		return false, false, fmt.Errorf("tree relocation event: %w", err)
	}
	treeEventInserted := tag.RowsAffected() > 0

	tag, err = tx.Exec(ctx, `
		INSERT INTO audit.activity_log(actor_user_id, entity_type, entity_id, action, before_data, after_data)
		VALUES (NULL, 'mlm.affiliate', $1, 'admin_tree_relocation', $2::jsonb, $3::jsonb)
	`, strconv.FormatInt(target.ID, 10), string(beforeJSON), string(afterJSON))
	if err != nil {
		return false, false, fmt.Errorf("tree relocation audit: %w", err)
	}
	return treeEventInserted, tag.RowsAffected() > 0, nil
}

func validateAdminTreeRelocationIntegrity(ctx context.Context, tx pgx.Tx, targetID int64, structureChanged bool) error {
	var badSelfRows int64
	if err := tx.QueryRow(ctx, `
		SELECT count(*)
		  FROM _admin_tree_moved m
		  LEFT JOIN mlm.affiliate_closure c
		    ON c.ancestor_id = m.id
		   AND c.descendant_id = m.id
		   AND c.distance = 0
		 WHERE c.ancestor_id IS NULL
	`).Scan(&badSelfRows); err != nil {
		return fmt.Errorf("tree relocation self closure check: %w", err)
	}
	if badSelfRows != 0 {
		return errAdminTreeRelocation("tree_self_closure_drift", http.StatusConflict)
	}

	var cycles int64
	if err := tx.QueryRow(ctx, `
		SELECT count(*)
		  FROM mlm.affiliate_closure c
		  JOIN _admin_tree_moved m ON m.id = c.descendant_id
		 WHERE c.ancestor_id = c.descendant_id
		   AND c.distance <> 0
	`).Scan(&cycles); err != nil {
		return fmt.Errorf("tree relocation cycle check: %w", err)
	}
	if cycles != 0 {
		return errAdminTreeRelocation("tree_cycle_detected", http.StatusConflict)
	}

	if !structureChanged {
		return nil
	}

	var negative int64
	if err := tx.QueryRow(ctx, `
		WITH affected AS (
			SELECT ancestor_id FROM _admin_tree_old_ancestors
			UNION
			SELECT ancestor_id FROM _admin_tree_new_ancestors
		)
		SELECT count(*)
		  FROM mlm.affiliate a
		  JOIN affected x ON x.ancestor_id = a.id
		 WHERE left_count < 0
		    OR right_count < 0
		    OR left_pv_lifetime < 0
		    OR right_pv_lifetime < 0
		    OR left_pv_current < 0
		    OR right_pv_current < 0
	`).Scan(&negative); err != nil {
		return fmt.Errorf("tree relocation negative aggregate check: %w", err)
	}
	if negative != 0 {
		return errAdminTreeRelocation("negative_aggregate", http.StatusConflict)
	}

	var pvDrift int64
	if err := tx.QueryRow(ctx, `
		WITH affected AS (
			SELECT ancestor_id FROM _admin_tree_old_ancestors
			UNION
			SELECT ancestor_id FROM _admin_tree_new_ancestors
		)
		SELECT count(*)
		  FROM mlm.v_tree_pv_truth v
		  JOIN affected x ON x.ancestor_id = v.id
		 WHERE v.materialized_left <> v.computed_left
		    OR v.materialized_right <> v.computed_right
	`).Scan(&pvDrift); err != nil {
		return fmt.Errorf("tree relocation pv drift check: %w", err)
	}
	if pvDrift != 0 {
		return errAdminTreeRelocation("tree_pv_drift", http.StatusConflict)
	}

	var countDrift int64
	if err := tx.QueryRow(ctx, `
		WITH affected AS (
			SELECT ancestor_id FROM _admin_tree_old_ancestors
			UNION
			SELECT ancestor_id FROM _admin_tree_new_ancestors
		), counted AS (
			SELECT a.id AS ancestor_id,
			       COALESCE(count(*) FILTER (
			         WHERE substring(ltree2text(subpath(d.path, a.depth + 1, 1)) from 1 for 1) = 'L'
			       ), 0) AS left_count,
			       COALESCE(count(*) FILTER (
			         WHERE substring(ltree2text(subpath(d.path, a.depth + 1, 1)) from 1 for 1) = 'R'
			       ), 0) AS right_count
			  FROM affected x
			  JOIN mlm.affiliate a ON a.id = x.ancestor_id
			  LEFT JOIN mlm.affiliate_closure c
			    ON c.ancestor_id = a.id
			   AND c.distance > 0
			  LEFT JOIN mlm.affiliate d ON d.id = c.descendant_id
			 GROUP BY a.id
		)
		SELECT count(*)
		  FROM counted c
		  JOIN mlm.affiliate a ON a.id = c.ancestor_id
		 WHERE a.left_count <> c.left_count
		    OR a.right_count <> c.right_count
	`).Scan(&countDrift); err != nil {
		return fmt.Errorf("tree relocation count drift check: %w", err)
	}
	if countDrift != 0 {
		return errAdminTreeRelocation("tree_count_drift", http.StatusConflict)
	}

	var targetClosure int64
	if err := tx.QueryRow(ctx, `
		SELECT count(*)
		  FROM mlm.affiliate_closure
		 WHERE descendant_id = $1
	`, targetID).Scan(&targetClosure); err != nil {
		return fmt.Errorf("tree relocation target closure check: %w", err)
	}
	if targetClosure == 0 {
		return errAdminTreeRelocation("tree_closure_missing", http.StatusConflict)
	}
	return nil
}
