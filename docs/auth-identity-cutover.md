# Better Auth, correo e identidad de la red

## Estado del contrato de autenticación

Este documento describe el código y la política de acceso acordada; no es una
comprobación de producción. Versionarlo no aplica migraciones, activa flags,
envía mensajes ni demuestra entrega de correo.

- Registro e inicio de sesión usan OTP por correo. La contraseña es opcional
  para el usuario y puede crearse o cambiarse mediante recuperación segura por
  OTP, sin cambiar su correo. La nueva contraseña requiere de 12 a 128 caracteres.
- Resend es el proveedor elegido para el despliegue: seleccionar expresamente
  `AUTH_EMAIL_PROVIDER=resend`. Si se omite, el código conserva el valor histórico
  `cloudflare`; no hay fallback automático entre proveedores.
- SMS y WhatsApp no son canales de autenticación de esta release. Cloudflare
  fuerza las capacidades telefónicas a `false`; no configurar sent.dm ni crear
  sus tablas opcionales para habilitar el registro por correo.
- `contactPhone` y `contactWhatsapp` son contactos opcionales con código de país
  y validación E.164. No prueban posesión, no autorizan mensajes ni identifican
  al propietario de una cuenta antigua.

Better Auth se ejecuta dentro del proceso Bun existente y utiliza PostgreSQL;
esta integración no necesita su infraestructura administrada opcional de pago.

## Identificadores y responsabilidades

| Identificador | Fuente autorizada | Uso |
| --- | --- | --- |
| `auth.user.id` / JWT `sub` | Better Auth | Cuenta de acceso, no posición de red |
| `mlm.person.public_id` | PostgreSQL, UUID único e inmutable | Identidad pública estable, incluso si cambia el correo |
| `identity.auth_binding` | Provisionamiento verificado o vínculo aprobado | Unión 1:1 cuenta/persona |
| `mlm.affiliate.id` | Red existente | Posición, padre y patrocinador; no se reconstruyen al autenticar |
| `identity.stripe_customer` | Evidencia verificada del servidor | Customer separado por cuenta Stripe y modo live/test |
| `payments.purchase_intent.id` | Servicio de pagos | Compra propia e idempotencia, independiente del usuario |

Una dirección desconocida debe registrarse primero: pedir un OTP de acceso no
crea una cuenta automáticamente. Los accesos antiguos migrados como pendientes
no equivalen a correos verificados ni a sesiones.

Después de consumir una prueba válida de correo, el provisionamiento puede
vincular automáticamente una única persona antigua elegible y no administradora,
conforme a la política acordada. Recomprueba estados y vínculos dentro de una
transacción. Las coincidencias ambiguas, restricciones y vínculos incompatibles
no se resuelven por una coincidencia de correo. Las cuentas privilegiadas
conservan el proceso separado de aprobación; verificar correo no concede roles.

Cuando hace falta aprobación, un operador autorizado emite un grant de corta
duración. Sólo se persiste su hash; el titular verificado lo consume una vez
mediante `POST /api/member/identity/claim` con `{token}`. El servidor obtiene el
usuario de la sesión: el cuerpo no elige persona ni aprobador.
`GET /api/member/identity` es una consulta privada sin efectos secundarios.
El vínculo actual, no el correo o un UUID enviado por el cliente, autoriza el JWT.
Estos procesos no mueven posiciones ni modifican rangos, ventas o comisiones.

## Correo, OTP y recuperación

- Resend usa `RESEND_API_KEY` y `AUTH_EMAIL_FROM`, configurados fuera de Git, con
  el dominio/remitente autorizado. Las plantillas nativas de OTP usan los alias
  `login-verification-code`, `account-verification` y `password-reset`, con el
  código generado por el backend. Una prueba de plantilla aislada no es un OTP
  canjeable en el portal.
- Cloudflare es un transporte alternativo explícito, no un proveedor de respaldo
  automático. Si se selecciona, necesita `CLOUDFLARE_ACCOUNT_ID`,
  `CLOUDFLARE_EMAIL_API_TOKEN` con permisos mínimos y `AUTH_EMAIL_FROM`. Email
  Routing por sí solo no es un transporte transaccional.
- Sólo el proveedor seleccionado recibe su configuración. No hay reintentos o
  fallback ocultos que dupliquen códigos. La aceptación HTTP no demuestra llegada
  a la bandeja ni identidad verificada; se corrobora con eventos autenticados del
  proveedor o con el destinatario. No se activan monitores o alertas al documentarlos.

Los OTP de correo son de seis dígitos, duran cinco minutos y admiten tres
intentos. Se guardan mediante hash con clave secreta, nunca en claro ni en logs.
Se separan por propósito y su consumo debe preceder a una sesión válida. El
reenvío respeta una espera persistente de cinco minutos y los límites por
IP/ruta también se guardan en PostgreSQL. Un fallo no autoriza a borrar límites,
reutilizar pruebas ni enviar otro código automáticamente.

Crear o cambiar contraseña mediante recuperación permite cinco solicitudes y
diez validaciones por correo durante las últimas 24 horas, no un reinicio a
medianoche. Un límite agotado responde con `Retry-After`. Este presupuesto no
bloquea por sí solo el inicio de sesión por OTP. La contraseña se guarda como
hash en `auth.account`, no en `mlm.person` ni en el navegador. Su cambio, el
consumo de la prueba y la revocación de sesiones anteriores son atómicos.

