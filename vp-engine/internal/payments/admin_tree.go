package payments

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

// AdminTreeRankRef es la referencia compacta al rango visible en el explorador.
type AdminTreeRankRef struct {
	Code string `json:"code"`
	Name string `json:"name"`
}

// AdminTreeAffiliateRef es una referencia compacta a sponsor/padre.
type AdminTreeAffiliateRef struct {
	ID     string `json:"id"`
	Handle string `json:"handle"`
	Name   string `json:"name"`
	Email  string `json:"email,omitempty"`
}

// AdminTreeNode es la unidad de navegación del árbol binario del panel admin.
// Es read-only y apta para carga perezosa: roots -> children -> children...
type AdminTreeNode struct {
	ID            string                 `json:"id"`
	ParentID      *string                `json:"parentId"`
	Side          *string                `json:"side"`
	Handle        string                 `json:"handle"`
	Name          string                 `json:"name"`
	Email         string                 `json:"email"`
	Status        string                 `json:"status"`
	Banned        bool                   `json:"banned"`
	Rank          *AdminTreeRankRef      `json:"rank"`
	Sponsor       *AdminTreeAffiliateRef `json:"sponsor,omitempty"`
	HasChildren   bool                   `json:"hasChildren"`
	DownlineTotal int64                  `json:"downlineTotal"`
	LeftCount     int64                  `json:"leftCount"`
	RightCount    int64                  `json:"rightCount"`
	PVLeft        string                 `json:"pvLeft"`
	PVRight       string                 `json:"pvRight"`
	ActivePackage bool                   `json:"activePackage"`
}

// AdminTreeSearchResult devuelve la ruta raíz->nodo para auto-expandir la UI.
type AdminTreeSearchResult struct {
	AdminTreeNode
	Path       []string `json:"path"`
	Revealable bool     `json:"revealable"`
}

func (s *Store) ListAdminTreeRoots(ctx context.Context, companyRoot int64) ([]AdminTreeNode, error) {
	rows, err := s.reader().Query(ctx, `
		WITH visible_affiliates AS (
		  SELECT a.id, a.parent_id, COALESCE(a.depth, 0) AS depth
		    FROM mlm.affiliate a
		    JOIN mlm.person p ON p.id = a.person_id
		   WHERE a.status::text <> 'deleted'
		     AND p.status::text <> 'deleted'
		),
		configured_root AS (
		  SELECT id, 0 AS priority, depth
		    FROM visible_affiliates
		   WHERE id = $1
		     AND $1 > 0
		),
		detached_roots AS (
		  SELECT id, 1 AS priority, depth
		    FROM visible_affiliates
		   WHERE parent_id IS NULL
		     AND NOT EXISTS (SELECT 1 FROM configured_root)
		),
		orphan_roots AS (
		  SELECT a.id, 2 AS priority, a.depth
		    FROM visible_affiliates a
		    LEFT JOIN visible_affiliates parent ON parent.id = a.parent_id
		   WHERE parent.id IS NULL
		     AND NOT EXISTS (SELECT 1 FROM configured_root)
		     AND NOT EXISTS (SELECT 1 FROM detached_roots)
		   ORDER BY a.depth, a.id
		   LIMIT 25
		),
		depth_roots AS (
		  SELECT id, 3 AS priority, depth
		    FROM visible_affiliates
		   WHERE NOT EXISTS (SELECT 1 FROM configured_root)
		     AND NOT EXISTS (SELECT 1 FROM detached_roots)
		     AND NOT EXISTS (SELECT 1 FROM orphan_roots)
		   ORDER BY depth, id
		   LIMIT 25
		),
		root_ids AS (
		  SELECT DISTINCT ON (id) id, priority, depth
		    FROM (
		      SELECT * FROM configured_root
		      UNION ALL
		      SELECT * FROM detached_roots
		      UNION ALL
		      SELECT * FROM orphan_roots
		      UNION ALL
		      SELECT * FROM depth_roots
		    ) candidates
		   ORDER BY id, priority, depth
		),
		selected_roots AS (
		  SELECT id, priority, depth
		    FROM root_ids
		   ORDER BY priority, depth, id
		   LIMIT 25
		)
		SELECT a.id,
		       a.parent_id,
		       a.position::text,
		       COALESCE(NULLIF(a.invitation_link,''), 'MP'||a.id),
		       trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')),
		       p.email::text,
		       p.status::text,
		       COALESCE(p.blacklisted,false),
		       EXISTS (
		         SELECT 1
		           FROM mlm.blacklist b
		          WHERE (b.email_norm IS NOT NULL AND b.email_norm = mlm.norm_email(p.email))
		             OR (b.phone_last10 IS NOT NULL AND b.phone_last10 = mlm.norm_phone10(p.phone_number))
		             OR (b.name_norm IS NOT NULL
		                 AND b.name_norm = mlm.norm_name(p.first_name || ' ' || p.last_name)
		                 AND (b.birthdate IS NULL OR (p.birthday IS NOT NULL AND b.birthdate = p.birthday)))
		       ),
		       a.status::text,
		       r.code,
		       r.name_es,
		       sp.id,
		       COALESCE(NULLIF(sp.invitation_link,''), 'MP'||sp.id),
		       trim(coalesce(spp.first_name,'')||' '||coalesce(spp.last_name,'')),
		       spp.email::text,
		       EXISTS (
		         SELECT 1
		           FROM mlm.affiliate c
		           JOIN mlm.person cp ON cp.id = c.person_id
		          WHERE c.parent_id = a.id
		            AND c.status::text <> 'deleted'
		            AND cp.status::text <> 'deleted'
		       ),
		       COALESCE(a.left_count,0),
		       COALESCE(a.right_count,0),
		       COALESCE(a.left_pv_lifetime,0)::text,
		       COALESCE(a.right_pv_lifetime,0)::text,
		       EXISTS (
		         SELECT 1 FROM mlm.affiliate_package ap
		          WHERE ap.affiliate_id = a.id AND ap.status::text = 'active'
		       )
		  FROM mlm.affiliate a
		  JOIN mlm.person p ON p.id = a.person_id
		  LEFT JOIN mlm.rank r ON r.id = a.current_rank_id
		  LEFT JOIN mlm.affiliate sp ON sp.id = a.sponsor_id
		  LEFT JOIN mlm.person spp ON spp.id = sp.person_id
		  JOIN selected_roots sr ON sr.id = a.id
		 WHERE a.status::text <> 'deleted'
		   AND p.status::text <> 'deleted'
		 ORDER BY sr.priority, sr.depth, a.id
	`, companyRoot)
	if err != nil {
		return nil, fmt.Errorf("admin tree roots: %w", err)
	}
	defer rows.Close()
	return scanAdminTreeNodes(rows)
}

