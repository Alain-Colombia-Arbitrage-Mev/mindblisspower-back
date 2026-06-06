# identity

Registro, login, KYC, roles, sesiones.

**Estado:** parcialmente implementado en `src/auth.ts` y `src/server/affiliate.ts:createPersonFromUser`. Falta extraer a este módulo + agregar KYC.

**Tablas owned:** `auth.user` (vía Better Auth), `mlm.person`.

**Endpoints:**
- `POST /api/auth/*` — Better Auth
- `GET  /api/me`
- `PUT  /api/me/profile`
- `POST /api/me/kyc/upload` (presigned URL → Storage Box)
- `GET  /api/me/kyc/status`
- `POST /api/admin/kyc/:personId/review`

**Eventos emitidos:** `identity.signed_up`, `identity.kyc_approved`, `identity.kyc_rejected`.

**Dependencias:** `notifications` (escucha eventos para emails), Storage Box S3 client.

**Pendientes:**
- [ ] Definir provider KYC (Truora / Sumsub / Onfido / manual). Ver BACKEND_PLAN §13.
- [ ] Mover `createPersonFromUser` desde `server/affiliate.ts`.
- [ ] Endpoint de KYC upload con presigned URL.
- [ ] Middleware `requireAdmin` para `/api/admin/*`.
- [ ] Encriptación de SSN/documentos en `mlm.person.ssn_encrypted` con `pgcrypto`.
