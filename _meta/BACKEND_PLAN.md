# VicionPower — Plan de construcción del backend

**Fecha:** 2026-04-28
**Estado actual:** schema Postgres listo, Better Auth + Drizzle esqueleto en `app/`, infra Hetzner documentada. **No existe backend de producción todavía** — toca construirlo desde el esqueleto.
**Audiencia:** quien ejecute o supervise la implementación.

---

## 1. Objetivos y no-objetivos

### Objetivos

1. Reemplazar SQL Server + (lo que sea que existía antes) con un backend nuevo en Bun/TypeScript que:
   - opera sobre el schema `mlm.*` definido en `_meta/schema_mlm.sql`,
   - mantiene los invariantes (idempotencia, doble-entrada, árbol consistente) en código y en DB,
   - es testeable, observable, y escalable a 100k+ afiliados activos sin reescribir.
2. Permitir cutover desde la base legacy con **paridad funcional mínima** para usuarios finales (ver/operar saldos, retirar, ver red), antes de añadir features nuevas.
3. Dejar ramas de extensión claras para el motor de bonos (ROI, binario, liderazgo) que es el corazón del sistema.

### No-objetivos

- **No** microservicios todavía. Modular monolith. Solo extraer servicios cuando un módulo tenga 1 razón clara para escalar/desplegar independientemente.
- **No** GraphQL. REST + JSON. Los consumidores son la app web propia y eventualmente la móvil; ambas controladas por nosotros, no necesitamos la flexibilidad ni el costo operativo de GraphQL.
- **No** event sourcing global. El árbol y el ledger ya son event-sourced en DB (`tree_event`, `wallet_movement` con `transaction.external_ref`). No necesitamos añadir Kafka/EventBridge encima.
- **No** Kubernetes. systemd + Docker en VMs Hetzner. K8s tiene sentido a partir de ~50 servicios o 20 ingenieros.

---

## 2. Arquitectura

### Modular monolith con dominio claro

```
app/
├── src/
│   ├── server.ts                # entry HTTP (Hono)
│   ├── worker.ts                # entry workers BullMQ (proceso aparte)
│   ├── auth.ts                  # Better Auth config (existente)
│   ├── db/
│   │   ├── client.ts            # postgres pool (existente)
│   │   └── schema/              # Drizzle schemas (existente)
│   ├── modules/
│   │   ├── identity/            # person, KYC, roles
│   │   ├── tree/                # affiliate placement, traversal, ranks
│   │   ├── ledger/              # wallet, transaction, movement
│   │   ├── packages/            # catálogo + compras + renovaciones
│   │   ├── payouts/             # motor de bonos (ROI, binario, liderazgo, directo)
│   │   ├── withdrawals/         # solicitudes + aprobación + pago
│   │   ├── payments/            # crypto + bancos + tarjetas (entrada de dinero)
│   │   ├── admin/               # operaciones backoffice
│   │   ├── notifications/       # email + in-app + (futuro) push
│   │   └── reporting/           # dashboards + exports
│   ├── shared/
│   │   ├── http/                # middleware, error handler, OpenAPI
│   │   ├── queue/               # BullMQ wrapper, idempotency keys
│   │   ├── crypto/              # pgcrypto helpers, age, password hashing
│   │   ├── audit/               # writer to audit.activity_log
│   │   ├── observability/       # OTel, structured logging
│   │   └── validation/          # zod schemas reusables
│   └── tests/
│       ├── integration/
│       └── e2e/
```

### Cada módulo tiene la misma forma

```
modules/<dominio>/
├── api.ts           # handlers HTTP (Hono routes)
├── service.ts       # lógica de negocio, sin Hono ni HTTP
├── repository.ts    # queries Drizzle/SQL — única capa que toca db
├── validators.ts    # zod schemas para input/output
├── jobs.ts          # workers BullMQ específicos del dominio
├── events.ts        # eventos internos que el módulo emite/escucha
└── README.md        # qué hace, invariantes, entradas/salidas
```

**Regla:** un módulo solo importa de `shared/*` y de otros módulos vía `events.ts`. Nunca un módulo lee la DB de otro directamente. Esto preserva la opción de extraer un módulo a su propio servicio en el futuro.

### Dependencias entre módulos (grafo)

