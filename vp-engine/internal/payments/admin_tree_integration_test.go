package payments

import (
	"context"
	"strconv"
	"testing"
)

func TestListAdminTreeChildren_ReturnsMaskedUnavailableNodes(t *testing.T) {
	if testing.Short() {
		t.Skip("needs DB (Docker); skipped under -short")
	}

	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	store := NewStore(pool)

	root := seedAdminTreeAffiliate(t, ctx, pool, "Root", "Visible", "root-visible@t.local", nil, "", nil, "root-visible")
	activeChild := seedAdminTreeAffiliate(t, ctx, pool, "Active", "Child", "active-child@t.local", &root.affID, "L", &root.affID, "active-child")
	pendingChild := seedAdminTreeAffiliate(t, ctx, pool, "Pending", "Child", "pending-child@t.local", &root.affID, "R", &root.affID, "pending-child")
	suspendedChild := seedAdminTreeAffiliate(t, ctx, pool, "Suspended", "Child", "suspended-child@t.local", &activeChild.affID, "L", &root.affID, "suspended-child")
	blacklistedChild := seedAdminTreeAffiliate(t, ctx, pool, "Blacklisted", "Child", "blacklisted-child@t.local", &activeChild.affID, "R", &root.affID, "blacklisted-child")
	seedAdminTreeAffiliate(t, ctx, pool, "Listed", "Child", "listed-child@t.local", &pendingChild.affID, "L", &root.affID, "listed-child")

	if _, err := pool.Exec(ctx, `UPDATE mlm.person SET status = 'suspended' WHERE id = $1`, suspendedChild.personID); err != nil {
		t.Fatalf("suspend child person: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE mlm.affiliate SET status = 'suspended' WHERE id = $1`, suspendedChild.affID); err != nil {
		t.Fatalf("suspend child affiliate: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE mlm.person SET blacklisted = true WHERE id = $1`, blacklistedChild.personID); err != nil {
		t.Fatalf("blacklist child person: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.blacklist (fullname, name_norm, motive, source)
		VALUES ('Listed Child', mlm.norm_name('Listed Child'), 'tree hide test', 'test')
	`); err != nil {
		t.Fatalf("seed blacklist row: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE mlm.person SET status = 'pending' WHERE id = $1`, pendingChild.personID); err != nil {
		t.Fatalf("pend child person: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE mlm.affiliate SET status = 'pending' WHERE id = $1`, pendingChild.affID); err != nil {
		t.Fatalf("pend child affiliate: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE mlm.affiliate
		   SET current_rank_id = 1,
		       left_pv_current = 120,
		       right_pv_current = 80,
		       left_pv_lifetime = 5120,
		       right_pv_lifetime = 5080
		 WHERE id = $1
	`, root.affID); err != nil {
		t.Fatalf("seed root rank and volume: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE mlm.affiliate
		   SET current_rank_id = 2,
		       left_pv_current = 45,
		       right_pv_current = 30,
		       left_pv_lifetime = 9045,
		       right_pv_lifetime = 9030
		 WHERE id = $1
	`, activeChild.affID); err != nil {
		t.Fatalf("seed active child rank and volume: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE mlm.affiliate
		   SET current_rank_id = 3,
		       left_pv_current = 25,
		       right_pv_current = 15,
		       left_pv_lifetime = 8025,
		       right_pv_lifetime = 8015
		 WHERE id = ANY($1::bigint[])
	`, []int64{suspendedChild.affID, blacklistedChild.affID}); err != nil {
		t.Fatalf("seed unavailable children rank and volume: %v", err)
	}

	roots, err := store.ListAdminTreeRoots(ctx, root.affID)
	if err != nil {
		t.Fatalf("ListAdminTreeRoots: %v", err)
	}
	if len(roots) != 1 {
		t.Fatalf("roots len = %d, want 1 (%v)", len(roots), roots)
	}
	if roots[0].ID != strconv.FormatInt(root.affID, 10) {
		t.Fatalf("root id = %s, want %d", roots[0].ID, root.affID)
	}
	if roots[0].Banned {
		t.Fatalf("active configured root should not be flagged banned")
	}
	if !roots[0].HasChildren {
		t.Fatalf("configured root should report visible children")
	}
	if roots[0].Rank == nil || roots[0].Rank.Name != "Bronce" || roots[0].PVLeft != "120.00" || roots[0].PVRight != "80.00" {
		t.Fatalf("root must return rank and current volume, got %+v", roots[0])
	}

	children, err := store.ListAdminTreeChildren(ctx, root.affID)
	if err != nil {
		t.Fatalf("ListAdminTreeChildren: %v", err)
	}
	wantIDs := map[string]bool{
		strconv.FormatInt(activeChild.affID, 10):  false,
		strconv.FormatInt(pendingChild.affID, 10): false,
	}
	for _, child := range children {
		if _, ok := wantIDs[child.ID]; ok {
			wantIDs[child.ID] = true
		}
	}
	if len(children) != len(wantIDs) {
		t.Fatalf("children len = %d, want %d (%v)", len(children), len(wantIDs), children)
	}
	for id, seen := range wantIDs {
		if !seen {
			t.Fatalf("missing child id %s in %v", id, children)
		}
	}
	for _, child := range children {
		if child.ID == strconv.FormatInt(activeChild.affID, 10) && (child.Rank == nil || child.Rank.Name != "Plata" || child.PVLeft != "45.00" || child.PVRight != "30.00") {
			t.Fatalf("active child must return rank and current volume, got %+v", child)
		}
	}

	activeChildren, err := store.ListAdminTreeChildren(ctx, activeChild.affID)
	if err != nil {
		t.Fatalf("ListAdminTreeChildren active child: %v", err)
	}
	if len(activeChildren) != 2 {
		t.Fatalf("unavailable children len = %d, want 2 (%v)", len(activeChildren), activeChildren)
	}
	for _, child := range activeChildren {
		if !child.Banned || child.Name != "Not Available" || child.Handle != "Not Available" || child.Email != "" || child.Sponsor != nil {
			t.Fatalf("unavailable child must be structurally present and identity-masked: %+v", child)
		}
		if child.Rank == nil || child.Rank.Name != "Oro" || child.PVLeft != "25.00" || child.PVRight != "15.00" {
			t.Fatalf("unavailable child must retain admin rank and current volume: %+v", child)
		}
	}

	pendingChildren, err := store.ListAdminTreeChildren(ctx, pendingChild.affID)
	if err != nil {
		t.Fatalf("ListAdminTreeChildren pending child: %v", err)
	}
	if len(pendingChildren) != 1 || !pendingChildren[0].Banned || pendingChildren[0].Name != "Not Available" {
		t.Fatalf("blacklist-listed child should be masked, got %v", pendingChildren)
	}

	branchRoot, branchChildren, err := store.GetBranchMini(ctx, root.affID)
	if err != nil {
		t.Fatalf("GetBranchMini root: %v", err)
	}
	if branchRoot == nil {
		t.Fatalf("GetBranchMini root = nil")
	}
	if len(branchChildren) != len(wantIDs) {
		t.Fatalf("branch children len = %d, want %d (%v)", len(branchChildren), len(wantIDs), branchChildren)
	}

	hiddenRoot, _, err := store.GetBranchMini(ctx, suspendedChild.affID)
	if err != nil {
		t.Fatalf("GetBranchMini suspended: %v", err)
	}
	if hiddenRoot != nil {
		t.Fatalf("suspended branch root should be hidden, got %+v", hiddenRoot)
	}
}

func TestListAdminTreeFull_ReturnsWholeConfiguredTree(t *testing.T) {
	if testing.Short() {
		t.Skip("needs DB (Docker); skipped under -short")
	}

	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	store := NewStore(pool)

	root := seedAdminTreeAffiliate(t, ctx, pool, "Root", "Full", "root-full@t.local", nil, "", nil, "root-full")
	left := seedAdminTreeAffiliate(t, ctx, pool, "Left", "Full", "left-full@t.local", &root.affID, "L", &root.affID, "left-full")
	right := seedAdminTreeAffiliate(t, ctx, pool, "Right", "Full", "right-full@t.local", &root.affID, "R", &root.affID, "right-full")
	grandchild := seedAdminTreeAffiliate(t, ctx, pool, "Grand", "Full", "grand-full@t.local", &left.affID, "L", &left.affID, "grand-full")
	deletedChild := seedAdminTreeAffiliate(t, ctx, pool, "Deleted", "Full", "deleted-full@t.local", &right.affID, "L", &right.affID, "deleted-full")
	suspendedChild := seedAdminTreeAffiliate(t, ctx, pool, "Suspended", "Full", "suspended-full@t.local", &right.affID, "R", &right.affID, "suspended-full")
	blacklistedChild := seedAdminTreeAffiliate(t, ctx, pool, "Blacklisted", "Full", "blacklisted-full@t.local", &left.affID, "R", &left.affID, "blacklisted-full")
	detachedRoot := seedAdminTreeAffiliate(t, ctx, pool, "Detached", "Root", "detached-full@t.local", nil, "", nil, "detached-full")
	detachedChild := seedAdminTreeAffiliate(t, ctx, pool, "Detached", "Child", "detached-child-full@t.local", &detachedRoot.affID, "R", &detachedRoot.affID, "detached-child-full")
	listedChild := seedAdminTreeAffiliate(t, ctx, pool, "Listed", "Full", "listed-full@t.local", &detachedChild.affID, "L", &detachedRoot.affID, "listed-full")

	if _, err := pool.Exec(ctx, `UPDATE mlm.person SET status = 'pending' WHERE id = $1`, grandchild.personID); err != nil {
		t.Fatalf("pend grandchild person: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE mlm.affiliate SET status = 'pending' WHERE id = $1`, grandchild.affID); err != nil {
		t.Fatalf("pend grandchild affiliate: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE mlm.affiliate SET status = 'deleted' WHERE id = $1`, deletedChild.affID); err != nil {
		t.Fatalf("delete child affiliate: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE mlm.person SET status = 'suspended' WHERE id = $1`, suspendedChild.personID); err != nil {
		t.Fatalf("suspend child person: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE mlm.person SET blacklisted = true WHERE id = $1`, blacklistedChild.personID); err != nil {
		t.Fatalf("blacklist child person: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.blacklist (fullname, name_norm, motive, source)
		VALUES ('Listed Full', mlm.norm_name('Listed Full'), 'tree full hide test', 'test')
	`); err != nil {
		t.Fatalf("seed blacklist row: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE mlm.affiliate
		   SET current_rank_id = 4,
		       left_pv_current = 70,
		       right_pv_current = 60,
		       left_pv_lifetime = 7070,
		       right_pv_lifetime = 7060
		 WHERE id = $1
	`, grandchild.affID); err != nil {
		t.Fatalf("seed full-tree rank and volume: %v", err)
	}

	nodes, err := store.ListAdminTreeFull(ctx, root.affID)
	if err != nil {
		t.Fatalf("ListAdminTreeFull: %v", err)
	}
	wantIDs := map[string]bool{
		strconv.FormatInt(root.affID, 10):             false,
		strconv.FormatInt(left.affID, 10):             false,
		strconv.FormatInt(right.affID, 10):            false,
		strconv.FormatInt(grandchild.affID, 10):       false,
		strconv.FormatInt(deletedChild.affID, 10):     false,
		strconv.FormatInt(suspendedChild.affID, 10):   false,
		strconv.FormatInt(blacklistedChild.affID, 10): false,
		strconv.FormatInt(detachedRoot.affID, 10):     false,
		strconv.FormatInt(detachedChild.affID, 10):    false,
		strconv.FormatInt(listedChild.affID, 10):      false,
	}
	nodesByID := map[string]AdminTreeNode{}
	for _, node := range nodes {
		nodesByID[node.ID] = node
		if _, ok := wantIDs[node.ID]; ok {
			wantIDs[node.ID] = true
		}
	}
	if len(nodes) != len(wantIDs) {
		t.Fatalf("nodes len = %d, want %d (%v)", len(nodes), len(wantIDs), nodes)
	}
	for id, seen := range wantIDs {
		if !seen {
			t.Fatalf("missing node id %s in %v", id, nodes)
		}
	}
	for _, id := range []int64{deletedChild.affID, suspendedChild.affID, blacklistedChild.affID, listedChild.affID} {
		node := nodesByID[strconv.FormatInt(id, 10)]
		if !node.Banned || node.Name != "Not Available" || node.Email != "" {
			t.Fatalf("unavailable full-tree node must be masked: %+v", node)
		}
	}
	if !nodesByID[strconv.FormatInt(root.affID, 10)].HasChildren || !nodesByID[strconv.FormatInt(left.affID, 10)].HasChildren {
		t.Fatalf("root and left child should report visible descendants (%v)", nodes)
	}
	if nodesByID[strconv.FormatInt(grandchild.affID, 10)].Status != "pending" {
		t.Fatalf("grandchild status = %s, want pending", nodesByID[strconv.FormatInt(grandchild.affID, 10)].Status)
	}
	grandchildNode := nodesByID[strconv.FormatInt(grandchild.affID, 10)]
	if grandchildNode.Rank == nil || grandchildNode.Rank.Name != "Platino" || grandchildNode.PVLeft != "70.00" || grandchildNode.PVRight != "60.00" {
		t.Fatalf("full tree must return rank and current volume, got %+v", grandchildNode)
	}
	if !nodesByID[strconv.FormatInt(right.affID, 10)].HasChildren {
		t.Fatalf("right child should report its unavailable children")
	}
}

func TestSearchAdminTree_HidesBannedAndBlacklistedNodes(t *testing.T) {
	if testing.Short() {
		t.Skip("needs DB (Docker); skipped under -short")
	}

	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	store := NewStore(pool)

	root := seedAdminTreeAffiliate(t, ctx, pool, "Root", "Search", "root-search@t.local", nil, "", nil, "root-search")
	visible := seedAdminTreeAffiliate(t, ctx, pool, "Needle", "Visible", "needle-visible@t.local", &root.affID, "L", &root.affID, "needle-visible")
	banned := seedAdminTreeAffiliate(t, ctx, pool, "Needle", "Banned", "needle-banned@t.local", &root.affID, "R", &root.affID, "needle-banned")
	blacklisted := seedAdminTreeAffiliate(t, ctx, pool, "Needle", "Blacklisted", "needle-blacklisted@t.local", &visible.affID, "L", &root.affID, "needle-blacklisted")

	if _, err := pool.Exec(ctx, `UPDATE mlm.person SET status = 'banned' WHERE id = $1`, banned.personID); err != nil {
		t.Fatalf("ban person: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE mlm.person SET blacklisted = true WHERE id = $1`, blacklisted.personID); err != nil {
		t.Fatalf("blacklist person: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE mlm.affiliate
		   SET current_rank_id = 5,
		       left_pv_current = 90,
		       right_pv_current = 75,
		       left_pv_lifetime = 9090,
		       right_pv_lifetime = 9075
		 WHERE id = $1
	`, visible.affID); err != nil {
		t.Fatalf("seed searchable rank and volume: %v", err)
	}

	results, err := store.SearchAdminTree(ctx, "needle", 20)
	if err != nil {
		t.Fatalf("SearchAdminTree: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("results len = %d, want 1 (%v)", len(results), results)
	}
	if results[0].ID != strconv.FormatInt(visible.affID, 10) {
		t.Fatalf("result id = %s, want %d", results[0].ID, visible.affID)
	}
	if results[0].Rank == nil || results[0].Rank.Name != "Zafiro" || results[0].PVLeft != "90.00" || results[0].PVRight != "75.00" {
		t.Fatalf("search result must return rank and current volume, got %+v", results[0])
	}
}
