# 0002 — Backend polyglot: TypeScript + Go

**Status:** Accepted
**Date:** 2026-04-28
**Deciders:** equipo VicionPower (devfidubit)

## Context

VicionPower opera con clientes existentes y TPS alto. El backend tiene dos perfiles de carga muy distintos:

1. **CRUD + workflows + auth + admin + reportes** — alto en cantidad de endpoints, bajo en cómputo por request, alta velocidad de iteración requerida (cambios de UI, KYC providers, integraciones de pago).
2. **Hot path transaccional** — escritura masiva al `wallet_movement`, runs del motor de bonos sobre millones de filas, watchers de blockchain con conexiones long-lived. CPU-bound y memory-sensitive.

Forzar un solo lenguaje significa elegir entre velocidad de feature delivery (TypeScript) o performance bruta (Go/Rust). Para un negocio en producción con clientes pagando, ninguno solo es óptimo.

Decidimos polyglot **desde día 1** porque migrar después con datos vivos en producción es ~10x más caro que arrancar correcto.

## Decision

**Dos servicios, dos lenguajes:**

| Servicio | Lenguaje | Owns |
|---|---|---|
| `vp-api` | TypeScript (Bun + Hono) | HTTP público, Better Auth, identity, admin, KYC, packages, withdrawals (workflow), notifications, reporting |
| `vp-engine` | Go 1.23+ | Ledger writes (alto TPS), motor de bonos, blockchain watcher, payment confirmation, jobs scheduled |

**Frontera estricta:**
- `vp-api` orquesta y expone HTTP. Nunca escribe directamente a `wallet_movement` ni `tree_event` ni `bonus_run_payout` — siempre vía gRPC a `vp-engine`.
- `vp-engine` no expone HTTP público. Solo gRPC (interno mTLS) + suscripciones NATS + jobs scheduled.

**Comunicación:** ver ADR 0006 (gRPC) y ADR 0007 (NATS).

## Consequences

### Positivas

- **Performance del hot path 5-10x mejor** vs single-language TS. Ledger inserts a >2,000/sec sostenidos, bonus runs de 100k afiliados < 90s, memoria predecible.
- **Velocidad de iteración mantenida** en el 70% del código (CRUD, admin, integrations) gracias a TS + Bun + Hono + Drizzle + Better Auth.
- **Aislamiento de fallas:** un bug en handlers HTTP no tumba el motor de bonos (proceso separado).
- **Escalabilidad horizontal independiente:** podemos sumar instancias de `vp-api` (CRUD-bound) sin tocar `vp-engine`, y viceversa.
- **Better Auth se mantiene** sin reimplementar auth en Go (ver ADR 0003).
- **Drizzle ORM se mantiene** en TS donde brilla; pgx + sqlc en Go donde la performance importa.

### Negativas

- **2 stacks operativos:** dos pipelines CI/CD, dos sets de métricas, dos lenguajes para hire/training, dos ecosistemas para securities updates.
- **Hire de Go senior es más difícil en LATAM** que TS. Presupuestar 30-50% más por seniority equivalente. Si no hay Go senior contratado al día 1, postergar `vp-engine` o aceptar bajada de calidad.
- **Drift de tipos** entre TS y Go al evolucionar `proto/`. Mitigación: buf codegen en CI bloquea PRs si los stubs no se regeneran.
- **Tests de integración cruzan servicios** — Docker Compose con ambos servicios + Postgres + NATS para CI. Más complejo que un test single-process.
- **Schema migrations requieren coordinación**: DDL primero, luego deploy `vp-engine`, luego `vp-api`. Mitigación: `schema-guard` en CI.
- **+2 semanas de timeline** vs single-language (~17 semanas total a producción funcional vs 15).
- **+€90/mes** infra (CCX33 dedicado para `vp-engine`, ~€263 total/mes).

### Neutras

- Equipos jóvenes que solo conocen TS pueden necesitar pair-programming inicial con el senior Go por 4-6 semanas.
- Tooling Go (gofmt, golangci-lint, goimports) es excelente; el costo de calidad es bajo si se usa.

## Alternatives considered

### Single-language TypeScript (Bun monolith)

**Rechazado** por carga real existente.
- Bun es rápido (3-5x Node) pero el motor de bonos sobre millones de filas se beneficia de Go por factor 5-10x adicional.
- Postgres set-based queries cubren mucho, pero algunos cálculos del binario requieren pasos imperativos (closing cycles con weak-leg lookups iterativos).
- Conexiones long-lived a TRC20/BTC nodes son terreno natural para goroutines, no para event loop con I/O bloqueante a un node externo.

Era nuestra primera recomendación cuando asumimos "negocio nuevo, sin carga". Cambió cuando supimos que ya hay clientes y TPS alto.

### Single-language Go

**Rechazado** por costo de infraestructura tooling perdida:
- Better Auth no tiene equivalente Go decente (ver ADR 0003).
- Drizzle no tiene equivalente; sqlc + pgx es excelente pero requiere más boilerplate para CRUD genérico.
- react-email para templates transaccionales no tiene par.
- Hire pool más limitado.

Go es el lenguaje correcto para 30% del sistema, no para 100%.

### NestJS (TS, framework Java-style)

**Rechazado.** Resuelve un problema diferente del que tenemos: añade convención DI/decoradores estilo Spring, útil cuando hay equipos heterogéneos grandes que necesitan un molde común. Para 2-3 ingenieros backend, es overhead sin beneficio. Hono ya da modular monolith con la convención que decidimos en `app/src/modules/*`.

### Rust en lugar de Go para `vp-engine`

**Rechazado.** Rust gana en performance puro y safety, pero:
- Compile times mucho más lentos (3-10x Go) — penaliza iteración.
- Hire pool aún más estrecho que Go en LATAM.
- Curva de aprendizaje más empinada (lifetimes, borrow checker).
- Para nuestro caso (DB-bound, no CPU-bound puro), la diferencia con Go es marginal.

Si el bottleneck fuera CPU-puro en cálculos numéricos sin tocar DB, Rust ganaría. No es nuestro caso.

### Microservicios completos (5+ servicios desde día 1)

**Rechazado.** Ver ADR 0008. Premature decomposition mata equipos pequeños.

### Java/Spring Boot

**Rechazado.** Resuelve los mismos problemas que Go pero con 3-5x el footprint de memoria y tiempos de boot. Sin ventaja específica para este caso.

## References

- `_meta/POLYGLOT_ARCHITECTURE.md` — diseño detallado.
- `_meta/BACKEND_PLAN.md` — plan de fases con timeline ajustado a polyglot.
- ADR 0006 — gRPC entre servicios.
- ADR 0007 — NATS para async cross-language.
- ADR 0008 — modular monolith dentro de cada servicio.
- Discord blog: https://discord.com/blog/why-discord-is-switching-from-go-to-rust (caso opuesto, útil para entender cuándo Rust gana)
- Stripe API in Ruby + Go workers: https://stripe.com/blog/inside-stripes-engineering-2 (patrón polyglot similar)
