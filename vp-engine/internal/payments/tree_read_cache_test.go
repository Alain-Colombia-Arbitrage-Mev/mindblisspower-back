package payments

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

func TestTreeReadCacheHitExpiryAndIndependentValues(t *testing.T) {
	c := newTreeReadCache()
	clock := time.Now()
	c.now = func() time.Time { return clock }
	var calls int
	parent := "1"
	load := func(context.Context) ([]AdminTreeNode, error) {
		calls++
		return []AdminTreeNode{{ID: "2", ParentID: &parent, Sponsor: &AdminTreeAffiliateRef{ID: "1"}, Rank: &AdminTreeRankRef{Code: "A"}}}, nil
	}
	first, err := c.read(context.Background(), "children:1", time.Second, load)
	if err != nil {
		t.Fatal(err)
	}
	first[0].ID, *first[0].ParentID, first[0].Sponsor.ID, first[0].Rank.Code = "bad", "bad", "bad", "bad"
	second, _ := c.read(context.Background(), "children:1", time.Second, load)
	if calls != 1 || second[0].ID != "2" || *second[0].ParentID != "1" || second[0].Sponsor.ID != "1" || second[0].Rank.Code != "A" {
		t.Fatal("cache miss or a consumer mutated the retained snapshot", calls, second)
	}
	clock = clock.Add(time.Second)
	if _, err := c.read(context.Background(), "children:1", time.Second, load); err != nil || calls != 2 {
		t.Fatal("expired branch must reload", calls, err)
	}
}

type treeWaitingContext struct {
	context.Context
	ready chan<- struct{}
	once  sync.Once
}

func (c *treeWaitingContext) Done() <-chan struct{} {
	c.once.Do(func() { c.ready <- struct{}{} })
	return c.Context.Done()
}

func TestTreeReadCacheCollapsesMissesAndErrors(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "error"}[fail], func(t *testing.T) {
			c := newTreeReadCache()
			var calls atomic.Int32
			gate, ready := make(chan struct{}), make(chan struct{}, 30)
			loadErr := errors.New("temporary read failure")
			load := func(context.Context) ([]AdminTreeNode, error) {
				calls.Add(1)
				<-gate
				if fail {
					return nil, loadErr
				}
				return []AdminTreeNode{{ID: "2"}}, nil
			}
			var wg sync.WaitGroup
			for i := 0; i < 30; i++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					ctx := &treeWaitingContext{Context: context.Background(), ready: ready}
					nodes, err := c.read(ctx, "full:1", 0, load)
					if fail && !errors.Is(err, loadErr) || !fail && (err != nil || len(nodes) != 1) {
						t.Errorf("shared result mismatch: %v %v", nodes, err)
					}
				}()
			}
			for i := 0; i < 30; i++ {
				select {
				case <-ready:
				case <-time.After(time.Second):
					t.Fatal("a waiter did not join")
				}
			}
			close(gate)
			wg.Wait()
			if calls.Load() != 1 || len(c.entries) != 0 {
				t.Fatal("concurrent full reads must load once and retain no completed export", calls.Load())
			}
			_, _ = c.read(context.Background(), "full:1", 0, load)
			if calls.Load() != 2 {
				t.Fatal("errors/full exports must not be cached")
			}
		})
	}
}

func TestTreeReadCacheInvalidationDoesNotResurrectOldLoad(t *testing.T) {
	c := newTreeReadCache()
	started, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		_, _ = c.read(context.Background(), "roots:1", time.Minute, func(context.Context) ([]AdminTreeNode, error) {
			close(started)
			<-release
			return []AdminTreeNode{{ID: "old"}}, nil
		})
	}()
	<-started
	c.invalidate()
	loadNew := func(context.Context) ([]AdminTreeNode, error) { return []AdminTreeNode{{ID: "new"}}, nil }
	if nodes, _ := c.read(context.Background(), "roots:1", time.Minute, loadNew); nodes[0].ID != "new" {
		t.Fatal(nodes)
	}
	close(release)
	<-done
	nodes, _ := c.read(context.Background(), "roots:1", time.Minute, func(context.Context) ([]AdminTreeNode, error) {
		t.Fatal("current generation should be cached")
		return nil, nil
	})
	if nodes[0].ID != "new" {
		t.Fatal("old in-flight read repopulated the cache", nodes)
	}
}

