# Refuerzo de sesiones y árbol administrativo

## Alcance

Cuatro defectos reproducidos y corregidos, sin migración ni cambios de saldos,
posiciones, rangos, compensación, permisos o remitente de correo:

- Logout: Better Auth 1.6.22 oculta algunos fallos al borrar sesiones. El hook
  previo verifica su cookie firmada con el mecanismo nativo y ejecuta un DELETE
  persistente por token antes de permitir borrar cookies. Un fallo devuelve 503
  genérico, sin fingir éxito; se puede reintentar. Cero filas es idempotente.
- Login con contraseña: conserva por petición el hash realmente verificado y,
  después del hook de identidad, usa una transacción corta con `FOR SHARE` para
  comprobar la credencial e insertar la sesión. El UPDATE de recuperación
  compite con ese bloqueo. Nunca se mantiene una transacción mientras identidad
  solicita otra conexión del mismo pool.
- Árbol administrativo: una respuesta 401/403 elimina datos y selección local,
  invalida cachés y peticiones pendientes. Respuestas tardías no restauran esos
  datos; una recarga explícita vuelve a consultar la autorización.
- Árbol administrativo: un HTTP 200 sin el contrato esperado ya no se considera
  una rama vacía válida. Se muestra error y se conserva la posibilidad de volver
  a consultar. Una lista vacía válida sigue aceptándose.

El límite de serialización es el HTTP publicado `/api/auth/sign-in/email`.
Los métodos internos `auth.api.signInEmail` y `auth.api.resetPasswordEmailOTP`
no deben incorporarse como vías alternativas que omitan los wrappers.
OTP, registro, vinculación y sesiones sólo de base de datos conservan sus reglas.

## Verificación

- Bun: 243 pruebas correctas, cero fallos; 18 pruebas requieren sus fixtures
  externos y no se ejecutan en la suite general. TypeScript correcto.
- PostgreSQL 17.11 aislado: 24 pruebas, 331 aserciones, cero fallos. Rol de
  autenticación restringido y pools de una conexión, con dos pools reales para
  las carreras. Se cubren ambos órdenes login/reset, DELETE, INSERT y COMMIT
  fallidos, revocación del token y preservación de otro usuario.
- Logout nativo con origen ajeno o cookie inválida no elimina sesiones.
- Sin pagos, OTP reales, cambio de contraseña de usuarios ni acceso a datos
  productivos para las pruebas de regresión.
- Portal: 655 pruebas correctas; administrador: 340, incluidas 18 regresiones
  del hook y panel reales; Core: 130. Cero fallos.
- El orden de relevancia de búsquedas conserva el orden del backend; ordenar
  por lado e ID sigue reservado a raíces y ramas.
- Smoke de los Workers compilados: portal 100 comprobaciones y administrador
  36, sin red externa, consultas reales ni mensajes.

Los bloqueos transaccionales siguen la [documentación de PostgreSQL](https://www.postgresql.org/docs/17/explicit-locking.html),
y las sesiones permanecen sin [caché de cookies de Better Auth](https://better-auth.com/docs/concepts/session-management).

## Publicación

- Core Worker `c6e0ea92-d972-42bf-95a4-9049f91f432a`, 100 %.
- API v13, 100 %, instancia saludable, cero errores y rollout terminado.
- Imagen `mindbliss/api-session-guards-20261103`, digest
  `sha256:fe7a0ce3a71831bddc8a0ffd2390c596c34736a696d853a847bc576245207f9e`.
- Sólo cambió la imagen de la API: motor v1, pagos v15 y retiros v3 intactos.
  Se conservaron flags, bindings y secretos de correo.
- Portal sin cambios de código ni nuevo despliegue: versión publicada
  `9a33313a-5af7-46c2-b795-92f4ddffbbc7`; utiliza el backend actualizado.
- Administrador `26d2dfd`, Worker
  `eca0250c-1d12-47ab-8c8c-b35c708821ba`, 100 %. Compilación y smoke offline
  correctos; 6 rutas y 5 chunks comprobados por GET con digest e inmutabilidad.
  Variables, cinco nombres de secretos y bindings coinciden con la referencia.
- En producción se usaron sólo comprobaciones de metadatos/GET y un rechazo
  vacío de origen ajeno, sin sesiones reales, mensajes ni facturas nuevas.
