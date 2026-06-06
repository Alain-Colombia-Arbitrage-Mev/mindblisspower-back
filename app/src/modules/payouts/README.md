# payouts — motor de bonos

**Módulo crítico:** cualquier cambio de fórmula afecta dinero real. La fuente
normativa del binario es `_meta/binary_spec.md`; el código ejecutable vive en
`vp-engine/internal/bonusengine`.

## Estado actual

| Pieza | Estado | Archivo |
|---|---|---|
| Cierre binario semanal | Implementado | `vp-engine/internal/bonusengine/binary_close.go` |
| Enumeración de candidatos | Implementado | `vp-engine/internal/bonusengine/candidate.go` |
| Streams v2: R2, R3, rangos, referido, regalía | Implementado | `vp-engine/internal/bonusengine/v2_streams.go` |
| Scheduler lunes 02:00 Bogotá | Implementado | `vp-engine/internal/bonusengine/scheduler.go` |
| Monitor T1-T4 | Implementado | `vp-engine/internal/bonusengine/invariants.go` |
| ROI diario standalone | Pendiente | `RunROIDaily()` retorna `not yet implemented` |
| Settlement mensual + split jubilación | Pendiente | DDL listo en `_meta/schema_payouts_v1.3.sql` |

El API TS no calcula payouts. `vp-api` delega ledger writes a `vp-engine`; el
cierre de bonos corre dentro del proceso Go.

## Flujo de cierre binario

1. Cargar `mlm.binary_period` abierto y tomar `pg_advisory_xact_lock(period_id)`.
2. Cargar `mlm.plan_config` vigente.
3. Sumar `inflows` del período desde `wallet_movement` con
   `concept.kind = 'package_purchase'`.
4. Enumerar ancestros tocados por `tree_event.kind = 'pv_credit'` hasta
   `depth_cap`.
5. Calcular bloques nuevos por ancestro:

```text
matched_lifetime = min(left_pv_lifetime, right_pv_lifetime)
blocks_total     = floor(matched_lifetime / block_size)
new_blocks       = blocks_total - blocks_paid_hist
```

6. Aplicar caps pre-theta en orden vinculante: T3 por período, luego T2 por
   paquete activo del ancestro.
7. Sumar streams v2 al `projected`: yield, puntos, rangos, referido y regalía.
8. Calcular `theta = floor6(alpha * inflows / projected)`, con máximo 1.
9. Postear pagos netos con `RoundDown(2)`, `available_at =
   mlm.fn_bonus_available_at(posted_at)`.
10. Cerrar el período, ejecutar `fn_expire_carry(period_id)` y verificar T1 con
    `fn_verify_period_solvency(period_id)`.

## Reglas matemáticas que no se pueden cambiar sin ADR

- T1: `total_paid <= treasury_alpha * inflows`.
- T2: `package_cap_state.paid_total <= package_cap_state.cap_total`.
- T3: cap por afiliado y período; el código usa `period_cap_factor × paquete`
  cuando existe y fallback `daily_cap_factor × rank_bonus`.
- T4: `wallet_movement` y `binary_block_payment` son append-only.
- T2 se calcula contra el paquete activo del afiliado que cobra, no contra el
  paquete del comprador que generó el evento.
- El PV no se re-aplica durante el cierre: el trigger de `tree_event` ya lo
  materializó al insertar el evento.
- Q_L/Q_R del binario exige doble candado cuando `Q > 0`: hijo binario activo
  en la pierna y patrocinado directo activo ubicado en esa misma pierna.

## Idempotencia

- `binary_period.status='closed'` hace que un re-run sea no-op.
- `pg_advisory_xact_lock(period_id)` serializa cierres concurrentes.
- `binary_block_payment` tiene `UNIQUE (affiliate_id, binary_period_id,
  source_event_id, posted_at)`.
- `transaction.external_ref` usa patrones como
  `binary:<period_id>:<affiliate_id>:<source_event_id>`.

## Validación

- Unit/integration tests en `vp-engine/internal/bonusengine/*_test.go`.
- Simulador económico en `vp-engine/internal/simulator` y CLIs
  `cmd/vp-sim`, `cmd/vp-derrame`, `cmd/vp-r1-compare`.
- Monitor operativo: `mlm.fn_check_payout_invariants()` expuesto por
  `Invariants.Run()` cada 60 segundos.

## Pendientes

- [ ] API admin en `vp-api` para consultar períodos, payouts y snapshots.
- [ ] ROI diario standalone (`RunROIDaily`) y devengo CD.
- [ ] Job de settlement mensual.
- [ ] Reconciliación automática contra shadow/legacy antes de cutover.
