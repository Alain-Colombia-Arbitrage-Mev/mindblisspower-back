# Diseño — Asesor IA del árbol binario MLM (`vp-advisor`)

**Fecha:** 2026-06-18
**Repo:** `mindblisspower-back`
**Estado:** Aprobado (diseño) — pendiente revisión de spec antes del plan

---

## 1. Contexto y objetivo

VicionPower opera una red MLM con **árbol binario** en Postgres (RDS, esquema `mlm.*`:
`affiliate`, `tree_position` izq/der, `sponsor_id`, `parent_id`), más esquemas de
payouts/ranks/bonos. El admin necesita **verificar la salud de la red** desde el panel
administrativo, con apoyo de IA.

### Objetivo
Un servicio nuevo `vp-advisor` que evalúa la salud del árbol binario / MLM y produce
reportes (global + por afiliado) que el **panel admin** muestra como su vista de
**"salud de la red"**, usando un LLM (DeepSeek v4 Pro vía OpenRouter) para interpretación
y recomendaciones sobre métricas calculadas de forma determinista.

### Alcance del análisis (confirmado)
- **Sanidad estructural** del árbol binario: balance izq/der, skew por pierna, profundidad,
  nodos huérfanos/desbalanceados, posiciones vacías, integridad padre-hijo.
- **Salud de comisiones/MLM**: bonos binarios, derrame (spillover), puntos por pierna,
  capping, anomalías en pagos/ROI (agregados).
- **Recomendaciones de crecimiento**: dónde colocar referidos, qué piernas reforzar,
  alertas proactivas.
- Fuera: detección de fraude (por ahora).

### No-objetivos
- No construir el frontend del panel admin (repo aparte) — este spec define el **contrato de API**.
- No analizar en tiempo real por evento.
- No enviar PII a terceros (ver §6).

---

## 2. Decisiones (cerradas)

| Área | Decisión |
|---|---|
| Ubicación | **Servicio nuevo dedicado** `vp-advisor` |
| Stack | **Go** (consistente con vp-engine; reusa `internal/simulator`; encaja en el pipeline CI/CD) |
| Ejecución | **Programado** (reporte global diario) **+ refresco a demanda + drill-down por afiliado** |
| Alcance reporte | **Global + drill-down** por afiliado |
| Datos al LLM | **Pseudonimizado** (IDs/alias + métricas; SIN nombres/emails/documento) |
| LLM | DeepSeek v4 Pro vía OpenRouter (`OPENROUTER_KEY`), con modelo de fallback |
| DB | **Misma RDS**, esquema nuevo `advisor` (read-only a `mlm.*`, read-write a `advisor.*`) |
| Host | **server1** (`i-060e76a6c26bded35`, host de workers), como contenedor (host net) |
| Despliegue | Pipeline existente: imagen `vp/vp-advisor` arm64 → ECR → SSM |
| Salida en panel | El reporte global ES la vista "salud de la red" del panel admin |

---

## 3. Principio de diseño central

**Los números se calculan en Go (determinista); el LLM solo interpreta, prioriza y
recomienda.** Nunca se le pide al LLM calcular estadísticas (evita números alucinados).
El LLM recibe métricas ya computadas (pseudonimizadas) y devuelve narrativa + hallazgos
priorizados + recomendaciones, refiriéndose a afiliados por **token pseudónimo**.

---

## 4. Componentes (dentro de `vp-advisor`)

Unidades con responsabilidad única e interfaces claras:

1. **`collector`** — lee RDS (read-only) y arma el dataset crudo del árbol (estructura,
   payouts, ranks). Sin lógica de negocio, solo extracción eficiente.
2. **`metrics`** — calcula determinísticamente todas las métricas (estructura, comisiones,
   crecimiento) a partir del dataset. Reutiliza/comparte la lógica de forma de árbol de
   `vp-engine/internal/simulator` donde aplique. **Testeable con árboles fixture.**
3. **`pseudonymizer`** — mapea `affiliate_id` → token estable por reporte (p.ej. `A1..An`
   o hash salado); produce el payload para el LLM **sin PII**; guarda el mapa token→id
   server-side (en el reporte, nunca al LLM).
4. **`llm`** — cliente DeepSeek/OpenRouter: arma el prompt (rol: asesor MLM), envía el
   payload pseudonimizado, parsea la respuesta estructurada (narrativa + findings +
   recomendaciones). Timeout + reintentos + fallback model.
5. **`store`** — persiste/lee `advisor.report` (global) y `advisor.affiliate_report`
   (drill-down); incluye métricas, salida LLM, timestamp, mapa pseudónimo, estado.
6. **`api`** — HTTP, admin-only (ver §7). Handlers finos que orquestan los anteriores.
7. **`scheduler`** — dispara el reporte global diario (cron in-process configurable).

---

## 5. Modelo de datos (esquema `advisor`)

