# 0013 — Regla de recompra por profundidad de downline

**Status:** Draft (esperando decisión de modo de pausa)
**Date:** 2026-05-13
**Deciders:** equipo VicionPower (devfidubit)
**Supersedes:** ninguno (suma a ADR-0012, no lo reemplaza)

## Context

ADR-0012 establece T2 (cap por paquete) como único mecanismo de recompra: cuando
un paquete acumula `K_pkg × precio = 2× precio` en bonos cobrados, se cierra y
el afiliado debe comprar uno nuevo para seguir recibiendo bonos.

Esta regla funciona pero tiene un blind spot: **un afiliado con downline muy
profundo que cobra lento puede seguir tomando bonos durante años con su paquete
original**. Si su downline crece sostenidamente, recibe inflows sin reinvertir.
Para el operador esto es:

1. **Capital congelado**: cada $1 que el plan permite cobrar a un afiliado
   "dormido" sale del flujo activo. Aceptable hasta los 10 primeros niveles
   (relación directa con su esfuerzo); cuestionable más allá.
2. **Asimetría de incentivo**: nuevos afiliados pagan cash hoy para alimentar
   ingresos de afiliados antiguos cuya última inversión fue meses atrás.
3. **Riesgo regulatorio**: estructuras con "ingreso pasivo permanente" son
   más atacables ante UIAF/SARLAFT que las que exigen reinversión activa.

La propuesta: **al cruzar la barrera de 10 niveles de downline, el afiliado
debe haber comprado un paquete nuevo después de ese hito**. Si no lo hizo,
sus bonos se pausan hasta que lo haga.

## Decision

### Regla R1 — recompra por umbral de profundidad

Para todo afiliado `A`, definimos:

```
max_downline_depth(A)  := profundidad máxima del subárbol bajo A
                          (0 si A no tiene descendientes,
                           N si su descendiente más profundo está N niveles abajo)

last_purchase_at(A)    := timestamp del último affiliate_package activo de A

depth_crossed_at(A)    := primer instante en que max_downline_depth(A) cruzó 10
                          (NULL si aún no ha cruzado)
```

**A es "calificado por recompra"** si:

```
max_downline_depth(A) ≤ 10
  OR
last_purchase_at(A) > depth_crossed_at(A)
```

Es decir: o tu downline aún no alcanzó 10 niveles, o sí lo hizo pero ya recompraste
después de ese hito.

Una vez que recompras post-cruce, el contador se "consume". Si tu downline sigue
creciendo y luego cruza otra barrera (20 niveles, 30 niveles, etc.), el evento
de cruce se vuelve a registrar y necesitarás otra recompra.

### Implementación en producción

1. **Schema (vp-engine)**:

```sql
ALTER TABLE mlm.affiliate
  ADD COLUMN last_depth_threshold_crossed int  -- último múltiplo de 10 cruzado
  ADD COLUMN last_depth_threshold_at      timestamptz;

CREATE FUNCTION mlm.fn_max_downline_depth(affiliate_id bigint)
RETURNS int LANGUAGE sql STABLE AS $$
  SELECT COALESCE(MAX(d.depth) - a.depth, 0)
    FROM mlm.affiliate a
    LEFT JOIN mlm.affiliate d ON d.path <@ a.path AND d.id != a.id
   WHERE a.id = affiliate_id;
$$;

CREATE TRIGGER trg_track_depth_crossing
  AFTER INSERT ON mlm.affiliate
  FOR EACH ROW EXECUTE FUNCTION mlm.fn_update_ancestor_depth_state();
-- el trigger actualiza last_depth_threshold_crossed/at en todos los ancestros
-- cuyo max_downline_depth recién pasó un múltiplo de 10.
```

2. **bonusengine.isQualified() (vp-engine/Go)**:

```go
func isQualifiedForRepurchase(a Affiliate, lastPurchase time.Time) bool {
    if a.LastDepthThresholdCrossed == 0 {
        return true  // never crossed any threshold
    }
    return lastPurchase.After(a.LastDepthThresholdAt)
}
```

3. **Visibilidad al afiliado**: dashboard expone "tu downline llegó al nivel 11 —
   comprá un paquete nuevo antes del próximo cierre para no perder bonos".

### Las 3 alternativas de "pausa"

Cuando un afiliado falla la calificación R1, hay tres formas posibles de
materializar la pausa. **Esta ADR aún no decide cuál**; documenta el análisis.

