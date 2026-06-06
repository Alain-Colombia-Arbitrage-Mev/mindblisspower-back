# vp-engine

Motor de bonos, ledger writes y wallet bridge de VicionPower. Implementa los
hot paths transaccionales en Go, según
[ADR 0002](../_meta/adr/0002-polyglot-ts-go.md).

## Qué hace

- **`internal/ledger/`** — único módulo que escribe `mlm.wallet_movement` y
  `mlm.transaction`. Expone gRPC al `vp-api`.
- **`internal/bonusengine/`** — cierre binario semanal, streams v2
  (R2/R3/rangos/referido/regalía), scheduler e invariantes T1-T4 según
  [ADR 0012](../_meta/adr/0012-binary-compensation-plan.md) y
  [`_meta/binary_spec.md`](../_meta/binary_spec.md).
- **`internal/walletbridge/`** — consume webhooks del wallet provider externo via NATS y los traduce a operaciones contables ([ADR 0014](../_meta/adr/0014-external-wallet-api.md)). NO observa blockchain ni custodia keys.
- **`internal/treewriter/`** — escritura de `mlm.tree_event` y aggregates (cuando vp-api delega placement masivo).
- **`internal/chainwatcher/`** — DEPRECATED tras ADR 0014. Stub vacío hasta eliminación.

## Cómo conecta con el resto

```
vp-api (TS) ──gRPC mTLS── vp-engine (Go)
                              │
                       ┌──────┼──────┐
                       │      │      │
                  Postgres  Redis  NATS
```

- **Sync:** gRPC + connectrpc + buf (ver `proto/`). [ADR 0006](../_meta/adr/0006-grpc-connectrpc.md).
- **Async:** NATS JetStream para eventos cross-service. [ADR 0007](../_meta/adr/0007-nats-jetstream.md).
- **Datos:** Postgres compartido con `vp-api`, role `engine_write` (no toca `auth.*`). [ADR 0001](../_meta/adr/0001-database-choice.md).

## Setup local

```bash
# Requisitos: Go 1.23+, Docker, Make, buf, sqlc.

# 1. Levantar dependencias (Postgres + Redis + NATS)
docker compose -f deployments/docker-compose.yml up -d

# 2. Aplicar schema (desde el repo padre)
psql postgres://migrator:CHANGEME@localhost:5432/vicionpower -f ../_meta/schema_mlm.sql
psql postgres://migrator:CHANGEME@localhost:5432/vicionpower -f ../_meta/schema_governance.sql
psql postgres://migrator:CHANGEME@localhost:5432/vicionpower -f ../_meta/migration/05_timescaledb.sql
psql postgres://migrator:CHANGEME@localhost:5432/vicionpower -f ../_meta/schema_payouts.sql

# 3. Codegen (proto + sqlc)
make generate

# 4. Run
make run

# 5. Smoke test
curl http://localhost:9090/health
curl http://localhost:9090/metrics | head
```

## Layout

```
cmd/vp-engine/main.go         entry: wiring + graceful shutdown
internal/
  bonusengine/                cierre binario + streams v2; ROI standalone pendiente
  ledger/                     gRPC handler que escribe wallet_movement
  chainwatcher/               watchers TRC20/BTC
  treewriter/                 pendiente: escritura masiva de tree_event
  server/                     HTTP /health/metrics + gRPC connectrpc
  shared/
    config/                   carga desde env
    db/                       pgx pool
    log/                      zerolog
    metrics/                  Prometheus registry
    tracing/                  OpenTelemetry
sqlc/
  sqlc.yaml                   config v2
  queries/*.sql               SQL crudo, sqlc lo traduce
  generated/                  output (.gitignored)
proto/vicionpower/v1/         servicios proto (compartidos con vp-api)
deployments/
  Dockerfile                  multi-stage scratch ~15 MB
  docker-compose.yml          dev local
  systemd/                    units para producción Hetzner
tests/integration/            tests con testcontainers
```

## Targets `make`

```
make generate    # buf generate + sqlc generate
make build       # CGO_ENABLED=0 build estático
make test        # go test ./... -race
make lint        # golangci-lint
make run         # build + run con env desarrollo
make docker      # build imagen scratch
```

## Simulador de desembolsos

`cmd/vp-sim` simula la liquidación del árbol binario y de los rangos sin tocar
base de datos. La salida separa el dinero distribuido por stream y el fondo que
queda para la empresa:

```bash
go run ./cmd/vp-sim --v2 --periods 26 --initial 1000 --growth 0.04 --quiet
```

Campos clave:

- `total distributed`: total desembolsado a afiliados.
- `company fund retained`: inflows menos desembolsos; es el fondo retenido por
  la empresa en la simulación.
- `binary tree paid`: pago neto del bono binario por bloques.
- `rank bonuses paid`: bonos de carrera de rangos liquidados en el período.
- `yield/points/referral/royalty`: streams adicionales v2, todos dentro de T1.

Reglas de árbol aplicadas por el simulador:

- La población inicial se siembra con sponsors reales según
  `SponsorDistribution`; sólo el primer nodo cuelga del root de compañía.
- El binario exige paquete propio activo.
- Si `Q_L/Q_R > 0`, exige hijo binario inmediato activo en la pierna requerida
  y patrocinado directo activo colocado en esa misma pierna.
- El volumen por derrame suma PV, pero no habilita pago binario por sí solo.

Para análisis externo:

```bash
go run ./cmd/vp-sim --v2 --csv sim.csv --json periods.json --report-json disbursement.json
```

El CSV por período incluye `binary_paid`, `rank_paid`, `company_fund` y
`cumulative_company_fund`. El `--report-json` emite el resumen acumulado por
stream y por período.

## Convenciones de código

- Errors con `errors.Is` / `errors.As`, sentinel errors públicos cuando aplique.
- Logs con zerolog estructurado. **Nunca** `fmt.Println` ni `log.Print`.
- `decimal.Decimal` (shopspring) para todo monto. **Nunca** `float64`.
- `context.Context` como primer parámetro en cualquier IO.
- Test names descriptivos: `TestEngine_CloseBinaryPeriod_ThetaThrottle`.
- Preferir sqlc para queries reutilizables. El hot path de `bonusengine` usa
  SQL local explícito cuando necesita transacciones compactas y auditables.

## Estado

| Módulo | Estado | Notas |
|---|---|---|
| server HTTP/gRPC | Implementado | `/health`, `/metrics`, connectrpc |
| ledger.PostTransaction | Implementado | Idempotente por `external_ref` |
| bonusengine.CloseBinaryPeriod | Implementado | Binario + streams v2 + T1-T4 |
| bonusengine scheduler | Implementado | Lunes 02:00 `America/Bogota` |
| invariant monitor | Implementado | `fn_check_payout_invariants()` cada 60s |
| walletbridge | Parcial | Suscrito a NATS; handlers de depósito/retiro pendientes |
| treewriter | Pendiente | Bulk placement / recompute |
| ROI diario/CD | Pendiente | `RunROIDaily()` aún retorna error |

Ver [BACKEND_PLAN §3.5](../_meta/BACKEND_PLAN.md),
[`_meta/binary_spec.md`](../_meta/binary_spec.md) y
[`docs/liquidacion_y_ciclo_de_pago.md`](../../docs/liquidacion_y_ciclo_de_pago.md).
