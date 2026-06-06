# VicionPower — Binary Bonus Specification (canónica)

**Status:** Normative. Esta es la **única fuente ejecutable** de la fórmula del bono binario. Los demás documentos (`mlm_binario_estabilidad.md`, `mlm_binario_margen_operativo.md`, `ADR 0012`) son contexto histórico y narrativa de diseño; **si divergen, este archivo manda**.

**Versión:** 1.1
**Fecha:** 2026-06-05
**Cubre:** `plan_config v1-conservative` y todas las plan_config futuras que respeten la estructura de campos.

---

## 1. Parámetros (`mlm.plan_config`)

| Símbolo | Columna | Default v1 | Rango operativo |
|---|---|---:|---|
| `B` | `block_size` | 500 | 100–1000 |
| `r` | `bonus_per_block` | $10.00 | $5–$20 |
| `D` | `depth_cap` | 10 | 7–15 |
| `K_user` | `daily_cap_factor` | 3.0 | 1–5 |
| `K_pkg` | `lifetime_cap_factor` | 2.0 | 1.5–3 |
| `α` | `treasury_alpha` | 0.45 | 0.30–0.60 |
| `β` | `carry_decay_days` | 14 | 7–30 |
| `Q_L` | `qualified_directs_left` | 1 | ≥0 |
| `Q_R` | `qualified_directs_right` | 1 | ≥0 |

Cambios de cualquier parámetro requieren `mlm.approval_request` aprobado (ADR 0010, enforced por `trg_enforce_plan_config_approval`).

---

## 2. Eventos (entrada del cálculo)

Cada compra, recompra o renovación que aporte PV genera **una fila en
`mlm.tree_event`** con `kind = 'pv_credit'`. El evento referencia al afiliado
comprador y guarda el delta de PV; `mlm.fn_apply_tree_event()` determina por
`ltree` si ese afiliado cae en la pierna izquierda o derecha de cada ancestro.

`enrollment` sólo cuenta estructura (`left_count` / `right_count`). No paga
bono por sí mismo.

`inflows_period` se computa así (la definición es vinculante):

```sql
SELECT COALESCE(SUM(wm.amount), 0)
  FROM mlm.wallet_movement wm
  JOIN mlm.concept c ON c.id = wm.concept_id
 WHERE c.kind      = 'package_purchase'
   AND wm.posted_at >= :period_start
   AND wm.posted_at <  :period_end;
```

> Nota: `concept.kind = 'package_purchase'` es el discriminador autoritativo.
> El antiguo `concept = compras` del documento de diseño se traduce a este filtro.

---

## 3. Calificación

Un afiliado `a` está **qualified para bono binario** ⇔

```
a.status = 'active'
∧ EXISTS (mlm.affiliate_package ap WHERE ap.affiliate_id = a.id AND ap.status = 'active')
∧ SI Q_L > 0: existe hijo binario activo en L
∧ SI Q_R > 0: existe hijo binario activo en R
∧ patrocinados_directos_activos_en_L(a) ≥ Q_L
∧ patrocinados_directos_activos_en_R(a) ≥ Q_R
```

El código actual (`bonusengine/candidate.go`) usa dos candados cuando
`Q_L/Q_R > 0`:

- **Candado estructural:** hijo binario inmediato activo en la pierna
  (`parent_id = a.id`, `position = 'L'/'R'`).
- **Candado comercial:** patrocinados directos activos en esa pierna
  (`sponsor_id = a.id`, ubicados por `ltree`, con paquete activo).

Esto evita que el spillover estructural habilite pago binario sin actividad
comercial propia.

No-qualified ⇒ compresión: el ancestro no emite candidato. El PV queda en el
árbol y puede ayudar a otros ancestros que sí califiquen.

---

## 4. Algoritmo canónico de cierre

El trigger de `tree_event` ya materializó el PV en `mlm.affiliate` antes del
cierre. Por eso `CloseBinaryPeriod` **no vuelve a sumar PV del evento**; sólo
lee el estado acumulado y calcula bloques nuevos.

Por cada ancestro tocado por algún `tree_event.kind='pv_credit'` del período:

```
SI nivel(a, te.affiliate_id) > D     → no candidato
SI NOT qualified(a)                  → no candidato

matched_lifetime := MIN(a.left_pv_lifetime, a.right_pv_lifetime)
blocks_total     := FLOOR(matched_lifetime / B)
blocks_paid_hist := Σ binary_node_state.blocks_paid_left
                  + Σ binary_node_state.blocks_paid_right
new_blocks       := blocks_total - blocks_paid_hist

SI new_blocks ≤ 0                  → no candidato

gross := new_blocks × r
SI a.is_founder Y founder_binary_matched_rate > 0:
  gross := founder_binary_matched_rate × (new_blocks × B)

# Caps (orden vinculante: daily PRIMERO, package DESPUÉS)
period_cap := SI period_cap_factor > 0
              ENTONCES period_cap_factor × paquete_activo(a).amount_usd
              SI NO daily_cap_factor × rank_bonus(a)
gross_after_daily := MIN(gross, period_cap)
cap_daily_reduction := gross − gross_after_daily

pkg_remaining := package_cap_state(paquete_activo(a)).cap_total
                 − package_cap_state(paquete_activo(a)).paid_total
gross_after_pkg := MIN(gross_after_daily, pkg_remaining)
cap_package_reduction := gross_after_daily − gross_after_pkg

candidate := { affiliate=a, source_event=primer_evento_del_periodo_que_lo_tocó,
               blocks=new_blocks, gross=gross_after_pkg,
               cap_daily_reduction, cap_package_reduction }
```

