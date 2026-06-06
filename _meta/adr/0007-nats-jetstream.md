# 0007 — NATS JetStream para mensajería asíncrona cross-language

**Status:** Accepted
**Date:** 2026-04-28
**Deciders:** equipo VicionPower (devfidubit)

## Context

VicionPower necesita un broker para eventos asíncronos cross-language entre `vp-api` (TS) y `vp-engine` (Go), y dentro de cada servicio para colas de jobs:

**Eventos cross-service (TS ↔ Go):**
- `packages.purchased` (vp-api) → `vp-engine` consume y emite `tree.pv_credited`.
- `payments.deposit_confirmed` (vp-engine) → `vp-api` consume y activa paquete + envía email.
- `payouts.payout_recorded` (vp-engine) → `vp-api` consume y notifica al afiliado.

**Jobs internos:**
- `vp-api`: emails, webhooks salientes, exports CSV/XLSX.
- `vp-engine`: blockchain watchers, scheduled bonus runs.

Restricciones:
- **Multi-language nativo** (TS y Go).
- **Persistencia** (no perder eventos si un consumidor está caído).
- **At-least-once delivery** mínimo; exactly-once preferido para eventos financieros.
- **Footprint operacional bajo** — ya operamos Postgres, Redis, dos servicios; no quiero un Kafka cluster.
- **Costo $0** preferido (open source).

## Decision

**NATS JetStream** desplegado en el host compartido con Redis (CX22).

Configuración:
- Single-node JetStream con storage local (file-based, encriptado en reposo).
- Streams clave:
  - `EVENTS` — eventos de dominio (packages.*, payments.*, payouts.*, tree.*, identity.*).
  - `JOBS_API` — colas de jobs de `vp-api` (emails, exports).
  - `JOBS_ENGINE` — colas de jobs de `vp-engine` (chain watchers, scheduled runs).
- Consumer groups con `DeliverPolicy=All` para nuevos consumers, `AckPolicy=Explicit` para confirmación manual.
- Retention: `WorkQueue` policy en jobs (delete on ack), `Limits` policy en eventos (7 días o 10 GB).
- Authentication: NATS user accounts con JWT, separadas para `vp-api` y `vp-engine`.

Wire format: **JSON con schema validation por consumer** (no protobuf — los consumers son ad-hoc por tipo de evento).

## Consequences

### Positivas

- **Footprint mínimo.** Single binary `nats-server`, ~30 MB RAM idle, <100 MB con load real. Cabe perfecto en CX22 junto con Redis.
- **Clientes oficiales TS y Go** maduros y con buena DX. `nats.js` y `nats.go` son first-class.
- **Persistencia + at-least-once** out of the box con JetStream. Restart de un consumer no pierde mensajes.
- **Exactly-once dedup** vía `Nats-Msg-Id` header — el publisher pone un ID idempotente, el server deduplica por ventana configurable. Para eventos financieros (`payouts.payout_recorded`) usamos esto.
- **Subject hierarchy** (`packages.purchased.usd`, `packages.purchased.btc`) permite consumers wildcard (`packages.purchased.>`) sin reconfiguración server-side.
- **Streaming push y pull** patterns disponibles. Pull-based ideal para workers (tipo BullMQ).
- **Performance excelente:** 100k+ msg/s en hardware modesto, latencia p99 sub-millisecond.
- **Sin Zookeeper, sin coordinador externo.** NATS server es autoritativo.

### Negativas

- **Single-node por defecto** = punto único de falla. Mitigación inicial: aceptamos eso porque NATS persiste a disco y tiene reinicio rápido (~5s); jobs encolados sobreviven al restart. Para HA real: NATS cluster de 3 nodos, requiere infra adicional (~€12/mo en 2 hosts adicionales). Posponer hasta que el negocio justifique.
- **Comunidad/documentación menor que Kafka.** Para casos edge raros, googlear ayuda menos. La docs oficial es buena.
- **No es un broker tradicional pesado.** Si en el futuro queremos transformaciones complejas en tránsito (Kafka Streams style), NATS no las hace. Sin uso obvio para nosotros.
- **Reto operacional:** snapshot/backup del stream JetStream requiere setup explícito (no es como un dump de Postgres). Mitigación: streams son replayable desde Postgres `tree_event` + `transaction` para los datos críticos, así que perder mensajes en JetStream temporalmente no es catastrófico.

### Neutras