```
   identity ←─── (todo)
       │
       ↓
     tree ←─── packages, payouts
       │           ↑
       ↓           │
    ledger ←──────┘
       ↑
       │
  withdrawals ──→ payments
       ↓
   admin (puede tocar todos vía service.ts; nunca repository.ts)
```

`identity` es la base. `tree` y `ledger` son los dos pilares. `payouts` es el módulo más complejo (motor de bonos) y consume de los tres.

---

## 3. Catálogo de módulos

### 3.1 `identity`

**Responsabilidad:** registro, login, KYC, roles, sesiones.

**Endpoints:**
- `POST /api/auth/*` — proxy a Better Auth (signup, signin, signout, OAuth callbacks).
- `GET  /api/me` — perfil del afiliado autenticado.
- `PUT  /api/me/profile` — actualizar nombre, teléfono, dirección.
- `POST /api/me/kyc/upload` — sube documentos a Storage Box (presigned URL).
- `GET  /api/me/kyc/status` — estado actual del KYC.
- `POST /api/admin/kyc/:personId/review` — aprobar/rechazar (rol admin).

**Eventos emitidos:** `identity.signed_up`, `identity.kyc_approved`, `identity.kyc_rejected`.

**Invariantes:**
- Cada `auth.user` tiene exactamente un `mlm.person` (creado por hook en `auth.ts`).
- KYC documents se cifran al subir; la metadata vive en `mlm.person`, los archivos en Storage Box.
- Rol `admin` requiere flag `person.is_admin = true` validado por middleware.

**Riesgos:**
- KYC requiere flujo síncrono con proveedor (Truora / Sumsub / Onfido). Decidir antes de empezar; cada uno tiene SDK distinto.
- PII en `person.ssn_encrypted` debe usar key rotativa. Documentar rotación en runbook.

---

### 3.2 `tree`

**Responsabilidad:** colocación en árbol binario, traversals, ranks.

**Endpoints:**
- `POST /api/tree/place` — coloca afiliado bajo (parent, position) (existente esqueleto en `server/affiliate.ts`).
- `GET  /api/tree/me/upline?levels=10` — sponsors hasta N niveles.
- `GET  /api/tree/me/downline?leg=L&depth=5` — descendientes por leg.
- `GET  /api/tree/:affiliateId/snapshot` — agregados (left/right counts, PV, carry).
- `POST /api/admin/tree/move` — reubicar afiliado (rol admin, **trigger fn_validate_move**).
- `GET  /api/tree/search?q=username` — buscar dentro de mi red.

**Servicios:**
- `placeAffiliate(personId, parentId, position, sponsorId)` — race-safe con `FOR UPDATE` (existente).
- `getUpline(affiliateId, depth)` — query con `path @> $1` ordenado por depth ASC.
- `getDownline(affiliateId, leg, depth)` — query con `path <@ $1 AND substring(...) = leg`.
- `recomputeAggregates(affiliateId)` — solo admin, fuerza recompute set-based desde `tree_event`.

**Eventos:**
- Escucha: `packages.purchased` → emite `tree.pv_credited`.
- Emite: `tree.affiliate_placed`, `tree.rank_advanced`.

**Invariantes:**
- `UNIQUE(parent_id, position)` en DB previene colocaciones duplicadas.
- Mover un afiliado recomputa path de todo su subárbol en una transacción.
- Aggregates son denormalizados pero auditables — `mlm.v_tree_pv_truth` debe dar drift = 0 siempre.

---

### 3.3 `ledger`

**Responsabilidad:** wallets, transacciones, movimientos. Ningún módulo escribe `wallet_movement` directamente excepto este.

**API interna (no HTTP):**
- `getWallet(affiliateId, assetId)` — devuelve balance materializado + último movimiento.
- `postTransaction({externalRef, description, movements[]})` — transacción atómica idempotente.
- `reverseTransaction(originalTxnId, reason)` — crea nueva transacción que netea la original.
- `getMovements(walletId, {from, to, page, limit})` — paginado por `posted_at`.

**Endpoints:**
- `GET /api/me/wallets` — balances actuales de todas mis wallets.
- `GET /api/me/movements?asset=USD&from=2026-01-01&page=1` — historial paginado.
- `GET /api/me/movements/:movementId` — detalle de un movimiento (incluye transaction y movements pareados).

**Eventos:**
- Emite: `ledger.transaction_posted`, `ledger.movement_recorded`.
- Escucha: `payouts.bonus_run_completed` → batch insert de movimientos.