**El orden `daily → package` es vinculante.** Cualquier implementación que aplique los caps en otro orden o en paralelo (`min(daily, pkg)`) puede dar resultados distintos cuando ambos caps muerden a la vez y rompe la auditabilidad fila por fila.

---

## 5. Throttle θ

```
projected := Σ candidate.gross
θ := MIN(1, MAX(0, α × inflows / projected))    # projected=0 ⇒ θ=1
```

Precisión: `numeric(8,6)`. Redondeo: hacia abajo a 6 decimales (`ROUND(_, 6, 'down')` en cada implementación).

```
PARA CADA candidate:
  net := ROUNDDOWN(candidate.gross × θ, 2)
  SI net = 0 → SKIP
  INSERT mlm.binary_block_payment (..., gross_amount=candidate.gross,
                                   theta_applied=θ, net_amount=net,
                                   cap_daily_reduction, cap_package_reduction)
  INSERT mlm.wallet_movement      (..., concept=binary_bonus, factor=+1, amount=net)
  UPDATE mlm.binary_node_state    (... blocks_paid_*, carry_*, paid_today_*, ...)
  UPDATE mlm.package_cap_state    SET paid_total = paid_total + net
```

Todo dentro de **una** transacción `SERIALIZABLE` por período, protegida con `pg_advisory_xact_lock(period_id)`.

---

## 6. Carry y caducidad

La implementación de producción paga por `matched_lifetime` menos bloques
históricos pagados. `binary_node_state.carry_left/right` conserva el residuo
operativo por nodo y período para reporting y caducidad.

Caducidad: tras el cierre del período, llamar
`mlm.fn_expire_carry(period_id)`. Función definida en
`schema_payouts_v1.1.sql §5`; caduca por nodo según `carry_started_at`.

---

## 7. Invariantes (DB-enforced)

| ID | Definición | Enforcement |
|---|---|---|
| **T1** | `Σ net_amount(P) ≤ α × inflows(P)` | construcción de θ + verificación post-cierre con `mlm.fn_verify_period_solvency(P)` |
| **T2** | `Σ bonos(p) ≤ K_pkg × p.amount_usd` ∀ paquete p | trigger `trg_enforce_package_cap` |
| **T3** | `Σ bonos(a, período P) ≤ period_cap_factor × paquete_activo(a)`; fallback legacy `daily_cap_factor × rank_bonus(a)` | trigger `trg_enforce_daily_cap` |
| **T4** | `binary_block_payment` y `wallet_movement` son INSERT-only | revoke UPDATE/DELETE en `schema_payouts_v1.1.sql §1` |

Verificable en cualquier momento con:

```sql
SELECT * FROM mlm.fn_check_payout_invariants();
-- Las cuatro deben estar en status = 'OK'.
```

---

## 8. Idempotencia

`mlm.binary_block_payment` tiene `UNIQUE (affiliate_id, binary_period_id, source_event_id, posted_at)`. Re-ejecutar `CloseBinaryPeriod` sobre un período `closed` retorna el mismo snapshot sin duplicar pagos. La transacción se serializa por advisory lock (`pg_advisory_xact_lock(period_id)`).

`mlm.transaction.external_ref` para bonos binarios sigue el patrón:

```
binary:<period_id>:<affiliate_id>:<source_event_id>
```

Esto hace que la combinación sea trazable desde el ledger hasta el evento original.

---

## 9. Alcance de esta spec

Esta spec norma la fórmula del **bono binario por bloques**. En el cierre real,
`CloseBinaryPeriod` también suma streams v2 al `projected` antes de θ: R2 yield,
R3 puntos, cuotas de rango, referido y regalía. Sus reglas de elegibilidad y
pago viven en `vp-engine/internal/bonusengine/v2_streams.go` y en
`docs/liquidacion_y_ciclo_de_pago.md`.

Fuera de esta spec:

- ROI/CD diario standalone.
- Settlement mensual y split de jubilación.
- Pricing de paquetes.
- Frecuencia del cierre: configurada en `schema_payouts_v1.1.sql §4`
  (semanal lunes 02:00 Bogotá). Cambiar a quincenal/mensual no toca esta spec,
  sólo el scheduler.

---

## 10. Cómo se cambia esta spec

1. Para **parámetros** dentro de los rangos operativos: nuevo registro en `mlm.plan_config` con `approval_request_id` aprobado por dos admins. Aplica al **siguiente** período. Nunca retroactivo.
2. Para **estructura** (orden de caps, definición de θ, cambios a invariantes): nueva versión de este documento + ADR superseder de 0012 + actualización de `schema_payouts.sql` con migración versionada.

> Diff vs. los docs narrativos previos: este archivo congela `daily-then-package` como orden canónico (vs. `min(.,.)` paralelo del estabilidad.md). Congela `inflows_period` con `concept.kind='package_purchase'` (vs. la lista numérica del margen_operativo.md). El resto es reformulación más estricta del mismo contenido.
