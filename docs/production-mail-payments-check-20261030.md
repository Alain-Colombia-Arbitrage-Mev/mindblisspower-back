# Producción: correo y bloqueo Stripe — 2026-10-30 (Colombia)

## Publicación acotada

El portal publicado corresponde a `a4f155b`; su Worker es
`b6e9ea12-93d5-40ae-8893-5fbb757d1630`. El administrador no necesitó
recompilación: los cambios posteriores a su publicación son documentación.

Se compiló y publicó exclusivamente el refuerzo de Payments de `bdb01bf`.
Core Worker: `665627a3-a337-4721-be87-5d1e01a4388b`. Imagen inmutable:

`registry.cloudflare.com/ed805ed2b05218b41fc1d4d2440e658e/mindbliss/payments-stripe-disabled-20261030@sha256:aa4f8df71b981ddbf08edbe430e5b2da29a69cad73d099bfa9dc2bf997b7f026`

La imagen mide 14.479.423 bytes, usa runtime scratch, usuario 65534 y
healthcheck binario. El contexto excluye archivos privados; no contiene
credenciales. API, Engine y Withdrawals se fijaron a sus digests anteriores,
con `rollout_kind: none`. Payments es la única aplicación actualizada.
El rollout `afe37739-7cdc-4d87-8c74-6d9c9bd5e32a` terminó como `completed`:
una de una instancias actualizada y saludable, cero fallidas, cero errores.

`STRIPE_CHECKOUT_ENABLED=false` permanece en Core y portal. Payments mantiene
`SERVICE_READ_ONLY=true`, sin credenciales de proveedores ni jobs financieros.
No se cancelaron enlaces Stripe emitidos anteriormente ni se modificaron
ventas, comisiones, posiciones, rangos o retiros. Chatwoot permanece fuera.

## Prueba real de correo

El propietario autorizó un envío a cada uno de dos buzones. Se solicitaron
desde los BFF públicos, uno en el portal y otro en el administrador. El
preflight de PostgreSQL fue de sólo lectura, fijado al destino y limitado a
esas dos cuentas; no consultó valores de códigos ni sesiones.

Una solicitud inicial recibió `429` con `Retry-After: 119`, sin eludir la
protección. El propietario autorizó un nuevo intento exclusivamente para ese
buzón, ejecutado después del plazo. El otro buzón recibió `200` en su primera
solicitud. Ambos envíos aceptados devolvieron `200`; el propietario confirmó
que los dos mensajes llegaron a la bandeja de entrada. Cloudflare también
confirmó `delivered` para el envío administrativo.

Los recibos exclusivos de cada intento se conservan localmente fuera de Git.
No hubo reenvíos automáticos, lecturas/canjes de OTP, mensajes a la cohorte
masiva, reinicios de límites ni eliminación de supresiones. Las consultas de
supresión de los dos destinatarios no encontraron entradas.

Otra consulta de sólo lectura encontró ambas cuentas de prueba con
`email_verified=true`; esta operación no modificó ese estado. No se verificó
en bloque a usuarios antiguos ni se concedieron roles o vínculos al árbol.
El propietario confirmó que la habilitación para recibir correo debe
conservar verificación por código y aprobación de vinculación.

La aplicación usa Cloudflare Email Sending REST: no existe una allowlist OTP
por destinatario que deba sustituirse por permisos administrativos. La lista
de destinos de Email Routing no es la verificación de identidad de Better Auth.
La recepción de dos mensajes no garantiza entrega de todos los buzones.

## NOWPayments: URL y estado real

Callback público previsto: `POST https://mindblisspower.com/api/webhooks/nowpayments`.
El proveedor utiliza `ipn_callback_url` y firma `x-nowpayments-sig` con el
IPN secret mediante HMAC-SHA512 sobre JSON canónico. No usar la API key como
secreto de firma. [Referencia oficial](https://documenter.getpostman.com/view/7907941/S1a32n38).

`NOWPAYMENTS_IPN_SECRET` está almacenado únicamente como secreto privado de
Core, no en el portal ni en Git. No se transmite al contenedor de lectura.
La recepción IPN y la creación de facturas siguen deshabilitadas. Una única
prueba pública con firma inválida recibió `503/payment_callback_unavailable`
y `private, no-store`. Es una prueba del bloqueo, no una confirmación de
callbacks válidos ni de persistencia de pagos.

No se habilitó un `200` ficticio: el handler real exige comprobación de firma,
correlación con una factura, consulta del proveedor y persistencia de evidencia.
Activar esa recepción requiere un cambio operativo separado y no debe implicar
activación automática de membresías, comisiones o posiciones.

## Verificación técnica

- Payments: 29 funciones de prueba seleccionadas PASS con `-race`, Go 1.26.10,
  Docker sin red, fuentes de sólo lectura y sin credenciales reales. La suite
  general anterior incluye fixtures PostgreSQL/Testcontainers no ejecutables
  sin su entorno; no se presenta como una aprobación integral de esa suite.
- NOWPayments: tres pruebas puras de canonicalización, firma y manipulación
  PASS con Go 1.26.10, sin red, SQL, proveedores ni secretos reales.
- Portal: 408 pruebas y 54 comprobaciones workerd aprobadas en la publicación
  del bloqueo Stripe; no se generaron cobros reales.
- Tras publicar: login y sesiones anónimas de ambos sitios responden `200`
  y `private, no-store`; reanudar Stripe devuelve `303` al catálogo sin abrir
  un checkout.

La distinción entre solicitud aceptada, entrega al servidor y bandeja del
destinatario sigue la [documentación de Cloudflare](https://developers.cloudflare.com/email-service/observability/logs/).
