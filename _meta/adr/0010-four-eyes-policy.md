# 0010 — Política de cuatro ojos para operaciones sensibles

**Status:** Accepted
**Date:** 2026-04-28
**Deciders:** equipo VicionPower (devfidubit)

## Context

El audit de `_meta/credito_audit.out` reveló que en el sistema legacy:

- 35 operadores + 5 administradores generaron $348M en concepto 16 sin workflow de aprobación visible.
- 12 mega-transacciones ≥ $1M (sumando $93.5M) fueron creadas por humanos sin segundo aprobador.
- No hay separation of duties — el mismo admin puede crear y ejecutar la operación.

Para fintech regulado (SARLAFT requirement, ISO 27001 control A.6.1.2 segregation of duties, COSO framework) esto es un agujero crítico. La nueva arquitectura debe cerrarlo en código + DB, no por confianza en procedimiento humano.

Restricciones:
- **No bloquear operaciones rutinarias** de bajo monto donde 2-eyes es overhead absurdo.
- **Imposibilitar bypass** vía DB direct edit — el control debe estar en DB, no solo en app.
- **Auditable:** cada aprobación debe quedar trazada con timestamp, aprobador, razón.
- **Workflow asíncrono:** initiator y approver pueden operar en momentos distintos (no requiere ambos online simultáneo).

## Decision

**Doble dimensión de control: por monto + por tipo de operación.**

### Por monto (manual_adjustment, reversal, withdrawal aprovecho)

| Monto USD | Aprobadores requeridos | Cooling-off | Notificación adicional |
|---|---|---|---|
| < $100 | 1 admin (razón obligatoria) | — | — |
| $100 – $1,000 | 1 admin + razón obligatoria | — | Supervisor (digest diario) |
| $1,000 – $10,000 | **2 admins distintos** | — | Finance lead (real-time) |
| $10,000 – $100,000 | 2 admins distintos | — | CFO (real-time) |
| > $100,000 | 3 admins distintos | **24h obligatorio** | CFO + CEO + auditor externo |

### Por tipo de operación (independiente del monto, siempre 2-ojos)

Las siguientes requieren 2 admins distintos por su naturaleza, sin importar monto:

- Promover persona a `is_admin = true`
- Remover de blacklist (`person.blacklisted = false`)
- KYC manual override (aprobar después de rechazo automático del provider)
- Tree relocation (`mlm.fn_move_affiliate`)
- Cambios al catálogo `mlm.concept` (alta, baja, modificación de `factor`/`requires_pair`)
- Whitelist de wallet crypto destinatario en withdrawal
- Bulk operation sobre > 10 afiliados (script ops)
- DDL en producción (cualquier CREATE/ALTER/DROP)
- Rotación de `BETTER_AUTH_SECRET` o `PII_ENCRYPTION_KEY`

### Estructura del workflow

Tabla `mlm.approval_request`:
```
id, operation_type, payload (jsonb), requires_n_approvers,
status (pending|approved|rejected|expired|executed),
initiator_person_id, initiator_reason,
approver_1_person_id, approver_1_at, approver_1_reason,
approver_2_person_id, approver_2_at, approver_2_reason,
approver_3_person_id, approver_3_at, approver_3_reason,
created_at, expires_at (default: created_at + 24h),
executed_at, executed_txn_id (uuid de la transaction si aplica)
```

**Estados:**
- `pending` — esperando aprobaciones; expira en 24h si no se completa.
- `approved` — todos los aprobadores requeridos firmaron; listo para ejecutar.
- `rejected` — cualquier aprobador rechazó; no se ejecuta nunca.
- `expired` — venció ventana de 24h sin completar.
- `executed` — ejecutado; payload aplicado al sistema.

**Constraints DB-enforced:**
- `CHECK (initiator_person_id <> approver_1_person_id)`
- `CHECK (approver_1_person_id <> approver_2_person_id)` cuando `requires_n_approvers >= 2`.
- Trigger valida que solo `is_admin = true` pueden firmar.
- Trigger valida `status` transitions legales (`pending → approved | rejected | expired`; `approved → executed`).

### Implementación

- Endpoint `POST /api/admin/approvals` crea request con `status='pending'`.
- Notificación email + in-app a admins según `operation_type` (definido en config).
- Endpoint `POST /api/admin/approvals/:id/sign` para aprobar/rechazar.
- Cuando alcanza `requires_n_approvers`, status → `approved`.
- Worker en `vp-engine` consume queue `approvals.approved` y ejecuta el payload (e.g., crea la `mlm.transaction`, ejecuta el `manual_adjustment`).
- Daily digest a finance/compliance con todas las aprobaciones del día.

