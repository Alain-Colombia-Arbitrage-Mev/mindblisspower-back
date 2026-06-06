# VicionPower — Arquitectura polyglot (TS + Go)

**Decisión:** dos servicios con frontera clara de lenguaje. **NO** microservicios proliferantes — exactamente dos binarios, cada uno por sus razones específicas.

| Servicio | Lenguaje | Owns |
|---|---|---|
| `vp-api` | TypeScript (Bun + Hono) | HTTP público, Better Auth, CRUD, admin, KYC, notifications, reporting |
| `vp-engine` | Go | Ledger writes (alto TPS), motor de bonos, blockchain watcher, jobs scheduled |

**Razón:** TS gana en developer velocity para el 70 % del código (CRUD, admin, auth, reportes). Go gana en throughput / latencia / consumo de memoria para el 30 % crítico (escritura masiva al ledger, runs de bonos sobre millones de filas, conexiones long-lived a blockchain). Ambos comparten Postgres + Redis + NATS.

---

## 1. Por qué dos servicios y no más

Cada servicio adicional cuesta:
- otro pipeline CI/CD,
- otro deploy job,
- otro set de métricas/logs/traces,
- otra dimensión en el modelo mental del equipo,
- otro punto de falla de red.

**Empezar con 2 servicios** mantiene el costo operativo manejable mientras gana lo que importa: el aislamiento de la zona caliente. Si en 12 meses `vp-engine` necesita partirse en `bonus-engine` + `chain-watcher` + `ledger-svc`, se hace cuando el dolor lo justifique. No antes.

---

## 2. Distribución de módulos

### vp-api (TS, Bun + Hono) — el BFF / gateway

Mantiene los 10 módulos del modular monolith del BACKEND_PLAN, **menos** los que se van a Go:

| Módulo | Por qué TS |
|---|---|
| `identity` | Better Auth es TS-only; KYC orquesta SDKs (Truora/Sumsub) que tienen mejores SDK en TS |
| `tree` (read) | Traversals con ltree son SQL puro; Drizzle alcanza |
| `tree` (write — placeAffiliate) | Llama a `vp-engine` vía gRPC para que el insert de tree_event sea el camino caliente |
| `packages` | CRUD; el activate dispara evento NATS que `vp-engine` consume |
| `withdrawals` | Workflow approval; el pago real lo emite `vp-engine` |
| `payments` (initiate) | Genera payment intents; webhooks bancarios y de card |
| `admin` | Backoffice CRUD |
| `notifications` | Resend + react-email — ecosistema TS |
| `reporting` | CSV/XLSX streaming desde Postgres con `pg-copy-streams` |

### vp-engine (Go) — la zona caliente

| Módulo Go | Por qué Go |
|---|---|
| `ledger-write` | Pico de inserts en `wallet_movement`; pgx es ~5-10x más rápido que postgres-js a alto TPS |
| `bonus-engine` | Runs ROI/binario sobre N filas; goroutines paralelizan; memoria predecible |
| `chain-watcher` | Long-lived conexiones a TRC20/BTC nodes; goroutine por chain, channel-based event emission |
| `payment-confirm` | Confirma pagos crypto N-confirmations; webhook receiver high-burst |
| `tree-traverse` (heavy) | Solo si descubrimos en profiling que downline > 100k afiliados satura TS — sino se queda en `vp-api` |

### Lo que NO va a Go

- **Better Auth.** No tiene equivalente Go que valga la pena. Auth se queda 100 % en `vp-api`.
- **HTTP CRUD genérico.** El 70 % de endpoints son lectura/escritura simple — ahí TS gana en velocidad de iteración.
- **Email templates.** react-email no tiene par en Go.

---

## 3. Comunicación entre servicios

### Síncrono: gRPC sobre red privada Hetzner

`vp-api` llama a `vp-engine` cuando necesita una respuesta inmediata:

