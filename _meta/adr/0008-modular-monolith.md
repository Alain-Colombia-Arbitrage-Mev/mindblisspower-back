# 0008 — Modular monolith en lugar de microservicios

**Status:** Accepted
**Date:** 2026-04-28
**Deciders:** equipo VicionPower (devfidubit)

## Context

ADR 0002 establece **dos servicios** (`vp-api` y `vp-engine`). Esta ADR responde la pregunta interna: **¿cómo organizamos el código DENTRO de cada servicio?**

Opciones:
1. **Single big file/module** — todo el código en una bola; rápido al inicio, doloroso después.
2. **Modular monolith** — un servicio, múltiples módulos con boundaries claros.
3. **Microservicios** — múltiples servicios pequeños desplegables independiente.

Restricciones de contexto:
- Equipo backend de 2-3 ingenieros senior + 1 mid.
- Negocio nuevo (post-cutover); cambio de requirements frecuente esperado en primeros 12 meses.
- Modelo de dominio bien entendido (MLM con ledger + árbol binario + bonos), pero los flujos de UX/ops siguen evolucionando.
- Carga ya alta (clientes en producción).

## Decision

**Modular monolith dentro de cada uno de los 2 servicios** (ADR 0002), con boundaries de módulo enforced por convención + lint.

### Estructura por servicio

`vp-api` (TS):
```
src/
├── modules/
│   ├── identity/         { api.ts, service.ts, repository.ts, events.ts }
│   ├── tree/
│   ├── ledger/           # cliente gRPC a vp-engine, no escribe DB directo
│   ├── packages/
│   ├── withdrawals/
│   ├── payments/
│   ├── admin/
│   ├── notifications/
│   └── reporting/
└── shared/               { http, queue, crypto, audit, observability, validation }
```

`vp-engine` (Go):
```
internal/
├── ledger/               { service, repository, sqlc-generated }
├── bonusengine/
├── treewriter/
├── chainwatcher/
└── shared/               { db, log, metrics, tracing }
cmd/
└── vp-engine/main.go
```

### Reglas de boundary (enforced)

1. **Módulo X solo importa de:**
   - `shared/*`.
   - `<otroModulo>/events.ts` (tipos de eventos públicos).
   - **Nunca** `<otroModulo>/repository.ts`, `<otroModulo>/service.ts`.
2. **Comunicación cross-module = eventos NATS** (ADR 0007) o **llamada explícita a service público vía export**, no acceso directo a la DB del otro.
3. **Una tabla = un dueño.** `mlm.wallet_movement` la escribe `ledger`. `mlm.tree_event` la escribe `tree`. Nadie más toca esas tablas — incluso los reports leen vía consultas read-only a vistas materializadas.
4. **`api.ts` solo orquesta:** valida con zod, llama service, formatea respuesta. Sin lógica de negocio.
5. **`repository.ts` es la única capa que importa Drizzle/sqlc.** Lógica nunca toca DB directamente.

Lint custom (eslint plugin para TS, golangci-lint custom para Go) verifica reglas 1-3 en CI.

## Consequences

### Positivas

- **Velocidad de cambio alta.** Tocar 3 módulos en un solo PR es trivial (mismo repo, mismo type-check, mismo deploy). En microservicios serían 3 PRs coordinados + deploy ordenado + breaking change risks.
- **Boundaries claros sin fricción de red.** Refactor cross-module = cambio de interfaces, no de protocolos.
- **Testing más simple.** Tests E2E corren un único proceso con DB; no hay que orquestar 8 contenedores.
- **Operación trivial.** 2 deployments, 2 sets de logs, 2 dashboards. Microservicios serían 8-15.
- **Boundaries listas para extraer si llega el día.** Cuando un módulo tenga (a) razón clara de escalar/desplegar independiente Y (b) tamaño suficiente para justificar costos, **se extrae a su propio servicio**. Mientras tanto, solo cuesta un import.
- **Ya practicamos boundaries serios:** ADR 0002 (vp-api ↔ vp-engine) son 2 servicios reales, no monolito puro. Esa es la decomposición de microservicios que SÍ vale ahora.

### Negativas

