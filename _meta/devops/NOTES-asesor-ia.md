# Pendiente: Asesor IA del árbol binario MLM (feature)

> A diseñar DESPUÉS de terminar el pipeline CI/CD Fase 1. Requiere brainstorming/spec propio.

## Qué es
Un asesor de IA que evalúa la salud del árbol binario / MLM de VicionPower y reporta los
hallazgos en el **panel administrativo**.

## Alcance (confirmado por el usuario 2026-06-17)
- ✅ Sanidad estructural del árbol binario (balance piernas izq/der, profundidad, nodos
  huérfanos/desbalanceados, posiciones vacías, integridad padre-hijo).
- ✅ Salud de comisiones/MLM (bonos binarios, derrame/spillover, puntos por pierna, capping,
  anomalías en pagos/ROI).
- ✅ Recomendaciones de crecimiento (dónde colocar referidos, qué piernas reforzar, alertas
  proactivas para el admin).
- ❌ Detección de fraude/anomalías — NO en este alcance (por ahora).

## Restricciones técnicas
- Modelo: **DeepSeek v4 Pro vía OpenRouter** (económico). Ya existe `OPENROUTER_KEY` en .env.local.
- Usar **context7** para mantener librerías/SDK actualizadas de forma segura.
- Salida/visualización: **panel administrativo**.
- Datos: el árbol vive en Postgres (RDS). Ver `_meta/migration/` (esquema MLM, payments, cd_roi_grants).
