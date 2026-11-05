# Lista de accesos OTP — comprobación de 2026-11-05 (Bogotá)

La lista canónica para solicitar OTP de acceso reside en `auth.user` del mismo
PostgreSQL productivo. `mlm.person` conserva los datos del legado y la red; su
presencia no sustituye al principal Better Auth. No es necesario exportar esa
lista a Resend Audience ni a Cloudflare Email. El proveedor únicamente transporta
los mensajes que el usuario solicita; su aceptación no verifica la dirección.

## Comprobación de sólo lectura

El plan revisado, ejecutado con el validador real `z.email()` y los mismos límites
de longitud de los portales, encontró 120.604 principales existentes y **cero
personas nuevas elegibles** para incorporar. Ninguna cuenta existente tiene
espacios externos o mayúsculas en su email canónico.

La clasificación estricta de las personas sin principal de email coincidente
encontró 519 excepciones:

| Motivo exclusivo | Personas |
| --- | ---: |
| Formato incompatible con el validador o longitud admitida | 463 |
| Espacios externos que impiden vincular el legado de forma segura | 12 |
| Restricción explícita o email listado | 44 |

Los conteos anteriores obtenidos con una expresión SQL básica eran candidatos
preliminares, no permisos para crear cuentas. La normalización completa y el
validador real son obligatorios antes de cualquier alta. No se corrigen dominios,
direcciones o identidades por conjetura ni se levantan bloqueos para completar
una importación.

## Operador preparado

`app/scripts/pending-email-access-migration.ts` usa ahora la política email-only
aprobada y el formato `pending-email-access-v2-email-only`. Mantiene las demás
restricciones, la revisión del destino, respaldo verificado para aplicar,
transacción, comprobaciones de esquema y protección contra duplicados. Rechaza
los planes del formato anterior. Es una herramienta administrativa explícita;
no se ejecuta al arrancar ni queda programada automáticamente.

La prueba sintética confirma seis tests unitarios y 24 comprobaciones PostgreSQL,
sin red externa ni proveedores reales. Compartir teléfono o nombre con alguien
listado no bloquea a otra persona. Los inserts autorizados sólo crearían accesos
pendientes sin contraseña, sesiones, bindings ni privilegios; nunca marcarían
correos como verificados ni modificarían personas, árbol, ventas o saldos.

En esta comprobación productiva se ejecutó **sólo el plan de lectura**. Al no
existir nuevos candidatos elegibles, no se ejecutó `--apply`, no se enviaron OTP,
no hubo cambios de base de datos y no se desplegó ningún Worker o Container.
Los planes y sus identificadores permanecen fuera del repositorio con ACL privada.

Para futuras incorporaciones debe generarse un plan nuevo siguiendo
`docs/pending-email-access-migration.md`; no se reutiliza esta instantánea como
una lista blanca permanente. Los nuevos usuarios completan el registro normal y
los conflictos históricos requieren revisión individual.