- Métricas Prometheus exporter incluido (`nats-server -m 8222`).
- Compatible con Cloud (Synadia ofrece managed) si el día de mañana queremos delegar.

## Alternatives considered

### Kafka

**Rechazado.**
- Operacionalmente pesado: Zookeeper (legacy) o KRaft (3+ nodos), JVM, GC tuning, log retention configuration.
- Footprint ~2 GB RAM mínimo; cluster mínimo HA es 3 nodos = ~€60+/mes adicional.
- Excelente para fan-out masivo (millones de eventos/s, múltiples consumers paralelos), uso bigtech-scale. **Overkill para nosotros.**
- Streams en Kafka brillan con CDC, log analytics. No tenemos esos casos.

Plan B: si llegamos a >100M eventos/día o necesitamos integraciones tipo Snowflake/BigQuery vía Debezium, migrar.

### Redis Streams (vía BullMQ)

**Considerado para jobs internos solamente.**
- BullMQ es excelente para jobs en Node/TS — ya pensamos usarlo.
- Pero **no es first-class en Go** (clients existen, son menos pulidos).
- Sin subject hierarchy / wildcards como NATS.
- Persistencia depende de Redis AOF, que ya está configurado, pero forzar Redis a cumplir dos roles (cache + broker) en la misma instancia mezcla blast radius.

**Decisión híbrida posible:** BullMQ dentro de `vp-api` para jobs **TS-only** (emails, exports), NATS para todo cross-language. Refinaremos en implementación.

### RabbitMQ

**Rechazado.**
- Erlang VM, 3-5x el footprint de NATS.
- Modelo de exchanges/queues más complejo que el de subjects de NATS.
- Performance inferior a NATS para nuestros patrones.
- Buen broker tradicional; sin razón específica de elección sobre NATS aquí.

### AWS SNS + SQS

**Rechazado.**
- Lock-in con AWS (ADR 0005 evita).
- Latencia desde Hetzner: ~100ms por publish.
- Costo escala con volumen ($0.50/M para SQS); irrelevante a baja escala, prohibitivo a 100k eventos/min.

### Apache Pulsar

**Rechazado.** Mismo perfil que Kafka — overkill operativo. Multi-tenancy y geo-replication built-in son superiores a Kafka, pero no necesitamos eso.

### NSQ

**Rechazado.** NATS lo supera técnicamente (mejor performance, mejor DX, JetStream para persistencia). NSQ es más simple pero no acepta persistencia nativa.

### Postgres como broker (LISTEN/NOTIFY)

**Considerado.** Funciona para casos chicos. Perdió por:
- LISTEN/NOTIFY no es persistente — un consumer offline pierde notificaciones.
- Para volumen alto (100k+ eventos/día) la presión sobre WAL se nota.
- Sin features de stream (replay desde un offset, dedup, etc.).

Útil para señales sencillas in-process. No para arquitectura de eventos cross-service.

### Cloudflare Queues / AWS EventBridge

**Rechazado por lock-in y costo.**

## Convenciones de uso

1. **Subjects estructurados:** `<dominio>.<acción>.<sufijo>`. Ej: `payments.deposit.confirmed.usdt`, `packages.purchased.basic`.
2. **Schema en `vp-proto/events/<dominio>.json`** (JSON Schema) con CI validation. Cambios breaking → bump de versión en subject (`v2.payments.deposit.confirmed`).
3. **Mensajes deben ser idempotentes.** Cada uno lleva `event_id` (uuid). Consumer hace dedup por DB unique constraint o tabla `processed_events`.
4. **Acks explícitos.** Worker ack solo cuando la mutación de DB se commitea. Si crash entre process y ack, NATS reentrega.
5. **Dead letter:** mensajes con > 5 fallos van a `DLQ.<stream-original>` para revisión humana.
6. **Tests E2E:** Docker Compose con NATS local — deployment idéntico al de producción, lectura/escritura desde TS y Go simultáneamente.

## References

- `_meta/POLYGLOT_ARCHITECTURE.md` §3 — patrones de uso async.
- ADR 0002 — polyglot.
- ADR 0006 — gRPC para sync (complemento).
- NATS docs: https://docs.nats.io/nats-concepts/jetstream
- "Choosing Between NATS, Kafka, and Pulsar": https://nats.io/blog/comparing-nats-jetstream-to-kafka/
- BullMQ vs NATS comparison (informal): https://docs.nats.io/running-a-nats-service/nats_admin/jetstream_admin
