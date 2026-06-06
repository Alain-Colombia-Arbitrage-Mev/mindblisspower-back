# 0012 — Plan de compensación binario: parámetros y invariantes

**Status:** Accepted
**Date:** 2026-04-28
**Deciders:** equipo VicionPower (devfidubit)

## Context

El sistema legacy paga **197 % de inflows** en bonos sostenidos durante 5 meses (datos: $717M inflows, $1,418M pagado). Esto no es margen bajo — es insolvencia estructural y, sin reforma, evoluciona inevitablemente a Ponzi.

El audit de `_meta/credito_audit.out` y los documentos de diseño `mlm_binario_estabilidad.md` + `mlm_binario_margen_operativo.md` identifican causas y proponen una solución cuantitativa. Esta ADR formaliza esa solución como **decisión arquitectónica vinculante** — no es un análisis exploratorio, es el contrato económico del producto.

Restricciones:
- **Solvencia matemática garantizada por construcción**, no por buena voluntad operativa.
- **Transparencia total con afiliados** — cualquier reducción de pago debe ser visible y explicable.
- **Cumplimiento legal** — el plan debe ser publicable y defendible ante reguladores (UIAF SARLAFT, SIC, DIAN).
- **Compatibilidad con el árbol existente** — no podemos reset el árbol; debemos rediseñar las reglas hacia adelante.

## Decision

### 1. Adoptar el modelo de Escenario B (`mlm_binario_margen_operativo.md §4`)

Parámetros iniciales `plan_config v1-conservative`:

| Parámetro | Símbolo | Valor | Rango operativo |
|---|---|---:|---|
| Tamaño de bloque (puntos) | `B` | 500 | 100 – 1,000 |
| Bono por bloque (USD) | `r` | $10.00 | $5 – $20 |
| Profundidad máxima (niveles) | `D` | 10 | 7 – 15 |
| Factor cap diario × rango | `K_user` | 3.0 | 1× – 5× |
| Factor cap lifetime × paquete | `K_pkg` | **2.0** | 1.5× – 3× |
| Treasury alpha (fracción inflows) | `α` | **0.45** | 0.30 – 0.60 |
| Carry decay (días) | `β` | 14 | 7 – 30 |
| Directos calificados pierna izq | `Q_L` | 1 | ≥ 1 |
| Directos calificados pierna der | `Q_R` | 1 | ≥ 1 |

### 2. Cuatro invariantes hard (T1–T4)

Estos invariantes son **enforced en DB**, no en código de aplicación:

**T1 — No overspend:** en cualquier período P,
```
Σ pagos_binarios(P) ≤ α × inflows(P)
```
Implementado por: cálculo de `θ = clamp(α × inflows / projected_outflows, 0, 1)` antes de emitir movimientos. Si `θ < 1`, todos los pagos del período se prorratean. Verificable post-hoc con `mlm.fn_verify_period_solvency(period_id)`.

**T2 — Cap por paquete:** para todo paquete p,
```
Σ bonos(p) ≤ K_pkg × p.amount_usd
```
Aplica a la SUMA de TODOS los conceptos de bono atribuibles al paquete (ROI + binario + rápido + rango + liderazgo). Implementado en `mlm.package_cap_state` con trigger `fn_enforce_package_cap`. Cuando se alcanza, el paquete se marca `closed_at` y deja de generar pagos hacia ancestros.

**T3 — Cap diario por usuario:** para todo afiliado a, todo día d,
```
Σ bonos(a, d) ≤ K_user × rank(a).bonus
```
Implementado por trigger `fn_enforce_daily_cap` antes de cada INSERT en `binary_block_payment`.

**T4 — Append-only ledger:** `mlm.wallet_movement` y `mlm.binary_block_payment` son INSERT-only. Cualquier corrección se hace por **transacción reversa referenciada**, nunca UPDATE/DELETE retroactivo. Enforced por permisos: `engine_write` no tiene DELETE en estas tablas.

### 3. Las 7 líneas rojas (de `mlm_binario_margen_operativo.md §10`)

Quedan **explícitamente prohibidas** en la implementación, vigilancia activa requerida:

1. No modificar bonos ya acreditados (movement append-only).
2. No ocultar el throttle θ — el afiliado lo ve en su panel.
3. No introducir caps no publicados ni "blackList silenciosa".
4. No prometer ROI fijo dependiente de inflows futuros (Ponzi disclaimer).
5. No usar `concept = manual_adjustment` como mecanismo discrecional. Toda emisión requiere justificación auditable + four-eyes (ADR 0010).
6. Caps prospectivos, no retroactivos. Cambios de `plan_config` aplican a períodos posteriores, nunca a períodos cerrados.
7. Simulaciones deben funcionar bajo `growth = 0` (estado estacionario). Si el plan requiere reclutar más para pagar, el plan es Ponzi por construcción.

### 4. Mecanismo de margen operativo

El operador retiene **mínimo 55 % de inflows** garantizado por T1 (con α = 0.45). Composición típica esperada bajo Escenario B (de `mlm_binario_margen_operativo.md §4`):

```
Inflows:                      $143 M / mes  (baseline)
Bonos efectivos (post-θ):     $71.5 M       (50 %)
OPEX:                         $1.4 M        (1 %)
Reservas (10 %):              $14.3 M       (10 %)
Margen operativo bruto:       $55.8 M / mes (39 %)
```

El margen viene de **breakage natural** (qualification + depth cap + carry decay + cap hit), no de tricks ocultos. Cada factor `< 1` en la ecuación de `§8 House edge` es transparente y publicado.

### 5. Período binario y cadencia

- **Período por defecto:** semanal (lunes 00:00 a domingo 23:59:59 America/Bogota).
- **Cierre:** lunes 02:00 América/Bogota — job idempotente en `vp-engine.bonusengine.CloseBinaryPeriod()`.
- **Visibilidad al afiliado:** dashboard muestra período activo, theta proyectado, daily cap restante, carry remaining con countdown.

## Consequences

### Positivas

- **Solvencia garantizada matemáticamente.** T1 es invariante DB-enforced; imposible exceder `α × inflows` por construcción.
- **Margen operativo positivo y predecible.** ~39 % de inflows queda en treasury vs. −97 % actual.
- **Auditabilidad total.** Cada bono enlaza a `binary_block_payment.id` + `binary_period.id` + `plan_config.id` + `theta_applied`. Reproducible bit-a-bit desde eventos inmutables.
- **Cumplimiento regulatorio.** Plan publicable; ningún parámetro oculto. Defensa ante UIAF/SIC documentable.
- **Idempotencia operacional.** Re-correr un período cerrado no duplica pagos — `UNIQUE(affiliate_id, period_id, source_event_id)`.

### Negativas

- **Política de comunicación necesaria.** Afiliados acostumbrados al sistema legacy verán bonos menores. Sin storytelling claro, riesgo de churn alto en transición. Mitigación: documentado en `mlm_binario_estabilidad.md §9` (Plan de migración).
- **`Q ≥ 1 directo por pierna` desafilia ~75 % del árbol** del cálculo (datos del audit muestran 75 % con 0 directos). Mitigación: política de ramping — `Q = 0` por 60 días post-cutover, luego `Q = 1`.
- **Ajustar parámetros requiere ADR superseder o approval flow.** Cambiar `α` o `K_pkg` no es decisión operativa ad-hoc; va por `mlm.approval_request` con cuatro-ojos (ADR 0010). Lentifica reacción a market events pero previene erosion del margen.
- **Shadow mode obligatorio 30 días** antes de cutover. Costo: 4 semanas de paralel run, recursos de ingeniería para comparar outputs. Beneficio: cero divergencia descubierta en producción.

### Neutras

- TimescaleDB hypertable de `binary_block_payment` ya configurada (compresión 60d, chunks mensuales).
- El modelo es agnóstico al lenguaje del motor; vive en `vp-engine` (Go) por performance, pero podría re-implementarse en TS si fuera necesario.

## Alternatives considered

### Escenario A — "Solo binario reformado"