**Invariantes:**
- Toda mutación va por `postTransaction`. La función exige `external_ref` único.
- Para conceptos `requires_pair=true`, el trigger valida que la suma sea cero al pasar a `posted`. Falla en runtime si no.
- `wallet.balance` se actualiza por trigger; reconciliación nocturna (`check-drift.sh`) detecta drift.

---

### 3.4 `packages`

**Responsabilidad:** catálogo, compras, renovaciones, PV.

**Endpoints:**
- `GET  /api/packages` — catálogo activo.
- `POST /api/packages/:id/purchase` — inicia compra; devuelve `payment_intent` (delegado a `payments`).
- `POST /api/packages/:id/renew` — renueva paquete activo.
- `GET  /api/me/packages` — paquetes míos (activos, expirados, pendientes).
- `POST /api/admin/packages` — CRUD de catálogo (rol admin).

**Servicios:**
- `initPurchase(affiliateId, packageId)` — crea `affiliate_package` en `pending_payment`, emite `packages.purchase_initiated`.
- `activatePackage(affiliatePackageId, transactionId)` — al confirmar pago, marca `active`, emite `packages.purchased` que `tree` consume para creditar PV.
- `processRenewals()` — job diario que detecta paquetes a expirar y procesa renovaciones automáticas.

**Eventos:**
- Emite: `packages.purchase_initiated`, `packages.purchased`, `packages.expired`, `packages.renewed`.
- Escucha: `payments.confirmed` → activar paquete.

---

### 3.5 `payouts` — el motor de bonos

**Responsabilidad:** ROI diario, bono binario, bono de liderazgo, bono directo. Es el módulo más complejo y crítico. Cada cálculo es un job idempotente con `external_ref`.

**Workers (BullMQ, no HTTP):**
- `roiDailyRun(date)` — distribuye ROI sobre paquetes activos (ver `mlm_binario_estabilidad.md` y `mlm_binario_margen_operativo.md` para fórmulas).
- `binaryBonusRun(date)` — cierra ciclo binario, calcula weak leg × pairing %, descuenta PV, paga.
- `leadershipBonusRun(month)` — bonos por rango.
- `directBonusOnPackagePurchase(affiliatePackageId)` — instantáneo al activar paquete del referido.

**Endpoints (admin/observability):**
- `POST /api/admin/payouts/run` — dispara un run manual (con `dryRun: true|false`).
- `GET  /api/admin/payouts/runs?kind=binary` — historial de runs.
- `GET  /api/admin/payouts/runs/:id/payouts` — detalle por afiliado.

**Patrón general de cada run:**
1. Crear `mlm.bonus_run` con `kind`, `run_date`, `parameters`, status `running`.
2. Calcular en una transacción set-based (no loops) los payouts.
3. Insertar en `bonus_run_payout` (read model inmutable).
4. Para cada payout, llamar `ledger.postTransaction({externalRef: 'roi:2026-04-28:<affId>', ...})`.
5. Emitir `payouts.bonus_run_completed` con totales.
6. Cerrar `bonus_run` con `closed_at`, `total_paid_usd`, `total_fee_usd` (margen operativo).

**Idempotencia:**
- `external_ref` por payout incluye fecha + tipo + afiliado.
- Si el run aborta a la mitad, re-correrlo es seguro: las transacciones ya posteadas detectan duplicado en `external_ref`.
- Tabla `bonus_run` con `UNIQUE(run_date, kind)` previene doble cálculo.

**Eventos:**
- Emite: `payouts.bonus_run_started`, `payouts.bonus_run_completed`, `payouts.payout_recorded`.

**Riesgos críticos:**
- **Fórmulas mal validadas = pérdida directa de dinero**. Cada fórmula debe tener test de propiedad: "para una red conocida, los payouts deben sumar al pool definido". Validar contra los docs `mlm_binario_*.md`.
- Concurrencia: dos runs del mismo tipo en la misma fecha deben ser imposibles (constraint en `bonus_run`).
- ROI corre a medianoche America/Bogota; el job debe tener tolerancia a fallo (BullMQ retries con exponential backoff + alerta si falla 3 veces).

---

### 3.6 `withdrawals`

**Responsabilidad:** solicitud → aprobación → pago.

