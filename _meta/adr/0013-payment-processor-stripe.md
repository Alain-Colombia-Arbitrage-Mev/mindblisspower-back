# 0013 — Stripe como procesador de pagos con tarjeta

**Status:** Accepted
**Date:** 2026-04-28
**Deciders:** equipo VicionPower (devfidubit)

## Context

VicionPower necesita aceptar compras de paquetes con tarjeta (crédito + débito) en al menos Colombia, con expansión esperada a México, Brasil, Estados Unidos y otros mercados LATAM/EU.

Restricciones:
- **Multi-país desde día 1.** Aunque Colombia es el mercado principal, los afiliados captan referidos en otros países.
- **Multi-moneda.** Necesitamos USD, COP, MXN, BRL, EUR.
- **DX para velocidad de iteración.** El equipo de 2-3 backend va a integrar bajo presión.
- **Webhooks confiables con firma verificable.** Compliance con doble-entrada (ADR 0001) requiere webhook signature verification para idempotencia.
- **Compliance PCI DSS** sin tener que tokenizar PAN nosotros mismos.
- **Roadmap de marketplace.** En el futuro: payouts a afiliados via Stripe Connect (split payments). No bloqueante hoy pero deseable.

## Decision

**Stripe** (https://stripe.com) como procesador único de pagos con tarjeta.

Implementación:
- **Stripe Checkout** para flujo hosted (no manejamos PAN, PCI scope mínimo SAQ A).
- **Stripe Webhooks** con verificación de firma (`Stripe-Signature` header + raw body HMAC-SHA256).
- **Idempotency-Key** en cada API call para safe retries.
- **Customer + PaymentMethod** persistidos en Stripe; nuestro `mlm.person.stripe_customer_id` solo guarda el ID externo.
- **Webhook handler en `vp-api`** (TS), no en `vp-engine`. Razón: webhooks de Stripe son sync HTTP, no batch — TS+Hono es ideal. El handler valida firma, deduplica por `event.id`, y publica NATS event `payments.confirmed` que `vp-engine` consume para crear la `mlm.transaction`.
- **Stripe Connect Standard** considerado para v2 (split payments a afiliados); no bloqueante hoy.

## Consequences

### Positivas

- **Excelente DX.** Documentación, SDKs (TS y Go oficiales), playground sandbox testnet con tarjetas de prueba documentadas.
- **Multi-país out of the box.** Stripe disponible en 45+ países incluyendo Colombia (lanzado 2023), México, Brasil, USA, EU.
- **Multi-moneda.** Settlement en USD para minimizar fricción FX. Tarjetas locales (COP, MXN, BRL) procesadas con conversión automática.
- **Compliance PCI DSS Level 1** del lado de Stripe. Nosotros quedamos en SAQ A (el scope mínimo) usando Checkout hosted.
- **Webhook system robusto.** Firma HMAC verificable, retry policy automático (hasta 3 días), event log query-able por `event.id`.
- **Idempotency-Key API-wide.** Cualquier mutación que repitamos por timeout es safe.
- **Radar (anti-fraude)** built-in con machine learning. Reduce chargebacks 30-60% según industry benchmarks.
- **Pricing predecible** — 2.9% + $0.30 USD para tarjetas internacionales, 3.6% + COP fija en pagos locales Colombia.
- **Stripe Connect path** disponible cuando queramos hacer split payments a afiliados sin operar custody nosotros.
- **Dashboard, refunds, disputes management** son producto maduro; el equipo de soporte/finance opera vía Stripe Dashboard, no construimos UI.

### Negativas

- **Costo más alto que procesadores locales.** PayU Latam, ePayco, o transferencia PSE directa via banco son ~1.5-2.5% vs 2.9-3.6% de Stripe. Para volumen alto en Colombia, un secondary processor para PSE puede valer la pena. Plan B: integrar PayU Latam como secondary específico para Colombia high-volume si volumen lo justifica.
- **PSE Colombia (transferencia bancaria) tiene UX inferior** vía Stripe que vía Mercado Pago o PayU. Los usuarios colombianos están acostumbrados a PSE; Stripe lo soporta pero con mas pasos.
- **Stripe Colombia es relativamente nuevo** (2023). Casos edge específicos del mercado pueden tener menos coverage que MP. Mitigación: mantener canal manual (transferencia bancaria con comprobante + review en backoffice) como fallback durante primer año.
- **Lock-in de DATOS** si usamos features propietarios (Radar rules, Connect, Treasury). Tokens de tarjeta NO son portables a otro processor. Mitigación: documentado como costo aceptable; los tokens caducan y se rebuilden naturalmente con re-purchases.
- **Currency settlement en USD por defecto** implica FX conversion. Para reportes contables en COP, calcular FX rate del momento del pago (Stripe expone `exchange_rate` en cada balance transaction).
- **Disputes/chargebacks suben la presión** vs MP, pero también el control de fraude (Radar) es superior. Net suele ser mejor si configuramos Radar agresivo.

### Neutras

- Stripe en Colombia opera en COP nativo o USD; elegimos USD para alinear con `mlm.asset` `USD` ya configurado en schema.
- Webhooks llegan a `vp-api` sobre TLS público con Cloudflare en frente; Cloudflare WAF bloquea bots, Stripe IPs whitelist es opcional pero recomendado.

## Alternatives considered

### Mercado Pago (Colombia + LATAM)

**Rechazado tras evaluación detallada.**
- Tier 1 candidato originalmente (BACKEND_PLAN §13.2 lo mencionaba como recomendación inicial).
- Strengths: PSE Colombia nativo, mercado-leader en LATAM, costo localmente competitivo.
- Weaknesses fatales:
  - SDK Go inexistente / TS comunitario sin oficialidad.
  - Webhook signing menos robusto (header propio, no estándar).
  - Documentación dispersa por país.
  - DX inferior — debugging es más doloroso, sandbox limitado.
  - Multi-país requiere subcuenta por país, no API unificada.
- A volumen alto, MP gana en costo COP local; a volumen variado multi-país, Stripe gana en developer-velocity y reliability.

**Plan B documentado:** si pasamos US$5M/mes en Colombia transactions, integrar MP o PayU como secondary processor SOLO para PSE Colombia (no para card), manteniendo Stripe como primary universal.

### PayU Latam

**Rechazado.**
- Mejor pricing localmente (~1.8-2.5% en Colombia).
- DX claramente inferior a Stripe; APIs antigas, documentación dispersa.
- Multi-país menos maduro que Stripe o MP.
- Queda como Plan B junto con MP para PSE específico.

### Adyen

**Rechazado.**
- Empresa enterprise excelente; pricing similar a Stripe.
- DX inferior — orientada a integraciones tipo Booking, Uber, Spotify.
- Para nuestro tamaño actual, overkill operacional.

### Procesadores locales puros (ePayco, Wompi, Bancolombia)

**Rechazado para v1.**
- Pricing localmente excelente.
- Lock geographic — no escalan a México/Brasil/EU sin re-integración.
- DX inferior a Stripe.
- Útiles como fallback PSE en Colombia si volumen lo justifica.

### Crypto-only (no card processor)

**Rechazado.**
- Reduciría el TAM significativamente. La mayoría de afiliados LATAM no operan en crypto natively.
- Compliance KYC/AML más fácil con card processor que con crypto puro.

### Integrar todos (Stripe + MP + PayU multi-region)

**Rechazado para v1, planeado para v3.**
- Complejidad de routing (qué processor para qué pago según país, monto, método).
- Reconciliación contable triplica.
- Decisión: empezar con Stripe único, agregar secondary cuando volumen justifique.

## Implementación

### Endpoints

- `POST /api/packages/:id/purchase` (vp-api): crea Stripe Checkout Session, retorna `url` para redirect.
- `POST /api/webhooks/stripe` (vp-api): handler webhook; valida firma; deduplica por `event.id`; publica NATS `payments.confirmed`.
- `vp-engine` consume `payments.confirmed`, crea `mlm.transaction` con `external_ref='stripe:' || event.id`, activa el `mlm.affiliate_package`.

### Eventos Stripe críticos a manejar

| Stripe event | Acción |
|---|---|
| `checkout.session.completed` | Activar paquete; emitir tree event PV credit |
| `payment_intent.succeeded` | Confirmación adicional (idempotente con el anterior) |
| `payment_intent.payment_failed` | Marcar `affiliate_package.status='pending_payment'` o `cancelled` |
| `charge.refunded` | Disparar workflow de reversa via approval (ADR 0010) |
| `charge.dispute.created` | Notificar finance + congelar comisiones del afiliado pending review |
| `customer.subscription.deleted` | (futuro) cancelar paquete recurrente |

### Costos estimados

- 2.9% + $0.30 por transacción internacional.
- ~$200-500/mes en Stripe fees a baseline ($143M/mes inflows × small % es card-paid → ajustar al volumen real).
- Radar: $0.05/screened transaction; chargeback prevention paga con creces.

## References

- ADR 0001 — Postgres + idempotencia DB-level.
- ADR 0002 — `vp-api` (TS) maneja webhooks, no `vp-engine`.
- ADR 0007 — NATS `payments.confirmed` cross-service.
- ADR 0010 — refunds/disputes requieren approval (cuatro-ojos).
- BACKEND_PLAN §3.7 (`payments` module).
- Stripe Colombia: https://stripe.com/co
- Stripe Webhooks signature verification: https://stripe.com/docs/webhooks/signatures
- Stripe Connect (futuro v2): https://stripe.com/connect
- PSE en Stripe: https://stripe.com/docs/payments/pse
