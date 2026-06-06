# withdrawals

Solicitud → aprobación → pago.

**Tablas owned:** `mlm.withdrawal_request`, `mlm.money_account`.

**Estados:** `requested → approved → paid` o `requested → rejected → cancelled`.

**Endpoints:**
- `POST /api/me/withdrawals` — crear solicitud
- `GET  /api/me/withdrawals` — historial
- `GET  /api/admin/withdrawals/queue`
- `POST /api/admin/withdrawals/:id/approve`
- `POST /api/admin/withdrawals/:id/reject`
- `POST /api/admin/withdrawals/:id/mark-paid`

**Invariantes:**
- Crear solicitud hace `postTransaction` con `withdrawal_pending` (debit del wallet, credit a "withdrawal_holding"). Saldo retirable se reduce inmediatamente.
- Rechazo reversa la retención.
- Aprobación + pago confirma como salida real.
- Imposible aprobar si KYC no aprobado o blacklist activa.

**Pendientes:** parte de fase 1 (MVP cutover). Implementar después de `ledger`.
