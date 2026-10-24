# Mindbliss: infraestructura portable

Estado: preparado y probado localmente; NO desplegado en Railway ni produccion.
Rama: `feature/portable-docker-infra-20261023`. Fecha: 2026-10-23.

Actualizacion 2026-10-24: el destino elegido es DigitalOcean App Platform.
Ver [pruebas locales y preparacion para App Platform](../digitalocean/README.md).
Este Compose sigue disponible para un host Docker propio; NO es un archivo
que App Platform pueda importar. Los perfiles nuevos usan PostgreSQL nativo.

## Alcance

| Servicio | Artefacto | Datos persistentes |
| --- | --- | --- |
| Cliente Next.js + sus BFF `/api/*` | `client` | Ninguno; cache regenerable |
| Admin Next.js + sus BFF `/api/*` | `admin` | Ninguno; cache regenerable |
| API Bun / Better Auth | `api` | PostgreSQL |
| Motor Go / ledger / binario | `engine` | PostgreSQL |
| Cobros y webhooks Go | `payments` | PostgreSQL |
| Retiros Go | `withdrawals` | PostgreSQL |
| PostgreSQL 17 nativo + ltree | Imagen de DB fijada por digest | Volumen `postgres-data` |
| Redis | Imagen versionada | Cache/limites regenerables; NO fuente contable |
| HTTPS en VPS | Caddy, perfil `edge` | Certificados ACME en volumen |
| Backup y restauracion | `backup`, perfil `ops` | Copias cifradas locales + S3 externo |

Los adaptadores de soporte/voz, Qdrant/FalkorDB, Chatwoot y el backend BMP son
integraciones separadas, NO quedan desplegadas por este stack. Ya tienen sus
propios Dockerfiles en otros directorios. No se importan sus secretos ni datos.
NATS no se activa en este primer rollout: el motor permite operar sin el puente
de eventos y payments activa compras atomicamente. Si una integracion requiere
NATS, hay que provisionarla y validar sus consumidores antes de habilitarla.

Docker no elimina dependencias funcionales: Cognito/SES, Stripe, BMP y documentos
KYC externos siguen requiriendo configuracion y un plan de exportacion propio.

## Contrato de ambientes

- `mindbliss-staging` y `mindbliss-production`: redes, volumenes, DB, claves y
  buckets/prefijos separados. Nunca apuntar staging a la DB real.
- La base recuperada `mindbliss-local-recovery-20261022` NO se reutiliza ni monta.
  La QA anterior `deploy/docker-qa` sigue siendo sintetica y efimera.
- Ninguna migracion, restauracion, movimiento del arbol o calculo financiero se
  ejecuta automaticamente al iniciar el stack.
- Todos los jobs del motor permanecen apagados con
  `BONUS_ENGINE_SCHEDULER_ENABLED=false`, incluido ROI e invariantes periodicas.
  El cierre binario tambien queda desactivado. Revisar y aprobar esos jobs antes
  de habilitar un unico ejecutor sobre datos reales.
- Reconciliacion Stripe, correos de carrito y comunicados masivos apagados en el
  rollout inicial; habilitarlos despues de validar entorno y responsables.
- APIs Go, API Bun, DB y Redis son privados. Solo frontend/admin y la ruta de
  webhook firmada se publican. No publicar `/api/admin/*` de payments directamente.
- En un VPS, `edge` expone 80/443; en Railway se usa su red publica/privada.
- Los limites de memoria del ejemplo NO certifican 1.100 usuarios simultaneos.
  Dimensionar con pruebas de carga, latencias, conexiones, RAM, IOPS y WAL reales.

## Preparar configuracion

Ejecutar desde la raiz `backend`. Los comandos de servidor siguientes usan Bash
(Linux/WSL); Node y Docker tambien funcionan desde PowerShell con rutas absolutas.

```sh
node deploy/portable/manage.mjs init --environment staging --directory deploy/portable/runtime/staging
node deploy/portable/manage.mjs init --environment production --directory deploy/portable/runtime/production
```

