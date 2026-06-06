# Architecture Decision Records

Decisiones arquitectónicas de VicionPower documentadas en formato ADR.

## Convención

- Numeradas secuencialmente: `0001-`, `0002-`, etc.
- Una decisión por archivo. Si una decisión reemplaza otra, la nueva referencia el número de la antigua y marca la antigua como `Superseded`.
- **No se editan ADRs aceptadas.** Si la realidad cambia, se escribe una nueva que supersede.
- Estados: `Proposed` → `Accepted` → (eventualmente) `Superseded` o `Deprecated`.

## Formato

```markdown
# NNNN — Título corto

**Status:** Accepted | Proposed | Superseded by NNNN | Deprecated
**Date:** YYYY-MM-DD
**Deciders:** quién firmó

## Context
Por qué necesitamos decidir esto. Qué fuerzas están en juego.

## Decision
Qué decidimos. Específico, accionable.

## Consequences
Qué cambia. Positivo, negativo, neutro.

## Alternatives considered
Qué evaluamos y por qué se descartó.

## References
Links a docs, benchmarks, discusiones.
```

## Índice

| # | Título | Estado | Fecha |
|---|---|---|---|
| [0001](0001-database-choice.md) | Postgres self-hosted + TimescaleDB | Accepted | 2026-04-28 |
| [0002](0002-polyglot-ts-go.md) | Backend polyglot TypeScript + Go | Accepted | 2026-04-28 |
| [0003](0003-better-auth.md) | Better Auth en lugar de Cognito/Auth0 | Accepted | 2026-04-28 |
| [0004](0004-secrets-sops-age.md) | sops + age para secrets management | Accepted | 2026-04-28 |
| [0005](0005-hetzner-bare-metal.md) | Hetzner bare metal en lugar de AWS/GCP | Accepted | 2026-04-28 |
| [0006](0006-grpc-connectrpc.md) | gRPC + connectrpc para servicio-a-servicio | Accepted | 2026-04-28 |
| [0007](0007-nats-jetstream.md) | NATS JetStream para eventos asíncronos | Accepted | 2026-04-28 |
| [0008](0008-modular-monolith.md) | Modular monolith en lugar de microservicios | Accepted | 2026-04-28 |
| [0009](0009-data-retention.md) | Política de retención de datos (Habeas Data + DIAN) | Accepted | 2026-04-28 |
| [0010](0010-four-eyes-policy.md) | Política de cuatro ojos para operaciones sensibles | Accepted | 2026-04-28 |
| [0011](0011-observability-stack.md) | Stack de observabilidad: Grafana Cloud Free + OTel | Accepted | 2026-04-28 |
| [0012](0012-binary-compensation-plan.md) | Plan de compensación binario: parámetros e invariantes | Accepted | 2026-04-28 |
| [0013](0013-payment-processor-stripe.md) | Stripe como procesador de pagos con tarjeta | Accepted | 2026-04-28 |
| [0014](0014-external-wallet-api.md) | Wallet crypto via API externa (no self-custody) | Accepted | 2026-04-28 |

## ADRs futuros probables

A escribir cuando se tomen las decisiones (BACKEND_PLAN §13):

- KYC provider (Truora / Sumsub / Onfido / manual)
- Wallet provider específico (BitGo / Fireblocks / Tatum / interno) — confirmar cuál
- SLA de procesamiento de retiros
- Política de blacklist (proceso, apelación)
- Plan de comunicación del cutover