func (s *Store) ListAdminTreeChildren(ctx context.Context, parentID int64) ([]AdminTreeNode, error) {
	rows, err := s.reader().Query(ctx, `
		SELECT a.id,
		       a.parent_id,
		       a.position::text,
		       COALESCE(NULLIF(a.invitation_link,''), 'MP'||a.id),
		       trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')),
		       p.email::text,
		       p.status::text,
		       COALESCE(p.blacklisted,false),
		       EXISTS (
		         SELECT 1
		           FROM mlm.blacklist b
		          WHERE (b.email_norm IS NOT NULL AND b.email_norm = mlm.norm_email(p.email))
		             OR (b.phone_last10 IS NOT NULL AND b.phone_last10 = mlm.norm_phone10(p.phone_number))
		             OR (b.name_norm IS NOT NULL
		                 AND b.name_norm = mlm.norm_name(p.first_name || ' ' || p.last_name)
		                 AND (b.birthdate IS NULL OR (p.birthday IS NOT NULL AND b.birthdate = p.birthday)))
		       ),
		       a.status::text,
		       r.code,
		       r.name_es,
		       sp.id,
		       COALESCE(NULLIF(sp.invitation_link,''), 'MP'||sp.id),
		       trim(coalesce(spp.first_name,'')||' '||coalesce(spp.last_name,'')),
		       spp.email::text,
		       EXISTS (
		         SELECT 1
		           FROM mlm.affiliate c
		           JOIN mlm.person cp ON cp.id = c.person_id
		          WHERE c.parent_id = a.id
		            AND c.status::text <> 'deleted'
		            AND cp.status::text <> 'deleted'
		       ),
		       COALESCE(a.left_count,0),
		       COALESCE(a.right_count,0),
		       COALESCE(a.left_pv_lifetime,0)::text,
		       COALESCE(a.right_pv_lifetime,0)::text,
		       EXISTS (
		         SELECT 1 FROM mlm.affiliate_package ap
		          WHERE ap.affiliate_id = a.id AND ap.status::text = 'active'
		       )
		  FROM mlm.affiliate a
		  JOIN mlm.person p ON p.id = a.person_id
		 LEFT JOIN mlm.rank r ON r.id = a.current_rank_id
		 LEFT JOIN mlm.affiliate sp ON sp.id = a.sponsor_id
		 LEFT JOIN mlm.person spp ON spp.id = sp.person_id
		 WHERE a.parent_id = $1
		   AND a.status::text <> 'deleted'
		   AND p.status::text <> 'deleted'
		 ORDER BY CASE a.position::text WHEN 'L' THEN 1 WHEN 'R' THEN 2 ELSE 3 END, a.id
	`, parentID)
	if err != nil {
		return nil, fmt.Errorf("admin tree children: %w", err)
	}
	defer rows.Close()
	return scanAdminTreeNodes(rows)
}