**Endpoints:**
- `POST /api/me/withdrawals` — crear solicitud (valida saldo, KYC aprobado, no blacklist).
- `GET  /api/me/withdrawals` — historial.
- `GET  /api/admin/withdrawals/queue` — cola de aprobaciones pendientes.
- `POST /api/admin/withdrawals/:id/approve` — aprueba; encola pago.
- `POST /api/admin/withdrawals/:id/reject` — rechaza con razón; reembolsa al wallet.
- `POST /api/admin/withdrawals/:id/mark-paid` — marca como pagada (manual, después de transferir).

**Estados:** `requested → approved → paid` o `requested → rejected → cancelled`.

**Invariantes:**
- Al crear solicitud, se hace un `postTransaction` con `withdrawal_pending` (debit del wallet, credit a "withdrawal_holding"). El saldo retirable se reduce inmediatamente.
- Al rechazar, otra transacción reversa la retención.
- Al aprobar+pagar, la transacción de retención se confirma como salida real.
- Una solicitud nunca puede aprobarse si el afiliado tiene blacklist o KYC no aprobado.

---

### 3.7 `payments` (entrada)

**Responsabilidad:** recibir dinero (compras de paquete, depósitos).

**Sub-módulos:**
- `payments/wallet/` — integración con wallet API externo ([ADR 0014](adr/0014-external-wallet-api.md)). NO custodia keys, NO observa blockchain. Recibe webhooks del provider, los traduce a NATS events que `vp-engine.walletbridge` consume.
- `payments/bank/` — transferencia bancaria con comprobante; manual review en admin.
- `payments/card/` — **Stripe** ([ADR 0013](adr/0013-payment-processor-stripe.md)). Stripe Checkout hosted + webhook con firma HMAC.

**Patrón común:**
1. Cliente solicita iniciar pago → recibe `payment_intent_id` + instrucciones.
2. Pago llega (webhook Stripe o webhook wallet provider).
3. Webhook handler en `vp-api` valida firma, deduplica por `event.id`, publica NATS event `payments.confirmed`.
4. `vp-engine` consume y crea `mlm.transaction` con `external_ref='stripe:<event.id>'` o `'wallet:<tx_hash>'` (idempotencia DB-level).
5. Activa el `mlm.affiliate_package` correspondiente.

**Riesgos:**
- Webhooks deben ser idempotentes y verificar firma del proveedor (Stripe HMAC-SHA256, wallet provider varía).
- Reglas anti-fraude: límite por afiliado/día, alertas en montos atípicos. Stripe Radar cubre card fraud; wallet provider cubre crypto-side.
- Reconciliación nightly de saldos: `mlm.wallet.balance` interno vs. provider API balance. Drift > tolerancia → alerta P0.

---

### 3.8 `admin`

**Responsabilidad:** backoffice operativo.

**Endpoints:**
- `GET  /api/admin/dashboard` — métricas globales (afiliados activos, transacciones del día, drift).
- `GET  /api/admin/users` — buscar/listar personas.
- `POST /api/admin/manual-adjustment` — crea `transaction` con concept `manual_adjustment`. **Requiere razón obligatoria** y escribe `audit.activity_log`.
- `GET  /api/admin/audit-log?entity=...&from=...` — consulta de auditoría.

**Invariantes:**
- Todo endpoint admin valida `is_admin=true` Y registra en `audit.activity_log` antes de retornar.
- `manual_adjustment` no usa `requires_pair`, pero requiere `comment` y `approved_by_person_id` no null.
- Cuatro-ojos opcional para ajustes > umbral: dos admins distintos deben aprobar antes de que se postee.

---

### 3.9 `notifications`

**Responsabilidad:** emails transaccionales + notificaciones in-app.

**Mecánica:**
- Cada módulo emite eventos; `notifications` escucha y enruta.
- `notifications.send_email(template, to, data)` usa Resend.
- `notifications.send_inapp(personId, type, payload)` inserta en tabla `notification` (existe en schema legacy, migrar).
- Templates en `modules/notifications/templates/*.tsx` (JSX → react-email → HTML).

---

### 3.10 `reporting`

**Responsabilidad:** dashboards + exports + reportes fiscales.

**Endpoints:**
- `GET /api/me/dashboard` — KPIs personales (saldo, red, ganancias del mes).
- `GET /api/me/reports/earnings.csv?year=2026` — export para mi declaración.
- `GET /api/admin/reports/cohort?from=...&to=...` — análisis por cohorte.
- `GET /api/admin/reports/payouts.xlsx?run_id=...` — detalle de un bonus run.

