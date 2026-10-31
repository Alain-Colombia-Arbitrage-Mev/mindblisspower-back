# Plan y presupuesto del núcleo en Cloudflare

Revisión del 25 de octubre de 2026. Alcance autorizado: preparar portales, API y
servicios Go para Cloudflare, incluyendo Containers, y revisar el costo **antes de
activarlos**. Chatwoot queda expresamente fuera de esta etapa: no se despliega,
no se modifica su instalación local ni se incluyen sus recursos en el presupuesto.

Esta preparación no habilita operaciones financieras ni constituye un despliegue.
PostgreSQL permanece en PlanetScale; no se traslada a un Container ni a D1.

## Destinos y fronteras

| Componente | Destino propuesto | Condición antes de activarlo |
| --- | --- | --- |
| Portal de usuarios | Worker con adaptador de Next.js | Validar SSR, cookies, BFF, SQL por petición, caché e invalidación |
| Panel administrativo | Worker con adaptador de Next.js | Validar permisos, BFF y rechazo de usuarios no administradores |
| API Hono y Better Auth | Container Bun existente | Separar credencial escritora de autenticación del lector comercial |
| Engine Go | Container privado | Probar transporte privado Bun a Go conservando mTLS y bloqueos financieros |
| Payments Go | Container privado, salvo webhook firmado | Probar identidad, procedencia Stripe e idempotencia sin cobros reales |
| Withdrawals Go | Container privado | Mantener retiros y desembolsos bloqueados durante la revisión |
| Base curada MLM | PlanetScale PostgreSQL existente | TLS verificado, roles mínimos, respaldo y restauración comprobados |

Better Auth sigue siendo la librería autohospedada dentro de la API: no se añade
una suscripción de autenticación ni un Worker de auth independiente. Cloudflare
entrega los correos; SMS y WhatsApp permanecen desactivados.

