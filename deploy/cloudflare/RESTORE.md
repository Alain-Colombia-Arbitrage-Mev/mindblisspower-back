# Restauracion preparada para PlanetScale

Fecha: 2026-10-25. Alcance: preparar y ensayar la importacion, NO ejecutarla sobre
PlanetScale ni arrancar aplicaciones. No se relajan las guardas de backup.sh.

## Estado y bloqueos reales

- Origen elegido por el usuario: docker:mindbliss-local-recovery-20261022.
- El contenedor esta activo/unhealthy, pero PostgreSQL rechaza conexiones TCP
  internas en 5432. No se reinicio, reparo, exporto ni modifico su almacenamiento.
- Actualizacion 2026-10-25: el usuario declara credenciales rotadas. La conexion
  nueva se valido con TLS y transaccion READ ONLY. Una conexion exitosa no prueba
  por si sola que la credencial anterior fue revocada ni que Hyperdrive se actualizo.
- El nombre de la DB de origen, snapshot actual y esquemas a importar siguen sin
  verificar. Los 12,14 GB documentados corresponden a una revision anterior.
- El destino se reviso nuevamente: PG18.6, DB postgres sin tablas de app.
  No se verifico que sea una rama staging nueva, ni su modalidad o recursos.

No importar hasta resolver el origen, verificar revocacion y revisar el inventario real. Esta
copia historica no certifica ventas Stripe recientes: conciliar las ultimas
transacciones antes de considerar cualquier lanzamiento.

## Herramientas

restore_plan.py tiene SOLO dos operaciones: preflight de metadatos en una
transaccion READ ONLY y compilacion offline de una seleccion TOC. NO dispone de
apply, no ejecuta pg_restore, no instala extensiones ni escribe sobre una DB.
Un resultado requires-manual-review NO es aprobacion para restaurar o producir.

El preflight exige:

1. Confirmaciones explicitas de credencial rotada y origen accesible. Son
   declaraciones del operador, no prueba automatica de rotacion o de integridad.
2. URL administrativa separada de la app: host PlanetScale, puerto DIRECTO 5432,
   sslmode=verify-full y nombre de DB confirmado. No sustituye silenciosamente
   el 6432 de la aplicacion ni acepta URLs como argumentos del proceso.
3. PG18 principal, permisos para crear esquemas y public cuando se seleccione.
4. Destino sin objetos ajenos a extensiones ni esquemas de aplicacion previos;
   public y pscale_extensions se reconocen, no se borran ni se recrea public.
5. Politica revisada con esquemas explicitos y sin comodines. El ejemplo tiene
   lista vacia a proposito: no es un inventario de negocio ni una seleccion valida.
6. Manifiesto portable 17/18, archivo cifrado presente, nombre seguro, tamano y
   SHA256 correctos. Esto NO verifica por si solo autenticidad age, contenido SQL
   o procedencia del manifiesto: revisar esos puntos separadamente.
7. Extensiones de la lista revisada ya instaladas y pares de versiones aprobados
   exactamente cuando cambien. Timescale, cron y extensiones no revisadas bloquean;
   no se omiten silenciosamente ni se convierten sus datos.

El plan incluye huellas sin contrasena del destino y origen declarado, baseline de
metadatos, hash del archivo y de la politica aplicada. Repetir el preflight antes
de ejecutar; estas huellas son evidencia para revision, NO un bloqueo transaccional
contra cambios concurrentes ni un certificado de identidad de la rama cloud.

## Orden de trabajo

1. Rotar en PlanetScale la credencial expuesta, revocando la anterior; actualizar
   los destinos privados necesarios sin compartir valores por chat o PR.
2. Diagnosticar por separado el origen recuperado. Preservar primero su volumen y
   evidencias; no usar reset, initdb, upgrade in-place, reemplazo de imagen ni
   reparaciones automaticas para conseguir que arranque. Verificar DB, version,
   extensiones, esquemas, roles, funciones y fecha de la ultima transaccion.