func TestTreeReadCacheCancellationDoesNotCancelOtherReaders(t *testing.T) {
	c := newTreeReadCache()
	ctx, cancel := context.WithCancel(context.Background())
	started, release, done := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	load := func(ctx context.Context) ([]AdminTreeNode, error) {
		close(started)
		<-release
		if ctx.Err() != nil {
			t.Error("shared load inherited browser cancellation")
		}
		return []AdminTreeNode{{ID: "ok"}}, nil
	}
	go func() { _, err := c.read(ctx, "roots:1", time.Minute, load); done <- err }()
	<-started
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	close(release)
	nodes, err := c.read(context.Background(), "roots:1", time.Minute, load)
	if err != nil || nodes[0].ID != "ok" {
		t.Fatal(nodes, err)
	}
}

func TestTreeReadCacheIsolatedKeysDatabasesAndBoundedStorage(t *testing.T) {
	first, second := newTreeReadCache(), newTreeReadCache()
	first.maxEntries = 2
	for _, key := range []string{"roots:1", "roots:2", "children:1", "children:2"} {
		_, _ = first.read(context.Background(), key, time.Minute, func(context.Context) ([]AdminTreeNode, error) {
			return []AdminTreeNode{{ID: key}}, nil
		})
		if len(first.entries) > 2 || first.bytes > first.maxBytes {
			t.Fatal("cache exceeded its bounds")
		}
	}
	nodes, _ := second.read(context.Background(), "children:2", time.Minute, func(context.Context) ([]AdminTreeNode, error) {
		return []AdminTreeNode{{ID: "other-database"}}, nil
	})
	if nodes[0].ID != "other-database" {
		t.Fatal("Store/database isolation failed")
	}
	first.maxBytes = 16
	first.invalidate()
	_, _ = first.read(context.Background(), "oversize", time.Minute, func(context.Context) ([]AdminTreeNode, error) {
		return []AdminTreeNode{{Name: strings.Repeat("x", 100)}}, nil
	})
	if len(first.entries) != 0 {
		t.Fatal("oversized payload retained")
	}
}

func TestTreeReadCacheNeverBypassesFreshAuthorization(t *testing.T) {
	store := NewStore(nil)
	_, _ = store.treeReads.read(context.Background(), "roots:1", adminTreeCacheTTL, func(context.Context) ([]AdminTreeNode, error) {
		return []AdminTreeNode{{ID: "1", Name: "Private tree identity"}}, nil
	})
	h := NewHandler(store, nil, "unit-service-token", []string{"admin@t.local"}, 1, zerolog.Nop())
	h.SetIdentityVerifier(fakeVerifier{email: "admin@t.local"}, true)
	request := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, "/api/admin/tree/roots", nil)
		r.Header.Set("X-VP-Service-Token", "unit-service-token")
		r.Header.Set(idTokenHeader, "unit-id-token")
		w := httptest.NewRecorder()
		h.handleAdminTreeRoots(w, r)
		return w
	}
	if w := request(); w.Code != http.StatusOK {
		t.Fatal("authorized read should use warmed branch", w.Code, w.Body.String())
	}
	h.SetIdentityVerifier(fakeVerifier{err: errors.New("expired")}, true)
	if w := request(); w.Code != http.StatusUnauthorized || strings.Contains(w.Body.String(), "Private tree") {
		t.Fatal("cached branch escaped current authorization", w.Code, w.Body.String())
	}
}
