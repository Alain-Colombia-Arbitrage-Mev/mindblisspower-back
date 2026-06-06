# VicionPower — SQL Server → Postgres 17 Migration Playbook

**Source:** SQL Server 2025 Express, database `viciongroup` (~30 GB .bak)
**Target:** AWS RDS PostgreSQL 17 Multi-AZ (ADR-0019) with schema from `_meta/schema_mlm.sql`
**Strategy:** Maintenance-window cutover (2–4 h), staging schema as intermediate, SQL Server kept read-only for 30 days as fallback.

---

## 1. Why one-shot cutover (and not dual-write)

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Dual-write app | zero downtime | requires app refactor + idempotency from day 1; 6+ weeks of work | overkill for current scale (186k movements, low TPS) |
| Logical replication (Debezium → Kafka → Postgres) | near-zero downtime | infra heavy; ordering bugs around triggers; needs CDC enabled in SQL Server | overkill |
| **Maintenance window cutover** | simple, 1 person can run it; fits current scale; validation is straightforward | 2–4 h offline | **chosen** |

The system has so few concurrent writes today that a planned 3 a.m. window costs less than the engineering effort of dual-write. We can revisit when monthly transactions exceed ~5M.

---

## 2. Cutover phases

```
T-7 days   → Run *timed* dry-run on a SQL Server backup copy.
             GATE: total wall time (01+02+03+04) MUST be ≤ 180 min.
             If >180 min, do NOT schedule cutover — split into two nights
             (catalogs+tree first, ledger backfill after) or invest in
             pgloader tuning (parallelism, staging on tmpfs).
T-1 day    → Freeze schema changes, snapshot baseline
T0  00:00  → Announce maintenance, app to read-only
T0  00:05  → Final SQL Server backup (.bak) + checksum
T0  00:15  → Restore .bak on staging Postgres host (or load from .bak directly via pgloader against live SQL Server, depending on which is faster locally)
T0  00:20  → Run migration/01_pgloader.load   (raw load → staging.*)
T0  01:30  → Run migration/02_postload.sql    (transform → mlm.*)
T0  02:00  → Run migration/03_backfill_events.sql
T0  02:20  → Run migration/04_reconcile.sql   (validation)
T0  02:30  → If reconcile = green, point app to Postgres + lift read-only
T0  03:00  → SQL Server set to read-only mode (kept 90 days)
T+90 days  → Decommission SQL Server, archive .bak in cold storage
```

If reconcile reports any drift, abort: revert app to SQL Server (still live, just read-only since T0). Investigate, fix, retry next window. **No tolerated drift on monetary fields** — see §7.

---

## 3. Type mapping (SQL Server → Postgres)

| SQL Server | Postgres | Notes |
|---|---|---|
| `int IDENTITY` | `bigint GENERATED ALWAYS AS IDENTITY` | Upgrade to `bigint` proactively — `movement.idMovement` will hit int max within years at current growth |
| `bigint` | `bigint` | |
| `smallint` | `smallint` | |
| `bit` | `boolean` | pgloader handles |
| `decimal(19,8)` | `numeric(20,8)` | one extra digit headroom |
| `decimal(19,2)`, `decimal(12,2)` | `numeric(14,2)` | fiat USD |
| `decimal(16,2)`, `decimal(19,4)` | `numeric(20,4)` | bonus calculations |
| `varchar(N)` | `text` (drop the limit) or `varchar(N)` | use `text` everywhere except keys |
| `varchar(max)` | `text` | |
| `nvarchar(N)` | `text` | UTF-8 native in Postgres |
| `char(N)` | `char(N)` | only for ISO codes |
| `datetime` | `timestamptz` | **assume UTC** during load; verify with sample (see §4.1) |
| `date` | `date` | |
| `uniqueidentifier` | `uuid` | |
| `varbinary(N)` | `bytea` | |
| `text` (deprecated) | `text` | |

**Casting rules in pgloader** are declared in `01_pgloader.load`.

---

## 4. Known data quality issues — handled during migration

