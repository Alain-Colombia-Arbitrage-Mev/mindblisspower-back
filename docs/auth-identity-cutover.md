# Better Auth, mensajería e identidad de la red

Implementación preparada para despliegue coordinado, no un cambio automático de
proveedor. No se han aplicado estas migraciones a la copia curada ni a PlanetScale.
No se envían mensajes ni se modifican objetos Stripe durante las pruebas.

## Identificadores y responsabilidades

| Identificador | Fuente autorizada | Uso |
| --- | --- | --- |
| `auth.user.id` / JWT `sub` | Better Auth | Cuenta de acceso, no posición de red |
| `mlm.person.public_id` | PostgreSQL, UUID único e inmutable | Identidad pública estable, incluso si cambia el correo |
| `identity.auth_binding` | Provisionamiento verificado o vínculo aprobado | Unión 1:1 cuenta/persona; no coincidencia automática de email |
| `mlm.affiliate.id` | Red existente | Posición, padre y patrocinador; no se reconstruyen al autenticar |
| `identity.stripe_customer` | Evidencia verificada del servidor | Customer separado por cuenta Stripe y modo live/test |
| `payments.purchase_intent.id` | Servicio de pagos | Compra propia e idempotencia, independiente del usuario |

Los usuarios nuevos deben verificar el correo. Si su correo coincide con una
persona heredada, quedan pendientes de vínculo, sin apropiarse de su nodo ni rango.
Un operador distinto, con principal administrativo y conexión autorizada, aprueba
un grant de corta duración. Sólo se persiste su hash; el titular verificado lo
consume una vez mediante `POST /api/member/identity/claim` con `{token}`.
El servidor obtiene el usuario de la sesión: el cuerpo no elige persona ni aprobador.
`GET /api/member/identity` es una consulta privada sin efectos secundarios.

## Tres canales, dos proveedores

- Correo: Resend existente, con dominio/remitente configurados y verificados.
- SMS y WhatsApp: Sent v3, plantilla de autenticación aprobada y canal configurado
  exclusivamente en el servidor (`SENTDM_OTP_CHANNEL=sms` o `whatsapp`).
- Una lista de canales en Sent puede producir varios envíos; no se interpreta como
  fallback automático. No hay reintentos de envío ocultos que dupliquen cobros/códigos.
- Confirmar teléfono no verifica correo. Una respuesta `QUEUED` no demuestra entrega.

Los OTP no se guardan en claro ni se registran en logs. Son de un solo uso, con
caducidad e intentos acotados. Consultar límites y diferencias de la versión
instalada en [la composición de autenticación](../app/src/auth/README.md).

## Información mínima en Stripe

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

1. Respaldar y revisar duplicados, permisos y estado de los esquemas. Aplicar una
   vez `_meta/migration/70_stable_identity_bindings.sql` en la fuente canónica.
   Conserva IDs/árbol/rangos; el UUID se asigna una vez. No backfillear por separado
   dos copias que deban compartir identidades: clonar desde la fuente ya migrada.
   La migración también es requisito antes de actualizar la API Bun y Payments,
   aunque se conserve Cognito: el adaptador requiere las columnas/tablas nuevas y
   Checkout no infiere un UUID si falta la columna.
2. Dar al runtime de autenticación un rol autorizado para sus tablas `auth.*`
   (incluidos verification, rate_limit y jwks) y los comandos de identidad. No usar
   un lector ni ampliar PUBLIC. Las claves privadas de JWKS no son visibles a lectores.
   La aprobación de grants usa una conexión de operador, no el rol normal de signup.
3. Configurar fuera de Git el secreto Better Auth, URL/orígenes confiables, remitente
   y clave de correo, clave Sent, plantilla/perfil/canal. Los nombres están en
   `app/.env.example`; no pegar secretos en el chat ni en ejemplos versionados.
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
   Las pantallas actuales siguen llamando rutas Cognito: adaptar y validar esos
   flujos de login/registro/recuperación antes de cambiar la variable en producción.
   Este cambio no rediseña ni activa esas pantallas.
   Su logout debe llamar `POST /api/auth/sign-out` o `POST /api/auth/logout`:
   GET se rechaza cuando Better Auth está seleccionado, sin simular una revocación.
6. Probar un destinatario controlado y autorizado en cada canal y comprobar entrega,
   expiración, bloqueo y recuperación antes del corte. No migrar contraseñas Cognito
   mediante copia de hashes ni vincular usuarios por correos sin la revisión indicada.

Los OTP/sesiones expirados pueden purgarse con una tarea de retención separada.
No usar esa tarea para borrar vínculos, aprobaciones o evidencia financiera.
Los lectores de soporte deben usar identidad corroborada y balances con estado
explícito. Esta integración no concede acceso de Chatwoot a la base principal.

La recuperación financiera continúa bloqueada: habilitar login o metadatos no
habilita compras, liquidaciones ni compensaciones pendientes de revisión.