```protobuf
// proto/ledger.proto
service Ledger {
  rpc PostTransaction(PostTransactionRequest) returns (PostTransactionResponse);
  rpc ReverseTransaction(ReverseRequest) returns (ReverseResponse);
  rpc GetWalletBalance(GetWalletBalanceRequest) returns (Balance);
}

message PostTransactionRequest {
  string external_ref = 1;            // idempotency key
  string description = 2;
  int64  initiated_by_person_id = 3;
  repeated Movement movements = 4;
}
```

**Por qué gRPC y no HTTP/JSON:**
- Codegen estricto en ambos lados (no más drift entre tipos TS y Go).
- ~2-3x menos latencia que JSON (binario protobuf, HTTP/2 multiplexed).
- Streaming nativo (útil para `Reverse Bulk` o `BatchPostTransactions`).
- mTLS fácil con buf + connectrpc.

**Implementación:**
- TS side: `@connectrpc/connect-node` + `buf` para codegen.
- Go side: `connectrpc.com/connect` + `buf` para codegen.
- Single repo `proto/` con `.proto` files; ambos servicios consumen el mismo contrato.
- mTLS entre servicios, certs gestionados por `cert-manager`-equivalente o Caddy interno.

### Asíncrono: NATS JetStream

Para eventos que no requieren respuesta inmediata:

```
vp-api  → publica  → "packages.purchased"  → vp-engine consume → trigger PV credit
vp-engine → publica → "payout.recorded"    → vp-api consume → email al afiliado
vp-engine → publica → "deposit.confirmed"  → vp-api consume → activar paquete
```

**Por qué NATS y no Redis Streams / Kafka:**
- Redis Streams: bien para BullMQ, pero NATS es más simple para pub/sub multi-lenguaje.
- Kafka: overkill operacional para 2 servicios; partitions y retention son complejidades que no necesitas.
- NATS JetStream: persistencia opcional, exactly-once con consumer groups, footprint mínimo (~30 MB RAM), clients oficiales TS y Go.
- Despliegue: 1 binario adicional en el host de Redis (puerto 4222), zero dependency.

### Reglas de uso

| Caso | Patrón |
|---|---|
| Cliente HTTP llama a vp-api → necesita postear transaction | gRPC sync a vp-engine, espera respuesta |
| Compra de paquete confirmada → debe creditar PV | NATS event `packages.purchased` |
| Bonus run completado → notificar afiliados | NATS event `payouts.payout_recorded` |
| Admin reversa transaction → necesita confirmación | gRPC sync |
| Chain watcher detecta deposit | NATS event `payments.deposit_confirmed` |

**Regla de oro:** si la UI espera la respuesta, es gRPC. Si es fan-out a N consumidores o fire-and-forget, es NATS.

---

## 4. Auth: cómo Better Auth funciona con Go

Better Auth corre solo en `vp-api`. **`vp-engine` nunca expone HTTP público** — solo escucha gRPC interno y NATS. Por lo tanto **no necesita validar sesiones de usuario final**, solo necesita autenticar al caller (`vp-api`).

### Capa 1: vp-api valida sesión de usuario (Better Auth nativo)

```ts
// vp-api: middleware
app.use('/api/*', async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthenticated' }, 401);
  c.set('session', session);
  await next();
});
```

Better Auth ya cachea sesiones en Redis (configurado en `app/src/auth.ts`); a 10k req/s la latencia está dominada por Redis lookup (~1ms).

### Capa 2: vp-api → vp-engine (mTLS, sin JWT)

Cuando `vp-api` llama a `vp-engine`:
- Conexión por red privada Hetzner (`10.0.0.0/16`, no enrutable desde fuera).
- mTLS con cert mutual: `vp-api.crt` y `vp-engine.crt` firmados por una CA interna.
- `vp-engine` confía en cualquier llamador con cert válido firmado por la CA interna; **no valida sesión del usuario final**.
- `vp-api` pasa la identidad del usuario en el request gRPC explícitamente:

```protobuf
message PostTransactionRequest {
  string external_ref = 1;
  // ... business fields ...
  ActorContext actor = 99;  // quién originó la operación, para audit
}

message ActorContext {
  int64  person_id = 1;
  string user_id = 2;       // auth.user.id
  bool   is_admin = 3;
  string ip_address = 4;
  string user_agent = 5;
}
```

