package payments

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type treeQueryCounter struct{ calls atomic.Int32 }

func (c *treeQueryCounter) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	c.calls.Add(1)
	return ctx
}
func (*treeQueryCounter) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func TestAdminTreeReadCacheIntegration(t *testing.T) {
	if testing.Short() {
		t.Skip("needs isolated PostgreSQL testcontainer")
	}
	pool, cleanup := pgContainer(t)
	defer cleanup()
	ctx := context.Background()
	root := seedAdminTreeAffiliate(t, ctx, pool, "Root", "Cache", "root-cache@t.local", nil, "", nil, "root-cache")
	child := seedAdminTreeAffiliate(t, ctx, pool, "Child", "Cache", "child-cache@t.local", &root.affID, "L", &root.affID, "child-cache")
	counter := &treeQueryCounter{}
	config := pool.Config()
	config.ConnConfig.Tracer = counter
	reader, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	store := NewStore(reader)
	first, err := store.ListAdminTreeChildren(ctx, root.affID)
	if err != nil || len(first) != 1 || first[0].Banned {
		t.Fatal(first, err)
	}
	before := counter.calls.Load()
	for i := 0; i < 29; i++ {
		if _, err := store.ListAdminTreeChildren(ctx, root.affID); err != nil {
			t.Fatal(err)
		}
	}
	if before != 1 || counter.calls.Load() != 1 {
		t.Fatal("30 identical reads should issue one database query", counter.calls.Load())
	}
	if err := store.SetBlocked(ctx, child.personID, true); err != nil {
		t.Fatal(err)
	}
	before = counter.calls.Load()
	after, err := store.ListAdminTreeChildren(ctx, root.affID)
	if err != nil || len(after) != 1 || !after[0].Banned || after[0].Name != "Not Available" {
		t.Fatal("committed ban must invalidate cached display data", after, err)
	}
	if counter.calls.Load()-before != 1 {
		t.Fatal("post-commit read must reload authoritative data")
	}
}