### 4.1 Timezone of `datetime`
SQL Server `datetime` is naive. Sample `creationTime` from `vicionario` and check against `creationTime` of `person` for the same `idPerson` to confirm timezone consistency. Operator timezone: **America/Bogota (UTC-5, sin DST)**. `02_postload.sql` applies `AT TIME ZONE 'America/Bogota'` then stores as `timestamptz`.

### 4.2 Corrupted `dateMovement` values
From `credito_audit.out`: values like `'0002-03-26'`, `'5024-04-16'`, year `203`. Strategy:
1. During load, push raw rows into `staging.movement` as-is (no constraint).
2. In `02_postload.sql`, route any row failing `posted_at BETWEEN '2015-01-01' AND now() + interval '7 days'` to `staging.movement_quarantine`.
3. Generate ops ticket: list of quarantined rows for manual date assignment using `creationTime` as fallback heuristic.
4. Once corrected, ops promotes rows back via admin script.

### 4.3 NULL `idVicionario` on 100% of `movement` rows for concepto 16 (and others)
Backfill from `wallet.idVicionario` since `movement.idWallet → wallet.idVicionario` is reliable. `02_postload.sql`:
```sql
INSERT INTO mlm.wallet_movement (..., affiliate_id, ...)
SELECT ..., aff.id, ...
  FROM staging.movement m
  JOIN staging.wallet w ON w.idWallet = m.idWallet
  JOIN mlm.affiliate aff ON aff.legacy_id_vicionario = w.idVicionario
```
This makes `affiliate_id NOT NULL` enforceable for 100% of historical rows.

### 4.4 $348M concepto 16 with no paired debit
Each row of legacy concepto 16 becomes a single-side `wallet_movement` wrapped in a `mlm.transaction` with `external_ref = 'legacy:concepto_16:<idMovement>'` and a special concept `inter_platform_legacy_unpaired` (factor=+1, requires_pair=false). This concept is marked `active=false` after migration so new movements can never use it. Going forward, all inter-platform transfers must use the new `inter_platform` concept which `requires_pair=true`.

### 4.5 `vicionarioAncestors` as varchar(max) CSV
The current schema stores ancestors as a comma-separated string in `vicionario.vicionarioAncestors`. Reconstruct `affiliate.path` (ltree) from `idVicionarioParent` recursively in topological order — it's deterministic and validates the CSV. If CSV disagrees with computed path, log the discrepancy (binary tree corruption signal).

### 4.6 Mega-transactions ≥ $1M (12 rows, $93.5M total)
Flag these in `audit.activity_log` with `before_data = {legacy_row}` so post-migration ops can review. They are not blocked from migrating — just tagged for human attention.

### 4.7 Negative imports (reversals via concepto 16)
Bucket `<$10` summed `-$70K`, min `-$112,000`. These are manual reversals. Map to new concept `reversal` (factor=-1, requires_pair=false for legacy load only). Going forward, reversals require `reversed_by_txn_id` link.

---

## 5. Tree reconstruction (`affiliate.path`)

The new `mlm.affiliate.path` (ltree) must be rebuilt because `vicionarioAncestors` is unreliable. Algorithm in `02_postload.sql`:

```sql
WITH RECURSIVE tree(id, parent_id, position, path, depth) AS (
  SELECT id, NULL::bigint, NULL::mlm.tree_position, text2ltree(id::text), 0
    FROM mlm.affiliate WHERE parent_id IS NULL
  UNION ALL
  SELECT a.id, a.parent_id, a.position,
         t.path || text2ltree(a.position::text || '_' || a.id::text),
         t.depth + 1
    FROM mlm.affiliate a JOIN tree t ON a.parent_id = t.id
)
UPDATE mlm.affiliate a SET path = t.path, depth = t.depth FROM tree t WHERE a.id = t.id;
```

Done in a single transaction after all affiliates are loaded with `parent_id` and `position` but before any `tree_event` is inserted. Trigger `trg_affiliate_path` is disabled during this step (`ALTER TABLE ... DISABLE TRIGGER`) and re-enabled after.

