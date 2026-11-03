# Recuperación de contraseña atómica

## Cambio

El POST productivo `/api/auth/email-otp/reset-password` ahora usa una transacción
PostgreSQL del escritor de autenticación. El consumo del OTP, la creación o
sustitución del hash, la comprobación del correo y la eliminación de sesiones
existentes se confirman juntos. La respuesta de éxito espera al `COMMIT`.

No se requiere migración, permisos nuevos, cambios de frontend, nuevos
proveedores, códigos reales ni cambios de correo, red o finanzas.

Better Auth 1.6.22 mantiene su hash, validación de OTP y consultas nativas. Para
esta petición se construye una instancia nativa con el adaptador enlazado a la
transacción. No basta envolver la instancia original: su handler sustituye el
contexto de adaptador al procesar la petición.

Las demás rutas siguen fuera de la transacción de recuperación. El login con
contraseña usa ahora su propia instancia y una transacción corta al insertar
la sesión (véase el refuerzo de sesiones del 3 de noviembre). No se activó `transaction:true`
global, porque los hooks de identidad usan otra conexión y podrían esperar a
sus propias filas sin confirmar. Se conservaron los predicados CAS del
adaptador de PostgreSQL y los límites de conexiones.

## Errores y límites

- Un OTP incorrecto, agotado o vencido devuelve su rechazo nativo y conserva el
  intento gastado o la limpieza. Revertir todos los errores 4xx permitiría
  intentos ilimitados.
- `onPasswordReset` marca la modificación sensible inmediatamente después de
  que el handler nativo guarda el hash. Se conserva cualquier hook anterior.
- Un error posterior a ese punto, incluso si parece un 4xx, revierte toda la
  operación. Lo mismo ocurre ante 5xx, excepción, respuesta inesperada o fallo
  de commit. El cliente recibe un error genérico, sin SQL, OTP ni contraseña.
- No se emiten cookies ni se inicia sesión automáticamente al recuperar.
- Los tiempos locales son: bloqueo 2 s, sentencia 10 s y sesión inactiva dentro
  de la transacción 15 s. No se contacta al proveedor de correo durante el reset.

El alcance es el endpoint HTTP publicado. No hay consumidores productivos del
método interno nativo `auth.api.resetPasswordEmailOTP`; no debe incorporarse un
consumidor que omita este límite transaccional.

El refuerzo posterior `secure-session-handler.ts` cierra también el login que
hubiese comprobado la contraseña anterior antes de la recuperación. Al guardar
su sesión, bloquea la credencial coincidente con `FOR SHARE` e inserta dentro
de esa misma transacción. Si gana el reset, ese hash ya no coincide y el login
se rechaza; si gana el login, el reset espera y elimina esa sesión. No se cambia
el correo, el hash nativo ni la vinculación de identidad.

## Pruebas

```powershell
node app/src/auth/test-password-recovery-postgres.mjs --synthetic-docker
```

El ensayo usa PostgreSQL 17.11 fijado por digest, Bun 1.4.4, rol restringido,
una conexión por pool de autenticación, red Docker aislada, `tmpfs` y ningún
puerto publicado. No hereda DSN de la aplicación ni llama a proveedores.

Se verifican primera contraseña, reemplazo y credencial vacía; fallos reales de
revocación, verificación de correo y commit diferido; conservación del mismo
OTP tras rollback; tres intentos incorrectos persistentes; rechazo de replay;
cookies antiguas inválidas; sesiones ajenas intactas; y registro/login sin
interbloqueos. Las pruebas unitarias comprueban además respuestas ambiguas,
aislamiento de peticiones y que el éxito no salga antes del commit.

La carrera reforzada usa dos pools independientes y observa el bloqueo real
en PostgreSQL antes de liberar la primera transacción. Sólo la ganadora cambia
el hash; la otra rechaza el OTP ya consumido sin escribir otra contraseña.

Resultado de esta revisión: 19 pruebas PostgreSQL y 273 comprobaciones, sin
fallos. La suite general de Bun pasó 239 pruebas y 3.357 comprobaciones; sus 18
pruebas que requieren entornos dedicados se omitieron en esa ejecución general.
El ensayo PostgreSQL anterior se ejecutó por separado. Typecheck correcto.

Se mantiene una prueba del comportamiento secuencial de la dependencia sin el
wrapper como regresión explícita; no representa la composición HTTP productiva.

## Publicación verificada

- Cloudflare Worker: `2d98b56c-647c-4301-bf99-c05a46613762`, 100 %.
- `core-api` versión 12, 100 %, saludable y sin errores de despliegue a las
  23:19:15 del 2 de noviembre de 2026 (America/Bogota).
- Imagen: `mindbliss/api-atomic-reset-20261102`, digest
  `sha256:09c9c7fd660ac785167683d07c9a05c7128669be2cf7cbdec102b14b7eb422a1`.
- Sólo cambió esa imagen. Motor v1, pagos v15, retiros v3, flags y configuración
  del remitente permanecieron iguales.

El GET público de sesión con una cookie enteramente sintética e inválida
comprobó la ruta BFF/API: HTTP 200, `private, no-store`, sin cookie de sesión
nueva. No es un restablecimiento real ni prueba entrega de correo. No se
solicitó ni canjeó ningún OTP de usuarios durante esta publicación.
