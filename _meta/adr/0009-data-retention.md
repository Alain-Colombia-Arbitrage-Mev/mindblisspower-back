# 0009 — Política de retención de datos

**Status:** Accepted
**Date:** 2026-04-28
**Deciders:** equipo VicionPower (devfidubit)

## Context

VicionPower opera bajo jurisdicción colombiana (Habeas Data — Ley 1581 de 2012, Decreto 1377 de 2013) y maneja datos financieros (DIAN, regulación de cooperativas/multinivel, UIAF SARLAFT). Las obligaciones son contradictorias por dato:

- **PII (datos personales):** retener solo lo necesario; sujeto puede pedir borrado.
- **Datos contables/financieros:** **mantener mínimo 10 años** (DIAN libros contables, art. 60 Código de Comercio).
- **AML/KYC:** **mantener mínimo 5 años** post-última-relación (UIAF SARLAFT).
- **Logs de auditoría:** Habeas Data acepta hasta lo que el responsable necesite probar cumplimiento.

Una "retención global de N años para todo" o falla en lo legal (muy corto) o expone PII innecesariamente (muy largo). Se requiere política tiered.

Además: el sistema actual no tiene política — los datos viven indefinidamente. Migrar a Postgres es la oportunidad de implementar correctamente.

## Decision

**Política tiered con anonimización (no delete) para PII después del término retención + delete físico para logs operacionales.**

### Tabla de retención por tipo de dato

| Tipo de dato | Retención | Acción al vencer | Razón legal |
|---|---|---|---|
| `mlm.person` (PII completo) | 5 años post-última-actividad | **Anonimizar** (no delete) | Habeas Data + UIAF |
| `mlm.person.ssn_encrypted` y KYC docs en Storage Box | 5 años post-última-actividad | Delete físico | Habeas Data minimization |
| `mlm.wallet_movement` + `mlm.transaction` | **10 años** | Mantener (cold/comprimido) | DIAN + Código Comercio art. 60 |
| `mlm.tree_event` + `bonus_run_payout` | 10 años | Mantener | Reconciliación + auditoría |
| `audit.activity_log` | 5 años | Delete (TimescaleDB retention) | Habeas Data |
| `auth.session` expiradas | 90 días | Delete | Sin requirement legal |
| Notification log | 1 año | Delete | Customer service operativo |
| Marketing/consent records | Hasta opt-out + 1 año | Delete | Soporte de re-consent |
| Backups pgbackrest | 4 fulls semanales + 12 monthly fulls | Rotación automática | Compromiso RPO/costo |
| KYC documents en Storage Box | 5 años post-última-actividad | Delete | Habeas Data minimization |
| Email bounces/complaints | 2 años | Delete | Deliverability hygiene |

### Anonimización vs delete

`mlm.person` **no se borra físicamente**. Se ejecuta `mlm.fn_anonymize_person(person_id)` que:
- Reemplaza `first_name`, `last_name`, `alias`, `email`, `phone_number` con valores deterministas tipo `'ANON-' || hash(person_id, salt)`.
- NULLifica `ssn_encrypted`, `birthday`, `phone_country_id`, `birth_country_id`.
- Mantiene `id`, `legacy_id_person`, `created_at`, `status='deleted'`.
- Rompe la relación con `auth.user` (set `user_id = NULL`).
- Borra física en Storage Box los KYC documents asociados.

**Razón:** los descendientes en el árbol siguen referenciando al person via `affiliate.person_id`. Borrar físicamente rompe el árbol. Anonimizar mantiene la integridad referencial pero elimina la PII identificable.

### Right to be forgotten

Tabla `mlm.data_subject_request` registra solicitudes de borrado. Workflow:
1. Usuario solicita borrado vía endpoint `POST /api/me/data-subject-request`.
2. Se crea row con `status='pending'`, type='deletion'.
3. Compliance review manual: si tiene obligaciones financieras pendientes (saldos, retiros pendientes, paquetes activos), se rechaza con razón hasta resolverlos.
4. Si aprobado y no hay obligaciones, ejecutar anonimización inmediata + delete de KYC docs.
5. Notificar al sujeto la confirmación.

Habeas Data permite rechazar borrado cuando hay "deber legal o contractual" — las obligaciones financieras de un MLM activo califican.

### Implementación técnica

- **TimescaleDB retention policy** ya configurada en `audit.activity_log` (5 años) — `_meta/migration/05_timescaledb.sql`.
- **Job scheduled mensual** (NATS scheduled o gocron en `vp-engine`) que:
  - Identifica `person.id` con `updated_at < now() - interval '5 years'` AND no afiliado activo en árbol.
  - Llama `mlm.fn_anonymize_person(id)` para cada uno.
  - Borra KYC docs correspondientes en Storage Box.
  - Logs en `audit.activity_log` cada anonimización.
