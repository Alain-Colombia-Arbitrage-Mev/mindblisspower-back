# Recuperación completa y límites diarios

## Política aprobada

- Cinco solicitudes de código de recuperación y diez intentos de canje por
  correo en las últimas 24 horas, compartidos entre dispositivos, IP, portal y
  administrador. No se reinician al recargar ni al solicitar otro código.
- Se conservan tres intentos por OTP, su caducidad y el cooldown de envío de
  cinco minutos. Las peticiones ya rechazadas por ese cooldown no consumen una
  solicitud diaria. Un envío rechazado por el proveedor sí fue una solicitud;
  no se reintenta automáticamente ni se afirma que se entregó.
- El canje cuenta peticiones con formato válido, incluso con un OTP incorrecto,
  vencido o reutilizado. Los errores locales de formulario no validan un OTP.
- Al agotarse un cupo, HTTP 429 indica mediante `Retry-After` cuándo vence el
  evento más antiguo. No se bloquea la cuenta ni se cambia su estado, correo,
  acceso, posición, saldo o compensación. El cooldown compartido de envío y las
  defensas por IP siguen siendo independientes del límite diario.

## Proceso obligatorio

Correo original → solicitar código → OTP de recuperación vigente → contraseña
nueva de 12–128 caracteres y confirmación coincidente → confirmación real del
backend. La posesión del correo nunca se presume por conocer su dirección.
El código se consume una sola vez; guardar hash, verificar correo y revocar
sesiones siguen en la transacción atómica existente. No se inicia una sesión
automáticamente ni se reasigna una identidad de la red.

El backend cubre `/email-otp/request-password-reset` y
`/email-otp/send-verification-otp` con `type: forget-password` usando el mismo
cupo. Los enlaces clásicos, el alias obsoleto y el comprobador no consumible de
OTP permanecen cerrados para que no sustituyan este proceso.

## Persistencia y concurrencia

No hay migración, tabla, proveedor o permiso nuevo. Se reutilizan hasta dos
registros de `auth.verification` por destinatario, con identificadores HMAC y
listas acotadas de cinco/diez timestamps, sin correo ni OTP en texto plano.
Es una ventana móvil real: no permite gastar dos cupos consecutivos en una
frontera de ventana fija. La expiración sigue al último evento + 24 horas;
la limpieza nativa puede eliminar el registro sólo cuando todos han vencido.

Las actualizaciones mantienen los predicados CAS de identificador, contenido y
vencimiento en el UPDATE exterior. La reserva inicial usa
`ON CONFLICT (id) DO NOTHING RETURNING`; un conflicto conocido se vuelve a leer
sin abortar la transacción. No se ocultan otros fallos de base de datos como
cuota agotada. Se precomprueba el cupo de solicitudes antes de reservar el
cooldown compartido.

## Verificación

- Bun: 253 pruebas aprobadas, cero fallos; 18 pruebas requieren fixtures y no
  se ejecutan en la suite general. TypeScript correcto.
- PostgreSQL 17.11 aislado: 30 pruebas, 480 aserciones, cero fallos. Incluye
  reservas iniciales y cerca del máximo con dos pools, ventana móvil exacta,
  persistencia, reinicios, aliases y acceso normal sin bloqueo diario.
- Portal: 659 pruebas aprobadas, cero fallos; muestra límites y espera legible
  por horas sin modificar el diseño ni los contadores globales del login.
- Sin OTP, contraseñas, sesiones ni cobros reales en estas pruebas.

Documentación contrastada con [Email OTP de Better Auth](https://better-auth.com/docs/plugins/email-otp)
y [sus límites de peticiones](https://better-auth.com/docs/concepts/rate-limit),
además del código instalado de la versión 1.6.22. El cupo por destinatario es
una protección propia, adicional a los límites nativos por IP y por OTP.