**Validation:** every non-root row must have `nlevel(path) = depth + 1`. A non-equal count = corrupted parent chain → abort migration.

---

## 6. Backfill of `tree_event`

History of PV credits and binary payouts must be replayed so the drift-detection view (`v_tree_pv_truth`) can validate from day 1.

Sources:
- `logVicionarioPointsHistory` — historical PV credits per affiliate
- `vicionarioPackage` activations (each gives PV based on package amount)
- `vicionarioLeadershipBonusRecord` — bonus payouts (PV consumption)

Each row becomes one `tree_event` with `external_ref = 'legacy:lvp:<id>'` etc. The `applied_at` is set to the original `creationTime` so the trigger fires and aggregates rebuild incrementally as if events were live.

**However**, replaying through the trigger for all historical events is slow (millions of trigger fires). Faster strategy:
1. `ALTER TABLE mlm.tree_event DISABLE TRIGGER trg_apply_tree_event;`
2. Bulk INSERT all historical events.
3. Recompute aggregates in a single SQL pass (set-based, ~30 s):
   ```sql
   WITH agg AS (
     SELECT a_anc.id AS ancestor_id,
            substring(ltree2text(subpath(a_desc.path, a_anc.depth + 1, 1)) from 1 for 1) AS leg,
            SUM(te.pv_delta_left + te.pv_delta_right) AS pv
       FROM mlm.tree_event te
       JOIN mlm.affiliate a_desc ON a_desc.id = te.affiliate_id
       JOIN mlm.affiliate a_anc  ON a_desc.path <@ a_anc.path AND a_desc.id <> a_anc.id
      GROUP BY a_anc.id, leg
   )
   UPDATE mlm.affiliate a
      SET left_pv_lifetime  = COALESCE((SELECT pv FROM agg WHERE ancestor_id = a.id AND leg = 'L'), 0),
          right_pv_lifetime = COALESCE((SELECT pv FROM agg WHERE ancestor_id = a.id AND leg = 'R'), 0);
   ```
4. `ALTER TABLE mlm.tree_event ENABLE TRIGGER trg_apply_tree_event;`

---

## 7. Reconciliation (validation gate)

`04_reconcile.sql` runs a series of comparative queries against both source and target. **Migration is not declared successful until all return zero drift** (or drift within documented tolerance).

| Check | Expected | Tolerance |
|---|---|---|
| Affiliate count | identical | 0 |
| Wallet count | identical | 0 |
| Wallet movement count (per concept × month) | identical | 0 |
| Total amount per concept (lifetime) | identical | **$0.00** — quarantined rows account for all rounding |
| Wallet balance (materialized vs computed) | drift = 0 | $0.00 |
| Tree PV (materialized vs computed) | drift = 0 | 0 |
| Path integrity | `nlevel(path) = depth + 1` for all | 0 violations |
| Transaction balance | all `posted` txns with `requires_pair` net to 0 | 0 violations (legacy concepto 16 uses unpaired concept, so excluded) |

**Sin tolerancia monetaria.** Filas legacy con redondeo malo van a `staging.movement_quarantine` (§4.2) y la suma de cuarentena = drift conocido y aislado. Drift > 0 fuera de cuarentena ⇒ abort.

Output is a single row per check with `status: PASS | FAIL` and a count of offending rows. Ops dashboard shows a stoplight.

---

## 8. App cutover

**Connection string switch** is the only app-side change at cutover time, assuming the app already supports both via a feature flag on `DB_DRIVER`. If the app is still SQL-Server-specific:

1. **Pre-cutover (T-2 weeks):** rewrite the data layer to use Postgres-compatible SQL (Drizzle ORM with Postgres dialect, or a thin abstraction). Test against a Postgres copy loaded from a `.bak` snapshot.
2. **Cutover:** flip `DATABASE_URL` to Postgres + flip flag. App restart.
3. **Post-cutover:** SQL Server stays online but `ALTER DATABASE viciongroup SET READ_ONLY` so any forgotten code path that still writes to it fails loudly instead of silently diverging.

