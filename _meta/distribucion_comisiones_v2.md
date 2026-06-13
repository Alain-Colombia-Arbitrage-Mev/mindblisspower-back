# Distribución de comisiones — Mindbliss Power v2

> Resumen ejecutable del contrato económico. Las decisiones vinculantes viven en
> ADR-0012 (invariantes T1–T4, θ) y ADR-0013→0018 (streams v2). Este doc es el
> mapa de "a dónde va cada dólar" + diagramas. Si un número aquí contradice el
> `plan_config` activo en DB, **manda el `plan_config`** (es prospectivo y se
> cambia con four-eyes, ADR-0010).

## 1. El sello maestro: θ (nunca se paga de más)

Todo bono, sin excepción, pasa por θ **antes** de emitirse:

```
θ = clamp( α × inflows(período) / Σ pagos_proyectados(período) , 0 , 1 )
con α = TreasuryAlpha = 0.45
```

- Si las obligaciones del período caben en el 45% de los inflows → **θ = 1** (todos cobran completo).
- Si se pasan → **θ < 1** y *todos* los pagos se prorratean parejo. El afiliado VE θ en su panel (línea roja #2: no se oculta).
- Consecuencia: **los bonos jamás superan el 45% de lo que entró**. La empresa no puede quebrar por el árbol, por construcción. Esto es independiente de qué tan profundo o ancho sea el bosque.

```mermaid
flowchart TD
    P["Compra de pack $X (+1% manejo)"] --> INF["Inflow del período → caja"]
    INF --> OBL["Obligaciones proyectadas del período"]
    OBL --> Y["ROI / Yield 25%–50% anual"]
    OBL --> B["Binario (weak-leg, D=10)"]
    OBL --> R1["Referido gen-1"]
    OBL --> R2["Regalía gen-2 (5%)"]
    OBL --> RK["Rango (cuotas, si ON)"]
    Y & B & R1 & R2 & RK --> TH{"θ = min(1, 0.45·inflows / Σobligaciones)"}
    TH -->|"× θ"| PAY["Bonos netos (≤ 45% inflows)"]
    TH -->|"55%+ restante"| TES["TESORERÍA (margen + reservas + OPEX)"]
    PAY --> LIQ["Liquidación: acumula diario → cierre de mes → +1 mes +1 día → pendiente de retiro"]
```

## 2. Los streams y sus tasas (PlanConfig real)

| Stream | Quién cobra | Tasa | Gate / condición | Alcance | Candado extra |
|---|---|---|---|---|---|
| **ROI / Yield** | dueño del pack | 25% anual base (→ tiers) | 1 directo ACTIVO por pierna, re-verificado cada período | propio | CD: principal bloqueado 365d (`CapitalLockPeriods`) |
| **Binario** | ancestros weak-leg | `BonusPerBlock` $10 / bloque de 500 pts · fundador `FounderBinaryMatchedRate` 10% | volumen en pierna débil | **D = 10 niveles** (`DepthCap`) | T3 cap diario 3× rango |
| **Referido g1** | patrocinador directo | fundador 10% (`FounderReferralRate`) / no-fundador `ReferralRate` | 1 directo activo a cada lado (`sponsor_gate`) | gen-1 | entra a θ |
| **Regalía g2** | patrocinador del patrocinador | 5% (`RoyaltyRate`) | g2 activo | gen-2 | T1 sólo |
| **Rango** | afiliado que cruza hito | bono fijo por rango, en N cuotas | puntos-por-pierna | T1 | Mitigación B (cuotas × θ) |

ROI por tiers (propuesta — califica con **2 directos de la misma inversión**):

| Pack (USD) | ROI base | ROI calificado |
|---|---|---|
| 100 / 250 / 500 | 25% | 30% |
| 1,000 / 2,500 | 25% | 35% |
| 5,000 / 10,000 | 25% | 40% |
| 25,000 | 25% | 45% |
| 50,000 | 25% | 50% |

## 3. Profundidad: por qué un bosque de 30+ niveles es estable

El binario **solo propaga 10 niveles hacia arriba** (`DepthCap = 10`). El árbol puede
medir 191 niveles estructuralmente; el dinero solo sube 10. Esto acota la cascada
de pago de cualquier compra sin partir el bosque.

```mermaid
flowchart TD
    subgraph "Una compra en el nivel 50"
      N50["nivel 50: COMPRA"] --> N49["nivel 49 ✅ cobra"]
      N49 --> dots["… niveles 41–48 ✅ cobran"]
      dots --> N40["nivel 40 ✅ cobra (último)"]
      N40 -.->|"D=10 corta aquí"| N39["nivel 39 ❌ no cobra"]
      N39 --> N0["niveles 0–39 ❌ no cobran de esta compra"]
    end
```

> **Decisión:** se acota con `DepthCap=10` sobre el flujo de comisión, **no** re-enraizando
> el bosque. Re-enraizar rompe genealogía y derrame (el spillover desciende por la pierna
> débil) sin ningún beneficio financiero que el cap de profundidad no dé ya.
> El "breakage" de los niveles que no cobran es precisamente lo que crea el margen.

## 4. Híbrido tipo 401k: a dónde va el bono NETO

θ y los caps definen *cuánto* se paga. El perfil 401k define *dónde cae* ese neto
(no cambia el costo para la empresa; el modo Agresivo además mejora la caja porque
encierra el dinero hasta los 65).

```mermaid
flowchart LR
    NET["Bono neto (post-θ)"] --> M{"Perfil del afiliado"}
    M -->|Moderado| MO["100% a gastos<br/>(solo bono referido al calificar 50%)"]
    M -->|Acelerado| AC["2 bonos → jubilación (bloqueado 65)<br/>1 bono → gastos"]
    M -->|Agresivo| AG["100% → jubilación (bloqueado 65)"]
```

**Plan de jubilación (CD permanencia):** principal aparece pero inmóvil; solo el ROI
diario acumula. No se puede sacar/mover/reinvertir hasta 365 días (inversión) o hasta
los 65 años (permanencia). Préstamo permitido sobre la ganancia. Retiro anticipado =
penalidad del 10% del monto retirado.

## 5. Candados (locks) end-to-end

1. **Registro + KYC** → dos perfiles: inversionista pasivo / red.
2. **Compra de pack** → colocación en el árbol (sin referido → root de empresa, id 117475).
3. **θ (T1)** → bonos ≤ 45% inflows, prorrateo visible.
4. **T2** → Σ bonos por paquete ≤ 2× monto; al tope, el paquete cierra.
5. **T3** → cap diario por usuario = 3× bono de rango.
6. **D = 10** → el binario no paga más de 10 niveles arriba.
7. **Liquidación** → diario acumula, cierre de mes, +1 mes +1 día al pendiente.
8. **CD 365d** / **permanencia 65 años** → float de tesorería.
9. **Superávit / sobrante / bonos no reclamados** → **Tesorería**.
10. **Fundadores v2.0** (registran + compran en v2) → 10% referido + 10% binario.
11. **Rango líder eliminado; T3 (tercera generación legacy) madura en v2 y ya no existe.**

## 6. Pendiente de validar contra DB / simulador
- ROI por tiers: hoy el motor usa `YieldAnnualRate` plano 25%; los tiers están diseñados, falta cablearlos a `plan_config` por pack.
- Correr el simulador en **estado estacionario (growth = 0)** con estos parámetros para confirmar margen ≥ 55% (línea roja #7: si necesita reclutar para pagar, es Ponzi).
