package payments

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Stop each independent writer after its affiliate/closure INSERT has acquired
// FK KEY SHARE locks, immediately before the real NOW ancestor-counter query.
// Different sponsors/slots avoid the unique-slot serialization of older tests.
type nowPlacementCounterBarrier struct {
	ready   chan<- struct{}
	release <-chan struct{}
	fired   atomic.Bool
}

func (b *nowPlacementCounterBarrier) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if strings.Contains(data.SQL, "WITH ancestors AS(") && strings.Contains(data.SQL, "SET left_count=a.left_count+") && !b.fired.Swap(true) {
		b.ready <- struct{}{}
		select {
		case <-b.release:
		case <-ctx.Done():
		}
	}
	return ctx
}
func (*nowPlacementCounterBarrier) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func TestNOWPlacementOverlappingSponsorsPostgres(t *testing.T) {
	if testing.Short() {
		t.Skip("isolated PostgreSQL testcontainer")
	}
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	root := seedAdminTreeAffiliate(t, ctx, pool, "Synthetic", "Root", "now-lock-root@example.test", nil, "", nil, "now-lock-root")
	child := seedAdminTreeAffiliate(t, ctx, pool, "Synthetic", "Child", "now-lock-child@example.test", &root.affID, "L", &root.affID, "now-lock-child")
	people := []int64{seedPlacementBuyer(t, ctx, pool, "now-lock-first@example.test"), seedPlacementBuyer(t, ctx, pool, "now-lock-second@example.test")}
	if _, err := pool.Exec(ctx, `UPDATE mlm.affiliate SET left_count=1 WHERE id=$1`, root.affID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE ROLE now_placement_synthetic LOGIN NOINHERIT PASSWORD 'synthetic-placement-only';
 GRANT USAGE ON SCHEMA mlm TO now_placement_synthetic;
 GRANT SELECT ON mlm.affiliate,mlm.affiliate_closure TO now_placement_synthetic;
 GRANT INSERT ON mlm.affiliate,mlm.affiliate_closure TO now_placement_synthetic;
 GRANT UPDATE(left_count,right_count,updated_at) ON mlm.affiliate TO now_placement_synthetic;
 GRANT USAGE,SELECT ON SEQUENCE mlm.affiliate_id_seq TO now_placement_synthetic;`); err != nil {
		t.Fatal(err)
	}
	ready, release := make(chan struct{}, 2), make(chan struct{})
	writers := make([]*pgxpool.Pool, 2)
	for i := range writers {
		cfg := pool.Config()
		cfg.MaxConns = 1
		cfg.ConnConfig.User = "now_placement_synthetic"
		cfg.ConnConfig.Password = "synthetic-placement-only"
		cfg.ConnConfig.Tracer = &nowPlacementCounterBarrier{ready: ready, release: release}
		var err error
		writers[i], err = pgxpool.NewWithConfig(ctx, cfg)
		if err != nil {
			t.Fatal(err)
		}
		defer writers[i].Close()
	}
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	defer unblock()
	runCtx, runCancel := context.WithTimeout(ctx, 15*time.Second)
	defer runCancel()
	type outcome struct {
		id  int64
		err error
	}
	results := make(chan outcome, 2)
	for i := range writers {
		go func(i int) {
			tx, err := writers[i].Begin(runCtx)
			if err != nil {
				results <- outcome{err: err}
				return
			}
			defer tx.Rollback(context.Background()) //nolint:errcheck
			sponsor, side := root.affID, "L"
			if i == 1 {
				sponsor, side = child.affID, "R"
			}
			id, err := autoPlaceNOWAffiliate(runCtx, tx, people[i], sponsor, side)
			if err == nil {
				err = tx.Commit(runCtx)
			}
			results <- outcome{id, err}
		}(i)
	}
	for range 2 {
		select {
		case <-ready:
		case <-runCtx.Done():
			unblock()
			t.Fatal("both restricted writers must reach the post-INSERT barrier", runCtx.Err())
		}
	}
	unblock()
	for range 2 {
		out := <-results
		if out.err != nil {
			t.Errorf("overlapping NOW placement must commit without FK/ancestor deadlock: %v", out.err)
		}
	}
	var valid int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM mlm.affiliate a JOIN mlm.affiliate_closure c ON c.descendant_id=a.id AND c.ancestor_id=$1 AND c.distance=2
 WHERE a.person_id=ANY($2::bigint[]) AND a.parent_id=$3 AND a.depth=2
 AND ((a.person_id=$4 AND a.position='L' AND a.sponsor_id=$1) OR(a.person_id=$5 AND a.position='R' AND a.sponsor_id=$3))`, root.affID, people, child.affID, people[0], people[1]).Scan(&valid); err != nil || valid != 2 {
		t.Error("two independent placements/closures required", valid, err)
	}
	assertAdminTreeAgg(t, ctx, pool, root.affID, 3, 0, "0.00", "0.00")
	assertAdminTreeAgg(t, ctx, pool, child.affID, 1, 1, "0.00", "0.00")
	var isolated bool
	if err := pool.QueryRow(ctx, `SELECT NOT EXISTS(SELECT 1 FROM mlm.tree_event)
 AND NOT has_table_privilege('now_placement_synthetic','mlm.tree_event','INSERT')
 AND NOT has_column_privilege('now_placement_synthetic','mlm.affiliate','left_pv_lifetime','UPDATE')`).Scan(&isolated); err != nil || !isolated {
		t.Fatal("NOW placement changed global PV capabilities", isolated, err)
	}

	for _, side := range []string{"L", "R", ""} {
		t.Run("sequential side "+side, func(t *testing.T) {
			label := side
			if label == "" {
				label = "auto"
			}
			sponsor := seedAdminTreeAffiliate(t, ctx, pool, "Synthetic", label, "now-side-"+label+"@example.test", nil, "", nil, "now-side-"+label)
			parent := sponsor.affID
			for i := 0; i < 2; i++ {
				person := seedPlacementBuyer(t, ctx, pool, "now-side-"+label+string(rune('a'+i))+"@example.test")
				tx, err := writers[0].Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				id, err := autoPlaceNOWAffiliate(ctx, tx, person, sponsor.affID, side)
				if err != nil {
					_ = tx.Rollback(ctx)
					t.Fatal(err)
				}
				if err := tx.Commit(ctx); err != nil {
					t.Fatal(err)
				}
				wantSide := side
				if side == "" {
					wantSide = "L"
					if i == 1 {
						wantSide = "R"
					}
					parent = sponsor.affID
				}
				assertAdminTreeParent(t, ctx, pool, id, parent, wantSide)
				assertAdminTreeSponsor(t, ctx, pool, id, sponsor.affID)
				parent = id
			}
		})
	}
	t.Run("placement rollback removes node closure and counters", func(t *testing.T) {
		person := seedPlacementBuyer(t, ctx, pool, "now-rollback@example.test")
		tx, err := writers[0].Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		id, err := autoPlaceNOWAffiliate(ctx, tx, person, root.affID, "R")
		if err != nil {
			_ = tx.Rollback(ctx)
			t.Fatal(err)
		}
		if err := tx.Rollback(ctx); err != nil {
			t.Fatal(err)
		}
		var clean bool
		if err := pool.QueryRow(ctx, `SELECT NOT EXISTS(SELECT 1 FROM mlm.affiliate WHERE person_id=$1)
 AND NOT EXISTS(SELECT 1 FROM mlm.affiliate_closure WHERE descendant_id=$2 OR ancestor_id=$2)`, person, id).Scan(&clean); err != nil || !clean {
			t.Fatal("rollback left placement artifacts", clean, err)
		}
		assertAdminTreeAgg(t, ctx, pool, root.affID, 3, 0, "0.00", "0.00")
	})
}