`vp-engine` graba `actor.person_id` en `audit.activity_log`. La autorización fina (¿este admin puede aprobar montos > $X?) se hace en `vp-api` antes de llamar; `vp-engine` confía y ejecuta.

**Razón:** `vp-engine` corre código sensible (mover dinero). Al estar detrás de mTLS + red privada y confiar en un único caller, su superficie de ataque baja drásticamente. Si lo abrieras a JWT validation, tendrías que duplicar lógica de roles y agregar JWKS rotation.

### Capa 3 (futuro): si vp-engine necesita HTTP público

Solo si en algún momento un cliente externo necesita hablar con `vp-engine` (improbable, podría pasar con webhooks de proveedores de pago):
- Better Auth emite un JWT firmado con HS512 al hacer login.
- `vp-engine` valida JWT con la misma key (compartida vía sops).
- Library: `golang-jwt/v5`.

Por ahora **no se necesita** — webhooks llegan a `vp-api` que los reenvía a `vp-engine` por gRPC.

---

## 5. Acceso a datos

### Postgres compartido, roles separados por servicio

```sql
-- Roles existentes: app_read, app_write, app_admin (definidos en schema_mlm.sql)
-- Agregar:

CREATE ROLE engine_write LOGIN PASSWORD 'CHANGEME';
GRANT USAGE ON SCHEMA mlm TO engine_write;

-- engine puede escribir solo en estas tablas (las del hot path)
GRANT INSERT, UPDATE ON
  mlm.wallet_movement, mlm.transaction, mlm.tree_event,
  mlm.bonus_run, mlm.bonus_run_payout, mlm.affiliate
TO engine_write;

-- engine puede leer todo lo que necesite para calcular bonos
GRANT SELECT ON ALL TABLES IN SCHEMA mlm TO engine_write;

-- engine puede insertar en audit
GRANT INSERT ON audit.activity_log TO engine_write;

-- engine NO puede tocar auth.* (ni siquiera leer)
-- engine NO puede DELETE en ninguna tabla del ledger
```

**Conexiones:**
- `vp-api` conecta como `app_write` vía PgBouncer transaction mode.
- `vp-engine` conecta como `engine_write` vía pool dedicado (pgx pool nativo, sin PgBouncer — Go maneja sus conexiones).

**Por qué pools separados:** `vp-engine` puede tener 50-100 conexiones largas para batch jobs; `vp-api` tiene 10-20 cortas. Mezclarlas en PgBouncer mata el pooling de transacciones.

### Drizzle vs sqlc vs pgx raw

| Servicio | Stack |
|---|---|
| `vp-api` | Drizzle ORM (typings) + postgres-js (driver). Existente. |
| `vp-engine` | sqlc (codegen desde SQL) + pgx (driver). Hot path queries. |

**sqlc** genera Go structs y funciones desde queries SQL puras. No es un ORM:

```sql
-- queries/ledger.sql
-- name: PostTransaction :one
INSERT INTO mlm.transaction (external_ref, description, status, initiated_by_person_id)
VALUES ($1, $2, 'pending', $3)
ON CONFLICT (external_ref) DO UPDATE SET description = EXCLUDED.description
RETURNING id;

-- name: InsertMovementsBatch :exec
INSERT INTO mlm.wallet_movement (
  transaction_id, wallet_id, affiliate_id, concept_id, amount, posted_at
)
SELECT * FROM unnest(
  $1::uuid[], $2::bigint[], $3::bigint[], $4::int[],
  $5::numeric[], $6::timestamptz[]
);
```

`sqlc generate` produce funciones tipadas en Go. Cero magia, cero reflection, cero overhead vs SQL puro.

### Schema migrations

`_meta/schema_mlm.sql` sigue siendo source of truth. Ambos servicios leen el mismo schema. Migraciones son DDL revisado humanamente. `schema-guard` en CI compara checksum (ya documentado).

