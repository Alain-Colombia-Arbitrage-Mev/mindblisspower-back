package payments

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestAdminTreeRelocation_SubtreeMoveIntegration(t *testing.T) {
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()

	store := NewStore(pool)

	root := seedAdminTreeAffiliate(t, ctx, pool, "Root", "User", "root-tree@t.local", nil, "", nil, "root-code")
	oldSponsor := seedAdminTreeAffiliate(t, ctx, pool, "Old", "Sponsor", "old-sponsor@t.local", &root.affID, "L", &root.affID, "old-code")
	newSponsor := seedAdminTreeAffiliate(t, ctx, pool, "New", "Sponsor", "new-sponsor@t.local", &root.affID, "R", &root.affID, "new-code")
	target := seedAdminTreeAffiliate(t, ctx, pool, "Move", "Target", "move-target@t.local", &oldSponsor.affID, "L", &oldSponsor.affID, "target-code")
	child := seedAdminTreeAffiliate(t, ctx, pool, "Move", "Child", "move-child@t.local", &target.affID, "L", &target.affID, "child-code")

	for _, a := range []adminTreeTestAffiliate{oldSponsor, newSponsor, target, child} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO mlm.tree_event(external_ref, kind, affiliate_id, occurred_at)
			VALUES ($1, 'enrollment', $2, now())
		`, "enroll:test:"+a.email, a.affID); err != nil {
			t.Fatalf("seed enrollment %s: %v", a.email, err)
		}
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO mlm.tree_event(external_ref, kind, affiliate_id, pv_delta_left, occurred_at)
		VALUES ('pv:test:target', 'pv_credit', $1, 100, now()),
		       ('pv:test:child', 'pv_credit', $2, 50, now())
	`, target.affID, child.affID); err != nil {
		t.Fatalf("seed pv events: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO payments.purchase_intent
			(user_id, person_id, affiliate_id, sponsor_affiliate_id, referral_code,
			 package_id, pv, amount_usd, fee_usd, total_cents, currency, status)
		VALUES ($1, $2, $3, $4, 'old-code', 1001, 500, 1000, 10, 101000, 'usd', 'activated')
	`, target.email, target.personID, target.affID, oldSponsor.affID); err != nil {
		t.Fatalf("seed purchase intent: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO payments.registration_referral(email_norm, referral_code, sponsor_affiliate_id, source)
		VALUES (lower($1), 'old-code', $2, 'test')
	`, target.email, oldSponsor.affID); err != nil {
		t.Fatalf("seed registration referral: %v", err)
	}

	preview, err := store.PreviewOrMoveAdminTreeRelocation(ctx, AdminTreeRelocationInput{
		PersonID:    target.personID,
		NewSponsor:  "new-code",
		Reason:      "corregir sponsor directo de prueba",
		DryRun:      true,
		RequestedBy: "root@example.com",
	})
	if err != nil {
		t.Fatalf("preview relocation: %v", err)
	}
	if !preview.Changed || preview.SubtreeCount != 2 || preview.PVMoved != "150.00" {
		t.Fatalf("unexpected preview: changed=%v subtree=%d pv=%s", preview.Changed, preview.SubtreeCount, preview.PVMoved)
	}
	assertAdminTreeParent(t, ctx, pool, target.affID, oldSponsor.affID, "L")

	applied, err := store.PreviewOrMoveAdminTreeRelocation(ctx, AdminTreeRelocationInput{
		PersonID:    target.personID,
		NewSponsor:  "new-code",
		Reason:      "corregir sponsor directo de prueba",
		DryRun:      false,
		RequestedBy: "root@example.com",
	})
	if err != nil {
		t.Fatalf("apply relocation: %v", err)
	}
	if !applied.OK || applied.DryRun || !applied.Changed {
		t.Fatalf("unexpected apply summary: ok=%v dry_run=%v changed=%v", applied.OK, applied.DryRun, applied.Changed)
	}
	if applied.PurchaseIntentsUpdated != 1 || !applied.RegistrationReferralUpdated || !applied.TreeEventInserted || !applied.AuditInserted {
		t.Fatalf("unexpected side effects: pi=%d rr=%v event=%v audit=%v",
			applied.PurchaseIntentsUpdated, applied.RegistrationReferralUpdated, applied.TreeEventInserted, applied.AuditInserted)
	}

	assertAdminTreeParent(t, ctx, pool, target.affID, newSponsor.affID, "L")
	assertAdminTreeParent(t, ctx, pool, child.affID, target.affID, "L")
	assertAdminTreeSponsor(t, ctx, pool, target.affID, newSponsor.affID)
	assertAdminTreeClosure(t, ctx, pool, newSponsor.affID, target.affID, 1)
	assertAdminTreeClosure(t, ctx, pool, newSponsor.affID, child.affID, 2)
	assertAdminTreeClosureMissing(t, ctx, pool, oldSponsor.affID, target.affID)

	assertAdminTreeAgg(t, ctx, pool, root.affID, 1, 3, "0.00", "150.00")
	assertAdminTreeAgg(t, ctx, pool, oldSponsor.affID, 0, 0, "0.00", "0.00")
	assertAdminTreeAgg(t, ctx, pool, newSponsor.affID, 2, 0, "150.00", "0.00")

	var piSponsor int64
	var piCode string
	if err := pool.QueryRow(ctx, `
		SELECT sponsor_affiliate_id, referral_code
		  FROM payments.purchase_intent
		 WHERE affiliate_id = $1
	`, target.affID).Scan(&piSponsor, &piCode); err != nil {
		t.Fatalf("purchase intent after: %v", err)
	}
	if piSponsor != newSponsor.affID || piCode != "new-code" {
		t.Fatalf("purchase intent sponsor/code = %d/%s, want %d/new-code", piSponsor, piCode, newSponsor.affID)
	}

	var rrSponsor int64
	if err := pool.QueryRow(ctx, `
		SELECT sponsor_affiliate_id
		  FROM payments.registration_referral
		 WHERE email_norm = lower($1)
	`, target.email).Scan(&rrSponsor); err != nil {
		t.Fatalf("registration referral after: %v", err)
	}
	if rrSponsor != newSponsor.affID {
		t.Fatalf("registration sponsor = %d, want %d", rrSponsor, newSponsor.affID)
	}
	assertAdminTreeNoDrift(t, ctx, pool)
}