### Excepciones explícitas

- **Operaciones automáticas** (`roi_daily_run`, `binary_bonus_run`, etc.) no requieren aprobación humana — su autorización es el ADR + el código revisado en CI.
- **Self-service del afiliado** (signup, package purchase, withdrawal request) no requiere aprobación humana mientras el monto/tipo no toque thresholds. La aprobación de retiro a partir de monto X sí requiere admin.

## Consequences

### Positivas

- **Cierra el agujero del sistema legacy.** Imposible que un admin genere $1M en `manual_adjustment` solo. La DB rechaza el INSERT si no hay `approval_request` ejecutado.
- **Auditable end-to-end.** `audit.activity_log` + `approval_request` permiten reconstruir cualquier decisión: quién pidió, quién firmó, cuándo, por qué.
- **Cumple ISO 27001 / COSO** segregation of duties.
- **Cooling-off para mega-ops** previene errores impulsivos en montos catastróficos.
- **Self-service del afiliado intacto.** Operaciones rutinarias del usuario final no son afectadas.

### Negativas

- **Latencia en operaciones grandes.** $10k+ ahora requiere 2 admins coordinándose; típicamente 1-4 horas de espera. Mitigación: documentación clara para admins de qué requiere cuántas firmas.
- **Riesgo de bottleneck si admin senior está fuera.** Si solo hay 2 admins y uno está en vacaciones, las operaciones $100k+ paran. Mitigación: definir mínimo 4 admins activos, escalado a directores en escenarios excepcionales.
- **Complejidad de UX para admins.** El backoffice debe mostrar bandeja de aprobaciones, contexto de cada request, historial. Trabajo de frontend extra.
- **Cooling-off de 24h** en ops > $100k bloquea decisiones urgentes. Acepted: si una operación de $100k+ es legítima, esperar 1 día no la mata; si no es legítima, mejor que esperemos.

### Neutras

- Workflow es agnóstico al lenguaje; vive en `vp-api` (TS) primary; `vp-engine` (Go) consume el queue post-aprobación.
- Approval requests expiran en 24h por defecto; configurable per `operation_type` si algún caso requiere window distinto.

## Alternatives considered

### Sin aprobación formal (status quo legacy)

**Rechazado.** Es el problema que motivó esta ADR. Compliance + audit imposible.

### Aprobación de TODAS las operaciones admin

**Rechazado.** UX inviable. Cambiar el nombre de un afiliado o rechazar un KYC obvio no requiere 2 ojos. Bloquearía operaciones rutinarias y los admins terminarían firmando todo sin leer (ritual, no control).

### Solo aprobación por monto, sin contemplar tipo de operación

**Rechazado.** "Promover a admin" o "remover de blacklist" no tienen monto pero son críticos. Solo umbral monetario deja agujeros.

### Solo aprobación por tipo, sin umbral monetario

**Rechazado.** Un `manual_adjustment` de $50 y uno de $50,000 tienen riesgos muy distintos. Misma fricción para ambos resulta en rituales.

### Aprobación post-hoc (admin actúa, alguien revisa después)

**Rechazado.** Ya el pago salió. Para fintech con dinero real moviéndose, post-hoc es perder la pelea.

### Aprobación delegada a sistema (rules-engine sin humano)

**Considerado parcialmente.** Buen complement para detección de patrones sospechosos (e.g., flag automático si admin X aprueba > $100k en un día), pero no reemplaza el cuatro-ojos humano para decisiones financieras grandes. Implementable como Fase 4 (hardening).

### Hardware tokens / MFA físico para operaciones críticas

**Considerado, aplazado.** Yubikey o similar para confirmar operaciones > $X agrega capa anti-phishing. No bloqueante para v1 pero recomendable cuando volumen lo justifique.

## References

- `_meta/schema_governance.sql` — DDL de `mlm.approval_request` con triggers y constraints.
- ADR 0001 — Postgres con triggers para enforcement.
- ADR 0009 — retention de `approval_request` (parte de audit, 5 años).
- `_meta/credito_audit.out` — el problema histórico que motivó esta ADR.
- ISO 27001 control A.6.1.2: segregation of duties.
- COSO Internal Control Framework: https://www.coso.org/
- SARLAFT (Sistema de Administración del Riesgo de LA/FT en Colombia): https://www.uiaf.gov.co/
