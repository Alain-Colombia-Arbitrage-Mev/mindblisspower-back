package payments

import (
	"context"
	"encoding/json"
	"strconv"
	"sync"
	"time"
)

const adminTreeCacheTTL = 15 * time.Second

// treeReadCache belongs to one Store/database. Only the display model is cached;
// authorization and placement/compensation decisions always read authoritative data.
// Each process keeps at most 8 MiB of serialized branches and 64 in-flight loads.
// Other processes/direct SQL writes become visible within the short TTL.
type treeReadCache struct {
	mu         sync.Mutex
	entries    map[string]treeReadEntry
	flights    map[string]*treeReadFlight
	generation uint64
	bytes      int
	maxBytes   int
	maxEntries int
	now        func() time.Time
}

type treeReadEntry struct {
	data      []byte
	expiresAt time.Time
	usedAt    time.Time
}

type treeReadFlight struct {
	done  chan struct{}
	nodes []AdminTreeNode
	err   error
}

func newTreeReadCache() *treeReadCache {
	return &treeReadCache{
		entries: make(map[string]treeReadEntry), flights: make(map[string]*treeReadFlight),
		maxBytes: 8 << 20, maxEntries: 2048, now: time.Now,
	}
}

func (c *treeReadCache) invalidate() {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.generation++
	c.entries = make(map[string]treeReadEntry)
	c.bytes = 0
	c.mu.Unlock()
}

func (c *treeReadCache) read(ctx context.Context, key string, ttl time.Duration, load func(context.Context) ([]AdminTreeNode, error)) ([]AdminTreeNode, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if c == nil {
		return load(ctx)
	}
	c.mu.Lock()
	now := c.now()
	if entry, ok := c.entries[key]; ok {
		if now.Before(entry.expiresAt) {
			entry.usedAt = now
			c.entries[key] = entry
			c.mu.Unlock()
			var nodes []AdminTreeNode
			if json.Unmarshal(entry.data, &nodes) == nil {
				return nodes, nil
			}
			return load(ctx)
		}
		delete(c.entries, key)
		c.bytes -= len(entry.data)
	}
	generation := c.generation
	flightKey := strconv.FormatUint(generation, 10) + ":" + key
	flight := c.flights[flightKey]
	if flight == nil {
		if len(c.flights) >= 64 {
			c.mu.Unlock()
			return load(ctx) // Bound retained work; the HTTP request guard bounds DB concurrency.
		}
		flight = &treeReadFlight{done: make(chan struct{})}
		c.flights[flightKey] = flight
		go func() {
			// One disconnected browser must not cancel a shared read for other admins.
			loadCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
			defer cancel()
			nodes, err := load(loadCtx)
			var data []byte
			if err == nil && ttl > 0 {
				data, _ = json.Marshal(nodes)
			}
			c.mu.Lock()
			if err == nil && len(data) > 0 && len(data) <= c.maxBytes && generation == c.generation {
				c.storeLocked(key, data, ttl)
			}
			flight.nodes, flight.err = nodes, err
			delete(c.flights, flightKey)
			close(flight.done)
			c.mu.Unlock()
		}()
	}
	c.mu.Unlock()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-flight.done:
		return cloneAdminTreeNodes(flight.nodes), flight.err
	}
}

func (c *treeReadCache) storeLocked(key string, data []byte, ttl time.Duration) {
	now := c.now()
	for existing, entry := range c.entries {
		if !now.Before(entry.expiresAt) || existing == key {
			delete(c.entries, existing)
			c.bytes -= len(entry.data)
		}
	}
	for len(c.entries) >= c.maxEntries || c.bytes+len(data) > c.maxBytes {
		var oldestKey string
		var oldest time.Time
		for candidate, entry := range c.entries {
			if oldestKey == "" || entry.usedAt.Before(oldest) {
				oldestKey, oldest = candidate, entry.usedAt
			}
		}
		c.bytes -= len(c.entries[oldestKey].data)
		delete(c.entries, oldestKey)
	}
	c.entries[key] = treeReadEntry{data: data, expiresAt: now.Add(ttl), usedAt: now}
	c.bytes += len(data)
}

// Callers receive independent slices/pointers; a consumer cannot corrupt a cached branch.
func cloneAdminTreeNodes(nodes []AdminTreeNode) []AdminTreeNode {
	if nodes == nil {
		return nil
	}
	out := append([]AdminTreeNode{}, nodes...)
	for i := range out {
		if nodes[i].ParentID != nil {
			value := *nodes[i].ParentID
			out[i].ParentID = &value
		}
		if nodes[i].Side != nil {
			value := *nodes[i].Side
			out[i].Side = &value
		}
		if nodes[i].Rank != nil {
			value := *nodes[i].Rank
			out[i].Rank = &value
		}
		if nodes[i].Sponsor != nil {
			value := *nodes[i].Sponsor
			out[i].Sponsor = &value
		}
	}
	return out
}