type adminTreeTestAffiliate struct {
	personID int64
	affID    int64
	email    string
}

func seedAdminTreeAffiliate(t *testing.T, ctx context.Context, q *pgxpool.Pool, first, last, email string, parentID *int64, position string, sponsorID *int64, handle string) adminTreeTestAffiliate {
	t.Helper()
	var personID int64
	if err := q.QueryRow(ctx, `
		INSERT INTO mlm.person(first_name, last_name, email, phone_number, status)
		VALUES ($1, $2, $3, '0', 'active')
		RETURNING id
	`, first, last, email).Scan(&personID); err != nil {
		t.Fatalf("seed person %s: %v", email, err)
	}
	var affID int64
	if parentID == nil {
		if err := q.QueryRow(ctx, `
			INSERT INTO mlm.affiliate(person_id, parent_id, position, sponsor_id, invitation_link, path, depth, status)
			VALUES ($1, NULL, NULL, NULL, $2, ''::ltree, 0, 'active')
			RETURNING id
		`, personID, handle).Scan(&affID); err != nil {
			t.Fatalf("seed root affiliate %s: %v", email, err)
		}
	} else {
		if err := q.QueryRow(ctx, `
			INSERT INTO mlm.affiliate(person_id, parent_id, position, sponsor_id, invitation_link, path, depth, status)
			VALUES ($1, $2, $3::mlm.tree_position, $4, $5, ''::ltree, 0, 'active')
			RETURNING id
		`, personID, *parentID, position, sponsorID, handle).Scan(&affID); err != nil {
			t.Fatalf("seed affiliate %s: %v", email, err)
		}
	}
	return adminTreeTestAffiliate{personID: personID, affID: affID, email: email}
}

func assertAdminTreeParent(t *testing.T, ctx context.Context, q *pgxpool.Pool, affID, wantParent int64, wantPos string) {
	t.Helper()
	var parent int64
	var pos string
	if err := q.QueryRow(ctx, `SELECT parent_id, position::text FROM mlm.affiliate WHERE id=$1`, affID).Scan(&parent, &pos); err != nil {
		t.Fatalf("affiliate %d parent: %v", affID, err)
	}
	if parent != wantParent || pos != wantPos {
		t.Fatalf("affiliate %d parent/pos = %d/%s, want %d/%s", affID, parent, pos, wantParent, wantPos)
	}
}

