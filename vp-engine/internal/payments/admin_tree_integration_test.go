package payments

import (
	"context"
	"strconv"
	"testing"
)

func TestListAdminTreeRoots_ShowsConfiguredRootAndNonActiveChildren(t *testing.T) {
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

	if _, err := pool.Exec(ctx, `UPDATE mlm.person SET status = 'suspended' WHERE id = $1`, root.personID); err != nil {
		t.Fatalf("suspend root person: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE mlm.affiliate SET status = 'suspended' WHERE id = $1`, root.affID); err != nil {
		t.Fatalf("suspend root affiliate: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE mlm.affiliate
		   SET left_count = 1,
		       right_count = 1,
		       left_pv_lifetime = 100,
		       right_pv_lifetime = 80
		 WHERE id = $1
	`, root.affID); err != nil {
		t.Fatalf("seed root metrics: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE mlm.person SET status = 'pending' WHERE id = $1`, pendingChild.personID); err != nil {
		t.Fatalf("pend child person: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE mlm.affiliate SET status = 'pending' WHERE id = $1`, pendingChild.affID); err != nil {
		t.Fatalf("pend child affiliate: %v", err)
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
	if !roots[0].Banned {
		t.Fatalf("suspended configured root should be shown with banned=true")
	}
	if !roots[0].HasChildren {
		t.Fatalf("configured root should report visible children")
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

	metrics, _, err := store.BuildNetworkMetrics(ctx, root.affID)
	if err != nil {
		t.Fatalf("BuildNetworkMetrics: %v", err)
	}
	if metrics.LeftMembers != 1 || metrics.RightMembers != 1 {
		t.Fatalf("metrics legs = %d/%d, want 1/1", metrics.LeftMembers, metrics.RightMembers)
	}
	if metrics.LeftVolume != 100 || metrics.RightVolume != 80 {
		t.Fatalf("metrics volumes = %.0f/%.0f, want 100/80", metrics.LeftVolume, metrics.RightVolume)
	}
}
