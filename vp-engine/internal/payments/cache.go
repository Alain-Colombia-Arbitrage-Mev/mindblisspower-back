package payments

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"
)

// Cache es un wrapper cache-aside sobre Redis. TODOS los métodos son nil-safe:
// si el Cache es nil (sin REDIS_ADDR) o Redis falla, se degrada a "miss" y la
// request sigue contra la DB — la caché NUNCA rompe una respuesta.
type Cache struct {
	rdb *redis.Client
}

// NewCache crea el cliente. addr vacío ⇒ devuelve nil (caché deshabilitada).
func NewCache(addr, password string) *Cache {
	if addr == "" {
		return nil
	}
	return &Cache{rdb: redis.NewClient(&redis.Options{
		Addr:         addr,
		Password:     password,
		DB:           0,
		DialTimeout:  500 * time.Millisecond,
		ReadTimeout:  300 * time.Millisecond,
		WriteTimeout: 300 * time.Millisecond,
		PoolSize:     10,
	})}
}

func (c *Cache) Ping(ctx context.Context) error {
	if c == nil {
		return nil
	}
	return c.rdb.Ping(ctx).Err()
}

// get deserializa la clave en dst. Devuelve true solo si hubo hit válido.
func (c *Cache) get(ctx context.Context, key string, dst any) bool {
	if c == nil {
		return false
	}
	b, err := c.rdb.Get(ctx, key).Bytes()
	if err != nil {
		return false
	}
	return json.Unmarshal(b, dst) == nil
}

// set guarda v con TTL (best-effort; ignora errores).
func (c *Cache) set(ctx context.Context, key string, v any, ttl time.Duration) {
	if c == nil {
		return
	}
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	_ = c.rdb.Set(ctx, key, b, ttl).Err()
}

// del invalida claves (best-effort).
func (c *Cache) del(ctx context.Context, keys ...string) {
	if c == nil || len(keys) == 0 {
		return
	}
	_ = c.rdb.Del(ctx, keys...).Err()
}

// --- Eventos de dominio (Redis Stream `vp:events`) ---------------------------
// Event log + hook para consumidores async (notif/analytics) vía consumer groups
// (XREADGROUP). Hoy el consumidor es el feed de actividad del admin (pull).

const eventStream = "vp:events"

// DomainEvent es un evento del stream para el feed/consumo.
type DomainEvent struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Payload string `json:"payload"` // JSON
	AtMs    int64  `json:"at_ms"`   // timestamp ms (del ID del stream)
}

// PublishEvent agrega un evento al stream (cap ~5000, aprox). nil-safe y
// best-effort: nunca rompe el camino de negocio.
func (c *Cache) PublishEvent(ctx context.Context, eventType string, payload map[string]any) {
	if c == nil {
		return
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return
	}
	_ = c.rdb.XAdd(ctx, &redis.XAddArgs{
		Stream: eventStream,
		MaxLen: 5000,
		Approx: true,
		Values: map[string]any{"type": eventType, "payload": string(b)},
	}).Err()
}

// RecentEvents devuelve los últimos n eventos (más reciente primero).
func (c *Cache) RecentEvents(ctx context.Context, n int64) ([]DomainEvent, error) {
	if c == nil {
		return []DomainEvent{}, nil
	}
	msgs, err := c.rdb.XRevRangeN(ctx, eventStream, "+", "-", n).Result()
	if err != nil {
		return []DomainEvent{}, nil // sin stream aún ⇒ vacío
	}
	out := make([]DomainEvent, 0, len(msgs))
	for _, m := range msgs {
		e := DomainEvent{ID: m.ID}
		if v, ok := m.Values["type"].(string); ok {
			e.Type = v
		}
		if v, ok := m.Values["payload"].(string); ok {
			e.Payload = v
		}
		// El ID del stream es "<ms>-<seq>"; el prefijo es el timestamp en ms.
		if i := indexByte(m.ID, '-'); i > 0 {
			e.AtMs = parseInt64(m.ID[:i])
		}
		out = append(out, e)
	}
	return out, nil
}

func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}

func parseInt64(s string) int64 {
	var n int64
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return n
		}
		n = n*10 + int64(s[i]-'0')
	}
	return n
}

// allow implementa rate-limit por ventana fija: ≤ limit hits por window para la
// clave dada. Devuelve true si se permite. Nil/fallo de Redis ⇒ permite (no
// bloquea tráfico por una caída de caché).
func (c *Cache) allow(ctx context.Context, key string, limit int64, window time.Duration) bool {
	if c == nil {
		return true
	}
	n, err := c.rdb.Incr(ctx, key).Result()
	if err != nil {
		return true
	}
	if n == 1 {
		_ = c.rdb.Expire(ctx, key, window).Err()
	}
	return n <= limit
}