If the app uses raw `sqlcmd`-style queries scattered throughout the codebase, the migration becomes a 2-month project, not a weekend. **Audit the data access layer before scheduling the cutover window.**

---

## 9. Rollback plan

If reconcile fails or app misbehaves post-cutover:

1. Set Postgres database to `default_transaction_read_only = on` so no further writes land.
2. Lift `READ_ONLY` on SQL Server.
3. Point app `DATABASE_URL` back to SQL Server.
4. Investigate Postgres data — staging schema is preserved for forensics.
5. Any writes that landed on Postgres post-cutover (during the broken window) must be replayed manually to SQL Server. Hence: **monitor closely for the first 30 minutes** and trigger rollback fast if anything is off.

The 90-day SQL-Server-read-only retention exists precisely so a rollback is possible up to a quarter later if a subtle bug surfaces (e.g., reporting discrepancy at fiscal-quarter close, ó hallazgo en el cierre trimestral DIAN). Para fintech 30 días es muy corto: un bug de reporting puede tardar hasta el cierre del Q en aparecer. El costo del .bak en frío (32 GB) es despreciable.

---

## 10. Files in this directory

- `PLAN.md` — this document
- `00_rank_map_seed.sql` — mapeo APROBADO rangos legacy → 14 nuevos (1:1, idénticos hasta Corona)
- `01_pgloader.load` — pgloader configuration: SQL Server → `staging.*`
- `02_postload.sql` — transforms `staging.*` → `mlm.*` with cleanup
- `03_backfill_events.sql` — enrollment events + structural counts only
- `04_reconcile.sql` — validation queries with PASS/FAIL output
- `05_timescaledb.sql` — hypertables/compresión (SOLO self-managed; obsoleto en AWS)
- `05_partitioning_rds.sql` — equivalente para AWS RDS: pg_partman + pg_cron (ADR-0019)

Run order: 01 → 00_rank_map_seed → 02 → 03 → 04. Each script is idempotent on a fresh target database (it truncates `staging.*` and `mlm.*` before loading on rerun, guarded by `IF EXISTS` checks).

**Pre-req schemas (before 01):** `schema_mlm.sql` → `schema_governance.sql` →
`schema_payouts.sql` → `schema_payouts_v1.1.sql` → `schema_payouts_v1.2.sql`
(candados R1/R2/R3) → `schema_ranks.sql` (carrera de 14 rangos) →
`05_partitioning_rds.sql` (target AWS RDS, ADR-0019; en self-managed sería
`05_timescaledb.sql` — son mutuamente excluyentes).

## 11. Directiva de seed del árbol (2026-06-04)

El árbol 2.0 migra completo **conservando posición y rango, pero NO volumen**:

| Qué | Cómo |
|---|---|
| Posición (parent/L-R/sponsor) | migrada tal cual + path ltree reconstruido (§5) |
| Rango | mapeo manual `staging.rank_map` (legacy idRank → rango 1-14); fail-closed si falta un mapeo |
| Rangos heredados | `mlm.affiliate_rank_achieved` con `source='legacy'`, **bono 0** (sin retroactivo) |
| Baseline de carrera | `rank_points_baseline = required_points` del rango heredado → el siguiente rango exige sólo el **delta** de puntos nuevos |
| Volumen binario (PV piernas, carry) | **0** — verificado por 03 (sanity) y 04 (check C10) |
| Puntos R3 / carry pausado R1 | **0** (`affiliate_payout_state` se inicializa limpio) |
| Histórico monetario | completo en `mlm.wallet_movement` (forense; no genera bloques ni rangos) |
| `last_purchase_at` (R1) | última activación de paquete legacy, para no marcar a todos stale en el primer cierre |

`staging.rank_map` quedó sembrada en `00_rank_map_seed.sql` (aprobada
2026-06-05): la escalera 2.0 es idéntica en nombres y umbrales a los 14
nuevos — mapeo 1:1 hasta Corona (12); Royal y King son nuevos, nadie los
hereda. 108,991 vicionarios sin rango quedan con `current_rank_id = NULL` y
baseline 0. 02_postload aborta si aparece un rango legacy fuera del mapeo.
