# 0015 — TimescaleDB scope: qué tablas son hypertable y cuáles no

**Status:** Accepted
**Date:** 2026-05-07
**Deciders:** equipo VicionPower (devfidubit)
**Refines:** ADR 0001 (Postgres + TimescaleDB extension)
**Does NOT supersede:** TimescaleDB sigue siendo parte del stack.

## Context

ADR 0001 adoptó TimescaleDB como extensión de Postgres y dejó implícito que las tablas time-series se convertirían en hypertable. La implementación inicial (`_meta/migration/05_timescaledb.sql` + `schema_payouts.sql §3`) convierte cuatro tablas:

- `mlm.wallet_movement`
- `mlm.tree_event`
- `audit.activity_log`
- `mlm.binary_block_payment`

A volúmenes actuales (186 k movements, ~5 años de datos legacy = ~30 GB en SQL Server), Timescale es **prematuro**: Postgres vainilla con b-tree e índices BRIN maneja ese volumen sin sudar. Pero retrofittear hypertable sobre una tabla con tráfico productivo después es caro (lock prolongado, validación, downtime). Hacerlo ahora con tablas chicas es barato.

La pregunta es **dónde** Timescale paga su costo (storage, complejidad, vendor lock-in suave) y dónde es overkill que solo agrega operación sin beneficio.

## Decision

Restringir el uso de TimescaleDB a las **dos tablas donde su valor es no-trivial y cuesta retrofittear después**:

### IN scope — hypertable + compresión + continuous aggregates

**1. `mlm.wallet_movement`** — hypertable mensual, compresión >30 d.
- Justificación: continuous aggregates (`mv_earnings_monthly`, `mv_ledger_volume_daily`) reemplazan reporting full-scan del legacy. El reporte de "ganancias mensuales por afiliado" deja de ser una query pesada y pasa a ser lectura del MV con refresh incremental cada hora.
- Compresión columnar: 90–95 % menos disco en chunks > 30 d.

**2. `audit.activity_log`** — hypertable mensual, compresión >90 d, **retention 5 años automática**.
- Justificación: Habeas Data Colombia (Ley 1581/2012) exige eliminación post 5 años. `add_retention_policy` dropea chunks enteros instantáneamente; sin Timescale habría que escribir cron + `DELETE WHERE occurred_at < ...` que con tabla grande bloquea y no es trivial. Es el caso más limpio de Timescale.

### OUT of scope — tabla vainilla con b-tree

**3. `mlm.tree_event`** — **NO hypertable**.
- Justificación: el motor lee esta tabla por `affiliate_id + período corto` (1 semana). El partitioning temporal de hypertable no acelera esa query — el b-tree por `(affiliate_id, occurred_at)` ya hace el trabajo. Compresión tampoco aporta porque `tree_event` no genera el volumen de `wallet_movement`.
- El continuous aggregate `mv_network_growth_daily` se mantiene **como vista materializada Postgres vainilla** con refresh por `pg_cron` cada 15 min. No requiere hypertable.

**4. `mlm.binary_block_payment`** — **NO hypertable**.
- Justificación: idéntica a `tree_event`. El motor consulta por `(affiliate_id, binary_period_id)`; reporting histórico se hace sobre `mv_earnings_monthly` (que sí es continuous aggregate sobre wallet_movement). Hypertable no compra nada operativo y agrega complejidad: el patch v1.1 ya enforce append-only, los chunks comprimidos complican `INSERT ON CONFLICT`.

### Tabla resumen

| Tabla | Hypertable | Compresión | Retention | Continuous aggregate |
|---|---|---|---|---|
| `mlm.wallet_movement`     | ✅ mensual | 30d  | manual    | ✅ 2 MVs |
| `audit.activity_log`      | ✅ mensual | 90d  | 5 años    | — |
| `mlm.tree_event`          | ❌         | —    | —         | ⚠ MV vainilla con pg_cron |
| `mlm.binary_block_payment`| ❌         | —    | —         | — (lee `mv_earnings_monthly`) |

## Consequences

### Positivas

