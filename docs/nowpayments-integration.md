# NOWPayments: alternativa para comprar membresías

El propósito confirmado es **comprar membresías**, no recargar saldo. El portal
permite elegir Stripe o NOWPayments. Los pedidos y comprobantes NOWPayments se
mantienen separados de `payments.purchase_intent`, `payments.stripe_sale` y del
historial recuperado de Stripe.

## Estado del cambio

Código preparado y probado; **NOWPayments no está habilitado en producción**.
La revisión local encontró API key y public key, pero no `NOWPAYMENTS_IPN_SECRET`.
No se crearon facturas reales, se enviaron fondos ni se aplicó la migración 74 a
PlanetScale. Las credenciales y permisos productivos no se han modificado.

El flujo nuevo registra evidencia para revisión de la membresía; **no activa
automáticamente** paquetes, ROI, comisiones, posiciones ni PV. La activación
existente está implementada específicamente para Stripe y no debe recibir IDs
NOWPayments. No se trasladan el 3 % ni el 35 % del acuerdo de Stripe a este proveedor.

## Configuración privada

- `NOWPAYMENTS_API_KEY`: clave de comerciante. También se acepta el nombre local
  legado `NOWPAYMENTS:API_KEY`; el nombre canónico tiene prioridad.
- `NOWPAYMENTS_IPN_SECRET`: secreto separado de firma IPN; la public key no lo
  sustituye. Configurarlo en el archivo privado, nunca en Git ni en el chat.
- `NOWPAYMENTS_PUBLIC_KEY`: no se usa en facturas hospedadas y no se envía al navegador.
- `NOWPAYMENTS_ENV`: `production` o `sandbox`, nunca inferido de las claves.
- `NOWPAYMENTS_MEMBERSHIPS_ENABLED`: `false` por defecto. No habilitar sólo porque
  existen claves: requiere revisión del flujo de membresías y los pasos siguientes.
- `NOWPAYMENTS_IPN_URL`: HTTPS, ruta exacta `/api/webhooks/nowpayments`. En producción
  sólo `https://mindblisspower.com/api/webhooks/nowpayments`, sin query, puerto ni fragmento.
  Los retornos de revisión/cancelación se derivan del mismo origen en el servidor.
- `ENV`: explícitamente `production` para cobros reales; sólo `development`/`test`
  junto con NOWPayments sandbox y un hostname público de prueba distinto del portal.
- En el portal, `NOWPAYMENTS_WEBHOOK_ENABLED` permanece ausente/`false`. Su ruta
  `/api/webhooks/nowpayments` conserva los bytes y la firma hacia el backend privado;
  no confirma recepción si éste no pudo persistir la evidencia. Este flag no abre
  el bloqueo de escrituras financieras del Worker Core.

`SERVICE_READ_ONLY=true` descarta todas las credenciales y opciones NOWPayments.
Los Workers actuales conservan sus bloqueos financieros y no reenvían estas
claves a los contenedores. El secreto nunca se copia al portal.

## Garantías implementadas

1. Sesión verificada más vinculación Better Auth explícita a `mlm.person`.
   Un correo por sí solo no reclama un nodo legado ni crea otra persona.
2. Identidad estable, paquete, PV, sponsor, lado e importe USD se conservan en
   una instantánea del servidor. No se aceptan importes o IDs de red del navegador.
3. Pedido persistido antes de solicitar la factura. Un resultado incierto o un
   error al guardar la factura exige revisión: no se reintenta automáticamente
   una API que no promete una clave de idempotencia.
4. Exclusión de compras pendientes entre Stripe y NOWPayments, serializada por
   persona. Cambiar de proveedor no permite iniciar otro cobro por la misma membresía.
5. IPN HMAC SHA-512, JSON limitado y comparación constante; consulta independiente
   de `GET /payment/:id`. Pedido, factura, ID de pago, entorno e importe deben coincidir.
6. Vinculación única de pagos, transacción con bloqueo de fila y comprobantes
   inmutables. Repeticiones idénticas no duplican evidencia; un cambio posterior
   de la API se guarda como nueva evidencia, sin borrar la anterior.
7. `finished` verificado se conserva como `pending_review`, nunca como activación.
   Pagos parciales, reembolsos, fallos, IDs múltiples o estados desconocidos exigen
   revisión. Un evento tardío no elimina señales de riesgo.
8. El retorno al portal no prueba pago. Las redirecciones sólo admiten las URLs
   HTTPS hospedadas exactas de cada proveedor; no se sigue un redirect de la API.

## Antes de cobrar en producción

1. Configurar el secreto IPN en NOWPayments y en la configuración privada del backend.
2. Revisar y aplicar manualmente `74_nowpayments_membership_review.sql` en la base
   canónica. No modifica datos históricos ni otorga permisos a ningún rol.
3. Diseñar/aprobar el procedimiento de revisión y entrega de la membresía, con
   reembolsos y conciliación; esta versión no incorpora un botón para aprobarla.
4. Revisar un rol escritor mínimo. Los lectores productivos actuales no pueden
   insertar pedidos/comprobantes; no otorgar permisos globales para resolverlo.
5. Verificar en sandbox factura → IPN → consulta API → revisión, incluidos timeout,
   pago parcial, duplicado, reembolso y cambio de proveedor. Las pruebas locales
   usan transportes sintéticos y PostgreSQL desechable, no cobros sandbox reales.
6. Revisar por separado el despacho privado del Worker y el callback público,
   sus secretos y flags. Mantener cerrados los demás movimientos financieros.

Documentación oficial:
[facturas y consulta de pagos](https://nowpayments.zendesk.com/hc/en-us/articles/21345824322717-API-and-endpoint-description),
[secreto IPN, firma y reintentos](https://nowpayments.zendesk.com/hc/en-us/articles/21395546303389-IPN-and-how-to-setup).