#### Modo P-A: Skip en enumeración (estricto)

El afiliado simplemente no aparece como candidato en `CloseBinaryPeriod`.
Los bloques que le hubieran tocado en ese período **no se acreditan, no se
acumulan en carry, no se pueden reclamar después**.

- ✅ **Implementación trivial**: una línea en `isQualified()`.
- ✅ **Matemáticamente cerrado**: los pagos no realizados quedan en treasury.
- ✅ **Auditable**: cada período el snapshot muestra cuántos afiliados fueron
  skippeados y por qué.
- ❌ **Hostil al afiliado**: si compraste el lunes 03:00 pero el cierre fue
  las 02:00, perdés un período entero de bonos.
- ❌ **Riesgo de mass-churn**: el afiliado que ve "perdí $500 por no comprar
  a tiempo" se va y nunca vuelve a comprar.

**Impacto matemático**: aumenta el margen del operador en ~el % de afiliados
no calificados. Conservador desde el punto de vista de solvencia.

#### Modo P-B: Acumula en carry (justo)

Los bloques se calculan normalmente pero no se acreditan a la wallet del
afiliado pausado. En cambio se guardan como `paused_carry`. Al recomprar,
el `paused_carry` vigente (sujeto a β decay) se libera al siguiente período.

- ✅ **Pro-afiliado**: tu trabajo no se evapora, solo se pospone.
- ✅ **Incentivo fuerte**: "comprá ahora y recuperás $1,200 acumulados". Más
  pull a la recompra que P-A.
- ❌ **Complejidad estatal**: nueva tabla `mlm.paused_carry(affiliate_id,
  period_id, amount, expires_at)`. Otra fuente de drift en reportes.
- ❌ **Riesgo financiero**: si muchos afiliados acumulan carry simultáneamente
  y luego recompran masivamente, el período de release puede romper T1.
  Necesita θ aplicado también al release.
- ⚠️ **Plazo de expiración**: el carry pausado debería expirar (¿30 días?
  ¿60? ¿β decay normal?). Sin expiración la deuda potencial crece sin tope.

**Impacto matemático**: neutro a largo plazo si las recompras coinciden con
crecimiento de inflows; pico de outflow si todos recompran a la vez.

#### Modo P-C: Pago reducido (suave)

El afiliado cobra una fracción `r ∈ (0,1)` de lo que le tocaría. Por defecto
`r = 0.5`. El resto queda en treasury (no se acumula).

- ✅ **Compromiso**: mantiene flujo de bonos al afiliado dormido pero le
  envía señal económica clara.
- ✅ **Implementación intermedia**: una constante de reducción en el cálculo
  de net.
- ❌ **No incentiva fuertemente la recompra**: 50% sigue siendo plata que sale.
- ❌ **Ambiguedad mensaje**: "te pago menos pero no te digo claramente por qué"
  es peor UX que "no te pago hasta que compres".

**Impacto matemático**: margen del operador sube por `(1-r) × bonos_no_calificados`.

#### Resumen comparativo

| Aspecto | P-A Skip | P-B Carry | P-C 50% |
|---|---|---|---|
| Implementación | Trivial | Compleja (nueva tabla) | Simple |
| Incentivo a recomprar | Alto | **Máximo** | Bajo |
| UX afiliado | Hostil | Bueno | Confuso |
| Margen operador | Sube alto | Neutro | Sube medio |
| Riesgo solvencia | Cero | Pico al release | Cero |
| Auditabilidad | Excelente | Compleja | Excelente |
| Riesgo regulatorio | Bajo | Medio (puede leerse como "deuda") | Bajo |

### Recomendación tentativa (no decidida)

Para un launch v1, **P-A es el más simple y matemáticamente cerrado**.
Si el plan en shadow mode muestra que P-A causa churn mayor al 15%, evaluar
migración a P-B en una segunda iteración con τ_expira = 30 días.

P-C queda como opción de compromiso si producto valida que P-A es demasiado
brusco pero P-B agrega demasiada complejidad operativa.

## Consequences

### Positivas

- **Reinversión forzada de líderes**. Top affiliates pasan de "renta vitalicia"
  a "negocio que requiere atención continua".
- **Margen operativo extra**. La fracción `f` de afiliados no-calificados se
  estima en ~5-15% en estado estacionario; eso es 5-15% adicional al margen
  del operador.