---

## 6. Stack por servicio

### vp-api (TS)

```
Runtime:     Bun 1.1+
HTTP:        Hono
ORM:         Drizzle
Auth:        Better Auth
Validación:  Zod
Cola:        BullMQ (sigue usándose para jobs internos al BFF)
gRPC:        @connectrpc/connect-node
NATS:        nats.js (oficial)
Email:       Resend + react-email
Files:       @aws-sdk/client-s3 (Hetzner Storage Box S3-compatible)
Tests:       Bun test + testcontainers + Playwright
Container:   Bun distroless (ya existe Dockerfile)
```

### vp-engine (Go)

```
Runtime:     Go 1.23+
HTTP:        Chi (solo para /health y /metrics; no hay HTTP público)
gRPC:        connectrpc.com/connect
DB:          pgx/v5 + sqlc (codegen)
Migraciones: solo lectura del checksum app.schema_checksum
NATS:        github.com/nats-io/nats.go
Crypto:      btcsuite/btcd, github.com/fbsobreira/gotron-sdk
Scheduler:   github.com/go-co-op/gocron (cron in-process)
Logs:        github.com/rs/zerolog
Metrics:     github.com/prometheus/client_golang
Tracing:     go.opentelemetry.io/otel
Tests:       testify + dockertest (Postgres real)
Container:   golang:1.23-alpine builder → scratch final ~15 MB
```

---

## 7. Topología de despliegue Hetzner (revisada)

```
                 Cloudflare (TLS, WAF)
                        ↓
                Hetzner LB11 (€5/mo)
                        ↓
       ┌──────────────────────────────────┐
       │ Private network 10.0.0.0/16      │
       │                                  │
       │  ┌─────────┐   ┌─────────┐      │
       │  │vp-api-01│   │vp-api-02│      │ CCX23 ×2 (€60/mo)
       │  │ Bun     │   │ Bun     │      │
       │  └────┬────┘   └────┬────┘      │
       │       │              │           │
       │  gRPC mTLS    gRPC mTLS          │
       │       │              │           │
       │  ┌────▼──────────────▼────┐     │
       │  │ vp-engine-01           │     │ CCX33 (€60/mo) — más CPU para bonus runs
       │  │ Go binary (~15 MB)     │     │
       │  └────────┬───────────────┘     │
       │           │                      │
       │  ┌────────▼──────────────┐      │
       │  │ NATS + Redis          │      │ CX22 (€4/mo) — JetStream + cache + sessions
       │  └────────┬──────────────┘      │
       │           │                      │
       │  ┌────────▼──────────────┐      │
       │  │ Postgres primary      │      │ AX52 (€80/mo) — DB bare metal
       │  │ (PgBouncer side)      │      │
       │  └────────┬──────────────┘      │
       │           │                      │
       │  ┌────────▼──────────────┐      │
       │  │ Postgres replica       │      │ AX42 (€50/mo) — read-heavy bonus reports
       │  │ (read-only, streaming) │      │
       │  └────────────────────────┘      │
       └──────────────────────────────────┘
                        ↓
              Hetzner Storage Box (€4/mo)
              pgbackrest + KYC files
```

**Costo total:** ~€263/mo. Más caro que el plan original (€175) por:
- vp-engine en CCX33 (€30 más que CCX23 que reemplaza al worker original).
- Réplica de Postgres incluida desde día 1 (no aplazada).

A cambio: capacidad probada para >5x la carga, motor de bonos en hot binario, escalabilidad por adición de réplicas vp-api sin tocar `vp-engine`.

---

## 8. Cambios al plan de fases (BACKEND_PLAN)

### Fase 0 — Foundation (3 semanas, +1 vs antes)

- Provisión Hetzner según topología nueva.
- Ambos repos: `vp-api/` (existente como `app/`) y `vp-engine/` (nuevo).
- Setup `proto/` con primeros services: `Ledger`, `BonusEngine`.
- buf + connectrpc codegen funcional en ambos lados.
- NATS desplegado, smoke test pub/sub TS↔Go.
- `vp-engine` skeleton: `/health` + `/metrics` + un dummy gRPC.

