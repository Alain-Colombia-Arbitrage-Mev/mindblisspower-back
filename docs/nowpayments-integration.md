# NOWPayments: conector de depósitos

El conector Go usa facturas hospedadas y evidencia de pago separada de Stripe.
No altera `payments.stripe_sale`, comisiones, saldos, rangos ni posiciones. Cargar
las claves no activa cobros ni supera los bloqueos financieros existentes.

Variables exclusivamente del backend:

- `NOWPAYMENTS_API_KEY`: clave de la API de comerciante; se acepta también el
  nombre local legado `NOWPAYMENTS:API_KEY`. El nombre canónico tiene prioridad.
- `NOWPAYMENTS_IPN_SECRET`: secreto separado para autenticar notificaciones IPN.
  La clave pública no lo sustituye. Sin este secreto no se crean facturas.
- `NOWPAYMENTS_PUBLIC_KEY`: se conserva sólo en configuración privada. No es
  necesaria para las facturas hospedadas y no se incorpora al frontend.
- `NOWPAYMENTS_ENV`: `production` por defecto; `sandbox` debe ser explícito.

`SERVICE_READ_ONLY=true` descarta todas estas credenciales. No se han cargado
secretos nuevos en Cloudflare ni modificado permisos de PostgreSQL.

El conector limita destinos y tamaños, usa HTTPS, no sigue redirecciones,
verifica HMAC SHA-512 y compara identidad de pedido/factura/pago e importe USD
exacto. `waiting`, `confirming`, `confirmed`, `sending` y `partially_paid` no
equivalen a un depósito acreditado; volver al portal tampoco acredita dinero.
La evidencia `finished` debe conciliarse y aplicarse de forma idempotente en el
flujo de negocio correspondiente, no en la activación específica de Stripe.

## Pendiente para habilitar el flujo

1. Definir si paga una membresía o recarga un saldo independiente. Actualmente
   el portal sólo tiene compras de membresías; no existe una recarga operativa.
2. Configurar el secreto IPN y una ruta pública HTTPS revisada para callbacks.
3. Implementar pedidos/evidencias persistentes separados por proveedor,
   idempotencia y liquidación correspondiente al propósito elegido.
4. Verificar el flujo completo en sandbox antes de habilitar cobros reales.

Documentación oficial:
[API de facturas](https://nowpayments.zendesk.com/hc/en-us/articles/21345824322717-API-and-endpoint-description),
[notificaciones IPN](https://nowpayments.zendesk.com/hc/en-us/articles/21395546303389-IPN-and-how-to-setup).