El contrato ejecutable está en [`options.ts`](../app/src/auth/options.ts),
[`delivery.ts`](../app/src/auth/delivery.ts),
[`recovery-daily-budget.ts`](../app/src/auth/recovery-daily-budget.ts) y
[`provision.ts`](../app/src/modules/identity/provision.ts). No registrar correos,
códigos, enlaces de acción, respuestas crudas de proveedores o claves privadas.

## Información mínima en Stripe: contrato histórico

Este contrato conserva compatibilidad y evidencia; no habilita la pasarela ni
modifica objetos externos por el solo hecho de versionarlo.

Checkout Session y PaymentIntent reciben la misma allowlist de metadatos: marca
de producto, versión de identidad, UUID público de persona, IDs internos actuales
de persona/afiliado y patrocinador corroborado cuando existen, compra, paquete y PV.
`client_reference_id` es el UUID público. Son datos derivados de la compra persistida,
no metadatos arbitrarios del navegador.

`identity_version=1` distingue estos IDs actuales de los IDs SQL Server heredados.
Las importaciones deben priorizar UUID y versión, nunca reinterpretar un número
actual como ID legado. No se envían árbol, balances, datos bancarios ni datos de
contacto dentro de estos metadatos. El vínculo de Customer no crea ni modifica
Customers reales y no reasigna registros históricos.

## Activación revisada

1. Respaldar y revisar catálogo, duplicados, permisos y estado del destino antes
   de cualquier DDL. Las migraciones 70/71/72 son pasos históricos revisados,
   no instrucciones para reaplicarlos en bloque. Los modelos Drizzle son un
   espejo parcial, no una autoridad para sincronizar automáticamente producción.
   Conservar IDs, árbol y rangos; el UUID se asigna una vez. No backfillear por
   separado dos copias que deban compartir identidades. La migración de contactos
   76 añade campos opcionales, sin verificar correos o teléfonos. Una tabla
   ausente de un módulo apagado no autoriza a crearla o activarlo. Hay prefijos
   históricos repetidos: comprobar nombre y catálogo, no sólo numeración.
2. Dar al runtime de autenticación un rol autorizado para sus tablas `auth.*`
   (incluidos verification, rate_limit y jwks) y los comandos de identidad. No usar
   un lector ni ampliar PUBLIC. Las claves privadas de JWKS no son visibles a lectores.
   La aprobación de grants usa una conexión de operador, no el rol normal de signup.
3. Configurar fuera de Git el secreto Better Auth, URL/orígenes confiables,
   proveedor/remitente y clave de correo. No configurar Sent para esta release.
   Los nombres están en `app/.env.example`; no pegar secretos en el chat ni en
   ejemplos versionados. Publicar código no confirma sus flags en producción.
4. Habilitar las capacidades OTP/JWT explícitamente. JWT usa RS256, issuer/audience
   iguales en todos los consumidores y cinco minutos de vida. Go vuelve a verificar
   firma y vínculo actual; no hay fallback a correo/Cognito si Better Auth falla.
5. Coordinar `AUTH_PROVIDER=better-auth` en BFF y servicios. Los BFF incluyen un
   proxy HTTP de origen estricto para endpoints Better Auth; los JWT de servicio
   permanecen en el servidor y las cookies del navegador son HttpOnly.
   Configurar `BETTER_AUTH_BACKEND_URL` (HTTPS), `AUTH_PUBLIC_ORIGIN`,
   `BETTER_AUTH_JWKS_URL`, `BETTER_AUTH_JWT_ISSUER` y `BETTER_AUTH_JWT_AUDIENCE`.
   `AUTH_BFF_SHARED_SECRET` debe coincidir entre BFF y Bun (mínimo 32 caracteres).
   El borde debe eliminar encabezados de IP del cliente y establecer su propio
   `cf-connecting-ip` o `x-real-ip`, elegido con `AUTH_CLIENT_IP_HEADER`. Bloquear
   acceso que evite ese borde. El BFF firma IP/ruta/cookie/cuerpo con una prueba
   de 30 segundos; Bun verifica esa prueba antes de confiar en la IP para límites.
   Sin IP confiable en producción se rechaza, no se usa un bucket global compartido.
   Las claves JWKS públicas se exponen sin cookies ni material privado.
   Verificar que las pantallas de login, registro y recuperación utilicen las
   rutas del proveedor elegido antes de promover una release. La documentación
   no cambia ni certifica esas pantallas o el estado de un despliegue.
   Su logout debe llamar `POST /api/auth/sign-out` o `POST /api/auth/logout`:
   GET se rechaza cuando Better Auth está seleccionado, sin simular una revocación.
6. Ejecutar pruebas sintéticas y comprobaciones de sólo lectura. Un envío real
   requiere destinatario y autorización explícitos; nunca leer ni canjear su OTP.
   Comprobar entrega, sesión, expiración, bloqueo y recuperación sin declarar
   éxito por un HTTP 200. No copiar hashes Cognito ni forzar verificaciones,
   roles o vínculos fuera de la política indicada.

La revisión específica de perfil y noticias está documentada en
[`database-schema-audit-20261103.md`](database-schema-audit-20261103.md).
La migración 88 es de operador, tiene una guarda de destino y no se ejecuta al
arrancar. Versionarla no la aplica ni activa módulos apagados.

Los OTP/sesiones expirados pueden purgarse con una tarea de retención separada.
No usar esa tarea para borrar vínculos, aprobaciones o evidencia financiera.
Los lectores de soporte deben usar identidad corroborada y balances con estado
explícito. Esta integración no concede acceso de Chatwoot a la base principal.

Autenticar una cuenta o versionar metadatos no activa por sí mismo compras,
retiros, ROI o compensaciones. Sus políticas y controles permanecen en los
flujos financieros respectivos; este documento no modifica esos controles.
