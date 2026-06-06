# 0011 — Stack de observabilidad: Grafana Cloud Free + OpenTelemetry

**Status:** Accepted
**Date:** 2026-04-28
**Deciders:** equipo VicionPower (devfidubit)

## Context

VicionPower operará con dos servicios (vp-api TS, vp-engine Go), Postgres + replica, Redis, NATS, todo en Hetzner. Necesitamos visibilidad sobre:

- **Estado de hosts:** CPU, memoria, disco, red por server.
- **Salud de servicios:** RED metrics (rate, errors, duration) por endpoint HTTP y método gRPC.
- **Postgres:** queries lentas, replication lag, autovacuum, conexiones, pg_stat_statements.
- **NATS:** lag de consumers, msg/s por subject, dead letters.
- **Métricas de negocio:** transacciones/seg, drift en `v_wallet_balance_truth`, withdrawal queue size, ROI run timing.
- **Distributed tracing:** request → vp-api → gRPC → vp-engine → Postgres latency breakdown.
- **Logs estructurados:** búsqueda y correlación por trace_id, person_id, etc.

Restricciones:
- **Costo bajo** — el negocio no justifica $200-500/mes en observabilidad operacional vs producto.
- **Sin operación pesada** — no queremos un cluster de Prometheus + Loki + Tempo a mantener.
- **Compliance** — logs financieros mínimo 1 año accesibles.
- **Estándar abierto** — sin lock-in propietario para evitar repetir migración.

## Decision

**Grafana Cloud Free Tier como backend, OpenTelemetry + Prometheus exporters como agentes.**

### Stack completo

| Capa | Tool | Costo |
|---|---|---|
| Métricas (host) | `node_exporter` en cada VM | $0 |
| Métricas (Postgres) | `postgres_exporter` en db-01, db-02 | $0 |
| Métricas (Redis) | Redis built-in `INFO` parseado por agent | $0 |
| Métricas (NATS) | `nats-server -m` Prometheus endpoint | $0 |
| Métricas (vp-api TS) | `prom-client` library, `/metrics` endpoint | $0 |
| Métricas (vp-engine Go) | `prometheus/client_golang`, `/metrics` endpoint | $0 |
| Logs (shipping) | `Vector` (Rust, ~5MB RAM) en cada host | $0 |
| Traces (instrumentation) | OpenTelemetry SDK en TS y Go | $0 |
| **Storage + dashboards + alerting** | **Grafana Cloud Free Tier** | **$0** |
| Archivo logs largo plazo | Hetzner Storage Box (Vector S3 sink) | ya pagado (€4/mes) |
| Uptime externo + status page | BetterStack Free (1 monitor) o UptimeRobot | $0 |

**Grafana Cloud Free Tier limites:**
- 10,000 active series (métricas).
- 50 GB logs/mes.
- 50 GB traces/mes.
- 14 días de retention.
- 3 usuarios.
- Alertas ilimitadas con notificación a Slack/email/PagerDuty.

A nuestro tamaño inicial (6 hosts + 2 servicios), generaremos ~1-2k active series y ~5-10 GB logs/mes. Margen 5-10x antes de pagar.

### Métricas core a instrumentar día 1

**RED por endpoint TS (Hono middleware):**
- `http_requests_total{method, route, status}` — counter
- `http_request_duration_seconds{method, route, status}` — histogram

**RED por método gRPC Go (connectrpc interceptor):**
- `grpc_requests_total{service, method, code}`
- `grpc_request_duration_seconds{service, method, code}`

**USE por host (node_exporter):**
- CPU, memory, disk, network, disk I/O, file descriptors.

**Postgres (postgres_exporter):**
- pg_stat_statements top 20 by total_time
- replication_lag_seconds
- autovacuum_count, autovacuum_duration
- conexiones por estado (active, idle, idle_in_transaction)
- table bloat, index bloat
- TimescaleDB: chunks count, compression ratio

**NATS (built-in):**
- jetstream_stream_messages
- consumer_lag por subject
- delivered, ack, redelivered

**Custom collectors (negocio):**
- `mlm_wallet_balance_drift{wallet_id}` — gauge from `v_wallet_balance_truth`
- `mlm_tree_pv_drift{affiliate_id}` — gauge from `v_tree_pv_truth`
- `mlm_withdrawal_queue_size{status}` — gauge
- `mlm_bonus_run_last_completed_seconds{kind}` — gauge (segundos desde último run exitoso)
- `mlm_signup_total` — counter
- `mlm_active_affiliates` — gauge (refresh cada 1h vía continuous aggregate)

