# Revisión del esquema productivo — 3 de noviembre de 2026 UTC

## Alcance y resultado

Se comparó el catálogo real de PlanetScale con las consultas del backend Go,
Better Auth, portal y administrador que están habilitadas en producción. No se
ejecutó la carpeta histórica de migraciones en bloque ni sincronización
automática de Drizzle/Better Auth.

La inspección inicial encontró 105 tablas, 19 vistas, 1.378 columnas, 278 índices,
1.467 restricciones y 46 funciones en aproximadamente 1,35 GB. Las consultas de
catálogo fueron `READ ONLY`, con límites de tiempo y TLS `verify-full`. No se
extrajeron correos, contraseñas, códigos, sesiones ni contenido de clientes.

No se detectaron índices inválidos ni restricciones sin validar. Better Auth,
identidad, NOWPayments, reportes de ventas y vistas de rangos estaban presentes.
No hace falta otra tabla para recuperar contraseñas: los códigos usan
`auth.verification`, las credenciales `auth.account` y las sesiones `auth.session`.

## Faltantes reales reparados

La migración revisada `88_runtime_read_schema_repair.sql` se aplicó una vez a
`mindbliss_curated_20261025`, a las **03:54:16 UTC**.

| Objeto | Consulta afectada | Reparación |
| --- | --- | --- |
| `support.news` | `payments/news.go`, `GET /api/member/news` | Tabla inicialmente vacía, PK e índice parcial de publicaciones. |
| `mlm.person.country` | `payments/profile.go`, `payments/admin_export.go` | Columna `text NULL`, sin default ni backfill. |
| `mlm.person.payout_wallet_usdc` | Las mismas consultas de perfil/exportación | Columna `text NULL`, sin default ni backfill. |

La reparación conserva el contrato de las migraciones antiguas 48/53, sin sus
permisos de escritura heredados. Las nuevas columnas no afirman país ni asignan
billeteras a ningún usuario y no habilitan retiros.

Sólo `mindbliss_go_payments_reader_v1` recibe `USAGE` del esquema `support` y
`SELECT` sobre las cinco columnas de `support.news`. El login de pagos hereda
ese grupo. No recibe escritura ni uso/lectura de la secuencia. El lector ya
tenía `SELECT` de tabla sobre `mlm.person`, por lo que no se añadieron permisos
en esa tabla. Tampoco se habilitó acceso a tickets o documentos de soporte.

El aplicador verificó el destino, la rama, el hash del SQL y el servidor primario.
La transacción tiene `lock_timeout=2s`, `statement_timeout=30s` y una guarda de
ejecución única. Un estado inesperado cancela el cambio completo.

SHA-256 del SQL revisado:
`91a85d15e9bd5b0769a75d4c93f907a1ed248239ab69abeed60351af3cb53389`.

## Verificación

Prueba reproducible, sin credenciales ni acceso a producción:

```powershell
node app/scripts/test-runtime-schema-repair-postgres.mjs --synthetic-docker
```

El ensayo usa PostgreSQL 17.11 fijado por digest, contenedor efímero, red `none`,
almacenamiento `tmpfs` y ningún puerto publicado. Pasaron 55 comprobaciones:
consultas reales con un login de lectura heredado, denegación de escrituras,
aislamiento de otros roles, datos y ACL originales intactos, ausencia de
reescritura, rechazo de reaplicación y rollback íntegro ante fallos.

Después de aplicar en producción se comprobó:

- Una revisión independiente confirmó 106 tablas, 19 vistas, 1.385 columnas y
  280 índices: exactamente una tabla, siete columnas y dos índices adicionales.
- Las dos columnas son opcionales, tipo `text` y sin defaults.
- `support.news` está vacía y sus dos índices son válidos.
- El archivo físico y los triggers de `mlm.person` no cambiaron.
- Las consultas exactas de perfil y noticias compilan; no se exportaron filas.
- Los permisos efectivos del lector permiten leer, no escribir.
- Auth, NOWPayments y el lector general no reciben acceso a noticias.
- La matriz de permisos de las tablas anteriores permaneció idéntica.
- Los accesos públicos a noticias/perfil sin sesión conservan HTTP 401 y
  `private, no-store`; login y recuperación responden HTTP 200.

No se comprobó una sesión de cliente real ni se solicitó ningún OTP. Las pruebas
del rol restringido se realizaron localmente; en producción las consultas se
validaron como operador y los permisos mediante el catálogo efectivo.

## Lo que no se cambió

No hubo modificaciones de filas existentes, correo, identidad, contraseñas,
árbol, posiciones, rangos, ventas, saldos, principal, ROI ni compensación.
No se enviaron mensajes ni se habilitaron SMS, Chatwoot, campañas o endpoints de
escritura. No se necesita un redepliegue de Workers para estos cambios aditivos.

Faltantes de módulos apagados se mantienen separados: `auth.sms_opt_in`, tablas
de campañas `comms.*`, agentes/llamadas de soporte y ramas de cobros heredadas.
Su ausencia no justifica activarlos o crear tablas sin un flujo operativo.

## Pendientes de arquitectura, no aplicados

- No se encontró un journal central de migraciones. Hay rutas históricas de un
  solo uso y dos archivos con prefijo 75; no deducir aplicación por numeración.
- Hay 85 FK candidatas sin índice prefijo incondicional. Algunas tienen índices
  parciales o pertenecen a legado/tablas vacías; evaluar consultas y planes
  antes de añadir índices que aumenten el tamaño y el coste de escritura.
- Los correos de Auth no presentan duplicados normalizados, espacios exteriores
  ni mayúsculas en la comprobación agregada. Sólo existe `UNIQUE(email)`;
  considerar una garantía normalizada en una migración separada revisada.
- `mlm.binary_block_payment_shadow` carece de PK y es un objeto legado; no se
  modificó ni eliminó.
- El mayor peso está en `mlm.affiliate_closure` (~779 MB) y `mlm.affiliate`
  (~219 MB), no en las pequeñas tablas de autenticación o comunicados. Una
  optimización del árbol necesita medir lecturas e integridad antes de depurar.

Los inventarios operativos de metadatos y evidencias del aplicador se conservaron
en carpetas locales ignoradas. No equivalen a un respaldo de datos ni a PITR;
no se atribuye a un respaldo de esquema la capacidad de restaurar ventas o árbol.