**Definition of done:** `vp-api` puede llamar `vp-engine.Ping()` por gRPC y recibe respuesta. NATS round-trip TS→Go→TS funciona.

### Fase 1 — MVP cutover (5 semanas, +1 vs antes)

Idéntico al plan original, **excepto** que `ledger.postTransaction` se mueve a `vp-engine.Ledger.PostTransaction` desde el principio. `vp-api` solo orquesta.

**Razón:** si dejas el ledger en TS para el MVP "porque es más rápido escribir", luego migrarlo es un refactor doloroso con datos reales en producción.

### Fase 2 — Motor de bonos (4 semanas + 4 sombra)

Todo el motor (`payouts`) nace en Go. **No hay versión TS intermedia.** Los workers son goroutines disparadas por `gocron` o por NATS subscriptions desde `vp-engine`.

### Fase 3 — Pagos (5 semanas)

- `payments/crypto/*` — Go en `vp-engine` (chain watcher).
- `payments/card/*` — TS en `vp-api` (webhook receiver).
- `payments/bank/*` — TS en `vp-api` (manual review workflow).

### Fase 4 — Hardening

Igual que antes + ahora también: load test específico de gRPC entre servicios (k6 con grpc protocol), profiling Go (pprof), Postgres conn pool tuning para 2 clientes simultáneos.

**Total revisado: ~17 semanas (~4 meses).** +2 semanas vs single-language. El costo de ir polyglot.

---

## 9. Equipo

Mínimo cambia:

- **1 senior backend Go** (no part-time, full-time owner de `vp-engine`).
- **1 senior backend TS** (owner de `vp-api`, Better Auth, integraciones).
- **1 mid backend** flexible (preferir TS al inicio, ramping a Go fase 2+).
- **1 DevOps PT** (50 %).
- **1 QA** desde fase 1.

**Si el equipo no tiene experiencia Go senior:** contratar antes de fase 0. No improvisar — la performance gain de Go solo se materializa con código idiomatic; un junior haciendo Go pierde la ventaja.

---

## 10. Riesgos específicos del polyglot

| Riesgo | Mitigación |
|---|---|
| **Drift de tipos** entre TS y Go al evolucionar `proto` | Single source `proto/` repo; CI bloquea PR si codegen falla en cualquier lado |
| **Latencia gRPC** suma a request time del usuario | mTLS local-network ~1ms; aceptable para mutaciones; lecturas no cruzan boundary |
| **Operaciones diferentes** (build, deploy, debug) | Uniformar con Make targets `make build/test/deploy` que funcionen igual en ambos repos |
| **Difícil contratar Go senior en LATAM** | Usar Toptal / Lemon.io o remoto fuera de LATAM; presupuestar 30-50 % más que TS senior |
| **Schema changes requieren coordinar 2 servicios** | `schema-guard` falla en CI si cualquiera está fuera de sync; deploy ordenado: DDL → vp-engine → vp-api |
| **Logs/traces correlacionados** | OpenTelemetry trace context se propaga vía headers gRPC + NATS message metadata |
| **Tests de integración cruzan servicios** | Docker Compose con ambos servicios + Postgres + NATS para CI |

---

## 11. Decisión de Better Auth bajo carga alta

**Better Auth aguanta carga real.** Benchmarks públicos muestran ~10-15k req/s sostenidos en Bun con cookie sessions cacheadas en Redis. Para fintech con autenticación-por-request, esto se escala horizontalmente añadiendo `vp-api` instances detrás del LB.

**Lo que NO debes hacer:**
- Validar sesión en `vp-engine` por cada call → mata throughput, multiplica Redis lookups.
- Usar JWT sin cache → cada request paga firma + verificación cripto, 5-10x más lento que cookie+Redis.