Se crean plantillas, NO credenciales productivas. `init` se niega a sobrescribir
archivos existentes. Completar `project.env` y los diez archivos `*.env`; todos
los `REPLACE_*` deben desaparecer. Guardarlos en un gestor de secretos y respaldo
cifrado fuera de Git. Usar contrasenas aleatorias de al menos 24 caracteres y
tokens/secretos de 32 o mas; codificar usuario/password al formar una URI.

Cada aplicacion necesita un rol de DB distinto y permisos minimos, con un rol
solo lectura para `MEMBER_DATABASE_URL`. NO usar `postgres` para aplicaciones.
Revisar politicas/RLS, roles historicos `engine_write`, `engine_read`, `app_read`
y los grants requeridos por las funciones antes del primer arranque. No se crea
un usuario superadmin ni se conceden permisos globales desde Docker.

En redes Docker locales aisladas se usa `sslmode=disable` y `MEMBER_DB_SSL=disable`.
Para DB remota configurar TLS y CA de confianza; nunca desactivar verificacion
para solucionar un error de certificado. El cifrado de disco del host/volumen
tambien corresponde al operador.

## Versionar imagenes

Los tres repositorios deben tener sus cambios committeados; los contextos de
build esperan `backend`, `mindblisspowerfront` y `mindblisspower-admin` como
directorios hermanos. No se usan secretos de runtime durante el build.

```sh
node deploy/portable/release.mjs build --tag r20261023-01 --registry ghcr.io/ORGANIZACION/mindbliss
```

Construye ocho imagenes `linux/amd64` y registra SHA de los tres repos, tag e ID
local en `deploy/portable/artifacts/r20261023-01.json`. No publica ni despliega.
Un tag ya registrado no se reutiliza. Cambiar plataforma expresamente para otro
host; no asumir que una imagen ARM de AWS funcionara en Railway x86.

Ejecutar pruebas sobre estos artefactos y publicar cada imagen en un registro
PRIVADO bajo control propio. Ejemplo para UN servicio, repetir para los ocho:

```sh
docker push ghcr.io/ORGANIZACION/mindbliss/client:r20261023-01
node deploy/portable/release.mjs lock --manifest deploy/portable/artifacts/r20261023-01.json
```

`lock` falla hasta que TODAS las imagenes construidas esten publicadas y su ID
local siga coincidiendo con el manifiesto. Verifica el digest contra el registro:
`RepoDigests` local puede existir aun sin un push. Genera `*.images.env` con digests;
promover ese mismo archivo de staging a produccion, SIN reconstruir aplicaciones.
Fijar tambien Postgres/Redis por digest en el archivo del proyecto. Nunca
actualizar una major de Postgres/Timescale cambiando un tag sobre un volumen viejo.
Tampoco montar PGDATA de Timescale en la nueva imagen PostgreSQL nativa: requiere
una conversion/restauracion revisada en otra DB, no un cambio de imagen in situ.

Mantener copias de los manifiestos y de las imagenes en un segundo registro o
en un archivo `docker image save -o release.tar ...`; verificar hash y probar
`docker image load -i release.tar` en un host de recuperacion. `docker save` NO
incluye la DB, secretos, archivos KYC ni volumenes.

Las variables `NEXT_PUBLIC_*` son de build en Next.js: no poner claves ni hosts
especificos de un ambiente en el bundle que se va a promover sin reconstruir.
Los BFF existentes usan URLs internas de runtime.

## Certificados mTLS

El motor usa una identidad de servidor y la API una identidad de cliente.
`engine` solo monta `tls/server`, `api` solo `tls/client`; la clave de CA queda
FUERA de ambos. La API carga `VP_ENGINE_TLS_CA/CERT/KEY` y exige HTTPS cuando
`ENGINE_MTLS_REQUIRED=true`. No hay fallback a transporte inseguro.

Para provisionar una CA interna inicial, en un equipo seguro y directorios nuevos:

```sh
docker build -t mindbliss/backup:infra-20261023 deploy/portable/backup
mkdir -p "$HOME/mindbliss-offline-ca" deploy/portable/runtime/staging
docker run --rm --network none --user 0 \
  -v "$PWD/deploy/portable/runtime/staging:/runtime" \
  -v "$HOME/mindbliss-offline-ca:/offline" \
  -v "$PWD/deploy/portable/certificates.py:/tools/certificates.py:ro" \
  --entrypoint python3 mindbliss/backup:infra-20261023 /tools/certificates.py \
  --runtime /runtime --offline-ca /offline --dns engine.railway.internal
```

Genera certificados de 90 dias con EKU y SAN, rechaza sobrescritura y asigna
propietarios 65534 (motor) / 65532 (API). Para produccion usar otra CA/directorio,
controlar acceso, respaldar CA offline y programar rotacion antes de vencer.
No ejecutar este comando sobre la CA de staging para generar produccion.
Para renovacion generar una version nueva y hacer rollout coordinado, conservando
temporalmente confianza anterior/nueva si se rota la CA.

`manage check` valida configuracion, certificados/clave, CA compartida, hostname
`engine`, proposito y al menos 14 dias de vigencia. Es un preflight local, NO una
certificacion de roles, capacidad, webhook real ni coherencia financiera.

## Arranque y actualizaciones

Inicializar/restaurar la DB y sus roles ANTES de arrancar aplicaciones. El volumen
vacio solo contiene el cluster; no contiene el esquema Mindbliss ni usuarios.
No ejecutar el inicializador sintetico de QA sobre una base real.

Ejemplo staging con imagenes de una release ya construida:

```sh
node deploy/portable/manage.mjs check --environment staging --env-file deploy/portable/runtime/staging/project.env
docker compose --env-file deploy/portable/runtime/staging/project.env \
  -f deploy/portable/compose.yml -f deploy/portable/compose.staging.yml up -d
```

El admin queda en `127.0.0.1:3401`, cliente en `127.0.0.1:3400`. Para login con
cookies seguras usar host HTTPS de staging mediante `edge` o un proxy TLS local.
`compose.build.yml` agrega builds desde fuentes para desarrollo/QA; NO usar ese
override para reconstruir imagenes en un despliegue productivo.

Produccion en un VPS con DNS previamente configurado:

```sh
node deploy/portable/manage.mjs check --environment production \
  --env-file deploy/portable/runtime/production/project.env \
  --images-file deploy/portable/artifacts/r20261023-01.json.images.env
docker compose --env-file deploy/portable/runtime/production/project.env \
  --env-file deploy/portable/artifacts/r20261023-01.json.images.env \
  -f deploy/portable/compose.yml -f deploy/portable/compose.production.yml \
  --profile edge up -d --no-build
```

Antes de actualizar: backup verificado, migraciones compatibles hacia atras
revisadas, release anterior disponible y ventana de cambio. Luego actualizar
SOLO servicios modificados con `up -d --no-deps --no-build SERVICE...`; no reiniciar
Postgres por una actualizacion del frontend. Con una instancia puede haber una
interrupcion breve: Compose no ofrece rolling deployment automatico.

Rollback: seleccionar el archivo de digests de la release anterior y recrear
solo aplicaciones. Si hubo cambios de esquema incompatibles, detenerse y usar
un plan de migracion/recovery revisado; volver a la imagen anterior NO revierte
los datos ni justifica restaurar una DB vieja sobre transacciones nuevas.

Nunca usar `docker compose down -v`, `docker volume prune` ni copiar `PGDATA`
en caliente como sustituto de un backup consistente.

## Backups independientes

El job ejecuta `pg_dump -Fc` y roles sin hashes de passwords, transmite el flujo
directamente a `age`, calcula SHA-256 y publica el manifiesto AL FINAL. No escribe
un dump sin cifrar. La clave publica age basta para crear copias; la identidad
PRIVADA se conserva offline y solo se entrega al restaurador en una recuperacion.
La subida S3 usa TLS; no hay opciones para desactivar verificacion.