func (s *Store) ListAdminTreeFull(ctx context.Context, companyRoot int64) ([]AdminTreeNode, error) {
	rows, err := s.reader().Query(ctx, `
		WITH RECURSIVE visible_affiliates AS (
		  SELECT a.id, a.parent_id, a.position::text AS position, COALESCE(a.depth, 0) AS depth
		    FROM mlm.affiliate a
		    JOIN mlm.person p ON p.id = a.person_id
		   WHERE a.status::text <> 'deleted'
		     AND p.status::text <> 'deleted'
		),
		configured_root AS (
		  SELECT id, 0 AS priority, depth
		    FROM visible_affiliates
		   WHERE id = $1
		     AND $1 > 0
		),
		detached_roots AS (
		  SELECT id, 1 AS priority, depth
		    FROM visible_affiliates
		   WHERE parent_id IS NULL
		),
		orphan_roots AS (
		  SELECT a.id, 2 AS priority, a.depth
		    FROM visible_affiliates a
		    LEFT JOIN visible_affiliates parent ON parent.id = a.parent_id
		   WHERE a.parent_id IS NOT NULL
		     AND parent.id IS NULL
		),
		depth_roots AS (
		  SELECT id, 3 AS priority, depth
		    FROM visible_affiliates
		   WHERE NOT EXISTS (SELECT 1 FROM configured_root)
		     AND NOT EXISTS (SELECT 1 FROM detached_roots)
		     AND NOT EXISTS (SELECT 1 FROM orphan_roots)
		   ORDER BY depth, id
		   LIMIT 25
		),
		root_ids AS (
		  SELECT DISTINCT ON (id) id, priority, depth
		    FROM (
		      SELECT * FROM configured_root
		      UNION ALL
		      SELECT * FROM detached_roots
		      UNION ALL
		      SELECT * FROM orphan_roots
		      UNION ALL
		      SELECT * FROM depth_roots
		    ) candidates
		   ORDER BY id, priority, depth
		),
		selected_roots AS (
		  SELECT id, priority, depth
		    FROM root_ids
		   ORDER BY priority, depth, id
		),
		tree AS (
		  SELECT va.id,
		         va.parent_id,
		         sr.priority,
		         ARRAY[va.id]::bigint[] AS path_ids,
		         lpad(sr.priority::text, 2, '0') || ':' ||
		         lpad(va.depth::text, 8, '0') || ':' ||
		         lpad(va.id::text, 20, '0') AS sort_path
		    FROM selected_roots sr
		    JOIN visible_affiliates va ON va.id = sr.id
		  UNION ALL
		  SELECT child.id,
		         child.parent_id,
		         tree.priority,
		         tree.path_ids || child.id,
		         tree.sort_path || '.' ||
		         CASE child.position WHEN 'L' THEN '1' WHEN 'R' THEN '2' ELSE '3' END ||
		         ':' || lpad(child.id::text, 20, '0') AS sort_path
		    FROM visible_affiliates child
		    JOIN tree ON child.parent_id = tree.id
		   WHERE cardinality(tree.path_ids) < 512
		     AND NOT child.id = ANY(tree.path_ids)
		),
		dedup_tree AS (
		  SELECT DISTINCT ON (id) id, priority, sort_path, cardinality(path_ids) AS tree_depth
		    FROM tree
		   ORDER BY id, cardinality(path_ids), priority, sort_path
		)
		SELECT a.id,
		       a.parent_id,
		       a.position::text,
		       COALESCE(NULLIF(a.invitation_link,''), 'MP'||a.id),
		       trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')),
		       p.email::text,
		       p.status::text,
		       COALESCE(p.blacklisted,false),
		       EXISTS (
		         SELECT 1
		           FROM mlm.blacklist b
		          WHERE (b.email_norm IS NOT NULL AND b.email_norm = mlm.norm_email(p.email))
		             OR (b.phone_last10 IS NOT NULL AND b.phone_last10 = mlm.norm_phone10(p.phone_number))
		             OR (b.name_norm IS NOT NULL
		                 AND b.name_norm = mlm.norm_name(p.first_name || ' ' || p.last_name)
		                 AND (b.birthdate IS NULL OR (p.birthday IS NOT NULL AND b.birthdate = p.birthday)))
		       ),
		       a.status::text,
		       r.code,
		       r.name_es,
		       sp.id,
		       COALESCE(NULLIF(sp.invitation_link,''), 'MP'||sp.id),
		       trim(coalesce(spp.first_name,'')||' '||coalesce(spp.last_name,'')),
		       spp.email::text,
		       EXISTS (
		         SELECT 1
		           FROM mlm.affiliate c
		           JOIN mlm.person cp ON cp.id = c.person_id
		          WHERE c.parent_id = a.id
		            AND c.status::text <> 'deleted'
		            AND cp.status::text <> 'deleted'
		       ),
		       COALESCE(a.left_count,0),
		       COALESCE(a.right_count,0),
		       COALESCE(a.left_pv_lifetime,0)::text,
		       COALESCE(a.right_pv_lifetime,0)::text,
		       EXISTS (
		         SELECT 1 FROM mlm.affiliate_package ap
		          WHERE ap.affiliate_id = a.id AND ap.status::text = 'active'
		       )
		  FROM dedup_tree t
		  JOIN mlm.affiliate a ON a.id = t.id
		  JOIN mlm.person p ON p.id = a.person_id
		  LEFT JOIN mlm.rank r ON r.id = a.current_rank_id
		  LEFT JOIN mlm.affiliate sp ON sp.id = a.sponsor_id
		  LEFT JOIN mlm.person spp ON spp.id = sp.person_id
		 WHERE a.status::text <> 'deleted'
		   AND p.status::text <> 'deleted'
		 ORDER BY t.sort_path
	`, companyRoot)
	if err != nil {
		return nil, fmt.Errorf("admin tree full: %w", err)
	}
	defer rows.Close()
	return scanAdminTreeNodes(rows)
}