**Implementación:** vistas materializadas en Postgres refresheadas nocturnamente para dashboards pesados. Exports streaming directo desde Postgres (sin cargar todo en memoria).

---

## 4. Stack tecnológico por capa

| Capa | Elección | Razón |
|---|---|---|
| Runtime | Bun 1.1+ | Velocidad, tooling nativo, package manager incluido |
| HTTP framework | Hono | Liviano, edge-friendly, type-safe; ya en `app/` |
| ORM | Drizzle | Schemas en TS, queries SQL-like, sin codegen pesado; ya en `app/` |
| Auth | Better Auth | Self-hosted, $0/MAU, OAuth + email + 2FA |
| Validación | Zod | Standard de facto en TS |
| Cola | BullMQ + Redis | ROI/binary runs, retries, scheduled jobs |
| Email | Resend + react-email | Templates JSX, deliverability decente |
| File storage | Hetzner Storage Box (S3-compatible vía MinIO) | KYC docs cifrados |
| Crypto wallet | bitcoinjs-lib + tronweb | USDT-TRC20 + BTC HD wallets |
| Pagos card | Mercado Pago SDK | Colombia es su mercado fuerte; PSE habilitado |
| Logs | pino + Loki (o Grafana Cloud free tier) | Structured JSON |
| Métricas | OpenTelemetry + Prometheus + Grafana | Estándar |
| Tests | Bun test (unit) + testcontainers (integration) + Playwright (e2e) | Sin frameworks adicionales |
| Lint/format | Biome | Reemplaza ESLint+Prettier, 30x más rápido |
| Type check | tsc --noEmit en CI | Bun no typechecks por sí solo |
| Container | Docker (Bun distroless) | ya en `app/Dockerfile` |
| Migraciones | DDL manual + `schema-guard` checksum | Drizzle migrations solo para auth tables |

---

## 5. Entrega por fases

### Fase 0 — Foundation (semanas 1-2)

**Meta:** todo lo que ya está documentado, ejecutado.

- [ ] Provisionar Hetzner según `_meta/devops/PLAYBOOK.md`.
- [ ] Aplicar `_meta/schema_mlm.sql` en Postgres.
- [ ] Correr `bun auth:migrate` para tablas Better Auth.
- [ ] CI/CD funcional con `schema-guard`.
- [ ] Esqueleto `app/` desplegado y respondiendo `/health`.
- [ ] sops + age con secrets reales en producción.
- [ ] `check-drift.sh` corriendo nocturno, reportando "no drift" (DB vacía → todo en cero, drift = 0).

**Definition of done:** `curl https://app.vicionpower.com/health` → `200 ok`. CI verde. Slack recibe "drift OK" cada noche.

---

### Fase 1 — MVP para cutover (semanas 3-6)

**Meta:** los usuarios existentes pueden hacer login, ver saldos, ver red, solicitar retiros. Nada más.

| Módulo | Entregables | Endpoints |
|---|---|---|
| identity | login, registro, recuperar contraseña, perfil | `/api/auth/*`, `/api/me`, `/api/me/profile` |
| tree | ver mi red, mi sponsor, mis directos | `/api/me`, `/api/tree/me/upline`, `/api/tree/me/downline` |
| ledger | ver saldos, ver historial | `/api/me/wallets`, `/api/me/movements` |
| withdrawals | solicitar, ver mis solicitudes | `/api/me/withdrawals`, `POST /api/me/withdrawals` |
| admin | aprobar retiros, KYC review | `/api/admin/withdrawals/*`, `/api/admin/kyc/*` |
| reporting | dashboard personal | `/api/me/dashboard` |

**No incluye:** compras de paquete, motor de bonos, pagos en línea. Usuarios siguen comprando paquetes por canal manual mientras tanto; ops crea `manual_adjustment` para registrar.

**Definition of done:**
- Migración de `viciongroup` (SQL Server) → Postgres ejecutada y reconciliada.
- 100 % de usuarios pueden hacer login con su contraseña migrada.
- Saldos y red coinciden con el sistema legacy (validación cruzada vs. reportes existentes).
- 50 retiros procesados sin incidente operativo.

---

### Fase 2 — Motor de bonos (semanas 7-10)

**Meta:** apagar el motor de bonos legacy y correr el nuevo en producción.

