# admin

Backoffice operativo.

**Endpoints:**
- `GET  /api/admin/dashboard`
- `GET  /api/admin/users`
- `POST /api/admin/manual-adjustment` — concept `manual_adjustment` con razón obligatoria
- `GET  /api/admin/audit-log?entity=...&from=...`

**Invariantes:**
- Todo endpoint admin valida `is_admin=true` Y registra en `audit.activity_log` antes de responder.
- `manual_adjustment` requiere `comment` no vacío + `approved_by_person_id`.
- **Cuatro-ojos** opcional > umbral (sugerido $1,000 USD): dos admins distintos deben aprobar.

**Pendientes:**
- [ ] Middleware `requireAdmin` (compartido con `identity`).
- [ ] Wrapper de auditoría que escribe `audit.activity_log` automáticamente.
- [ ] Política de cuatro-ojos (BACKEND_PLAN §13.8).
