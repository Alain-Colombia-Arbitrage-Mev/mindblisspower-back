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
