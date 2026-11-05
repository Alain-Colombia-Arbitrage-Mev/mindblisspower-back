# Corrección de accesos con identidades duplicadas del legado

## Problema que debe distinguirse de un cambio de rango

El rango y la posición pertenecen al afiliado, no al correo ni a la sesión.
Una migración puede haber conservado dos personas que compartían un correo y
haber asignado una dirección de deduplicación a una de ellas. Una coincidencia
única del correo moderno no demuestra cuál era la cuenta comercial elegida.
No se debe resolver ese caso otorgando un rango al nodo equivocado, trasladando
ventas por nombre o eliminando una de las posiciones.

La investigación del 5 de noviembre de 2026 confirmó un caso de este tipo:
el acceso existente conducía a una cuenta Bronce, mientras que el usuario legado
reportado conservaba Embajador en otra persona. La comparación de usuario,
teléfono y correo de origen corroboró la cuenta correcta. Los identificadores y
datos personales del caso se conservan únicamente en el expediente privado y en
la auditoría de operación, no en este documento.

## Evidencia y autorización

Antes de corregir:

1. Consultar con una transacción `READ ONLY`, TLS `verify-full`, tiempo de
   ejecución y espera de locks limitados.
2. Contrastar identificadores de persona/afiliado, usuario legado, contacto
   reportado, rango e hitos, estado de bloqueo y vínculos de autenticación.
3. Revisar las ventas del reporte activo y las compras NOWPayments verificadas
   por separado. Una compra comunicada por soporte no es un comprobante de pago.
4. Obtener autorización explícita para la cuenta origen y destino. No aplicar
   reactivaciones o reasignaciones masivas por similitud de nombre o teléfono.
5. Guardar una instantánea privada de los campos afectados y el hash del SQL
   revisado. Detenerse si cambia la evidencia antes de aplicar.

## Corrección sin reutilizar la identidad equivocada

La receta revisada está en
[`20261105_correct_legacy_identity_access.sql`](../_meta/ops/20261105_correct_legacy_identity_access.sql).
Es una operación manual de mantenimiento, no una migración automática ni un
endpoint de registro.

Su destino es el esquema productivo ya verificado. Guardar esta receta en
`main` no instala las tablas de ese esquema ni autoriza ejecutar migraciones
históricas o desplegar una versión antigua del backend.

Se utilizan dos transacciones acotadas y un nuevo principal Better Auth pendiente:

- Primero, sólo el correo del principal anterior pasa a un alias único bajo
  `.invalid`; queda sin verificar y se revocan sus sesiones y desafíos previos.
  Los correos de ambas personas comerciales siguen intactos en esta primera fase.
- Se registra la cuarentena en auditoría. La segunda fase se prohíbe en SQL hasta
  seis minutos después: cinco minutos del JWT más un minuto de margen. No existe
  un parámetro de producción para saltarse la espera.
- Su vínculo inmutable y sus cuentas de autenticación no se reasignan ni borran.
- Después, el correo de la persona incorrecta pasa al mismo alias de cuarentena
  y la persona correcta recibe el correo original. Sus UUID, afiliado, rango,
  puntos históricos, patrocinador y posición no cambian.
- Se prepara un nuevo `auth.user` con `email_verified=false`. No se crean
  contraseñas, sesiones ni vínculos de acceso por anticipado.
- Se invalidan solamente los desafíos OTP previos de ese correo y de los tres
  propósitos de email. No se restablecen los presupuestos ni los límites diarios.
- El titular solicita y verifica un OTP nuevo. El flujo normal de provisión
  vincula entonces el principal nuevo a la persona correcta.

No se reutiliza el principal anterior: revocar sus sesiones no revoca por sí solo
un JWT ya emitido. Las peticiones nuevas del portal obtienen un JWT mediante una
sesión nativa vigente, pero una petición ya iniciada puede retenerlo en memoria.
La espera obligatoria impide transferir el correo mientras esa autorización
anterior pueda seguir vigente. No hace falta apagar triggers, compartir cookies
o rotar secretos globales.

## Candados de la operación

- Destino activo, no administrativo, no bloqueado y sin otra identidad vinculada.
- Colisión de correo/alias, actor no autorizado, deriva o reaplicación: rollback.
- Identidad pública y vínculo anterior permanecen inmutables.
- Ni filas de afiliados ni hitos de rango ni tablas financieras se modifican.
- La auditoría registra actor, operación y estado anterior/posterior sin códigos,
  tokens, contraseñas, hashes de contraseña ni payloads de proveedores.
- Un fallo de comunicación tras el commit obliga a verificar por lectura el
  recibo/auditoría; no autoriza a repetir ciegamente la operación.

## Validación y recuperación

La prueba sintética debe cubrir las dos fases, rechazo de la finalización
prematura, conservación de terceros y del árbol completo,
sesiones antiguas revocadas, principal nuevo pendiente, desafíos de otros correos
intactos, colisiones, reaplicación y rollback ante una mutación inesperada.

Después de aplicar, verificar por lectura que el correo resuelve a la persona y
rango correctos, el principal anterior no tiene sesiones ni verificación y el
nuevo sigue pendiente hasta el OTP real. La comprobación técnica no sustituye la
confirmación del titular al entrar al portal. No solicitar ni canjear su código.

Una reversión posterior al commit requiere otra operación autorizada, revisando
si ya se verificó o vinculó el principal nuevo. No restaurar sesiones revocadas
ni trasladar ventas o saldos como parte de una reversión de identidad.

## Ensayo y aplicación del caso revisado

El 5 de noviembre de 2026 se ejecutaron dos ensayos independientes del protocolo
de dos fases sobre PostgreSQL 17.11 efímero, sin red ni puertos publicados: 105
comprobaciones aprobadas por ensayo. Se validaron también finalización prematura,
deriva entre fases, sesión tardía, bloqueo sobrevenido, rollback, repetición y
conservación global de las tablas sintéticas de negocio.

Tras la autorización explícita del propietario, se aplicaron ambas fases del
caso investigado en producción, contando seis minutos desde la confirmación de
la primera transacción. La verificación de lectura confirmó que el correo
reportado corresponde a la persona cuyo rango conservado es Embajador y que el
principal anterior quedó sin sesiones ni correo verificado. Se preservaron sus
vínculos inmutables y ambos afiliados. No se creó ni trasladó la compra reportada
de USD 100: no estaba atribuida en las fuentes vigentes consultadas.

El acceso nuevo quedó pendiente de la verificación personal por OTP. No se
enviaron ni canjearon códigos y no se comprobó una sesión real del titular.
Los planes, recibos y datos personales del caso permanecen en el expediente
privado ignorado por Git y en la auditoría acotada de la operación.