- [ ] `payouts/roi` — job diario; valida fórmula contra `mlm_binario_estabilidad.md`.
- [ ] `payouts/binary` — cierre de ciclo; valida margen operativo (`mlm_binario_margen_operativo.md`).
- [ ] `payouts/leadership` — mensual.
- [ ] `payouts/direct` — instantáneo al activar paquete del referido.
- [ ] Backoffice de `bonus_run`: dispara, supervisa, aprueba, reversa.
- [ ] Tests de propiedad: para una red conocida (fixture), los totales pagados deben coincidir con cálculo manual.
- [ ] Ejecución en sombra: 30 días corriendo en paralelo con el sistema legacy, comparando outputs. Cero divergencias antes de cutover.

**Riesgo principal:** divergencia con sistema legacy por mal entendimiento de las fórmulas. Mitigación: ejecución en sombra obligatoria.

**Definition of done:** 30 días en sombra con < 0.01 % drift por afiliado. Una vez cumplido, se desconecta el motor legacy y el nuevo es la fuente de verdad.

---

### Fase 3 — Pagos en línea (semanas 11-15)

**Meta:** los usuarios pueden comprar paquetes sin intervención humana.

- [ ] `packages/purchase` — flujo completo.
- [ ] `payments/crypto/usdt-trc20` — HD wallet, watcher, webhook interno.
- [ ] `payments/crypto/btc` — opcional según volumen.
- [ ] `payments/card/mercadopago` — checkout + webhook + reembolsos.
- [ ] `payments/bank` — comprobante manual con OCR opcional (Truora/AWS Textract).
- [ ] Reglas anti-fraude básicas: límite por afiliado/día, lista negra de wallets.

**Definition of done:**
- 100 compras procesadas sin intervención humana.
- < 1 % de pagos requieren reconciliación manual.
- Cero reportes de "pagué y no se activó mi paquete" durante 7 días seguidos.

---

### Fase 4 — Hardening continuo (siempre)

- Cobertura de tests > 70 % en lógica de negocio (modules/), > 90 % en `payouts` y `ledger`.
- Load test con k6: el sistema sostiene 500 transacciones/seg sustained sin degradación.
- Revisión de seguridad externa (pentest) antes de superar US$10M en transacciones mensuales.
- Compliance: implementar export de datos personales (Habeas Data Colombia, similar a GDPR).
- Monitoreo: SLO 99.9 % uptime, p95 < 200 ms en endpoints `/api/me/*`.

---

## 6. Convenciones de API

### REST

- `GET` para lectura idempotente.
- `POST` para crear o disparar acción no idempotente.
- `PUT` para reemplazo total; `PATCH` raramente, prefiero POST a sub-recurso.
- `DELETE` solo en recursos que el dueño tiene derecho a eliminar (ej. wallets nunca; sesión sí).

### Idempotencia

Todo `POST` que muta dinero o el árbol acepta header `Idempotency-Key`. El servidor:
1. Busca el key en una tabla `idempotency` (TTL 24h).
2. Si existe, devuelve la respuesta cacheada con mismo status code.
3. Si no, ejecuta y graba.

Esto cubre el caso del cliente reintentando por timeout.

### Errores

```json
{
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Wallet 1234 has 50.00 USD but withdrawal request was 100.00",
    "details": { "wallet_id": 1234, "balance": "50.00", "requested": "100.00" }
  }
}
```

Códigos en `SCREAMING_SNAKE`. Mensaje en inglés (logs); cliente traduce con i18n.

### Paginación

Cursor-based para historiales largos:
```
GET /api/me/movements?cursor=eyJpZCI6MTIzNDV9&limit=50
```
Retorna `{ data: [...], next_cursor: '...' | null }`.

### OpenAPI

Generar contrato OpenAPI desde zod schemas con `hono/zod-openapi`. Servir en `/api/docs` (solo en staging, no en prod).

---

## 7. Estrategia de testing

### Unit (Bun test)

- Cada `service.ts` tiene tests con DB mockeada (in-memory `pg-mem` o testcontainers).
- Validators, calculadoras de bonos, parseo de webhooks.
- Target: 80 % de cobertura en `modules/*/service.ts`.

### Integration (testcontainers)

- Spin up Postgres real con schema, ejecuta una secuencia de operaciones, valida estado final.
- Cobertura crítica: `placeAffiliate`, `postTransaction`, `roiDailyRun`, `binaryBonusRun`.