Generar identidad age con `age-keygen` en un directorio privado fuera del repo;
copiar solo el destinatario publico a `backup.env`. Mantener dos copias offline
de la identidad privada: perderla hace irrecuperables los backups cifrados.

`DATABASE_URL` de backup debe poder leer TODAS las tablas/objetos necesarios;
no aceptar un dump parcial por falta de permisos. La exportacion de roles puede
necesitar permisos adicionales. No se guardan passwords de roles, grants de
aplicaciones ni archivos externos como secretos: respaldarlos separadamente.
`pg_read_all_data` no evita RLS: revisar el rol de backup y el alcance real sin
desactivar RLS de las aplicaciones. Los clientes remotos de backup usan
`sslmode=verify-full` por defecto; proveer la CA de la DB cuando sea necesaria.

En Linux preparar `BACKUP_DIR` para escritura del UID/GID 70, sin hacerlo publico.
El volumen `backup-work` guarda temporalmente SOLO ciphertext y se limpia al
terminar. Dimensionar disco segun el dump comprimido; no se exige que la base
quepa en RAM. Un kill abrupto puede dejar ciphertext huerfano sin manifiesto.

```sh
docker compose --env-file deploy/portable/runtime/production/project.env \
  --env-file deploy/portable/artifacts/r20261023-01.json.images.env \
  -f deploy/portable/compose.yml -f deploy/portable/compose.production.yml \
  --profile ops run --rm --no-deps backup create
```

Programar este mismo comando con un timer/cron del servidor. En Railway usar el
job que termina tras la copia; ver [RAILWAY.md](RAILWAY.md). El ejemplo corre cada
6 horas: su RPO de exportacion puede ser 6 h MAS duracion/retraso del job. NO es
suficiente para prometer recuperacion de todas las transacciones recientes.

Para transacciones reales: habilitar y probar WAL/PITR continuo, con base backups
y archivo externo, y medir el lag. El viejo archivo pgBackRest del repo es una
referencia, NO se instala ni activa automaticamente aqui. No declarar un RPO de
minutos hasta probarlo. El PITR nativo de Railway depende de sus imagenes y no
es una capacidad automatica de nuestro contenedor Timescale personalizado.

Politica propuesta, ajustar coste/volumen medido: copias logicas cada 6 h durante
7 dias, una diaria 30 dias y una mensual 12 meses; WAL/PITR segun el RPO acordado.
El job NO borra copias: configurar retencion/seleccion en almacenamiento externo,
con versionado/Object Lock cuando exista. Credencial de subida sin permisos de
borrado, credencial de lectura separada, alertas si falla o no aparece un
manifiesto nuevo. Alertar tambien por disco, lag WAL y expiracion de certificados.
El programador y las alertas del proveedor real aun NO estan activados.

## Restauracion y salida del proveedor

1. Descargar ciphertext + manifiesto de una fuente de confianza; conservar
   versionado/immutabilidad. Un SHA detecta corrupcion, no sustituye la confianza
   en el origen. Un dump SQL de un origen no confiable puede ejecutar codigo.
2. Crear PostgreSQL 17 compatible con las extensiones/versiones del manifiesto.
   No restaurar un dump Timescale en Postgres sin Timescale. Validar las reglas
   de upgrade de extensiones; la imagen de backup se niega a exportar otra major.
3. Revisar el archivo de roles cifrado, recrear los roles requeridos y passwords
   nuevos bajo control del DBA. NO ejecutar `roles.sql` automaticamente: contiene
   atributos sensibles como SUPERUSER. Las politicas pueden referenciar roles.
4. Crear una DB NUEVA con nombre `mindbliss_restore_production_YYYYMMDD` o
   `mindbliss_restore_staging_YYYYMMDD`, usando `TEMPLATE template0`. No iniciar
   aplicaciones ni jobs contra ella hasta terminar la validacion.