3. Aprobar el coste e identidad de una rama staging NUEVA y aislada de PlanetScale.
   Nunca reutilizar una base poblada. Crear un rol temporal de restauracion con
   permisos minimos en el panel; no copiar roles del cluster ni usarlo para la app.
4. Generar una copia real del origen con las herramientas PG17 y el backup cifrado
   portable, sin detener ni cambiar posiciones. Mantener manifiesto, checksum,
   claves offline y copia externa. No etiquetar una copia real como drill ni
   saltarse el requisito de almacenamiento externo de production. Revisar roles
   aparte: no importar roles, passwords, owners o ACLs automaticamente.
5. Con servicios y jobs apagados, acordar TODOS los esquemas de negocio y revisar
   dependencias cruzadas, particiones y tablas fuera de la seleccion. No inferir
   que mlm sea el unico esquema ni eliminar datos historicos o staging sin permiso.
   Registrar el snapshot/ultima transaccion y conciliar Stripe/ledger por separado.
6. Revisar las extensiones disponibles y sus permisos en el destino. Su instalacion
   o cambio de version requiere una operacion separada aprobada; el planificador
   no ejecuta CREATE/ALTER EXTENSION. El ensayo prueba ltree 1.2 a 1.3, pero la
   politica real debe usar las versiones observadas, no copiarlas del ensayo.