### Alertas P0 (despierta a alguien de noche)

```yaml
- alert: WalletBalanceDrift
  expr: max(mlm_wallet_balance_drift) != 0
  for: 5m
  severity: critical

- alert: TreePvDrift
  expr: max(mlm_tree_pv_drift) != 0
  for: 5m
  severity: critical

- alert: PostgresReplicationLag
  expr: pg_replication_lag_seconds > 30
  for: 2m
  severity: critical

- alert: PostgresConnectionsExhausting
  expr: (pg_connections_active / pg_connections_max) > 0.9
  for: 5m
  severity: critical

- alert: DiskFreeLow
  expr: (node_filesystem_avail_bytes / node_filesystem_size_bytes) < 0.1
  for: 5m
  severity: critical

- alert: ServiceDown
  expr: up{job=~"vp-api|vp-engine"} == 0
  for: 30s
  severity: critical

- alert: BonusRunFailed
  expr: time() - mlm_bonus_run_last_completed_seconds{kind="roi"} > 90000  # 25h
  for: 5m
  severity: critical
```

### Alertas P1 (Slack durante horas hábiles)

```yaml
- alert: HighLatency
  expr: histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m])) > 2
  for: 5m
  severity: warning

- alert: HighErrorRate
  expr: rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m]) > 0.01
  for: 5m
  severity: warning

- alert: TimescaleCompressionLag
  expr: time() - timescale_last_compression_seconds > 43200  # 12h
  for: 30m
  severity: warning

- alert: NATSConsumerLag
  expr: nats_consumer_num_pending > 1000
  for: 10m
  severity: warning
```

### Logs estructurados

Format JSON con campos canonical:
```json
{
  "timestamp": "2026-04-28T15:30:00Z",
  "level": "info",
  "service": "vp-api",
  "trace_id": "...",
  "span_id": "...",
  "person_id": 1234,
  "request_id": "...",
  "msg": "withdrawal_approved",
  "data": { "withdrawal_id": 567, "amount_usd": "100.00" }
}
```

Vector ships a Loki (Grafana Cloud) + paralelamente a Storage Box S3 para retention larga.

### Distributed tracing

OpenTelemetry SDK en ambos servicios. Trace context se propaga:
- HTTP request → Hono middleware extrae `traceparent` header.
- vp-api → gRPC call → propaga via metadata.
- vp-engine → Postgres call → propaga via `application_name` setting.
- vp-engine → NATS publish → propaga en message headers.
- vp-api → NATS consume → continúa el trace.

Tempo en Grafana Cloud almacena 14 días. Para investigación de incidentes >14d viejos, los logs estructurados con `trace_id` permiten reconstruir aproximadamente.

## Consequences

### Positivas

- **$0/mes** mientras estamos bajo los limites del free tier (esperable mínimo 6 meses).
- **Sin operación de DB de metrics propia.** Grafana Cloud opera Prometheus, Loki, Tempo, Alertmanager.
- **OpenTelemetry estándar abierto.** Migrar a self-hosted o paid es literal cambiar la URL del OTLP exporter.
- **Dashboards prefabricados** para Postgres, Redis, NATS, Linux hosts disponibles inmediatamente desde el catalog.
- **Comunidad y docs excelentes.** Grafana Labs ha hecho buen trabajo de DX.
- **Alertmanager incluido** sin componente extra. Slack/PagerDuty/email out of the box.

### Negativas

- **Si free tier cambia**, podemos quedar atrapados. Mitigación: portabilidad por OTel; Plan B documentado (self-hosted Grafana stack + VictoriaMetrics ~€15/mes).
- **14 días de retention** en metrics y traces es corto para postmortems históricos. Mitigación: continuous aggregates en TimescaleDB para métricas críticas de negocio (drift, transactions/sec) que se mantienen 5+ años en DB. Logs detallados en Storage Box S3 retention 1+ año.
- **Free tier no incluye SLA del servicio Grafana Cloud.** Si Grafana Cloud cae, perdemos visibilidad temporalmente — pero el sistema sigue funcionando, solo no vemos qué pasa. Aceptable.
- **3 usuarios free tier** límite. Más de 3 ingenieros con acceso = upgrade a Pro ($29/user/mo). Workaround: usuarios compartidos por rol (read-only ops, alert-receiver, etc.) con SSO via Google.
- **Métricas de altísima cardinalidad** (e.g., `person_id` en label) explotan series. Disciplina de etiquetado importante; revisar antes de cada nueva métrica.

