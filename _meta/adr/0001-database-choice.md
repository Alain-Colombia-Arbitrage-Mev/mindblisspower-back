# 0001 — Postgres 17 self-hosted + TimescaleDB extension

**Status:** Accepted
**Date:** 2026-04-28
**Deciders:** equipo VicionPower (devfidubit)

## Context

VicionPower es un MLM fintech con un ledger de doble-entrada (`mlm.wallet_movement`, `mlm.transaction`), un árbol binario de afiliados (`mlm.affiliate` con ltree path), y un motor de bonos que procesa millones de filas por run. La base actual (SQL Server 2025 Express con `viciongroup` ~30 GB en `vicionpower.bak`) tiene problemas de:

- Falta de validación en datos (fechas corruptas, NULL en columnas críticas).
- $348M en concepto 16 sin contraparte verificable (auditoría rota).
- Restricción del motor (Express limitado a 10 GB) que bloquea el restore.
- Costo de licenciamiento al subir a Standard.

Hay clientes en producción y TPS alto, así que el reemplazo necesita cumplir simultáneamente:

1. ACID transaccional fuerte (ledger contable no tolera eventual consistency).
2. Soporte de árbol jerárquico eficiente (afiliados con miles de descendientes).
3. Particionamiento + compresión para el historial de movimientos.
4. Triggers para invariantes en DB (no en aplicación).
5. Costo operacional bajo dado que el budget vs AWS es restrictivo.
6. Compatibilidad con Better Auth (decisión separada, ver ADR 0003).
7. Ejecutable en infra Hetzner que ya elegimos (ADR 0005).

## Decision

**Postgres 17 self-hosted en Hetzner AX52, con TimescaleDB como extensión.**

Stack de extensiones:
- `ltree` — árbol binario.
- `pgcrypto` — encriptación de PII (`mlm.person.ssn_encrypted`).
- `btree_gist` — índices compuestos sobre ltree.
- `pg_stat_statements` + `auto_explain` — observabilidad.
- **`timescaledb`** — particionamiento automático + compresión columnar + continuous aggregates para `wallet_movement`, `tree_event` y `audit.activity_log`.

`pg_partman` (que estaba en el plan original) se **reemplaza por TimescaleDB**, que cubre el mismo caso (particionamiento por tiempo) y agrega beneficios que pg_partman no tiene.

## Consequences

### Positivas

- **Costo:** €80/mes (AX52 dedicado) vs $599+/mes Supabase Dedicated, $300+/mes Mongo Atlas M30, $500+/mes CockroachCloud.
- **Performance:** NVMe local + Ryzen 7950X3D + memoria abundante = p99 inserts < 1ms en `wallet_movement`. Bare metal supera managed cloud a igual costo por factor 3-5x.
- **Compresión:** TimescaleDB columnar comprime particiones cerradas (>30 días) en 90-95%. Storage de 30 GB actual cae a ~3-5 GB para datos históricos. Reportes de "movements del 2024" se ejecutan sobre datos comprimidos sin descomprimir explícitamente.
- **Continuous aggregates:** vistas materializadas con refresh incremental para dashboards (`mv_earnings_monthly`, `mv_network_summary_daily`). El motor de bonos no tiene que recalcular desde cero cada vez.
- **Retention automática:** TimescaleDB drop policy elimina particiones >5 años para cumplir Habeas Data Colombia sin scripts custom.
- **Sin lock-in:** TimescaleDB es Apache 2.0 y es Postgres puro; si en algún punto queremos quitarla, los datos se exportan como tablas Postgres normales.
- **Compatibilidad total:** Drizzle ORM, pgx, Better Auth, todo el ecosistema funciona idéntico.
- **Control de auditoría:** logs, replication, backups, accesos están en infraestructura nuestra. Para fintech regulado en Colombia (Habeas Data), esto es defensivo importante.

### Negativas

- **Operamos la DB.** Backups (pgbackrest), réplicas, monitoring, failover, kernel tuning son responsabilidad nuestra. Mitigación: PLAYBOOK.md en `_meta/devops/` cubre todo; DBA part-time o senior backend con experiencia Postgres es suficiente.
- **TimescaleDB añade complejidad operacional.** Hypertables, chunks, compression policies, continuous aggregates son conceptos que el equipo debe entender. Mitigación: comenzar con configuración por defecto (auto-particioning mensual + sin compresión); agregar policies después de medir impacto.
- **No tenemos failover automático cross-region.** AX52 + AX42 réplica en NBG1 cubre node failure pero no región completa. Mitigación documentada: cold standby en HEL1 con pgbackrest pull diario; aceptable para RPO < 24h cross-region.
- **TimescaleDB hypertables NO son compatibles con `PARTITION BY RANGE` nativo de Postgres.** Hay que elegir uno u otro. Esta ADR elige TimescaleDB; `schema_mlm.sql` se ajusta para que `wallet_movement`, `tree_event` y `audit.activity_log` no usen particionamiento nativo, sino que se conviertan en hypertables vía `_meta/migration/05_timescaledb.sql`.