**Rechazado.** Estabilizar solo el binario sin tocar ROI ni concepto 16 deja ROI ($784M, 109% de inflows) intacto. Margen sigue negativo. El binario es 10 % del problema; corregirlo solo es cosmético.

### Escenario C — "Reforma agresiva"

**Rechazado para v1.** Parámetros: α = 0.40, K_pkg = 1.8, D = 8, Q = 2/pierna, β = 7d. Margen esperado +54 % pero `Q = 2` saca al 75 % del árbol del cálculo, riesgo alto de churn de afiliados activos. Documentado como **Plan B**: si retención > 80 % se mantiene en Escenario B durante 90 días, se evalúa migración a C vía nuevo `plan_config` y ADR superseder.

### Mantener fórmula legacy

**Rechazado categóricamente.** Camino cierto a insolvencia o Ponzi por diseño. El 197 % de payout es inviable matemáticamente.

### "Apagar el binario, pagar solo ROI"

**Rechazado.** Destruye el incentivo comercial del MLM. El binario es lo que diferencia un MLM de una rentabilidad fija.

### Pricing de paquetes diferente para mejorar margen

**Considerado complementario, no sustituto.** Ajustar precio de paquetes (`§7 Diferenciación de paquetes`) puede subir margen unitario, pero sin las invariantes T1-T4 cualquier margen es ilusorio porque los pagos pueden exceder inflows en cualquier momento. Las invariantes son el piso; el pricing es optimización sobre ese piso.

### Aceptar growth-dependent (asumir que crecimiento futuro paga obligaciones presentes)

**Rechazado categóricamente.** Es la definición de Ponzi. T7 (no diseñar asumiendo growth > 0) es no negociable. Las simulaciones de margen funcionan en estado estacionario — si dejaras de captar afiliados nuevos hoy, el sistema sigue siendo solvente.

## Plan de migración

Documentado en `mlm_binario_estabilidad.md §8` y resumido aquí:

| Fase | Duración | Hito |
|---|---|---|
| 0 | 1 sem | Aplicar `schema_payouts.sql`; insertar `plan_config v1-conservative` |
| 1 | 2 sem | Implementar `bonusengine.CloseBinaryPeriod()` en `vp-engine` (Go) |
| 2 | **4 sem shadow mode** | Cálculo nuevo paralelo al legacy; comparar outputs por afiliado/período |
| 3 | 1 día | Cutover: desactivar trigger legacy, activar nuevo motor |
| 4 | 2 sem | Cap retroactivo opcional sobre paquetes vivos (con approval) |
| 5 | 1 sem | Eliminar columnas `current*`, `carry*`, `volume*` de `affiliate` (ya migradas a `binary_node_state`) |

Si shadow mode revela divergencia > 0.01% en cualquier afiliado, **abortar cutover** hasta entender causa.

## Cómo se cambia esta ADR en el futuro

Esta ADR define decisión vinculante. Cambios de `plan_config` (ej., subir `α` de 0.45 a 0.50) **no requieren** ADR superseder — son ajustes operativos previstos en los rangos documentados, sujetos a `mlm.approval_request` con dos admins (ADR 0010).

Cambios estructurales (eliminar T1, cambiar fórmula de θ, romper append-only) **sí requieren** nueva ADR que supersede 0012, con análisis cuantitativo nuevo y aprobación del equipo completo.

## References

- `mlm_binario_estabilidad.md` — diseño completo del bono binario.
- `mlm_binario_margen_operativo.md` — diseño del margen operativo.
- `_meta/credito_audit.out` — el audit que motivó la reforma.
- `_meta/schema_payouts.sql` — DDL ejecutable de tablas + triggers + invariantes.
- `_meta/sketches/binary_close.go.md` — pseudocódigo del algoritmo de cierre.
- ADR 0001 — Postgres + TimescaleDB (storage).
- ADR 0002 — vp-engine en Go (donde corre el motor).
- ADR 0009 — retención (binary_block_payment 10 años).
- ADR 0010 — four-eyes para cambios de `plan_config`.
- ADR 0011 — observabilidad del motor (drift detection en tiempo real).
- Charles Ponzi (1920) — caso histórico de growth-dependent que esta ADR previene.
