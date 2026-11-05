# Accesos pendientes por email: operación revisada

Este procedimiento aprovisiona únicamente principales de acceso Better Auth.
No equivale a verificar una dirección, recuperar la propiedad de una cuenta
histórica, aprobar una vinculación ni habilitar compensaciones. No crea personas,
afiliados, posiciones, rangos, ventas, movimientos o comisiones.

## Alcance y exclusiones

Operador: `app/scripts/pending-email-access-migration.ts`, ejecutado con Bun y
`--no-env-file`. No se importa desde el servidor ni se ejecuta al arrancarlo.
La conexión llega exclusivamente mediante `PENDING_ACCESS_DATABASE_URL`; nunca
se imprime ni se pasa como argumento de terminal. Para conexiones no locales
se exige TLS verificado y parámetros de conexión limitados.

El modo predeterminado es planificar dentro de una transacción de sólo lectura.
La cohorte admite personas `pending` o `active`, sin `user_id`, con correo válido
según el validador `z.email()` usado por Better Auth, con máximo de 254 caracteres
compatible con los portales. Excluye:

- Formatos inválidos y espacios al principio/final. Recortar un email histórico
  podría impedir encontrar su persona original después de verificarlo.
- Colisiones entre emails normalizados, aunque uno esté bloqueado o sea inválido.
- Estados suspendidos, baneados, eliminados y coincidencias en blacklist por
  email, teléfono o nombre/fecha, conforme a la política de registro existente.
- Afiliados suspendidos/baneados/eliminados, personas ya ligadas y principales
  existentes. Nunca se modifican, fusionan o sustituyen estos registros.

Los correos mayúsculos únicos se guardan en minúscula. El plan contiene sólo
IDs de auditoría, UUID aleatorios previstos, hashes de emails, conteos y digests;
no copia nombres ni correos claros a logs. Todos los archivos operativos deben
estar fuera del repositorio, con ACL privada; `mode:0600` no sustituye las ACL
de Windows. Cualquier respaldo con PII debe estar cifrado.

## Plan, respaldo y aplicación

1. El operador responsable confirma el destino. `--target` es SHA256 del JSON
   `[hostnameEnMinúscula, puertoComoTexto, database]`; no es una credencial.
2. Ejecutar el plan sin `--apply`, indicando `--plan-file` privado y `--target`.
   La creación del plan es exclusiva y nunca sobreescribe otro plan.
3. Revisar conteos, exclusiones, runId, digest, esquema y destino. El límite es
   150.000 personas; estados o esquema inesperados requieren revisión.
4. Crear un respaldo reciente, cifrado y con restauración ensayada. El manifest
   de respaldo requerido tiene esta forma, sin incluir credenciales:

   ```json
   {
     "format": "pending-access-backup-v1",
     "target": "SHA256_DEL_DESTINO",
     "archivePath": "RUTA_ABSOLUTA_PRIVADA_DEL_ARCHIVO_CIFRADO",
     "archiveSha256": "SHA256_REAL_DEL_ARCHIVO",
     "completedAt": "FECHA_UTC_ISO",
     "restoreVerified": true
   }
   ```

   La atestación `restoreVerified` la establece el operador después del ensayo,
   no este script. Se comprueba el archivo real, su hash, antigüedad máxima de
   24 horas y correspondencia del destino antes de aplicar.
5. Aplicar sólo con `--apply`, el mismo `--plan-file`, `--target`,
   `--expected-digest` revisado y `--backup-manifest`. No hay reintentos
   automáticos. No debe invocarse directamente la función interna de aplicación
   omitiendo los controles del CLI.

La aplicación prepara primero un recibo privado con el conjunto exacto de IDs.
Después abre una transacción `SERIALIZABLE`, toma locks de tabla antes de fijar
el snapshot, revalida el esquema y toda la cohorte y comprueba el digest. Los
timeouts son 5 segundos para locks y 60 segundos por sentencia.

Sólo inserta las once columnas revisadas de `auth.user`: UUID, email canónico,
`email_verified=false`, nombre neutro `Cuenta pendiente`, timestamps, teléfono
no verificado y campos de imagen/contacto nulos. No crea contraseña, cuenta de
proveedor, sesión, JWT, rol, claim ni `identity.auth_binding`. Triggers, reglas,
RLS o columnas inesperadas impiden la ejecución. Cualquier error anterior al
commit revierte toda la transacción.

El recibo final permite auditar cuántos principales se insertaron y sus IDs sin
publicar direcciones. Si el resultado del commit es ambiguo, conservar plan y
recibo: una repetición sólo se considera ya aplicada cuando aparecen TODOS los
IDs con los hashes de email esperados. Un conjunto parcial o conflictivo aborta
para revisión manual; nunca se ejecuta DELETE automáticamente. Un reenvío no
revierte una verificación de email que el titular haya completado después.

## Dirección autorizada fuera de la cohorte

La dirección de prueba indicada por el titular queda fuera de la cohorte
histórica si no tiene una persona registrada. En ese caso, el operador
separado crea sólo su principal de autenticación, sin persona, afiliado, rango,
privilegios o binding. No se incorpora silenciosamente al plan masivo. La
verificación de email y el flujo ordinario de identidad siguen siendo necesarios.

Una prueba real exige autorización expresa de destinatario y número de envíos.
El conteo de desafíos y los metadatos de entrega no requieren leer códigos,
hashes OTP ni cuerpos de correo. HTTP 200 reconoce una solicitud; no demuestra
que Gmail la haya entregado a la bandeja de entrada. No se reintenta una entrega
ambigua automáticamente.

## Reversión manual

No existe un botón ni modo de rollback que elimine cuentas usadas. Una reversión
posterior al commit requiere revisión independiente, respaldo y exclusivamente
IDs del recibo cuyo email siga coincidiendo y que permanezcan sin verificar,
sin sesiones, cuentas de proveedor/contraseña, personas ligadas, bindings,
aprobaciones, claims ni otras referencias. También debe comprobarse que no hubo
actividad o cambios posteriores. Cualquier uso, referencia o duda excluye la
cuenta de una eliminación automática y requiere un procedimiento específico.

La verificación y aprobación de vinculación de usuarios históricos no se omite.
La presencia de un acceso pendiente no prueba propiedad de un nodo de la red.

## Pruebas aisladas

- `bun --no-env-file test scripts/pending-email-access-migration.test.ts` valida
  selección, colisiones, privacidad del plan y pins.
- `node scripts/test-pending-email-access-postgres.mjs --synthetic-docker`
  utiliza PostgreSQL efímero fijado por digest, tmpfs y `--network none`;
  comprueba neutralidad, no-op, rollback y guard de triggers. No acepta un DSN
  productivo, no contacta proveedores y elimina su contenedor de fixture.

Los datos reales y las credenciales no deben entrar en imágenes Docker ni tests.