### Neutras

- TimescaleDB community edition cubre todo lo que necesitamos. No requiere licencia comercial. Si en algún punto queremos features de Cloud edition (multi-node, mayor compresión), upgrade es transparente.
- `pg_partman` se elimina del plan. Se ajustan PLAYBOOK.md y `postgresql.conf.tuned` para reflejar cambio de extensión.

## Alternatives considered

### Supabase

**Rechazado.** Es Postgres por debajo (compatible con nuestro schema), pero:

- Tier Pro ($25/mes) no aguanta nuestra carga; Dedicated ($599+/mes) es 7-10x más caro que self-hosted.
- Conflicto con Better Auth: Supabase Auth es su diferenciador comercial; usarlo nos casa con su ecosistema.
- No podemos instalar `pg_partman`, ni `timescaledb`, ni hacer kernel tuning agresivo que es la razón por la que elegimos AX52 bare metal.
- Performance real worse a igual costo: corre sobre AWS, paga margen Supabase + AWS sobre Hetzner directo.
- Vendor lock-in operacional (su backup format, su runtime, su CLI).

Supabase es excelente para MVPs y proyectos pequeños. No para fintech con TPS alto en producción.

### MongoDB

**Rechazado categóricamente.** Es la peor opción posible para este dominio:

- Ledger de doble-entrada requiere transacciones ACID multi-documento. Mongo las soporta desde 4.0 pero son lentas, con caveats, y rompen el modelo single-doc-atomic que es su única ventaja.
- No existe equivalente a `ltree`. El árbol binario sería embedded docs o references; recorridos = O(n) recursive traversal en código de aplicación. Volveríamos al problema original de SQL Server.
- Joins son terribles. Nuestro schema hace joins constantes (movement → wallet → affiliate → person). Mongo obliga a denormalizar agresivamente, perdiendo el invariante de single source of truth.
- No hay triggers reales. Change streams son async; la validación de balance neto = 0 no puede ser atómica.

Mongo es excelente para catálogos de producto, logs, eventos. No para un ledger fintech con árbol binario.

### CockroachDB

**Rechazado.** Su único caso de uso real (multi-región activa-activa con failover automático) no aplica:

- No necesitamos multi-región. Clientes están en Colombia; Hetzner NBG1 da latencia <100ms a LATAM; réplica en HEL1 cubre disaster recovery suficientemente.
- Cada transacción paga overhead de consenso Raft. En el hot path (`wallet_movement` insert) eso es 5-10x más latencia que Postgres single-node.
- Pierde `ltree`, `pg_partman`, triggers complejos. CockroachDB es Postgres-wire-compatible, no Postgres-feature-compatible.
- Mínimo 3 nodos para HA real; cada uno dimensionado como nuestro primary actual = ~3x el costo.
- Operacionalmente más complejo: rebalancing, gossip protocol, Raft tuning.

Cockroach es excelente para SaaS globales B2B con tenants en múltiples regiones. Para un MLM con base operativa en un país, es overkill caro.

### MariaDB / MySQL

**Rechazado.** Inferior a Postgres para este caso:

- No hay equivalente a `ltree` (geometry tricks son inferiores).
- JSONB es más débil que en Postgres.
- Particionamiento más limitado que TimescaleDB.
- Triggers menos potentes.
- Sin extensión equivalente a TimescaleDB community.

No hay razón a favor de MySQL aquí.

### AWS Aurora Postgres / Google Cloud SQL Postgres

**Considerado como segunda opción si no se quiere operar.** 100% compatible con nuestro schema, mantiene Better Auth, soporta extensiones (Aurora soporta TimescaleDB, Cloud SQL no oficialmente). Costo ~5x self-hosted a igual capacidad pero quita la operación.

Si en el futuro el equipo decide no operar Postgres directo, esta es la migration path. Hoy: self-hosted gana por costo y control.

### Neon (Postgres serverless)

**Rechazado para producción.** Cold starts, latencia variable, costo escala mal con TPS sostenido alto. Útil para staging/dev branches.

### YugabyteDB

**Rechazado.** Mismo perfil que CockroachDB con menos madurez. No agrega valor.

### ScyllaDB / Cassandra

**Rechazado.** Wide-column con eventual consistency. Modelo equivocado para ledger ACID.

## References

- `_meta/schema_mlm.sql` — schema canónico (se ajusta en este ADR para TimescaleDB).
- `_meta/migration/05_timescaledb.sql` — script de instalación + conversión a hypertables.
- `_meta/devops/PLAYBOOK.md` — operación Postgres en Hetzner.
- `mlm_binario_estabilidad.md`, `mlm_binario_margen_operativo.md` — fórmulas que el motor de bonos calcula.
- TimescaleDB docs: https://docs.timescale.com/
- Postgres performance tuning para Ryzen + NVMe: https://wiki.postgresql.org/wiki/Performance_Optimization
- Stripe Postgres at scale: https://stripe.com/blog/online-migrations
- GitHub Postgres operation: https://github.blog/engineering/scaling-the-gitlab-database/
