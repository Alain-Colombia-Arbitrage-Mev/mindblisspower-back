# ADR-0019 — AWS RDS Multi-AZ en lugar de Hetzner self-managed; particionado nativo en lugar de TimescaleDB

**Fecha:** 2026-06-06
**Estado:** Aceptado
**Supersede:** ADR-0005 (Hetzner bare metal) parcialmente; ADR-0015 (TimescaleDB scope) en lo relativo a hypertables/compresión. La decisión de ADR-0015 de NO particionar `tree_event` sigue vigente.

## Contexto

El plan original (ADR-0005) era Postgres 17 self-managed en Hetzner AX52 con
TimescaleDB (ADR-0015): hypertables para `wallet_movement` y
`audit.activity_log`, compresión columnar y continuous aggregates.

Al mover la infraestructura a AWS surgió el conflicto: **RDS y Aurora no
soportan TimescaleDB** (la licencia TSL prohíbe a terceros ofrecerlo como
DBaaS). Las opciones evaluadas:

| Opción | TimescaleDB | Failover | Costo/mes aprox | Carga ops |
|---|---|---|---|---|
| EC2 self-managed + réplica otra AZ | ✅ | manual (o Patroni = semanas de setup) | ~$620 | alta |
| Tiger Cloud (Timescale managed en AWS) | ✅ | automático | ~$900+ | baja |
| **RDS Multi-AZ + pg_partman/pg_cron** | ❌ | **automático 60–120s** | ~$420–640 | **baja** |

## Decisión

**RDS PostgreSQL 17 Multi-AZ** (`db.r7g.xlarge`, gp3 400 GB con autoscaling
hasta 1 TB), reemplazando TimescaleDB por particionado nativo:
`_meta/migration/05_partitioning_rds.sql` sustituye a `05_timescaledb.sql`.

## Justificación: qué valía TimescaleDB a nuestra escala

1. **Compresión columnar (90–95%)** — el ledger histórico completo (31.6M
   movements) son ~4–5 GB en Postgres. El ahorro es irrelevante frente al
   costo de perder failover managed.
2. **Continuous aggregates** — las 3 vistas se reemplazan con matviews
   vainilla + `REFRESH CONCURRENTLY` vía pg_cron (soportado en RDS).
   `mv_network_growth_daily` ya estaba implementada así.
3. **Hypertables** — ADR-0015 ya había excluido `tree_event` porque el b-tree
   bastaba. El mismo razonamiento aplica a `wallet_movement` al TPS actual;
   pg_partman da el particionado mensual sin Timescale.
4. **Retention 5 años (Habeas Data, ADR-0009)** — pg_partman
   `retention = '5 years'` + `run_maintenance_proc()` diario hace el drop
   físico de particiones igual que la retention policy de Timescale.

TimescaleDB resuelve problemas de cientos de GB a TB de series temporales;
tenemos 118k usuarios y un ledger de 5 GB. Para una fintech con liquidación
mensual y equipo de 1–2 personas, el failover automático, backups/PITR
managed y parchado sin intervención pesan más.

## Consecuencias

- **Parameter group RDS requerido:** `shared_preload_libraries = 'pg_cron'`,
  `cron.database_name = 'vicionpower'` (reboot). `pg_partman` no necesita
  preload (sin BGW en RDS; el mantenimiento lo dispara pg_cron).
- **Storage:** gp3 400 GB inicial (el umbral de 400 GiB da 12,000 IOPS /
  500 MB/s baseline — necesario para el gate de migración ≤180 min).
  Autoscaling con techo 1 TB. El storage RDS no se puede reducir.
- `postgresql.conf.tuned`, `pgbackrest.conf`, `pg_hba.conf` y los cloud-init
  de `_meta/devops/` quedan obsoletos para la DB (RDS los gestiona);
  siguen siendo válidos para entornos dev/staging self-hosted.
- El docker-compose de dev (`vp-engine/deployments/`) debe cambiar la imagen
  `timescale/timescaledb` por `postgres:17` + pg_partman + pg_cron para
  mantener paridad dev/prod.
- El `.bak` de rollback (90 días, PLAN.md §9) va a S3 Glacier, no a snapshots.
- Si en el futuro el volumen de series temporales lo justifica (>100 GB de
  eventos), reevaluar Tiger Cloud o EC2 — la salida es replicación lógica,
  no hay lock-in de esquema (el DDL es Postgres vanilla).

## Trigger de reevaluación

- Slow queries sostenidas en `wallet_movement`/`tree_event` que el
  particionado mensual + índices no resuelvan (medir con pg_stat_statements).
- Crecimiento del ledger > 50 GB/año.
- Costo RDS Multi-AZ > $1,200/mes sostenido.