**Lo que SÍ debes hacer:**
- Cookie sessions + Redis cache en `vp-api`.
- `vp-engine` confía en mTLS, no valida sesión.
- Si en algún punto el bottleneck es Better Auth, primero escalar `vp-api` horizontalmente; solo si eso falla, considerar JWT con JWKS.

---

## 12. Reglas de oro

1. **Una operación = un dueño.** `wallet_movement` lo escribe `vp-engine`. Punto. Si `vp-api` necesita escribir uno, llama gRPC, no inserta directo aunque pueda.
2. **No compartir código.** Tipos comunes vienen de `proto/`. No hay paquete TS-y-Go compartido.
3. **gRPC para sync, NATS para async.** Sin excepciones.
4. **Postgres es la integration boundary, no el detalle de implementación.** Ambos servicios leen el mismo schema; nadie inventa tablas privadas.
5. **mTLS interno, JWT solo si abre HTTP público.** No mezclar.
6. **Schema migrations son atómicas y coordinadas.** DDL primero, despliegue ordenado, schema-guard valida.
7. **Si un módulo en TS sufre por performance, primero perfilar; segundo optimizar TS; tercero (último recurso) mover a Go.** No es una progresión inevitable.
8. **Escribir Go senior, no Go improvisado.** Pair-program el primer mes, code review estricto, lint con `golangci-lint` agresivo.

---

## 13. Cómo empezar (semana 1, revisada)

**Día 1-2:**
- Provisión Hetzner topología nueva (CCX23 ×2 api, CCX33 engine, CX22 nats+redis, AX52+AX42 db).
- Crear repos: `vp-api/` (mover existente `app/`), `vp-engine/` (nuevo Go), `vp-proto/` (proto files).

**Día 3:**
- buf + connectrpc en ambos.
- Primer `.proto`: `Ping`. Codegen funcional.
- vp-api hace gRPC call a vp-engine. Round-trip exitoso.

**Día 4:**
- NATS desplegado en host de Redis.
- TS publica → Go consume; Go publica → TS consume.

**Día 5:**
- Aplicar `schema_mlm.sql` + `00-init.sql` (con role `engine_write` agregado).
- Ambos servicios conectan a Postgres con sus roles respectivos.
- Smoke test: `vp-engine` lee `concept` table; `vp-api` hace `GET /api/me` con sesión Better Auth.

**Final de semana 1:** dos servicios en producción, ambos leen DB, se comunican entre sí, autenticación de usuario funciona en TS, autenticación servicio-a-servicio funciona vía mTLS. Sobre esa base se construye todo lo demás.

---

## 14. Lo que pasa con los archivos ya creados

| Archivo | Estado |
|---|---|
| `_meta/schema_mlm.sql` | sin cambios; fuente de verdad |
| `_meta/migration/*` | sin cambios; ejecuta antes que cualquier servicio |
| `_meta/devops/*` | actualizar topología (1 host más para vp-engine, 1 para vp-engine-replica futura) |
| `app/` | renombrar a `vp-api/`; 95 % del código sigue válido |
| `app/src/server/affiliate.ts:postTransaction` | mover su implementación a `vp-engine`; en `vp-api` queda como cliente gRPC |
| Nuevo `vp-engine/` | crear desde cero con la estructura Go convencional |
| Nuevo `vp-proto/` | proto files compartidos |
| `BACKEND_PLAN.md` | parcialmente reemplazado por este doc en lo arquitectónico; las fases siguen, ajustadas |

---

## 15. Métricas de éxito específicas del polyglot

- **Latency p99 de gRPC interno < 5ms** (red privada Hetzner, mTLS, payload < 4KB).
- **Throughput vp-engine.PostTransaction sostenido > 2,000/sec** en CCX33 con Postgres dedicado.
- **Bonus run de 100k afiliados completa < 90 segundos** (vs. ~10-15 min en SQL Server estimado).
- **Memoria steady-state vp-engine < 150 MB** (Go binary debería ser delgado).
- **Cero divergencia** entre tipos generados por `buf` en TS y Go (CI bloquea drift).

Si cualquiera de estos KPIs no se cumple a fase 1, revisar diseño antes de seguir.