7. Verificar age y el TOC completo del archivo sin enviar SQL o datos personales a
   logs. Revisar funciones, triggers, FDWs, conexiones externas, politicas RLS y
   SECURITY DEFINER. Un dump puede ejecutar codigo privilegiado; el filtro NO es
   una sandbox. [Advertencia oficial](https://www.postgresql.org/docs/18/app-pgrestore.html).
8. Completar runtime/restore.env y una politica privada siguiendo los ejemplos.
   Los flags de confirmacion permanecen no hasta verificar cada requisito.
   Usar una imagen de herramientas PG18 probada y fijar su ID/digest para la revision.
9. Ejecutar el preflight y revisar TODOS los blockers y manualReviews. Validar
   tambien en el panel organizacion/rama, TLS, permisos y aislamiento del origen.
10. Preparar la seleccion TOC descrita abajo y aprobar su SHA256 junto al archivo,
    plan, baseline, lista de esquemas, maintenance window y procedimiento de retorno.
11. Solo con autorizacion expresa para importar: usar pg_restore DIRECTO 5432,
    --single-transaction, --exit-on-error y --use-list de la seleccion revisada.
    Mantener los flags no-owner/no-acl/no-comments/no-security-labels/
    no-publications/no-subscriptions/no-tablespaces del plan. Nunca --clean,
    --create, disable-triggers, paralelismo, ignorar errores o reintentos automaticos.
    Registrar errores solo en un destino privado; pueden contener filas o SQL.
12. Si falla, no conectar la app: la importacion de una sola transaccion revierte
    sus cambios, NO las extensiones instaladas previamente. Conservar evidencia y
    volver a planificar sobre una rama nueva; no borrar objetos para forzar reintento.
13. Verificar conteos exactos, secuencias, constraints, indices, RLS, grants y
    propietarios SECURITY DEFINER. Comparar posiciones/rutas y placeholders de
    baneados, hashes del arbol y saldos/ledger/ventas Stripe contra el snapshot.
    ANALYZE y cualquier cambio de permisos son pasos separados revisados.
14. Probar backup real, PITR y restore independiente; medir RPO/RTO y carga del
    backend completo. El corte de DNS/DSNs necesita otra aprobacion, manteniendo
    intacto el origen y evitando escritores o schedulers duplicados.

## Preflight en PowerShell

Ejemplo para despues de resolver los bloqueos. No crea directorios, copia datos,
aprovisiona recursos ni guarda credenciales. runtime y artifacts estan fuera de Git.
SOURCE_DATABASE_NAME debe ser el nombre observado, no un valor adivinado.

```powershell
$root = 'D:/vicionpower/backend'
$tools = (docker image inspect mindbliss/backup:pg18-20261025 --format '{{.Id}}').Trim()
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true `
  --env-file "$root/deploy/cloudflare/runtime/restore.env" `
  -v "$root/deploy/cloudflare/restore_plan.py:/tools/restore_plan.py:ro" `
  -v "$root/deploy/cloudflare/artifacts/restore-input:/input:ro" `
  --entrypoint python3 $tools -B /tools/restore_plan.py `
  --policy /input/policy.json --manifest /input/BACKUP_ID.manifest.json
```

Salida 2 significa bloqueado; salida 0 aun exige revision humana. Sin confirmacion
de rotacion/origen el programa se detiene antes de abrir cualquier conexion.
El endpoint y el rol no se imprimen: la huella permite comparar sin revelar la URL.

## Seleccion TOC

En un entorno privado y con la clave age offline montada solo lectura:

1. Descifrar hacia pg_restore --list y guardar full.toc en artifacts privados.
   Verificar la salida de AMBOS procesos. No guardar el dump SQL sin cifrar.
2. Guardar el campo filter del plan en approved.filter. Generar selected.toc
   mediante age y pg_restore --list --strict-names --filter=approved.filter.
3. Ejecutar offline restore_plan.py --policy policy.json --full-toc full.toc
   --selected-toc selected.toc. El resultado JSON contiene toc y tocSha256.
4. Guardar toc como approved.list y revisar sus IDs y orden contra el archivo
   original. La herramienta conserva la seleccion nativa y agrega SOLO las
   definiciones SCHEMA aprobadas; no modifica SQL ni incluye pscale_extensions.
5. Restaurar con --use-list=approved.list, SIN volver a aplicar --filter o --schema:
   volverian a excluir las definiciones SCHEMA que se agregaron. public no se recrea.

Ambos TOCs deben provenir del MISMO archivo cuyo checksum se verifico; el compilador
no certifica que selected.toc realmente haya sido producido por pg_restore. Comprobar
que no tenga IDs extra y revisar todas las exclusiones. No ejecutar una lista editada
sin renovar la revision, su hash y el plan. El programa no ejecuta esta lista.
[TOC y transaccion unica](https://www.postgresql.org/docs/18/app-pgrestore.html).

## Pruebas reproducibles

Construir primero las dos imagenes de [backup PG17/18](../portable/README.md#postgresql-18).
Las pruebas no leen archivos .env ni aceptan URLs de bases existentes.

```powershell
docker run --rm --network none --read-only --tmpfs /tmp:mode=1777 `
  -v D:/vicionpower/backend/deploy/cloudflare/restore_plan.py:/tools/restore_plan.py:ro `
  -v D:/vicionpower/backend/deploy/cloudflare/test_restore_plan.py:/tools/test_restore_plan.py:ro `
  -w /tools --entrypoint python3 mindbliss/backup:pg18-20261025 `
  -B -m unittest -v test_restore_plan
node deploy/cloudflare/test-restore-plan.mjs --synthetic-docker
```

El drill usa red Docker --internal y dos contenedores nuevos con identificador
aleatorio. Restaura 17 a 18 con un rol sin superusuario, extension de proveedor
preexistente, ltree 1.2 a 1.3, posicion de baneado y descendiente, GiST, montos,
secuencias y RLS. Verifica ausencia de escrituras del planner, bloqueo de destino
poblado, namespaces pgx no confundidos con sistema y rollback tras error de tipo.
Elimina SOLO esos contenedores/red al terminar. Los artefactos y claves son
sinteticos, no copias utiles de la empresa. No se certifican permisos reales de
PlanetScale, integridad de la copia historica ni capacidad de 1.100 usuarios.