### Neutras

- Vector vs Fluent Bit vs Promtail: elegimos Vector por mejor rendimiento + soporte nativo S3 sink.
- BetterStack vs UptimeRobot para uptime externo: BetterStack tiene mejor UX y status page; UptimeRobot tiene tier gratis más generoso. Decisión final en setup.

## Alternatives considered

### Datadog

**Rechazado.**
- $15/host/mes infra + $31/host APM + $1.06/M log events + $1.27/GB log retention. Para 6 hosts + APM + logs: ~$200-400/mes desde día 1.
- Lock-in con su query language y formato. Migrar después es proyecto.
- Excelente DX y producto, pero el costo es prohibitivo para este tamaño.

Plan B explícito: si llegamos a regulación pesada (PCI/SOC2 estricto) o equipo de SRE dedicado, evaluar Datadog. Tiene compliance certs built-in que ahorran trabajo.

### New Relic

**Rechazado.** 100 GB/mes free es generoso pero NRQL lock-in es alto. Si crecemos, su pricing por user es caro.

### Honeycomb

**Considerado seriamente para traces específicamente.** $130/mes Pro tier cubre traces ilimitados con retention larga. Honeycomb es el mejor del mercado en traces y eventos de alta cardinalidad. Perdió por:
- Solo traces — necesitaríamos otra herramienta para metrics y logs.
- A volumen actual, Tempo en Grafana Cloud Free es suficiente.

Plan B: si descubrimos que traces son nuestro debugging primario y 14d retention es insuficiente, mover traces a Honeycomb manteniendo metrics+logs en Grafana.

### Self-hosted full stack (Prometheus + Loki + Tempo + Grafana propio)

**Considerado.** $0 software pero requiere operar el cluster: storage, retention, scaling, upgrades. Estimado 5-10 horas/mes de operación. A nuestro tamaño no compensa vs Grafana Cloud Free.

Plan B documentado: cuando excedamos free tier o queramos retention > 14d en metrics, levantar VictoriaMetrics + Loki + Tempo en una VM Hetzner CCX22 (~€15/mes). Los exporters y SDKs no cambian, solo apuntan a otro endpoint.

### SigNoz (open source Datadog clone)

**Considerado.** Excelente promesa: ClickHouse-backed, OpenTelemetry-native, todo-en-uno. Perdió por:
- Inmadurez relativa (proyecto joven).
- Operacionalmente ClickHouse + servicio SigNoz es overhead.
- Si vamos a self-hosted, VictoriaMetrics + Grafana es más maduro.

Plan B: si Datadog se vuelve necesario por features pero el costo es prohibitivo, SigNoz es la opción open source.

### ELK Stack (Elasticsearch + Logstash + Kibana)

**Rechazado.** Operacionalmente pesado, JVM-heavy, expensive at scale, query language (Lucene) menos potente que LogQL. Reemplazado por Loki en este espacio.

### Splunk

**Rechazado.** Enterprise-priced, lock-in, overkill.

### Cloud-native (CloudWatch / GCP Monitoring)

**Rechazado.** Lock-in y costo, además somos Hetzner (ADR 0005).

### Netdata

**Considerado para complemento.** Excelente para visualización en tiempo real per-host. No reemplaza Grafana Cloud para histórico/alertas/correlación, pero podría agregarse free como vista local rápida en cada host. Decisión: aplazar; no urgente.

## References

- `_meta/devops/PLAYBOOK.md` §8 — monitoreo (actualizar con esta ADR).
- ADR 0005 — Hetzner.
- ADR 0006 — gRPC con interceptors OTel.
- ADR 0007 — NATS con métricas.
- Grafana Cloud Free: https://grafana.com/auth/sign-up/create-user
- OpenTelemetry: https://opentelemetry.io/
- Vector: https://vector.dev/
- BetterStack: https://betterstack.com/
- Postgres exporter: https://github.com/prometheus-community/postgres_exporter
- Comparison "Datadog vs Grafana Cloud" (real-world): https://www.honeycomb.io/blog/observability-cost-pricing-comparison