5. Ejecutar el contenedor restaurador con identidad privada montada solo lectura.

Ejemplo en un host de recuperacion, con red Docker que alcanza la nueva DB:

```sh
docker run --rm --read-only --network RED_DE_RECUPERACION \
  --tmpfs /work:uid=70,gid=70,mode=0700 \
  --env-file /RUTA/restore.env \
  -v /RUTA/copias:/input:ro -v /RUTA/offline:/keys:ro \
  IMAGEN_BACKUP_FIJADA_POR_DIGEST restore
```

`restore.env`, privado y fuera de Git:

```dotenv
DATABASE_URL=postgres://ROL_RESTORE:PASSWORD_CODIFICADO@NUEVA_DB:5432/mindbliss_restore_production_YYYYMMDD?sslmode=verify-full&sslrootcert=/keys/db-ca.crt
BACKUP_MANIFEST=/input/ID.manifest.json
AGE_IDENTITY_FILE=/keys/db.agekey
RESTORE_TARGET_NAME=mindbliss_restore_production_YYYYMMDD
RESTORE_CONFIRM=mindbliss_restore_production_YYYYMMDD
```

Verifica nombre real de DB, destino vacio, hash, tamano, descifrado y TOC antes
de restaurar. Usa transaccion unica, sin `--clean` ni `DROP`, y el modo de restore
de Timescale si corresponde. Si falla, no arrancar aplicaciones: la extension
preparada previamente puede permanecer y el destino ya no se considera vacio;
conservar evidencia y usar otro destino nuevo para el siguiente intento.

NO restaura automaticamente owners ni ACLs. Reaplicar roles/grants/RLS revisados,
auditar afiliados/posiciones, saldos/ledger, pagos Stripe e idempotencia de
webhooks, secuencias y ultimos registros. Medir duracion y punto de recuperacion.
Despues cambiar DSNs/DNS bajo ventana de mantenimiento, conservando el origen
intacto y evitando escritores o schedulers duplicados. No reejecutar pagos reales
como parte de una prueba de restauracion.

## Verificacion reproducible

```sh
node --test deploy/portable/manage.test.mjs deploy/portable/release-policy.test.mjs
docker build -t mindbliss/backup:infra-20261023 deploy/portable/backup
node deploy/portable/test-backup.mjs --synthetic-docker
docker build -f deploy/portable/Dockerfile.edge -t mindbliss/edge:infra-20261023 deploy/portable
node deploy/portable/test-edge.mjs --qa-docker
docker compose -f deploy/docker-qa/compose.yml --profile test build api bun-tests
docker compose -f deploy/docker-qa/compose.yml --profile test run --rm --no-deps bun-tests
node deploy/docker-qa/smoke.mjs
```

El drill crea y elimina SOLO contenedores/redes con identificador aleatorio
`mindbliss-backup-drill-*`; NO acepta una URL externa. Verifica Timescale,
posiciones L/R, un bloqueado con su descendiente, montos y rechazos de operaciones
inseguras. Sus artifacts son sinteticos y la copia del caso negativo termina
corrompida intencionalmente: NO confundirla con un backup util de la empresa.

El chequeo de mTLS real adicional es `app/scripts/test-engine-mtls.ts`, con
identidades sinteticas y `MTLS_FIXTURE_DIR` apuntando a `tls/`. El workflow
`.github/workflows/portable-infra.yml` prepara el fixture, hace handshake HTTP/2
y verifica rechazo de cliente sin certificado y de hostname incorrecto.

La base historica recuperada ocupa 12.142.300.307 bytes (~12,14 GB decimales) en
la consulta de solo lectura de esta revision. No se exporto ni modifico esa DB.
El drill pequeno NO mide el tiempo real de recuperar esos 12 GB ni certifica
compras Stripe recientes; la copia historica no contenia esos intents.

Referencias: [Docker en produccion](https://docs.docker.com/compose/how-tos/production/),
[pg_dump y portabilidad](https://www.postgresql.org/docs/17/backup-dump.html),
[pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html).
