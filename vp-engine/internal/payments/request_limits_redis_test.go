package payments

import (
	"context"
	"fmt"
	"net"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestRequestBudgetsRedisAtomic(t *testing.T) {
	address := os.Getenv("REQUEST_LIMIT_TEST_REDIS")
	if address == "" {
		t.Skip("set REQUEST_LIMIT_TEST_REDIS to an isolated loopback Redis")
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil || (host != "localhost" && !net.ParseIP(host).IsLoopback()) {
		t.Fatal("test Redis must be an explicit loopback address")
	}
	first, second := NewCache(address, ""), NewCache(address, "")
	defer first.rdb.Close()
	defer second.rdb.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	prefix := fmt.Sprintf("qa:{request-budget}:%d:", time.Now().UnixNano())
	rules := []budgetRule{{prefix + "member", 30}, {prefix + "shared", 1000}}
	defer first.rdb.Del(context.Background(), rules[0].key, rules[1].key, prefix+"orphan")
	if err := first.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	// Warm the script before measuring concurrent calls from two instances.
	if _, err := first.takeRequestBudget(ctx, rules); err != nil {
		t.Fatal(err)
	}
	var accepted, failures atomic.Int64
	accepted.Add(1)
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			client := first
			if index%2 != 0 {
				client = second
			}
			retry, err := client.takeRequestBudget(ctx, rules)
			if err != nil {
				failures.Add(1)
				return
			}
			if retry == 0 {
				accepted.Add(1)
			}
		}(i)
	}
	wg.Wait()
	if failures.Load() != 0 || accepted.Load() != 30 {
		t.Fatal("distributed budget mismatch", accepted.Load(), failures.Load())
	}
	if hits := first.rdb.Get(ctx, rules[1].key).Val(); hits != "30" {
		t.Fatal("rejected calls charged the shared budget", hits)
	}
	for _, rule := range rules {
		if ttl := first.rdb.PTTL(ctx, rule.key).Val(); ttl <= 0 || ttl > time.Minute {
			t.Fatal("counter lacks TTL", ttl)
		}
		if strings.Contains(rule.key, "@") {
			t.Fatal("private identity in key")
		}
	}
	// Old/broken counters with no TTL must not lock a user out forever.
	orphan := []budgetRule{{prefix + "orphan", 1}}
	if err := first.rdb.Set(ctx, orphan[0].key, 100, 0).Err(); err != nil {
		t.Fatal(err)
	}
	if retry, err := first.takeRequestBudget(ctx, orphan); retry != 0 || err != nil {
		t.Fatal(retry, err)
	}
	if ttl := first.rdb.PTTL(ctx, orphan[0].key).Val(); ttl <= 0 {
		t.Fatal("orphan TTL not repaired")
	}
}
