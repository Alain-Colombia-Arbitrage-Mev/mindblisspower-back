# Contrato de recuperación Stripe

Este modelo es opcional: las bases operativas anteriores conservan su contrato
cuando no existe `payments.stripe_sale`. La presencia de esa tabla identifica una
recuperación en revisión y bloquea comandos financieros, incluso si tiene cero filas.
No es un interruptor que deba desactivarse borrando la tabla para habilitar pagos.

## Dependencias de datos

| Relación | Responsabilidad |
| --- | --- |
| `payments.stripe_sale` | Captura canónica por PaymentIntent, unidad menor, reembolsos y evidencia de producto |
| `recovery.stripe_sale_identity` | Vínculo corroborado a persona/afiliado y verificación del catálogo |
| `recovery.package_catalog_snapshot` | Precio base y tarifa corroborados, con moneda explícita |
| `recovery.v_stripe_funds_review` | Declaración revisada de fondos, alcance y cantidades desconocidas |
| `recovery.v_stripe_funds_provider_comparison` | Evidencia del procesador, sin inferir caja bancaria |

La importación debe preservar la procedencia. Sólo se leen capturas live/succeeded
en USD con la marca explícita del producto; no se mezclan intents operativos,
otros productos de una cuenta compartida ni payouts globales de Stripe.
Los scripts de una recuperación concreta y sus snapshots se mantienen privados.
El esquema y las vistas deben aprovisionarse mediante una reconstrucción revisada,
no mediante una ruta HTTP ni una migración al arrancar.

Si faltan vistas o permisos, las lecturas fallan cerradas. No se vuelve a la fuente
operativa ni se convierte un importe desconocido en cero.

## Contratos de respuesta

Admin Finance/Sales y el resumen del miembro indican
`data_source=verified_stripe_recovery`. El miembro recibe `stripe_sales` separado
de `payments`, `financial_status=pending_calculation_and_review`,
`payout_locked=true` y balances no calculados como JSON `null`.
Sólo ve ventas vinculadas a su persona verificada. Un candidato por email no
constituye identidad corroborada.

Una venta `paid` describe el cobro al comprador, no una comisión pagada al afiliado.
Los reembolsos y disputas siguen visibles. No se fabrican activaciones, paquetes,
PV, rangos o posiciones históricas a partir de una captura.

Las declaraciones agregadas conservan su alcance histórico; un filtro de fechas
no las prorratea ni las asigna a individuos. Capturas nuevas señalan un snapshot
anterior como pendiente de revisión, sin heredar su reparto automáticamente.

## Seguridad y reanudación

Los endpoints financieros derivados no demuestran solvencia y responden 503 durante
la revisión. Ledger, créditos de PV, compras/activaciones, reembolsos, retiros y
procesos de compensación rechazan mutaciones antes de sus efectos secundarios.
Las lecturas no usan ese rechazo como sustituto de autenticación o autorización.

El saldo crudo del ledger gRPC no es una deuda de afiliado calculada: soporte debe
utilizar el contrato de miembro con estado explícito, nunca reinterpretar un ledger
vacío como balance disponible. Una integración Chatwoot requiere identidad vinculada
y acceso específico de sólo lectura; estas rutas no la implementan por sí mismas.

Reanudar compensaciones exige un cambio revisado independiente con reglas, planes,
reconciliación y saldos aprobados. Este refactor no habilita ese paso.