func (s *Store) SearchAdminTree(ctx context.Context, q string, limit int) ([]AdminTreeSearchResult, error) {
	q = strings.TrimSpace(q)
	if limit <= 0 || limit > 25 {
		limit = 20
	}
	like := "%" + q + "%"
	rows, err := s.reader().Query(ctx, `
		SELECT a.id,
		       a.parent_id,
		       a.position::text,
		       COALESCE(NULLIF(a.invitation_link,''), 'MP'||a.id),
		       trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')),
		       p.email::text,
		       p.status::text,
		       COALESCE(p.blacklisted,false),
		       EXISTS (
		         SELECT 1
		           FROM mlm.blacklist b
		          WHERE (b.email_norm IS NOT NULL AND b.email_norm = mlm.norm_email(p.email))
		             OR (b.phone_last10 IS NOT NULL AND b.phone_last10 = mlm.norm_phone10(p.phone_number))
		             OR (b.name_norm IS NOT NULL
		                 AND b.name_norm = mlm.norm_name(p.first_name || ' ' || p.last_name)
		                 AND (b.birthdate IS NULL OR (p.birthday IS NOT NULL AND b.birthdate = p.birthday)))
		       ),
		       a.status::text,
		       r.code,
		       r.name_es,
		       sp.id,
		       COALESCE(NULLIF(sp.invitation_link,''), 'MP'||sp.id),
		       trim(coalesce(spp.first_name,'')||' '||coalesce(spp.last_name,'')),
		       spp.email::text,
		       EXISTS (
		         SELECT 1
		           FROM mlm.affiliate c
		           JOIN mlm.person cp ON cp.id = c.person_id
		          WHERE c.parent_id = a.id
		            AND c.status::text <> 'deleted'
		            AND cp.status::text <> 'deleted'
		       ),
		       COALESCE(a.left_count,0),
		       COALESCE(a.right_count,0),
		       COALESCE(a.left_pv_lifetime,0)::text,
		       COALESCE(a.right_pv_lifetime,0)::text,
		       EXISTS (
		         SELECT 1 FROM mlm.affiliate_package ap
		          WHERE ap.affiliate_id = a.id AND ap.status::text = 'active'
		       )
		  FROM mlm.affiliate a
		  JOIN mlm.person p ON p.id = a.person_id
		  LEFT JOIN mlm.rank r ON r.id = a.current_rank_id
		  LEFT JOIN mlm.affiliate sp ON sp.id = a.sponsor_id
		  LEFT JOIN mlm.person spp ON spp.id = sp.person_id
		 WHERE a.status::text <> 'deleted'
		   AND p.status::text <> 'deleted'
		   AND (
		         a.id::text = $1
		      OR lower(COALESCE(NULLIF(a.invitation_link,''), 'MP'||a.id)) = lower($1)
		      OR COALESCE(NULLIF(a.invitation_link,''), 'MP'||a.id) ILIKE $2
		      OR p.email::text ILIKE $2
		      OR trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')) ILIKE $2
		   )
		 ORDER BY (lower(p.email::text) = lower($1)) DESC,
		          (lower(COALESCE(NULLIF(a.invitation_link,''), 'MP'||a.id)) = lower($1)) DESC,
		          (p.email::text ILIKE ($1 || '%')) DESC,
		          a.id
		 LIMIT $3
	`, q, like, limit)
	if err != nil {
		return nil, fmt.Errorf("admin tree search: %w", err)
	}
	defer rows.Close()

	nodes, err := scanAdminTreeNodes(rows)
	if err != nil {
		return nil, err
	}
	if len(nodes) == 0 {
		return []AdminTreeSearchResult{}, nil
	}

	ids := make([]int64, 0, len(nodes))
	for _, n := range nodes {
		id, err := strconv.ParseInt(n.ID, 10, 64)
		if err == nil {
			ids = append(ids, id)
		}
	}
	pathByID, revealableByID, err := s.adminTreePaths(ctx, ids)
	if err != nil {
		return nil, err
	}

	out := make([]AdminTreeSearchResult, 0, len(nodes))
	for _, n := range nodes {
		path := pathByID[n.ID]
		if len(path) == 0 {
			path = []string{n.ID}
		}
		out = append(out, AdminTreeSearchResult{
			AdminTreeNode: n,
			Path:          path,
			Revealable:    revealableByID[n.ID] && !n.Banned,
		})
	}
	return out, nil
}