### E2E (Playwright)

- Flujos completos: signup → KYC → comprar paquete → ver red → solicitar retiro → admin aprueba → ver saldo final.
- Solo el "happy path" + 3-4 errores comunes. No exhaustivo.

### Property tests

- `payouts`: para árbol generado aleatoriamente con N afiliados y M paquetes, los payouts deben cumplir invariantes (suma = pool, ningún afiliado paga más PV del que tenía, etc.).
- Library: `fast-check`.

### Drift tests

- Job nocturno (`check-drift.sh`) ya cubre runtime.
- En CI: cargar fixture, correr ROI run, validar `v_wallet_balance_truth.drift = 0` y `v_tree_pv_truth = 0`.

---

## 8. Operations / runbooks que hay que escribir

Cada uno es un `.md` corto con pasos numerados:

- [ ] `runbook-cutover.md` — la migración (ya esbozado en `_meta/migration/PLAN.md`).
- [ ] `runbook-rollback.md` — qué hacer si la migración falla a las 02:30.
- [ ] `runbook-restore-drill.md` — drill trimestral de pgbackrest.
- [ ] `runbook-failover.md` — promover réplica si primary muere.
- [ ] `runbook-bonus-run-failed.md` — qué pasa si ROI/binary run aborta a la mitad.
- [ ] `runbook-drift-detected.md` — el `check-drift.sh` reportó drift; quién investiga, cómo.
- [ ] `runbook-payment-stuck.md` — pago confirmado en blockchain pero no activó paquete.
- [ ] `runbook-key-rotation.md` — rotar `BETTER_AUTH_SECRET`, `PII_ENCRYPTION_KEY`, age keys.
- [ ] `runbook-incident-response.md` — clasificación de severidad, on-call, comunicación.

---

## 9. Equipo y timeline

### Equipo mínimo viable

- **1 senior backend** (TS, Postgres, sistemas distribuidos): tech lead, owns architecture.
- **1 mid backend** (TS, ramping up en Postgres): paired con el senior.
- **1 DevOps part-time** (Hetzner, Postgres ops, observabilidad): 50 % tiempo.
- **1 QA**: desde fase 1, escribe tests E2E y valida cutover.

**Si solo hay 1 ingeniero:** doble el timeline. Realista: 6 meses para fase 1 cumplida con calidad.

### Timeline asumiendo 2 backend FT + 1 DevOps PT + 1 QA desde fase 1

| Fase | Duración | Hitos |
|---|---|---|
| 0 | 2 semanas | infra arriba, esqueleto desplegado |
| 1 | 4 semanas | cutover ejecutado, usuarios operativos |
| 2 | 4 semanas | motor de bonos en sombra |
| 2 cutover | 4 semanas (en paralelo con 3) | sombra → producción |
| 3 | 5 semanas | pagos en línea |
| 4 | continuo | hardening |

**Total a producción funcional completa: ~15 semanas (3.5 meses).**

---

## 10. Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Fórmulas de bonos mal entendidas | Pérdida de dinero directa | Ejecución en sombra 30d antes de cutover; tests de propiedad |
| Migración SQL Server → Postgres rompe datos | Cutover abortado, pérdida de confianza | Reconciliación obligatoria; rollback < 30 min |
| Webhooks de pagos no idempotentes | Doble crédito de paquetes | `external_ref` único + UNIQUE constraint en DB |
| KYC provider no integra como pensábamos | Bloquea fase 1 | Definir provider semana 1; tener fallback manual |
| Equipo subdimensionado | Fechas se mueven a la derecha | Honestidad con stakeholders; no aceptar fechas con < 30 % buffer |
| Concepto 16 legacy ($348M) tiene reglas no documentadas | Reportes históricos no cuadran | Marcar como `legacy_unpaired`; reportes nuevos parten de fase 1 |
| Crecimiento viral satura DB primary | Latencia en hot path | Réplica read-only + connection pooling; particionado mensual ya en schema |
| Compliance Colombia (Habeas Data, SFC) | Multas, bloqueo | Asesoría legal antes de fase 3 si involucra crypto |

---

## 11. Métricas de éxito

### Técnicas