- **Defensa regulatoria fortalecida**. "No vendemos ingreso pasivo
  permanente" es defendible. Cada afiliado debe reinvertir activamente para
  seguir recibiendo.

### Negativas

- **Riesgo de churn en cohorte legacy**. Afiliados con downline de 15+ niveles
  cuya última compra fue hace 2 años pueden percibirlo como "cambio de reglas
  retroactivo". **Mitigación obligatoria**: 60 días de gracia post-cutover
  donde la regla se anuncia pero no se enforce; afiliados afectados reciben
  comunicación directa con su deadline personal.
- **Complejidad operativa adicional**. Una nueva regla = un nuevo motivo de
  ticket de soporte. Estimación: +20% volumen de soporte en los primeros
  90 días.
- **Cap implícito al árbol**. Afiliados que no quieran recomprar dejarán de
  expandir su downline pasado el nivel 10. La empresa tendrá menos árbol total
  vs un mundo sin esta regla, pero más "árbol activo".

### Neutras

- **No cambia T1, T2, T3, T4**. Las invariantes hard de ADR-0012 siguen
  vigentes; R1 es una capa de qualification adicional, no las reemplaza.
- **Independiente del modo de pausa**. La regla R1 (cuándo) y la pausa
  (qué hacer cuando no califica) son ortogonales — el modo de pausa puede
  evolucionar P-A → P-B → P-C sin tocar la definición del trigger.

## Alternatives considered

### "Sin regla — solo K_pkg" (status quo de ADR-0012)

Rechazado por las razones del Context: deja en pie el escenario del afiliado
dormido cobrando indefinidamente con paquete único.

### "Recompra por tiempo en lugar de profundidad"

Considerado y rechazado. "Cada 90 días debes comprar para seguir cobrando"
es más simple de comunicar pero es ortogonal a la salud económica del
afiliado (alguien con 3 directos forzado a recomprar es injusto, mientras
que alguien con 1000 directos al que sólo se le pide cada 6 meses es laxo).

La profundidad correlaciona con el tamaño real del beneficio que el afiliado
está extrayendo del plan — es el trigger correcto.

### "Recompra por múltiplos de paid_total"

"Cuando has cobrado 5× tu inversión original, recomprá." Equivalente conceptual
a subir K_pkg de 2 a 5. Más simple pero no resuelve el blind spot: un afiliado
con downline gigante puede llegar al 5× rápido y seguir cobrando con su próxima
compra básica.

### "Cap absoluto a profundidad del árbol (D=10 también para placement)"

Rechazado. Cap estructural al árbol es destructivo para el crecimiento del
plan; ya tenemos D=10 como cap del bono (la profundidad efectiva), no de la
estructura.

## Plan de migración

1. **Semana 0** — Aprobar esta ADR + decidir modo P-A/B/C.
2. **Semana 1** — Schema migration + función `fn_max_downline_depth` +
   campos en `mlm.affiliate`. Backfill `last_depth_threshold_crossed` para
   afiliados existentes via path scan.
3. **Semana 2** — `vp-engine.bonusengine.isQualifiedForRepurchase()` con
   feature flag OFF.
4. **Semana 3-6** — Shadow mode. Se calcula la regla pero no se enforce.
   Reporte diario: "% afiliados que serían descalificados hoy".
5. **Semana 7** — Comunicación a base afiliada: regla, deadline personal,
   FAQ. 60 días de gracia anunciados.
6. **Semana 15** — Enforce ON. Primer cierre con regla activa.
7. **Semana 19** — Revisión de métricas: churn rate, % no calificados,
   impacto en margen, volumen de soporte. Decidir si mantener P-A o evaluar
   P-B.

## Métricas de éxito

- **Tasa de calificación R1** ≥ 85% del árbol activo en estado estacionario.
- **Churn 90 días post-enforce** ≤ 15% (afiliados que pasan a `status='suspended'`).
- **Lift de margen** ≥ +3pp vs período pre-enforce.
- **Cero solvency breach** (T1 sigue holding).
- **Volumen de soporte** vuelve a baseline en 90 días.

Si cualquiera falla por > 20%, congelar enforce y revisar el modo de pausa.

## References

- ADR-0012 — Plan de compensación binario (define T2 cap actual).
- ADR-0008 — Modular monolith (dice dónde vive el cambio).
- ADR-0010 — Four-eyes policy (cualquier cambio retroactivo del threshold
  requiere approval).
- `vp-engine/internal/simulator/` — donde se va a modelar antes de tocar prod.