func (s *Store) adminTreePaths(ctx context.Context, ids []int64) (map[string][]string, map[string]bool, error) {
	pathByID := map[string][]string{}
	revealableByID := map[string]bool{}
	if len(ids) == 0 {
		return pathByID, revealableByID, nil
	}
	rows, err := s.reader().Query(ctx, `
		WITH RECURSIVE up AS (
		  SELECT id, parent_id, id AS match_id, 0 AS d
		    FROM mlm.affiliate
		   WHERE id = ANY($1)
		  UNION ALL
		  SELECT a.id, a.parent_id, up.match_id, up.d + 1
		    FROM mlm.affiliate a
		    JOIN up ON a.id = up.parent_id
		   WHERE up.d < 256
		)
		SELECT up.match_id,
		       array_agg(up.id ORDER BY up.d DESC) AS path,
		       bool_and(
		         a.status::text <> 'deleted'
		         AND p.status::text <> 'deleted'
		       ) AS revealable
		  FROM up
		  JOIN mlm.affiliate a ON a.id = up.id
		  JOIN mlm.person p ON p.id = a.person_id
		 GROUP BY up.match_id
	`, ids)
	if err != nil {
		return nil, nil, fmt.Errorf("admin tree paths: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var matchID int64
		var rawPath []int64
		var revealable bool
		if err := rows.Scan(&matchID, &rawPath, &revealable); err != nil {
			return nil, nil, fmt.Errorf("scan admin tree path: %w", err)
		}
		key := strconv.FormatInt(matchID, 10)
		path := make([]string, 0, len(rawPath))
		for _, id := range rawPath {
			path = append(path, strconv.FormatInt(id, 10))
		}
		pathByID[key] = path
		revealableByID[key] = revealable
	}
	return pathByID, revealableByID, rows.Err()
}

func scanAdminTreeNodes(rows pgx.Rows) ([]AdminTreeNode, error) {
	out := []AdminTreeNode{}
	for rows.Next() {
		node, err := scanAdminTreeNode(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, node)
	}
	return out, rows.Err()
}

func scanAdminTreeNode(rows pgx.Rows) (AdminTreeNode, error) {
	var id int64
	var parentID *int64
	var side *string
	var handle, name, email, personStatus, affiliateStatus string
	var blacklisted, listedByBlacklist, hasChildren, activePackage bool
	var rankCode, rankName *string
	var sponsorID *int64
	var sponsorHandle, sponsorName, sponsorEmail *string
	var leftCount, rightCount int64
	var pvLeft, pvRight string

	if err := rows.Scan(
		&id,
		&parentID,
		&side,
		&handle,
		&name,
		&email,
		&personStatus,
		&blacklisted,
		&listedByBlacklist,
		&affiliateStatus,
		&rankCode,
		&rankName,
		&sponsorID,
		&sponsorHandle,
		&sponsorName,
		&sponsorEmail,
		&hasChildren,
		&leftCount,
		&rightCount,
		&pvLeft,
		&pvRight,
		&activePackage,
	); err != nil {
		return AdminTreeNode{}, fmt.Errorf("scan admin tree node: %w", err)
	}

	status := adminTreeDisplayStatus(personStatus, affiliateStatus)
	banned := blacklisted || listedByBlacklist || inactiveTreeStatus(personStatus) || inactiveTreeStatus(affiliateStatus)
	node := AdminTreeNode{
		ID:            strconv.FormatInt(id, 10),
		ParentID:      int64PtrToString(parentID),
		Side:          side,
		Handle:        handle,
		Name:          strings.TrimSpace(name),
		Email:         email,
		Status:        status,
		Banned:        banned,
		HasChildren:   hasChildren,
		DownlineTotal: leftCount + rightCount,
		LeftCount:     leftCount,
		RightCount:    rightCount,
		PVLeft:        pvLeft,
		PVRight:       pvRight,
		ActivePackage: activePackage,
	}
	if node.Name == "" {
		node.Name = "—"
	}
	if rankCode != nil {
		node.Rank = &AdminTreeRankRef{Code: *rankCode, Name: derefStr(rankName)}
	}
	if sponsorID != nil {
		node.Sponsor = &AdminTreeAffiliateRef{
			ID:     strconv.FormatInt(*sponsorID, 10),
			Handle: derefStr(sponsorHandle),
			Name:   strings.TrimSpace(derefStr(sponsorName)),
			Email:  derefStr(sponsorEmail),
		}
	}
	return node, nil
}

func adminTreeDisplayStatus(personStatus, affiliateStatus string) string {
	statuses := []string{affiliateStatus, personStatus}
	for _, target := range []string{"deleted", "banned", "suspended", "pending"} {
		for _, status := range statuses {
			if strings.EqualFold(strings.TrimSpace(status), target) {
				return target
			}
		}
	}
	if strings.TrimSpace(affiliateStatus) != "" {
		return affiliateStatus
	}
	return personStatus
}

func inactiveTreeStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "suspended", "banned", "deleted":
		return true
	default:
		return false
	}
}

