# Conexion Del Cliente Y Arbol - 2026-10-24

Rama: `feature/member-tree-data-20261024` en backend y cliente.

## Infraestructura QA

La conexion del arbol del cliente es directa a PostgreSQL, distinta de las APIs Go. Se agrega `MEMBER_DATABASE_URL` al cliente QA y un rol dedicado `qa_member_read`: solo SELECT en las seis tablas/vistas requeridas, USAGE en mlm, sin acceso a auth, sin privilegios de superusuario, creacion de roles/bases ni BYPASSRLS. Default de transaccion de solo lectura y timeout SQL de 8 segundos.

`member-read.sql` rechaza bases distintas de `mindbliss_qa`. La preparacion del contenedor existente verifica nombre, etiquetas Compose y configuracion sintetica antes de ejecutarlo. No se modifican bases recuperadas ni configuraciones productivas. La imagen PostgreSQL incluye el rol para futuros arranques desde cero; no fue necesario recrear PostgreSQL ni Redis existentes.

## Comprobaciones

- Rol creado y probado sin permisos de escritura en afiliados ni USAGE de auth.
- Modulo `memberDb` real ejecutado en la imagen de tests y el namespace de red del cliente: conexion correcta y `read_only=on`. Reporte agregado: `D:/vicionpower/reportes/member-data-diagnostics-20261024.json`.
- Prueba SQL de cliente con fixtures transaccionales: bloqueado a la izquierda y descendiente a la derecha conservan posiciones, parentesco, lado raiz y cobertura. ROLLBACK de las filas sinteticas.
- Docker cliente: 157 pruebas, typecheck y build aprobados; contenedor actualizado saludable. La imagen PostgreSQL se reconstruyo pero no se reemplazo el contenedor de datos.
- Arbol/referidos/pagos sin sesion: 401; smoke general: 24 comprobaciones; diagnostico Go: 15 lecturas HTTP 200.

El frontend en la rama homonima separa lecturas de arbol/pagos/referidos, valida datos, cancela consultas y hace visibles los fallos sin inventar saldos ni ubicaciones. No se cambio codigo Go ni reglas de colocacion/finanzas.

## Pendiente

Cognito no esta configurado en QA y no se uso un bypass. El informe declara `authenticatedBffVerified: false`. Los 2 usuarios y 0 afiliados QA no representan la base historica. Falta validar con copia aislada de datos reales y sesion autorizada antes de produccion. No hubo envios de OTP, operaciones Stripe ni despliegue productivo.