func assertAdminTreeSponsor(t *testing.T, ctx context.Context, q *pgxpool.Pool, affID, wantSponsor int64) {
	t.Helper()
	var sponsor int64
	if err := q.QueryRow(ctx, `SELECT sponsor_id FROM mlm.affiliate WHERE id=$1`, affID).Scan(&sponsor); err != nil {
		t.Fatalf("affiliate %d sponsor: %v", affID, err)
	}
	if sponsor != wantSponsor {
		t.Fatalf("affiliate %d sponsor = %d, want %d", affID, sponsor, wantSponsor)
	}
}

func assertAdminTreeClosure(t *testing.T, ctx context.Context, q *pgxpool.Pool, ancestor, descendant int64, wantDistance int) {
	t.Helper()
	var distance int
	if err := q.QueryRow(ctx, `
		SELECT distance
		  FROM mlm.affiliate_closure
		 WHERE ancestor_id=$1 AND descendant_id=$2
	`, ancestor, descendant).Scan(&distance); err != nil {
		t.Fatalf("closure %d -> %d: %v", ancestor, descendant, err)
	}
	if distance != wantDistance {
		t.Fatalf("closure %d -> %d distance = %d, want %d", ancestor, descendant, distance, wantDistance)
	}
}

func assertAdminTreeClosureMissing(t *testing.T, ctx context.Context, q *pgxpool.Pool, ancestor, descendant int64) {
	t.Helper()
	var exists bool
	if err := q.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM mlm.affiliate_closure
			 WHERE ancestor_id=$1 AND descendant_id=$2
		)
	`, ancestor, descendant).Scan(&exists); err != nil {
		t.Fatalf("closure missing check %d -> %d: %v", ancestor, descendant, err)
	}
	if exists {
		t.Fatalf("closure %d -> %d should not exist", ancestor, descendant)
	}
}

func assertAdminTreeAgg(t *testing.T, ctx context.Context, q *pgxpool.Pool, affID, wantLeft, wantRight int64, wantPVLeft, wantPVRight string) {
	t.Helper()
	var left, right int64
	var pvLeft, pvRight string
	if err := q.QueryRow(ctx, `
		SELECT left_count, right_count, left_pv_lifetime::text, right_pv_lifetime::text
		  FROM mlm.affiliate
		 WHERE id=$1
	`, affID).Scan(&left, &right, &pvLeft, &pvRight); err != nil {
		t.Fatalf("affiliate %d agg: %v", affID, err)
	}
	if left != wantLeft || right != wantRight || pvLeft != wantPVLeft || pvRight != wantPVRight {
		t.Fatalf("affiliate %d agg = %d/%d %s/%s, want %d/%d %s/%s",
			affID, left, right, pvLeft, pvRight, wantLeft, wantRight, wantPVLeft, wantPVRight)
	}
}

func assertAdminTreeNoDrift(t *testing.T, ctx context.Context, q *pgxpool.Pool) {
	t.Helper()
	var pvDrift int64
	if err := q.QueryRow(ctx, `
		SELECT count(*)
		  FROM mlm.v_tree_pv_truth
		 WHERE materialized_left <> computed_left
		    OR materialized_right <> computed_right
	`).Scan(&pvDrift); err != nil {
		t.Fatalf("pv drift query: %v", err)
	}
	if pvDrift != 0 {
		t.Fatalf("pv drift rows = %d", pvDrift)
	}
	var countDrift int64
	if err := q.QueryRow(ctx, `
		WITH counted AS (
			SELECT a.id AS ancestor_id,
			       COALESCE(count(*) FILTER (
			         WHERE substring(ltree2text(subpath(d.path, a.depth + 1, 1)) from 1 for 1) = 'L'
			       ), 0) AS left_count,
			       COALESCE(count(*) FILTER (
			         WHERE substring(ltree2text(subpath(d.path, a.depth + 1, 1)) from 1 for 1) = 'R'
			       ), 0) AS right_count
			  FROM mlm.affiliate a
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
		t.Fatalf("count drift query: %v", err)
	}
	if countDrift != 0 {
		t.Fatalf("count drift rows = %d", countDrift)
	}
}