- **Tentación de violar boundaries** ("solo esta vez importo el repository del otro módulo, prometo que es tarde y mañana lo arreglo"). Mitigación: lint en CI.
- **Despliegue all-or-nothing dentro de cada servicio.** Si `notifications` se rompe en deploy, también rollback `identity`. Aceptable: rollback de `vp-api` es rápido (~30s con docker pull).
- **Boundary creep:** módulos pueden crecer sin límite si nadie los policía. Mitigación: tabla en CHANGES.md tracking line count por módulo; > 2,000 líneas dispara discusión "¿hay que partirlo?".
- **Perception:** equipos juniors a veces creen que "modular monolith = anticuado". No es. Shopify, Stack Overflow, GitHub corren modular monolith a escala enorme.

### Neutras

- Microservicios completas se mantienen como Plan B para módulos específicos. Si `payouts` necesita escalar a 100k cores en horas pico de bonus runs, o si `chainwatcher` tiene SLA de uptime distinto, se extraen.

## Alternatives considered

### Microservicios completos desde día 1 (8-12 servicios)

**Rechazado para tamaño actual del equipo.**
- Cada servicio cuesta: pipeline CI/CD, deploy job, observabilidad, security updates, on-call rotation.
- 12 servicios × 2 ingenieros = cada ingeniero owns 6 servicios. Imposible mantener calidad.
- Refactors cross-domain (que son el 30% del trabajo en primeros 12 meses) requieren coordinación multi-PR, multi-deploy, breaking change versioning.
- Latencia: cada hop entre servicios suma 1-5ms. Una operación que toca 5 dominios = 5-25ms de overhead solo por boundaries de red.

Microservicios premature decomposition es una de las top causas de muerte de startups de stage seed-A.

### Single mega-module (todo en src/index.ts)

**Rechazado obvio.** Funciona la primera semana, irreparable la primera siguiente.

### CQRS-heavy con event sourcing global

**Rechazado.**
- Ya tenemos event sourcing local en `tree_event` y `wallet_movement` con `transaction`. Suficiente para auditoría.
- CQRS global (write models y read models separados, eventos como source of truth) añade ~3-5x complejidad.
- Costo no justificado a este tamaño.

Se evalúa para módulos específicos (e.g. `payouts` ya tiene patrón CQRS-light: `bonus_run` write model + `bonus_run_payout` read model).

### Hexagonal architecture / Clean architecture estricta

**Considerado, adoptado parcialmente.** La forma `api → service → repository` es hexagonal. No vamos a la pureza completa (puertos/adaptadores con DI containers, etc.) porque añade boilerplate sin beneficio en TS (dependencies son explicit imports, no hace falta DI framework).

## Reglas de cuándo extraer un módulo a su propio servicio

Un módulo se extrae cuando ≥ 2 de las siguientes son ciertas:

1. **Razón de escalado distinta** (e.g. `chainwatcher` necesita 16 cores en spike de Bitcoin, el resto del sistema no).
2. **SLA de disponibilidad distinto** (e.g. `payments` debe tener 99.99 % uptime; `reporting` con 99 % está bien).
3. **Lenguaje distinto** (ya pasó: `payouts` está en Go, `reporting` en TS).
4. **Equipo dedicado** (e.g. equipo "fraud" toma `payments/fraud-detection` como su módulo full-time).
5. **Compliance distinto** (e.g. `payments/card` debe correr en zona PCI separada del resto).
6. **Tamaño > 5,000 líneas + 3 personas tocándolo simultáneamente** sin que se pisen.

**Sin al menos 2 de las anteriores, NO se extrae.** "Es más limpio así" no es razón. "Lo dijeron en una conferencia" no es razón.

## References

- `app/src/modules/README.md` — convención de boundaries en TS.
- `_meta/BACKEND_PLAN.md` §3 — catálogo completo de módulos.
- ADR 0002 — la decomposition real son 2 servicios polyglot.
- "Modular Monolith: A Primer", Kamil Grzybek: https://www.kamilgrzybek.com/blog/posts/modular-monolith-primer
- Shopify modular monolith: https://shopify.engineering/deconstructing-monolith-designing-software-maximizes-developer-productivity
- "Don't start with microservices", Stefan Tilkov: https://martinfowler.com/articles/dont-start-monolith.html
