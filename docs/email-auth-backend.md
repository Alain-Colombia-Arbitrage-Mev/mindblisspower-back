# Códigos de autenticación por email

## Componentes y costos

Better Auth 1.6.22 es la librería MIT instalada dentro de la API Bun existente.
No se contrata su infraestructura gestionada, no hay una suscripción de
autenticación ni un servidor adicional. PostgreSQL existente guarda cuentas,
sesiones, desafíos y límites. Cloudflare sólo entrega el correo.

El procesamiento y almacenamiento siguen consumiendo la infraestructura propia.
Cloudflare Email Sending tiene sus propios requisitos y cuotas: esta integración
no cambia planes, contrata servicios ni garantiza envíos ilimitados gratuitos.
SMS y WhatsApp permanecen desactivados en el perfil de email.

Referencias oficiales: [Better Auth](https://better-auth.com/pricing) y
[Cloudflare Email Sending](https://developers.cloudflare.com/email-service/platform/pricing/).

## Contrato HTTP

La composición `app/src/auth.ts` ya conecta `createAuthOptions` con PostgreSQL y
`createAuthDelivery` con Cloudflare. No hay un generador de códigos independiente:
Better Auth genera el desafío y verifica su canje.

1. `POST /api/auth/email-otp/send-verification-otp`
   con `{"email":"miembro@example.test","type":"sign-in"}` solicita el código.
2. `POST /api/auth/sign-in/email-otp`
   con `{"email":"miembro@example.test","otp":"123456"}` canjea el código.
3. Sólo un código válido crea la sesión y su cookie HttpOnly. Los endpoints
   privados de la API verifican esa sesión antes de ejecutar sus servicios.

En navegador, usar las rutas del BFF del mismo origen y sus cookies; no almacenar
tokens en localStorage. Con `AUTH_BFF_SHARED_SECRET` configurado, Bun exige el
contexto firmado por el BFF: no quitar esa protección para probar una llamada.
Esta integración del backend no cambia las pantallas actuales de Cognito.

El código tiene seis dígitos, caduca en cinco minutos y permite tres intentos.
La base persiste su HMAC, no el código en claro. El canje correcto lo consume y
no permite reutilización. El límite de reenvío por destinatario persiste entre
procesos y actualmente espera hasta la expiración original, cinco minutos.
El contador por IP también vive en PostgreSQL; no requiere otro servicio pago.

No existe registro automático al solicitar un código para un correo desconocido.
Que una persona figure en `mlm.person` no crea por sí solo una cuenta de acceso.
El vínculo con personas heredadas exige el procedimiento aprobado de identidad;
iniciar sesión no mueve nodos, cambia rangos ni habilita pagos.

La respuesta genérica de solicitud de acceso no prueba que exista una cuenta ni
que el correo se haya entregado. Se conserva para no enumerar cuentas. Los
rechazos confirmados del proveedor retiran únicamente el reto de ese destinatario,
propósito y HMAC; no reinician el presupuesto de cinco minutos. Una confirmación
ambigua, timeout o 5xx no retira un código que podría haberse entregado.

Si el envío del registro recién creado fue rechazado, devuelve
`503/AUTH_EMAIL_DELIVERY_UNAVAILABLE`: la cuenta sigue pendiente, sin sesión ni
correo verificado. El BFF permite continuar a verificación y pedir un código
manualmente después del plazo, sin crear una segunda cuenta. No anuncia entrega
confirmada. Los errores no disparan reintentos o fallback. Los diagnósticos sólo
contienen clasificación, estado HTTP y código numérico; nunca correo, OTP,
credenciales ni texto/cuerpo del proveedor.

Las esperas están ordenadas: proveedor 8 s, BFF 20 s para envíos y navegador 30 s.
El canje conserva límites más cortos (BFF 8 s / navegador 12 s). La cancelación del
cliente sigue siendo efectiva y no hay reenvíos automáticos. `Retry-After` se
calcula desde el plazo persistente, sin ampliarlo ni reducir controles de intentos.
El checker opcional que valida sin consumir el OTP está deshabilitado por HTTP;
los helpers de lectura/creación son server-only en la versión instalada.

## Configuración y arranque

Mantener los secretos fuera de Git. Para desarrollo, desde `backend/app`,
`bun run dev:local` carga explícitamente `backend/.env.local`.
`bun run start:local` usa el mismo archivo sin watch. Los comandos genéricos
`dev`/`start` y Docker siguen usando el entorno que inyecta su ejecutor.
Docker recibe su configuración mediante `RUNTIME_DIR/api.env`; no copia el
archivo privado de desarrollo a la imagen.

Antes de activar, revisar:

- `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_EMAIL_API_TOKEN` y `AUTH_EMAIL_FROM`.
- `BETTER_AUTH_SECRET`: secreto aleatorio estable de al menos 32 caracteres.
- `BETTER_AUTH_URL` y `BETTER_AUTH_TRUSTED_ORIGINS`: URLs reales de API y portales,
  HTTPS en producción. No inferir dominios desde encabezados del cliente.
- Migración `70_stable_identity_bindings.sql` aplicada en la base canónica revisada
  y rol runtime con los permisos de escritura necesarios en `auth.*` e identidad.
  No usar la cuenta de Chatwoot, un lector, ni ampliar permisos de PUBLIC.
- Contexto/IP confiable y secreto HMAC coordinados entre BFF y Bun.
- `BETTER_AUTH_EMAIL_OTP_ENABLED=true` y `BETTER_AUTH_PHONE_OTP_ENABLED=false`.
  JWT permanece apagado hasta coordinar sus consumidores; no se necesita para
  probar las sesiones propias de la API Bun.

Los flags OTP no apagan por sí solos otros métodos existentes de autenticación.
No cambiar Cognito o login con contraseña sin revisar el corte completo. Una
respuesta `/health` tampoco prueba que las tablas o permisos de auth estén listos.
No ejecutar migraciones automáticamente al iniciar la API.

## Verificación

`app/src/auth/email-flow.integration.test.ts` cruza el handler HTTP real de Better
Auth y el transporte real de Cloudflare con un fetch sintético. Comprueba el
desafío, HMAC, caducidad, intentos, sesión, cookie, replay, limitación de reenvío,
usuario desconocido y fallos del proveedor. No utiliza credenciales reales ni red.
El harness de identidad prueba PostgreSQL aparte, en una instancia desechable.

Estas pruebas no aplican cambios a la copia curada ni a PlanetScale. La activación
operativa debe completarse con configuración y migración revisadas, seguida de
una prueba controlada; no equivale a habilitar compensaciones o pagos.