func int64PtrToString(v *int64) *string {
	if v == nil {
		return nil
	}
	s := strconv.FormatInt(*v, 10)
	return &s
}

func (h *Handler) handleAdminTreeRoots(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	nodes, err := h.store.ListAdminTreeRoots(r.Context(), h.companyRoot)
	if err != nil {
		h.log.Error().Err(err).Msg("admin tree roots")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"roots": nodes})
}

func (h *Handler) handleAdminTreeFull(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	nodes, err := h.store.ListAdminTreeFull(r.Context(), h.companyRoot)
	if err != nil {
		h.log.Error().Err(err).Msg("admin tree full")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"nodes": nodes})
}

func (h *Handler) handleAdminTreeChildren(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	parentID, err := strconv.ParseInt(strings.TrimSpace(r.URL.Query().Get("parent_id")), 10, 64)
	if err != nil || parentID <= 0 {
		writeErr(w, http.StatusBadRequest, "bad_parent_id")
		return
	}
	children, err := h.store.ListAdminTreeChildren(r.Context(), parentID)
	if err != nil {
		h.log.Error().Err(err).Int64("parent_id", parentID).Msg("admin tree children")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"parentId": strconv.FormatInt(parentID, 10),
		"children": children,
	})
}

func (h *Handler) handleAdminTreeSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) < 2 {
		writeJSON(w, http.StatusOK, map[string]any{"results": []AdminTreeSearchResult{}})
		return
	}
	limit := atoiDefault(r.URL.Query().Get("limit"), 20)
	results, err := h.store.SearchAdminTree(r.Context(), q, limit)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSON(w, http.StatusOK, map[string]any{"results": []AdminTreeSearchResult{}})
			return
		}
		h.log.Error().Err(err).Str("q", q).Msg("admin tree search")
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}
