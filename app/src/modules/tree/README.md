# tree

Colocación en árbol binario, derrame de PV y lecturas de upline/downline.

**Estado actual:** la lógica productiva vive todavía en
`src/server/affiliate.ts`; este módulo documenta el contrato y el destino final
cuando se extraiga a `modules/tree`. Los endpoints expuestos hoy están en
`src/server.ts`.

## Tablas

- `mlm.affiliate`: estructura binaria (`parent_id`, `position`), patrocinio
  (`sponsor_id`), `ltree path`, contadores y PV materializado.
- `mlm.tree_event`: log append-only de mutaciones del árbol. `external_ref`
  es la llave de idempotencia.
- `mlm.rank`: catálogo de rangos; los ascensos se calculan en `vp-engine`.

## Separacion obligatoria

`tree` tiene dos caminos de escritura que no deben compartir handler:

- **Activacion nueva:** crea una posicion nueva para una persona nueva o ya
  autenticada. Solo puede insertar `mlm.affiliate` y `tree_event=enrollment`.
- **Reconciliacion de raices:** job admin/migracion. Puede mover subarboles y
  recalcular `path/depth/left_count/right_count`, pero no crea usuarios ni
  acredita volumen.

Detalle operativo: `../../../../docs/tree-activation-reconciliation.md`.

## Escrituras implementadas

| Operación | Endpoint actual | Implementación | Estado |
|---|---|---|---|
| Colocación manual | `POST /api/affiliate/place` | `placeAffiliate` | Implementado |
| Colocación weak-leg | `POST /api/affiliate/auto-place` | `autoPlaceAffiliate` | Implementado |
| Crédito de PV | interno | `registerPvCredit` | Implementado, sin endpoint público |

## Reglas de colocación

`placeAffiliate(personId, parentAffiliateId, position, sponsorAffiliateId)`
inserta directamente en una pierna. La transacción toma `FOR UPDATE` sobre el
padre y revalida que la pierna esté vacía antes del `INSERT`.

`autoPlaceAffiliate(personId, sponsorAffiliateId, preferredSide?)` serializa
por sponsor con `pg_advisory_xact_lock(sponsorAffiliateId)` y aplica weak-leg:

```text
1. Leer el nodo actual.
2. Elegir la pierna con menor left_pv_current/right_pv_current.
3. Si empatan, elegir la pierna con menor left_count/right_count.
4. Si empatan otra vez, usar preferredSide o 'L'.
5. Si esa pierna está ocupada, bajar al hijo y repetir.
6. Insertar en el primer slot vacío.
```

La base de datos refuerza la estructura con
`UNIQUE(parent_id, position) WHERE parent_id IS NOT NULL` y
`fn_compute_affiliate_path()`, que calcula `path` y `depth` antes del insert.

Los codigos de referido deben resolverse antes de este paso: codigo publico
estable -> `sponsorAffiliateId`. El codigo no es el `parent_id`; el slot final
lo decide `placeAffiliate` o `autoPlaceAffiliate`.

## Derrame de PV

`registerPvCredit({ externalRef, affiliateId, pv })` inserta:

```sql
INSERT INTO mlm.tree_event (
  external_ref, kind, affiliate_id, pv_delta_left, pv_delta_right
) VALUES (:externalRef, 'pv_credit', :affiliateId, :pv, 0)
ON CONFLICT (external_ref) DO NOTHING;
```

Aunque el delta se registra en una sola columna, el trigger
`mlm.fn_apply_tree_event()` determina la pierna desde la perspectiva de cada
ancestro usando `ltree`. El trigger actualiza todos los ancestros:

- `left_pv_lifetime` / `right_pv_lifetime`: PV histórico para binario y rangos.
- `left_pv_current` / `right_pv_current`: lectura operativa del ciclo abierto.
- `left_count` / `right_count`: sólo en eventos `enrollment`.

La profundidad máxima de pago (`plan_config.depth_cap`) no limita el trigger de
PV; se aplica después, durante `vp-engine.bonusengine.CloseBinaryPeriod()`, al
enumerar candidatos pagables.

## Lecturas pendientes

- `getUpline(affiliateId, depth)`: `WHERE ancestor.path @> self.path`.
- `getDownline(affiliateId, leg, depth)`: `WHERE child.path <@ root.path` y
  filtro por etiqueta `L_` / `R_` bajo el nodo raíz.
- `recomputeAggregates(affiliateId)`: recomputar desde `tree_event` y comparar
  contra `mlm.v_tree_pv_truth`.
- `moveAffiliate(affiliateId, newParentId, newPosition)`: admin only; requiere
  recomputar el subárbol y emitir `position_move`.

## Invariantes

- Un afiliado tiene como máximo un hijo `L` y uno `R`.
- `parent_id` define derrame binario; `sponsor_id` define referido, regalía y
  gates comerciales.
- Para el bono binario, `vp-engine` usa ambos: estructura viva por
  `parent_id/position` y patrocinados directos por `sponsor_id` ubicados en
  cada pierna.
- `tree_event` es append-only e idempotente por `external_ref`.
- Los agregados de `mlm.affiliate` deben cuadrar con `mlm.v_tree_pv_truth`.

## Pendientes

- [ ] Mover `placeAffiliate`, `autoPlaceAffiliate` y `registerPvCredit` a
  `modules/tree`.
- [ ] Formalizar `generateReferralCode` y `resolveReferralCode` sobre
  `mlm.affiliate.invitation_link` o una columna dedicada.
- [ ] Implementar endpoints de traversal y snapshot.
- [ ] Implementar reconciliacion programada de agregados.
- [ ] Implementar reconciliacion separada de raices migradas con dry-run.
- [ ] Documentar payloads JSON definitivos de `/api/affiliate/*`.
