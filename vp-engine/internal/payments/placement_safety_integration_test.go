package payments

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPlacementSafety_Integration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	store := NewStore(pool)
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.package(id, name, amount_usd, pv, type)
		VALUES (1201, 'Placement test', 1000, 500, 'enrollment')
	`); err != nil {
		t.Fatal(err)
	}

	t.Run("normalization works outside extension search path", func(t *testing.T) {
		migration, err := os.ReadFile(filepath.Join(findRepoRoot(t), "_meta/migration/68_blacklist_normalization_schema.sql"))
		if err != nil {
			t.Fatal(err)
		}
		// pgContainer already applied it once; repeated deployment must be safe.
		if err := applySchema(ctx, pool, string(migration)); err != nil {
			t.Fatalf("reapply normalization migration: %v", err)
		}
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, `SET LOCAL search_path TO pg_catalog`); err != nil {
			t.Fatal(err)
		}
		var name string
		if err := tx.QueryRow(ctx, `SELECT mlm.norm_name($1)`, "  Jos\u00e9   P\u00e9rez  ").Scan(&name); err != nil || name != "jose perez" {
			t.Fatalf("normalizer depends on caller search_path: name=%q err=%v", name, err)
		}
	})

	t.Run("simultaneous purchases keep one buyer position", func(t *testing.T) {
		root := seedAdminTreeAffiliate(t, ctx, pool, "Concurrent", "Root", "concurrent-root@t.local", nil, "", nil, "concurrent-root")
		personID := seedPlacementBuyer(t, ctx, pool, "concurrent-buyer@t.local")
		for i := 0; i < 2; i++ {
			seedPlacementIntent(t, ctx, pool, personID, root.affID, "concurrent-buyer@t.local", fmt.Sprintf("cs_concurrent_%d", i), "L")
		}

		// Hold the sponsor lock so both webhooks reach placement before release.
		blocker, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer blocker.Rollback(ctx)
		if _, err := blocker.Exec(ctx, `SELECT pg_advisory_xact_lock(2, $1::int)`, root.affID); err != nil {
			t.Fatal(err)
		}
		runCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		type outcome struct {
			result ActivationResult
			err    error
		}
		results := make(chan outcome, 2)
		for i := 0; i < 2; i++ {
			go func(i int) {
				result, err := store.ActivatePaidPurchase(runCtx, fmt.Sprintf("cs_concurrent_%d", i), fmt.Sprintf("pi_concurrent_%d", i))
				results <- outcome{result, err}
			}(i)
		}
		deadline := time.Now().Add(5 * time.Second)
		blocked := 0
		for time.Now().Before(deadline) {
			if err := pool.QueryRow(ctx, `
				SELECT count(*) FROM pg_stat_activity
				 WHERE datname = current_database() AND wait_event_type = 'Lock'
			`).Scan(&blocked); err != nil {
				t.Fatal(err)
			}
			if blocked >= 2 {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		if err := blocker.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		var affiliateID int64
		for i := 0; i < 2; i++ {
			out := <-results
			if out.err != nil || out.result.Status != "activated" {
				t.Errorf("activation %d: result=%+v err=%v", i, out.result, out.err)
				continue
			}
			if affiliateID != 0 && affiliateID != out.result.AffiliateID {
				t.Errorf("buyer got two positions: %d and %d", affiliateID, out.result.AffiliateID)
			}
			affiliateID = out.result.AffiliateID
		}
		if blocked < 2 {
			t.Fatalf("concurrency barrier did not catch both webhooks: %d", blocked)
		}
		var affiliates, packages, enrollments, credits int
		if err := pool.QueryRow(ctx, `
			SELECT (SELECT count(*) FROM mlm.affiliate WHERE person_id = $1),
			       (SELECT count(*) FROM mlm.affiliate_package WHERE affiliate_id = $2),
			       (SELECT count(*) FROM mlm.tree_event WHERE affiliate_id = $2 AND kind = 'enrollment'),
			       (SELECT count(*) FROM mlm.tree_event WHERE affiliate_id = $2 AND kind = 'pv_credit')
		`, personID, affiliateID).Scan(&affiliates, &packages, &enrollments, &credits); err != nil {
			t.Fatal(err)
		}
		if affiliates != 1 || packages != 2 || enrollments != 1 || credits != 2 {
			t.Fatalf("affiliates/packages/enrollments/credits = %d/%d/%d/%d", affiliates, packages, enrollments, credits)
		}
		assertAdminTreeParent(t, ctx, pool, affiliateID, root.affID, "L")
		assertAdminTreeAgg(t, ctx, pool, root.affID, 1, 0, "1000.00", "0.00")
	})

	t.Run("blacklist-only sponsor cannot receive new placement", func(t *testing.T) {
		root := seedAdminTreeAffiliate(t, ctx, pool, "Listed", "Sponsor", "listed-sponsor@t.local", nil, "", nil, "listed-sponsor")
		buyerID := seedPlacementBuyer(t, ctx, pool, "listed-sponsor-buyer@t.local")
		seedPlacementIntent(t, ctx, pool, buyerID, root.affID, "listed-sponsor-buyer@t.local", "cs_listed_sponsor", "R")
		if _, err := store.RecordRegistrationReferral(ctx, "listed-sponsor-buyer@t.local", "listed-sponsor", "R"); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO mlm.blacklist(fullname, name_norm, motive, source)
			VALUES ('Listed Sponsor', mlm.norm_name('Listed Sponsor'), 'test', 'test')
		`); err != nil {
			t.Fatal(err)
		}
		eligible, err := store.SponsorCanReceivePlacement(ctx, root.affID)
		if err != nil || eligible {
			t.Errorf("blacklist-only sponsor eligible=%v err=%v", eligible, err)
		}
		registered, err := store.LookupRegistrationReferral(ctx, "listed-sponsor-buyer@t.local")
		if err != nil || registered != nil {
			t.Errorf("stored referral must not bypass sponsor ban: %+v err=%v", registered, err)
		}
		for _, code := range []string{"listed-sponsor", "LISTED-SPONSOR", fmt.Sprintf("MP%d", root.affID)} {
			sponsor, err := store.ResolveSponsorByCode(ctx, code)
			if err != nil || sponsor != nil {
				t.Errorf("blocked sponsor code %q resolved=%v err=%v", code, sponsor, err)
			}
		}
		result, err := store.ActivatePaidPurchase(ctx, "cs_listed_sponsor", "pi_listed_sponsor")
		if err != nil || result.Status != "needs_placement" {
			t.Errorf("paid activation should await review: %+v err=%v", result, err)
		}
		var paid bool
		var affiliates int
		if err := pool.QueryRow(ctx, `
			SELECT paid_at IS NOT NULL,
			       (SELECT count(*) FROM mlm.affiliate WHERE person_id = $1)
			  FROM payments.purchase_intent WHERE stripe_session_id = 'cs_listed_sponsor'
		`, buyerID).Scan(&paid, &affiliates); err != nil {
			t.Fatal(err)
		}
		if !paid || affiliates != 0 {
			t.Fatalf("payment must be kept without an invalid placement: paid=%v affiliates=%d", paid, affiliates)
		}
	})

	t.Run("old checkout email cannot bypass the buyer ban", func(t *testing.T) {
		root := seedAdminTreeAffiliate(t, ctx, pool, "Email", "Root", "email-root@t.local", nil, "", nil, "email-root")
		buyerID := seedPlacementBuyer(t, ctx, pool, "old-buyer@t.local")
		seedPlacementIntent(t, ctx, pool, buyerID, root.affID, "old-buyer@t.local", "cs_stale_email", "R")
		if _, err := pool.Exec(ctx, `UPDATE mlm.person SET email = 'renamed-buyer@t.local' WHERE id = $1`, buyerID); err != nil {
			t.Fatal(err)
		}
		if err := store.SetBlocked(ctx, buyerID, true); err != nil {
			t.Fatal(err)
		}
		result, err := store.ActivatePaidPurchase(ctx, "cs_stale_email", "pi_stale_email")
		if err != nil || result.Status != "security_blocked" {
			t.Fatalf("buyer must be checked by authoritative person: %+v err=%v", result, err)
		}
		var affiliates, credits int
		var paid bool
		if err := pool.QueryRow(ctx, `
			SELECT paid_at IS NOT NULL,
			       (SELECT count(*) FROM mlm.affiliate WHERE person_id = $1),
			       (SELECT count(*) FROM mlm.tree_event WHERE external_ref = 'package_purchase:pi_stale_email')
			  FROM payments.purchase_intent WHERE stripe_session_id = 'cs_stale_email'
		`, buyerID).Scan(&paid, &affiliates, &credits); err != nil {
			t.Fatal(err)
		}
		if !paid || affiliates != 0 || credits != 0 {
			t.Fatalf("security-blocked purchase produced enrollment or PV: paid=%v affiliates=%d credits=%d", paid, affiliates, credits)
		}
	})

	for _, side := range []string{"L", "R"} {
		t.Run("explicit "+side+" chain and automatic weak-leg", func(t *testing.T) {
			prefix := "side-" + side
			root := seedAdminTreeAffiliate(t, ctx, pool, prefix, "Root", prefix+"-root@t.local", nil, "", nil, prefix)
			parent := root.affID
			for i, requested := range []string{side, side, ""} {
				email := fmt.Sprintf("%s-%d@t.local", prefix, i)
				session := fmt.Sprintf("cs_%s_%d", prefix, i)
				buyerID := seedPlacementBuyer(t, ctx, pool, email)
				seedPlacementIntent(t, ctx, pool, buyerID, root.affID, email, session, requested)
				result, err := store.ActivatePaidPurchase(ctx, session, fmt.Sprintf("pi_%s_%d", prefix, i))
				if err != nil || result.Status != "activated" {
					t.Fatalf("placement %d: %+v err=%v", i, result, err)
				}
				wantSide := side
				if requested == "" {
					parent = root.affID
					wantSide = "L"
					if side == "L" {
						wantSide = "R"
					}
				}
				assertAdminTreeParent(t, ctx, pool, result.AffiliateID, parent, wantSide)
				assertAdminTreeSponsor(t, ctx, pool, result.AffiliateID, root.affID)
				parent = result.AffiliateID
			}
		})
	}

	t.Run("overlapping sponsors allocate distinct slots concurrently", func(t *testing.T) {
		root := seedAdminTreeAffiliate(t, ctx, pool, "Overlap", "Root", "overlap-root@t.local", nil, "", nil, "overlap-root")
		left := seedAdminTreeAffiliate(t, ctx, pool, "Overlap", "Left", "overlap-left@t.local", &root.affID, "L", &root.affID, "overlap-left")
		const buyers = 12
		type purchase struct {
			email, session string
			sponsor        int64
		}
		purchases := make([]purchase, buyers)
		for i := range purchases {
			email := fmt.Sprintf("overlap-%d@t.local", i)
			sponsor := root.affID
			if i%2 == 1 {
				sponsor = left.affID
			}
			purchases[i] = purchase{email, fmt.Sprintf("cs_overlap_%d", i), sponsor}
			buyerID := seedPlacementBuyer(t, ctx, pool, email)
			seedPlacementIntent(t, ctx, pool, buyerID, sponsor, email, purchases[i].session, "L")
		}
		runCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		start := make(chan struct{})
		results := make(chan error, buyers)
		for i, p := range purchases {
			go func(i int, p purchase) {
				<-start
				result, err := store.ActivatePaidPurchase(runCtx, p.session, fmt.Sprintf("pi_overlap_%d", i))
				if err == nil && result.Status != "activated" {
					err = fmt.Errorf("unexpected activation: %+v", result)
				}
				results <- err
			}(i, p)
		}
		close(start)
		for range purchases {
			if err := <-results; err != nil {
				t.Error(err)
			}
		}
		var activated, valid int
		if err := pool.QueryRow(ctx, `
			SELECT count(*), count(*) FILTER (
			         WHERE a.sponsor_id = pi.sponsor_affiliate_id
			           AND a.path = parent.path || text2ltree(a.position::text || '_' || a.id::text)
			           AND a.depth = parent.depth + 1
			           AND EXISTS (SELECT 1 FROM mlm.affiliate_closure c
			                        WHERE c.ancestor_id = $1 AND c.descendant_id = a.id AND c.distance > 0))
			  FROM payments.purchase_intent pi
			  JOIN mlm.affiliate a ON a.id = pi.affiliate_id
			  JOIN mlm.affiliate parent ON parent.id = a.parent_id
			 WHERE pi.stripe_session_id LIKE 'cs_overlap_%' AND pi.status = 'activated'
		`, root.affID).Scan(&activated, &valid); err != nil {
			t.Fatal(err)
		}
		if activated != buyers || valid != buyers {
			t.Fatalf("concurrent placements: activated=%d valid=%d want=%d", activated, valid, buyers)
		}
	})

	t.Run("blocked roots remain navigable and descendants never move", func(t *testing.T) {
		root := seedAdminTreeAffiliate(t, ctx, pool, "Blocked", "Root", "blocked-root@t.local", nil, "", nil, "blocked-root")
		child := seedAdminTreeAffiliate(t, ctx, pool, "Visible", "Descendant", "visible-descendant@t.local", &root.affID, "R", &root.affID, "visible-descendant")
		var pathBefore string
		if err := pool.QueryRow(ctx, `SELECT path::text FROM mlm.affiliate WHERE id = $1`, child.affID).Scan(&pathBefore); err != nil {
			t.Fatal(err)
		}
		if err := store.SetBlocked(ctx, root.personID, true); err != nil {
			t.Fatal(err)
		}
		roots, err := store.ListAdminTreeRoots(ctx, root.affID)
		if err != nil {
			t.Fatal(err)
		}
		if len(roots) != 1 || roots[0].ID != strconv.FormatInt(root.affID, 10) || !roots[0].Banned || roots[0].Name != "Not Available" || !roots[0].HasChildren {
			t.Errorf("blocked root disappeared instead of being masked: %+v", roots)
		}
		children, err := store.ListAdminTreeChildren(ctx, root.affID)
		if err != nil || len(children) != 1 || children[0].ID != strconv.FormatInt(child.affID, 10) || children[0].Banned {
			t.Errorf("active descendant must remain reachable: %+v err=%v", children, err)
		}
		assertAdminTreeParent(t, ctx, pool, child.affID, root.affID, "R")
		assertAdminTreeClosure(t, ctx, pool, root.affID, child.affID, 1)
		var unchanged bool
		if err := pool.QueryRow(ctx, `SELECT path::text = $2 FROM mlm.affiliate WHERE id = $1`, child.affID, pathBefore).Scan(&unchanged); err != nil || !unchanged {
			t.Errorf("ban changed descendant path: unchanged=%v err=%v", unchanged, err)
		}
	})

	t.Run("spillover traverses a blocked node without replacing it", func(t *testing.T) {
		root := seedAdminTreeAffiliate(t, ctx, pool, "Spillover", "Root", "spillover-root@t.local", nil, "", nil, "spillover-root")
		blocked := seedAdminTreeAffiliate(t, ctx, pool, "Blocked", "Middle", "blocked-middle@t.local", &root.affID, "L", &root.affID, "blocked-middle")
		if err := store.SetBlocked(ctx, blocked.personID, true); err != nil {
			t.Fatal(err)
		}
		buyerID := seedPlacementBuyer(t, ctx, pool, "below-blocked@t.local")
		seedPlacementIntent(t, ctx, pool, buyerID, root.affID, "below-blocked@t.local", "cs_below_blocked", "L")
		result, err := store.ActivatePaidPurchase(ctx, "cs_below_blocked", "pi_below_blocked")
		if err != nil || result.Status != "activated" {
			t.Fatalf("spillover activation: %+v err=%v", result, err)
		}
		assertAdminTreeParent(t, ctx, pool, blocked.affID, root.affID, "L")
		assertAdminTreeParent(t, ctx, pool, result.AffiliateID, blocked.affID, "L")
		assertAdminTreeSponsor(t, ctx, pool, result.AffiliateID, root.affID)
		assertAdminTreeClosure(t, ctx, pool, root.affID, result.AffiliateID, 2)
		children, err := store.ListAdminTreeChildren(ctx, root.affID)
		if err != nil || len(children) != 1 || children[0].ID != strconv.FormatInt(blocked.affID, 10) || children[0].Name != "Not Available" || !children[0].HasChildren {
			t.Fatalf("blocked structural node lost: %+v err=%v", children, err)
		}
	})

	t.Run("search does not reveal a cyclic or incomplete path", func(t *testing.T) {
		root := seedAdminTreeAffiliate(t, ctx, pool, "Cycle", "Root", "cycle-root@t.local", nil, "", nil, "cycle-root")
		child := seedAdminTreeAffiliate(t, ctx, pool, "Cycle", "Child", "cycle-child@t.local", &root.affID, "L", &root.affID, "cycle-child")
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, `UPDATE mlm.affiliate SET parent_id = $2, position = 'L' WHERE id = $1`, root.affID, child.affID); err != nil {
			t.Fatal(err)
		}
		// adminTreePaths reads through Store, so use a committed corruption only
		// in this disposable fixture and restore it before later checks.
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if _, err := pool.Exec(ctx, `UPDATE mlm.affiliate SET parent_id = NULL, position = NULL WHERE id = $1`, root.affID); err != nil {
				t.Error(err)
			}
		}()
		paths, revealable, err := store.adminTreePaths(ctx, []int64{child.affID})
		key := strconv.FormatInt(child.affID, 10)
		if err != nil || revealable[key] || len(paths[key]) != 2 {
			t.Fatalf("cyclic path must be bounded and not revealable: paths=%v revealable=%v err=%v", paths, revealable, err)
		}
	})
}

func seedPlacementBuyer(t *testing.T, ctx context.Context, pool *pgxpool.Pool, email string) int64 {
	t.Helper()
	var id int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mlm.person(first_name, last_name, email, phone_number, status)
		VALUES ('Placement', $1::text, $1::text, '0', 'active') RETURNING id
	`, email).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func seedPlacementIntent(t *testing.T, ctx context.Context, pool *pgxpool.Pool, personID, sponsorID int64, email, session, side string) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO payments.purchase_intent
		  (user_id, person_id, sponsor_affiliate_id, preferred_side, package_id, pv,
		   amount_usd, fee_usd, total_cents, currency, status, stripe_session_id)
		VALUES ($1, $2, $3, NULLIF($4,''), 1201, 500, 1000, 10, 101000, 'usd', 'created', $5)
	`, email, personID, sponsorID, side, session); err != nil {
		t.Fatal(err)
	}
}