Los portales actuales usan Next.js 16.4.3 y no tienen un adaptador Workers
instalado. No son sitios estáticos: requieren SSR y rutas de servidor. Seleccionar
y fijar una versión compatible del adaptador, conservar el build Docker y probar
en `workerd` antes de publicar. La [guía oficial de Next.js](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/)
y la [guía del adaptador OpenNext](https://developers.cloudflare.com/workers/framework-guides/web-apps/opennext/)
describen rutas diferentes; ninguna demuestra por sí sola compatibilidad con
nuestros BFF, SDKs y consultas.

## Escenarios de costo

La [calculadora local](cost-model.mjs) y sus [escenarios](scenarios.example.json)
no utilizan credenciales, no consultan proveedores y no crean recursos. Los
importes son subtotales de los conceptos modelados, no una factura ni un límite
de gasto garantizado. Las tarifas están fechadas y deben renovarse al cambiar.

Desde la raíz del backend:

```sh
node --test deploy/cloudflare/cost-model.test.mjs
node deploy/cloudflare/cost-model.mjs deploy/cloudflare/scenarios.example.json
```

Hipótesis para comparar: cuatro Containers `basic`, uno por servicio, cada uno
con 1 GiB de memoria, 0,25 vCPU y 4 GB de disco; CPU media utilizada de 0,02 vCPU
por instancia. El tipo de instancia limita capacidad, pero CPU se factura por
uso; memoria y disco se cobran por recursos provisionados durante las horas
activas. No se ha validado esta capacidad con carga de producción.

| Escenario | Horas activas por Container | Subtotal mensual modelado USD |
| --- | --- | ---: |
| Laboratorio del núcleo | 80 | 7,94 |
| Núcleo de producción continuo | 730 | 50,20 |
| Producción más laboratorio de staging | 730 + 80 por servicio y entorno | 66,37 |

Los tres ejemplos incluyen una sola cuota Workers Paid de USD 5 por cuenta y
descuentan las franquicias una sola vez para el conjunto, no por aplicación.
Incluyen el supuesto conservador de que los Durable Objects permanecen activos
mientras corren los Containers; la hibernación real puede reducir esa parte.
Solicitudes, CPU de Workers y los demás parámetros completos están en los
escenarios, no se deducen del número de afiliados.

Sensibilidad: si las cuatro instancias de producción utilizaran de media toda
su CPU asignada (0,25 vCPU cada una), manteniendo los demás parámetros, el
subtotal modelado subiría a USD 98,56. El ejemplo de USD 50,20 no es un techo.

Quedan por cotizar o confirmar la factura existente de PlanetScale, correo,
respaldos y retención, impuestos y cualquier consumo no incluido en los escenarios.
El modelo conserva conceptos desconocidos como `null`, no como cero. Tampoco
incluye Chatwoot, Redis para Chatwoot, adjuntos, IA ni servicios de voz.

Fuentes de tarifas: [Containers](https://developers.cloudflare.com/containers/platform/pricing/),
[Workers](https://developers.cloudflare.com/workers/platform/pricing/) y
[Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/).
Cloudflare factura por separado uso de Workers y Durable Objects asociado a
Containers. Un tope de instancias no constituye un tope monetario de toda la cuenta.

## Red y seguridad

La red privada de Docker Compose no existe automáticamente en Cloudflare.
`engine:50051` no se convierte en un destino privado por copiar una variable.
Las llamadas HTTP entre servicios pueden usar hostnames virtuales y bindings
privados; gRPC Bun a Go requiere una prueba del puente TCP o una adaptación del
transporte que preserve autenticación, TLS, ALPN y rechazo de certificados ajenos.
No exponer engine ni retiros mediante una URL pública para resolver esa conexión.
Las [API de TCP](https://developers.cloudflare.com/workers/runtime-apis/handlers/connect/)
y de [puertos de Containers](https://developers.cloudflare.com/containers/api/durable-object-container/)
permiten estudiar un relay; ese relay aún no está implementado ni probado aquí.

Bun y Go ya aceptan certificados PEM por variables privadas. Inyectarlos como
secretos al iniciar, sin claves en imágenes, archivos versionados, `vars` o logs.
La CA privada no se entrega a los servicios. Las credenciales de cada servicio
deben ser distintas y no permitir escrituras financieras desde autenticación.

Para PostgreSQL TCP directo, no prometer `enableInternet=false` como una allowlist
de 5432: los [controles de salida HTTP](https://developers.cloudflare.com/containers/configuration/outbound-traffic/)
se limitan a 80 y 443. Revisar la salida necesaria, validar TLS/hostname y aplicar
los controles de acceso del proveedor. No desactivar validación de certificados.

Propuesta inicial: política `default`, `max_instances=1` por servicio y entorno e
identidad de instancia constante. La política `durable_object` en beta no admite
ese tope, según las [políticas de planificación](https://developers.cloudflare.com/containers/configuration/scheduling-policy/).
Ningún singleton reemplaza locks, idempotencia o coordinación en PostgreSQL.

## Autenticación y caché

La migración 70 y los permisos deben aprobarse y aplicarse como operación
independiente, nunca durante build, arranque o despliegue de imagen. El código
actual de `app/src/auth.ts` todavía comparte el lector general; la separación
de credenciales aún no está integrada en esa composición. No activar OTP o JWT
hasta conectar y probar un escritor mínimo de `auth.*` e
identidad. Revisar también grants heredados y permisos por defecto: el lector
comercial no debe poder leer secretos de sesiones, verificaciones o claves.

Los formularios de login de ambos portales todavía usan Cognito. Un cambio de
variables no completa su sustitución; el corte requiere adaptar la interfaz y
probar envío, verificación, expiración, límite de intentos, sesión y cierre.

No cachear autenticación, sesiones, permisos, saldos, posiciones ni lecturas
inmediatamente posteriores a una escritura. Si el portal usa Hyperdrive, usar
un binding sin caché para esas rutas y clientes por petición. El catálogo puede
usar TTL e invalidación explícitos entre instancias; un `Map` local no es una
caché distribuida ni un limitador global. [Reglas de caché de Hyperdrive](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/).

Estos escenarios tampoco contratan Redis para el núcleo. Payments permite
operar sin su caché opcional (`REDIS_ADDR` vacío); se debe probar ese modo, sus
límites y el impacto en PostgreSQL. No copiar el Compose con `REDIS_ADDR=redis:6379`
sin un recurso real, ni tratar límites locales como protección global entre
réplicas o reinicios. Si el despliegue requiere Redis, añadirlo al presupuesto
antes de aprobarlo.

## Condiciones de salida de staging

1. Aprobar presupuesto mensual y confirmar dominios HTTPS de portal, admin y API.
   No cambiar DNS ni contratar o activar recursos durante esta revisión.
2. Aprobar rol y respaldo; probar migración e identidad en copia aislada antes
   del cambio canónico. No mover posiciones, rangos o comisiones como efecto del login.
3. Resolver y probar red privada con credenciales sintéticas: handshake mTLS,
   certificado equivocado, timeout, reconexión y denegación de acceso público.
4. Construir candidatos reproducibles `linux/amd64`, probarlos y publicar sólo
   los mismos artefactos por digest. Incluir readiness de dependencias y rollback;
   un deploy de Worker no demuestra que su imagen esté lista.
5. Probar portales y BFF en `workerd`, con sesiones seguras, CSRF/orígenes, IP
   confiable y límites persistentes. El panel debe rechazar roles insuficientes.
6. Mantener scheduler y ciclo binario apagados, conciliación automática en cero,
   recordatorios y comunicaciones automáticas desactivados. Conservar los bloqueos
   de la [recuperación Stripe](../../docs/recovery-read-model.md); desplegar código
   no autoriza comisiones, activaciones, reembolsos o desembolsos.
7. Medir carga representativa, latencia, memoria, CPU y conexiones globales de
   todos los pools antes de aumentar recursos o réplicas. Aprobar staging antes
   de producción mediante una decisión independiente.

Los scripts de esta preparación sólo calculan escenarios locales. No existe
todavía un publicador Cloudflare completo y verificado; no se debe ejecutar
`wrangler deploy` sobre el servidor Bun o el Compose como si fueran un Worker.