- **TimescaleDB compression** ya activa para `wallet_movement` (>30d) y `tree_event` (>60d) — los datos de 10 años caben en disco gracias a compresión columnar 90-95%.
- **No retention policy** sobre `wallet_movement` ni `tree_event` — esos son legal records, no se tocan.

## Consequences

### Positivas

- **Cumplimiento Habeas Data + DIAN simultáneo.** Cada dato tiene política específica que satisface la regulación que aplica.
- **Anonimización preserva el árbol.** Operacionalmente no rompemos el sistema borrando un person — solo desaparece la PII.
- **Compresión TimescaleDB hace viable retención larga.** 10 años de movimientos comprimidos cabe en costos manejables (estimado <50 GB para escenarios típicos).
- **Right to be forgotten implementado** con balance entre derecho del sujeto y obligaciones del responsable.
- **Auditable:** cada anonimización queda en `audit.activity_log`; un regulador puede ver cuándo y por qué se borró cada dato.

### Negativas

- **Anonimización irreversible.** Si por error anonimizamos un activo, no hay vuelta atrás (los datos están perdidos). Mitigación: backups pgbackrest mantienen 12 meses de fulls; recover desde snapshot pre-anonimización es posible dentro de ese window.
- **Trabajo manual en data subject requests.** Cada solicitud requires review humano (verificar obligaciones pendientes). A volumen alto (>10/mes), considerar workflow tooling.
- **Storage cost de 10 años** de wallet_movement crece linealmente. Mitigación: TimescaleDB compression + tiered storage si crecemos a TB.
- **Definición de "última actividad" no es trivial.** Para `person`, ¿es el último login? ¿la última transacción? ¿la última KYC update? Decisión: el más reciente entre `updated_at` de `person`, `affiliate`, y `wallet_movement.posted_at` del afiliado vinculado. Documentado en función SQL.

### Neutras

- TimescaleDB retention policy de 5 años en `audit.activity_log` ya estaba implementada — esta ADR formaliza el racional.
- Backup retention (`pgbackrest`) es separado de retention de datos en DB. Backups pueden tener PII de personas ya anonimizadas en producción — eso es aceptable porque backups solo se restauran en emergencias y bajo control de compliance.

## Alternatives considered

### "Mantener todo para siempre"

**Rechazado.** Exposición legal innecesaria. Habeas Data Colombia exige minimización. Multas de la SIC pueden llegar a 2,000 SMMLV (~$2,5M USD).

### "Borrar todo a 5 años, parejo"

**Rechazado.** Viola obligación de DIAN de 10 años para libros contables. Multa por destrucción prematura de información contable es agravante.

### "Single retention global, el más largo (10 años)"

**Rechazado.** 10 años de PII es exposición innecesaria. Si nos hackean en año 7, comprometemos datos personales que ya no necesitábamos.

### Delete físico de `mlm.person` después de retención

**Rechazado.** Rompe el árbol binario (FK desde `affiliate.person_id`). La integridad histórica del árbol es valor de negocio que perdemos. Anonimización preserva integridad sin guardar PII.

### Hard delete con cascada al árbol

**Rechazado.** Imposible — los descendientes en el árbol heredaron posición de un afiliado borrado. Al borrar al ancestro, los descendientes quedan huérfanos. El árbol pierde integridad.

### Encriptación a la "key shredding" (delete = perder la key)

**Considerado.** Cifrar PII con key per-person, "borrar" = borrar la key. Más seguro técnicamente. Perdió por:
- Complejidad operacional (key management de millones de keys).
- Performance (overhead cifrado en queries).
- Backups deben cubrir keys también, lo que reintroduce el problema.

Útil para PII extremadamente sensible (e.g., datos de salud). Para nuestro caso, anonimización determinista es suficiente.

## References

- `_meta/schema_governance.sql` — DDL de `mlm.data_subject_request` y función `fn_anonymize_person`.
- `_meta/migration/05_timescaledb.sql` — retention policy de `audit.activity_log`.
- `_meta/schema_mlm.sql` — schema base con `mlm.person`.
- ADR 0001 — Postgres + TimescaleDB.
- Ley 1581 de 2012 (Habeas Data Colombia): https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=49981
- Decreto 1377 de 2013 (reglamenta Habeas Data): https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=53646
- DIAN art. 60 Código de Comercio (10 años libros contables): https://www.dian.gov.co/normatividad/codigos
- UIAF SARLAFT: https://www.uiaf.gov.co/
- SIC sanciones por habeas data: https://www.sic.gov.co/