```sql
CREATE SCHEMA IF NOT EXISTS advisor;

-- Reporte global de salud de la red
CREATE TABLE advisor.report (
  id            bigserial PRIMARY KEY,
  generated_at  timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL,          -- 'ok' | 'metrics_only' (LLM caído) | 'failed'
  metrics       jsonb NOT NULL,         -- métricas deterministas
  llm_output    jsonb,                  -- narrativa + findings + recomendaciones (null si LLM caído)
  pseudo_map    jsonb NOT NULL,         -- token -> affiliate_id (server-side; NO se expone crudo al panel salvo para resolver)
  model         text,                   -- modelo LLM efectivo
  duration_ms   integer
);

-- Reporte drill-down por afiliado (cache)
CREATE TABLE advisor.affiliate_report (
  affiliate_id  bigint NOT NULL,
  generated_at  timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL,
  metrics       jsonb NOT NULL,
  llm_output    jsonb,
  model         text,
  PRIMARY KEY (affiliate_id, generated_at)
);
```
El rol de DB de `vp-advisor` tiene `SELECT` sobre `mlm.*`/payouts y `ALL` sobre `advisor.*`.

---

## 6. Privacidad (Ley 1581 / habeas data)

- **Ningún dato personal sale a DeepSeek/OpenRouter.** El payload al LLM contiene solo
  tokens pseudónimos + métricas + ranks/categorías. Nombres, emails, documento y datos de
  contacto/pago **nunca** se envían.
- El **panel admin resuelve token→nombre localmente** (consultando `mlm.*` o el `pseudo_map`
  vía un endpoint server-side que sí está dentro del perímetro de la empresa).
- Diseñado para poder migrar a un LLM auto-hospedado en el futuro sin cambiar el resto.

---

## 7. API (contrato para el panel admin)

Todas admin-only. Auth: token de servicio entre panel y advisor + red privada (no expuesto
a internet). (El mecanismo exacto se decide en el plan; default: header `Authorization: Bearer <token>` validado contra un secreto en Parameter Store.)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | liveness |
| GET | `/reports/latest` | último reporte global (salud de la red) |
| POST | `/reports/refresh` | dispara recálculo global (async; devuelve id/estado) |
| GET | `/affiliates/{id}/report` | último drill-down de un afiliado |
| POST | `/affiliates/{id}/analyze` | dispara drill-down de un afiliado |

Respuesta: `metrics` (números deterministas) + `llm_output` (narrativa/findings/recs) +
`generated_at` + `status` + `pseudo_map` (token→affiliate_id). Los findings referencian
afiliados por token; **como el panel es interno/confiable**, la API le entrega el `pseudo_map`
y el panel resuelve token→affiliate_id→nombre contra `mlm.*`. La protección de PII aplica
**solo al LLM**: ni el payload ni el `pseudo_map` salen jamás a DeepSeek/OpenRouter.

---

## 8. Flujo de datos (global, programado)

```
scheduler (diario)
  → collector lee RDS (read-only)
  → metrics (Go, determinista)
  → pseudonymizer (quita PII, asigna tokens)
  → llm (DeepSeek vía OpenRouter: interpreta + recomienda)   [si falla -> status=metrics_only]
  → store.report (métricas + salida LLM + pseudo_map)
panel admin: GET /reports/latest → muestra "salud de la red" (resuelve tokens→nombres localmente)
```
Drill-down: igual pero acotado al subárbol del afiliado, vía `POST /affiliates/{id}/analyze`.

---

## 9. Manejo de errores
- LLM timeout/error → guardar reporte con `status='metrics_only'` (las métricas solas ya
  son útiles) + reintentos con backoff + modelo de fallback.
- DB read error → fallar el run, no escribir reporte parcial corrupto; loguear.
- El scheduler nunca solapa runs (lock/`concurrency`).

---

## 10. Despliegue (reusa el pipeline CI/CD)
- Añadir `vp/vp-advisor` al matrix de `.github/workflows/build.yml` (Go, imagen scratch arm64).
- Secretos en SSM `/vicionpower/prod/vp-advisor/` (DATABASE_URL read-only, OPENROUTER_KEY,
  modelo, token de servicio del API).
- Compose en server1 (host net) + entrada en el deploy (target server1).
- **Nota:** respeta la limitación per-host conocida del pipeline (ver `PLAYBOOK-AWS.md`).

---

## 11. Testing
- `metrics`: unit tests deterministas contra árboles fixture (generados con el simulador de
  vp-engine) — casos: balanceado, skew extremo, cadena, huérfanos.
- `pseudonymizer`: test que **falla si cualquier PII aparece** en el payload del LLM.
- `llm`: cliente con mock (sin llamar a OpenRouter en tests).
- `api`: tests de handlers (auth, formato de respuesta, estados).
- Integración: un run completo con LLM mockeado escribe un `advisor.report` válido.

---

## 12. Criterios de éxito
- El panel admin muestra una vista "salud de la red" con métricas + narrativa + recomendaciones.
- Reporte global se genera diario y bajo demanda; drill-down por afiliado a demanda.
- **Cero PII** en cualquier payload a DeepSeek (verificado por test).
- Si DeepSeek está caído, el panel igual muestra métricas (`status=metrics_only`).
- Los números los calcula el servicio (no el LLM); el LLM solo interpreta.
- Desplegado por el pipeline existente (imagen en ECR, deploy por SSM).
