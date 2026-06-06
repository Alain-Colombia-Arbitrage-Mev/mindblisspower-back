# notifications

Emails transaccionales + notificaciones in-app.

**Mecánica:**
- Cada módulo emite eventos; `notifications` escucha y enruta.
- `notifications.send_email(template, to, data)` usa Resend.
- `notifications.send_inapp(personId, type, payload)` inserta en tabla `notification`.

**Templates:** `templates/*.tsx` (JSX → react-email → HTML).

**Eventos consumidos:**
- `identity.signed_up` → email de bienvenida + verificación
- `identity.kyc_approved/rejected` → email correspondiente
- `withdrawals.approved` → email "tu retiro fue aprobado"
- `payouts.payout_recorded` (opcional, agregar a digest semanal)
- `tree.affiliate_placed` (cuando alguien se registra bajo el afiliado)

**Pendientes:**
- [ ] Decidir provider transaccional (Resend ya integrado en `auth.ts`).
- [ ] Decidir provider marketing (Loops / Mailgun) — separado de transaccional.
- [ ] Templates react-email para los 5-7 eventos críticos de fase 1.
- [ ] Tabla `notification` migrada del legacy.