- **Menos superficie operacional.** Dos hypertables en lugar de cuatro: menos chunks que monitorear, menos compresión policies, menos hypertable maintenance.
- **Triggers más simples** sobre `binary_block_payment`. Append-only enforcement (T4 del ADR 0012) es directo en tabla vainilla; en hypertable hay que considerar chunks comprimidos.
- **Test harness más liviano.** Tests de integración pueden correr en Postgres vainilla para los casos del motor; solo los tests de reporting/retention necesitan timescaledb.
- **Vendor lock-in reducido.** Si en el futuro hay razón para migrar fuera de Timescale (managed Postgres en Hetzner, p. ej.), solo dos tablas requieren plan de salida.

### Negativas

- **Storage de `binary_block_payment` y `tree_event` no comprimido.** A 5 años, esto puede sumar GB extras. Estimación: con tasa actual de eventos, `tree_event` ~10 M filas en 5 años ≈ 2 GB; `binary_block_payment` similar. Total ≤ 5 GB no comprimido vs ~500 MB comprimido. Costo en disco SSD Hetzner: despreciable (<€1/mes).
- **Si reporting histórico crece sobre `binary_block_payment`** (p. ej. dashboards que escanean años de pagos por afiliado) y deja de ser eficiente, hay que revisitar. Acción: monitor `pg_stat_statements` para queries lentas sobre estas dos tablas; si aparecen, evaluar conversion. Esta ADR no es irreversible.
- **`mv_network_growth_daily` pierde refresh incremental nativo.** Con MV vainilla, el `REFRESH MATERIALIZED VIEW CONCURRENTLY` recalcula todo (no solo el último bucket). Para una vista con 365 buckets/año esto es manejable; si crece a granularidad horaria habría que volver a continuous aggregate.

### Neutras

- ADR 0001 sigue válido: TimescaleDB es parte del stack.
- ADR 0009 (data retention) sigue cumpliéndose: la retention legal está cubierta por `audit.activity_log` retention policy.

## Alternatives considered

### A. Mantener las cuatro tablas como hypertable (status quo del SQL inicial)

**Rechazada.** Complejidad sin beneficio para `tree_event` y `binary_block_payment` a este volumen. Los queries del motor no se aceleran. El argumento "lo necesitaremos a futuro" no se sostiene: convertir una tabla a hypertable después es operación con `migrate_data => TRUE` que sí toma tiempo pero es un evento puntual planificable, no un bloqueador.

### B. Eliminar TimescaleDB completamente

**Rechazada.** Habeas Data retention sobre `audit.activity_log` y los continuous aggregates sobre `wallet_movement` son value real. Reescribirlos a mano (cron + MV) es 2-3 semanas de trabajo + bugs propios.

### C. Hypertable solo para `audit.activity_log` (mínimo legal)

**Considerada.** Salva el cumplimiento Habeas Data. Pero pierde los continuous aggregates de reporting que ya están escritos y son el reemplazo del reporting legacy lento. No vale la pena por €0 de ahorro.

## Plan de implementación

1. **Inmediato:** dejar `_meta/schema_payouts.sql §3` y `05_timescaledb.sql §2` como están en el repo, pero comentar las líneas que convierten `tree_event` y `binary_block_payment` a hypertable. Documentar el motivo inline apuntando a esta ADR.
2. **Antes del cutover:** correr el dry-run completo con la nueva configuración; verificar que `mv_earnings_monthly` cubre las queries que antes corrían sobre `binary_block_payment` directamente.
3. **Post-cutover (mes 1):** instrumentar `pg_stat_statements` para medir performance real sobre `tree_event` y `binary_block_payment`. Si aparece query > 200 ms recurrente, abrir ADR superseder.

## Cómo se cambia esta ADR

Si en producción aparece evidencia de que `tree_event` o `binary_block_payment` necesitan partitioning (slow queries documentadas, costo de storage relevante, requirement de retention temporal), nueva ADR 00XX que supersede esta y ejecuta `create_hypertable(..., migrate_data => TRUE)` en una ventana de mantenimiento.

## References

- ADR 0001 — Postgres 17 + TimescaleDB extension (decisión paraguas).
- ADR 0009 — Data retention (5 años Habeas Data).
- ADR 0012 — Binary compensation plan (define que `binary_block_payment` es append-only).
- `_meta/migration/05_timescaledb.sql` — implementación actual (a editar tras esta ADR).
- `_meta/schema_payouts.sql §3` — `binary_block_payment` hypertable (a comentar).
