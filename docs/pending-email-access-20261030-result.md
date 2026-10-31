# Recuperación de acceso por correo — 2026-10-30

## Aplicado en producción

Se incorporaron **107.252 principales Better Auth pendientes**, sin verificar
el correo, crear contraseñas, sesiones, roles, personas ni vínculos de identidad.
El administrador existente se conservó. Una dirección de prueba expresamente
indicada por el titular, ausente del legado, se preparó por separado como
principal no verificado, sin nodo ni privilegios.

| Clasificación del legado | Personas |
| --- | ---: |
| Aptas, incorporadas como pendientes | 107.252 |
| Formato de correo incompatible | 463 |
| Espacios externos que requieren revisión | 1.075 |
| Correo normalizado compartido | 100 |
| Bloqueo o estado no disponible | 12.235 |
| Vínculo anterior ya existente | 1 |
| Total revisado | 121.126 |

La clasificación es exclusiva y sigue ese orden; por ejemplo, un correo inválido
que también esté bloqueado se contabiliza en la primera exclusión aplicable.
No certifica que un buzón exista ni que pueda recibir mensajes.

## Evidencia de seguridad

- Respaldo limitado a `auth.user`, cifrado con age; restauración en PostgreSQL
  18 aislado, sin red y con almacenamiento efímero. La fila anterior y el digest
  coincidieron; el hash del archivo se verificó antes de aplicar.
- Plan y recibo privados, fijados al destino y al conjunto exacto de IDs.
  La transacción confirmó las 107.252 inserciones y sus postcondiciones.
- Comprobación posterior: los 107.252 accesos siguen neutrales y no verificados,
  sin cuentas proveedor/contraseña, sesiones ni bindings. Sus personas originales
  siguen sin `user_id` asignado.
- Totales posteriores: 107.254 principales de autenticación, 121.126 personas,
  121.072 afiliados y un binding anterior. Ninguna operación financiera formó
  parte del procedimiento.
- La verificación de un correo histórico sólo habilita una sesión limitada.
  El JWT de acceso a la red exige la vinculación aprobada por separado.

Los respaldos, claves, planes y recibos están fuera del repositorio, bajo ACL
privadas. No se guardan DSN, contraseñas ni códigos en este informe.

## Publicación y pruebas

- Operador y pruebas: commit backend `8e48281`.
- Portal: commit `fe01b14`, Worker de producción
  `64fac4a0-c560-4807-833c-63a9cbe1b4fa`.
- Portal: 397 pruebas, typecheck y build aprobados; 50 comprobaciones de runtime
  Workers sin red externa ni mensajes reales.
- Migración: 5 pruebas unitarias / 28 aserciones y 17 aserciones PostgreSQL
  aisladas, incluyendo rollback, idempotencia y rechazo de triggers inesperados.
- Lifecycle: Better Auth y política de identidad reales, con almacenamiento y
  SQL sintéticos estrictos: 5 pruebas / 138 aserciones.
- Login, registro y sesión anónima del portal publicados responden correctamente;
  login y sesión del administrador también. Las respuestas de autenticación
  mantienen `private, no-store`.

No fue necesario redesplegar la API: el cambio del backend es un operador
administrativo externo, no una modificación del servidor HTTP. Los servicios
Go, las restricciones financieras y Chatwoot no se modificaron.

## Prueba real de correo

Se realizó una única solicitud OTP por cada una de las dos direcciones
autorizadas, desde el portal publicado. Ambas respondieron HTTP 200 y generaron
un desafío activo. No se leyeron ni canjearon códigos; tampoco se reenviaron.

HTTP 200 y la existencia del desafío no prueban entrega al buzón. La confirmación
final requiere los metadatos del proveedor o la confirmación del destinatario.
No se envió ningún correo a la cohorte masiva y no se marcó a sus titulares
como verificados.