- **Drift = 0** en `v_wallet_balance_truth` y `v_tree_pv_truth` durante 30 días seguidos.
- **p95 < 200 ms** en endpoints de lectura `/api/me/*`.
- **Zero downtime** durante cutover salvo la ventana planeada.
- **Cobertura de tests > 70 %** global, **> 90 %** en `payouts` + `ledger`.
- **MTTR < 1 hora** para incidentes P0.

### Negocio

- 100 % de usuarios legacy migrados con login funcional.
- < 1 % de tickets de soporte relacionados con saldo incorrecto post-cutover.
- 95 % de retiros aprobados pagados en < 24 horas.
- 0 incidentes de pérdida de dinero atribuibles al sistema (vs. fraude externo, que es separado).

---

## 12. Qué construir literalmente esta semana

Si arrancas mañana, semana 1 se ve así:

**Día 1-2:**
- Provisionar Hetzner (2× CCX23, 1× AX52, 1× CX22) según PLAYBOOK §2.
- Ejecutar `cloud-init/db.sh` en AX52, restaurar Postgres, aplicar `00-init.sql` y `schema_mlm.sql`.
- Subir `app/` a un repo Git, configurar GHA con secrets.

**Día 3:**
- Setup sops + age (todos los pubkeys ops y de hosts en `.sops.yaml`).
- Encriptar `production.enc.yaml` con secrets reales.
- Primer deploy del esqueleto. `/health` responde.

**Día 4:**
- Setup Cloudflare con DNS apuntando a LB.
- Setup Resend, dominio verificado.
- `bun auth:migrate` ejecutado; signup de prueba funciona.

**Día 5:**
- Empezar módulo `identity` real: endpoint `GET /api/me` con sesión Better Auth + lookup en `mlm.person`.
- Primer test de integración con testcontainers.
- Setup Grafana Cloud + postgres_exporter.

**Final de semana 1:** un usuario de prueba puede hacer signup, verificar email, hacer login, y `GET /api/me` devuelve su perfil. Drift nocturno = 0 (DB vacía). Esa es la base sobre la que se construye todo lo demás.

---

## 13. Cosas que NO escribiste todavía pero vas a necesitar

Lista corta de decisiones pendientes que deben tomarse antes de que el equipo arranque:

1. **Provider KYC.** Truora (LATAM-friendly), Sumsub, Onfido, o manual con OCR propio.
2. **Provider de email.** Resend está bien para transaccional; para marketing/news, ¿Mailgun? ¿Loops?
3. ~~**Procesador de pagos card.**~~ **DECIDIDO** — Stripe ([ADR 0013](adr/0013-payment-processor-stripe.md)).
4. ~~**Custodia de crypto.**~~ **DECIDIDO** — wallet API externa, no self-custody ([ADR 0014](adr/0014-external-wallet-api.md)). Provider específico TBD.
5. **Stack de observabilidad.** Grafana Cloud free tier alcanza ~10k series; OpenTelemetry SaaS (Honeycomb, Datadog) si crecemos.
6. **Política de retención de datos.** Habeas Data Colombia: 5 años para datos financieros tras última operación.
7. **Política de blacklist.** Quién decide, cómo se documenta, cómo se apela.
8. **Política de manual adjustments.** ¿Cuatro-ojos a partir de qué umbral? (Sugerencia: > $1,000 USD requiere segundo aprobador.)
9. **SLA con afiliados.** ¿Tiempo máximo de procesamiento de retiro? ¿Compensación si se incumple?
10. **Plan de comunicación del cutover.** Email a usuarios 1 semana antes; banner en app durante; post-mortem público si hay incidente.

Estas decisiones no bloquean fase 0 pero sí bloquean la transición a fase 1/2/3. Asignar dueño y fecha límite a cada una en la primera semana de planning.

---

## 14. Lectura previa obligatoria para quien implemente

- `_meta/schema_mlm.sql` — el contrato de DB que el código respeta.
- `_meta/credito_audit.out` — entender qué problemas existen en datos legacy.
- `mlm_binario_estabilidad.md` — la fórmula del bono binario actual.
- `mlm_binario_margen_operativo.md` — el margen operativo esperado.
- `_meta/migration/PLAN.md` — cómo se hizo el cutover.
- `_meta/devops/PLAYBOOK.md` — cómo está provisionada la infra.
- `CHANGES.md` — historia de decisiones y archivos.
- Better Auth docs: https://www.better-auth.com
- Drizzle docs (Postgres section): https://orm.drizzle.team

Sin haber leído esto, no se debe abrir un PR.
