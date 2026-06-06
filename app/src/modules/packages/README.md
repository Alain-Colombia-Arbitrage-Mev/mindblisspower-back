# packages

Catálogo, compras, renovaciones, crédito de PV.

**Tablas owned:** `mlm.package`, `mlm.affiliate_package`.

**Endpoints:**
- `GET  /api/packages` — catálogo activo
- `POST /api/packages/:id/purchase` — inicia compra; devuelve `payment_intent`
- `POST /api/packages/:id/renew`
- `GET  /api/me/packages` — paquetes míos
- `POST /api/admin/packages` — CRUD de catálogo

**Servicios:**
- `initPurchase(affiliateId, packageId)` — crea `affiliate_package` en `pending_payment`.
- `activatePackage(affiliatePackageId, transactionId)` — al confirmar pago.
- `processRenewals()` — job diario.

**Eventos:**
- Emite: `packages.purchase_initiated`, `packages.purchased`, `packages.expired`, `packages.renewed`.
- Escucha: `payments.confirmed` → activar paquete.

**Pendientes:** todo. Empezar después de fase 1 (cutover).
